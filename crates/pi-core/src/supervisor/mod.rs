//! Native Subagent POSIX Process Supervisor & Sandbox Watchdog
//!
//! Provides isolated process group execution, hard timeout enforcement,
//! cascade tree termination (0 zombie leaks), and bounded stdout/stderr capture.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessExecutionResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// Spawns a command in its own POSIX process group with strict timeout enforcement and bounded memory output.
pub fn execute_supervised(
    command_str: &str,
    cwd: &str,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> ProcessExecutionResult {
    let start_time = Instant::now();
    let max_bytes = if max_output_bytes == 0 {
        10 * 1024 * 1024 // default 10MB
    } else {
        max_output_bytes
    };

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/C", command_str]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command_str]);
        c
    };

    if !cwd.is_empty() && Path::new(cwd).exists() {
        cmd.current_dir(cwd);
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(unix)]
    {
        // Place child in its own process group (PGID = child PID) for cascade kills
        cmd.process_group(0);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            return ProcessExecutionResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("Failed to spawn process: {err}"),
                timed_out: false,
                duration_ms: start_time.elapsed().as_millis() as u64,
            };
        }
    };

    let pid = child.id() as i32;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    // Stream stdout & stderr on background threads to prevent OS pipe buffer deadlocks
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();

    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut out) = stdout_pipe {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = out.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if buf.len() + n <= max_bytes {
                    buf.extend_from_slice(&chunk[..n]);
                } else {
                    let rem = max_bytes.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..rem]);
                    break;
                }
            }
        }
        let _ = stdout_tx.send(String::from_utf8_lossy(&buf).to_string());
    });

    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut err) = stderr_pipe {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = err.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if buf.len() + n <= max_bytes {
                    buf.extend_from_slice(&chunk[..n]);
                } else {
                    let rem = max_bytes.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..rem]);
                    break;
                }
            }
        }
        let _ = stderr_tx.send(String::from_utf8_lossy(&buf).to_string());
    });

    // Wait with timeout
    let (wait_tx, wait_rx) = mpsc::channel();
    let timeout = Duration::from_millis(timeout_ms);

    thread::spawn(move || {
        let status = child.wait();
        let _ = wait_tx.send(status);
    });

    let (exit_code, timed_out) = match wait_rx.recv_timeout(timeout) {
        // A signal death has no exit code; report 128 + signal like a shell, never success.
        Ok(Ok(status)) => (exit_code_of(status), false),
        Ok(Err(_)) => (-1, false),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // Hard cascade kill process group
            kill_process_group(pid, 15); // SIGTERM
            thread::sleep(Duration::from_millis(150));
            kill_process_group(pid, 9); // SIGKILL hard kill
            (-9, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => (-1, false),
    };

    let stdout = stdout_rx
        .recv_timeout(Duration::from_millis(500))
        .unwrap_or_default();
    let stderr = stderr_rx
        .recv_timeout(Duration::from_millis(500))
        .unwrap_or_default();

    ProcessExecutionResult {
        exit_code,
        stdout,
        stderr,
        timed_out,
        duration_ms: start_time.elapsed().as_millis() as u64,
    }
}

/// Kills an entire process group by PGID using POSIX signals.
pub fn kill_process_group(pgid: i32, signal: i32) -> i32 {
    #[cfg(unix)]
    {
        if pgid <= 0 {
            return -1;
        }
        unsafe { libc::kill(-pgid, signal) }
    }
    #[cfg(not(unix))]
    {
        let _ = (pgid, signal);
        0
    }
}

/// Checks if a process with the given PID is currently active.
pub fn is_process_alive(pid: i32) -> bool {
    #[cfg(unix)]
    {
        if pid <= 0 {
            return false;
        }
        unsafe { libc::kill(pid, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

#[cfg(unix)]
fn exit_code_of(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

#[cfg(not(unix))]
fn exit_code_of(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(-1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execute_supervised_simple() {
        let res = execute_supervised("echo 'hello supervisor'", "", 5000, 1024);
        assert_eq!(res.exit_code, 0);
        assert!(res.stdout.contains("hello supervisor"));
        assert!(!res.timed_out);
    }

    #[test]
    fn test_execute_supervised_timeout() {
        // Sleep for 3 seconds with a 300ms timeout
        let res = execute_supervised("sleep 3", "", 300, 1024);
        assert!(res.timed_out);
        assert!(res.duration_ms >= 250);
    }

    #[test]
    fn test_execute_supervised_cascade_subprocesses() {
        // Spawns a child and background grandchild
        let res = execute_supervised("sh -c 'sleep 5 & sleep 0.1'", "", 5000, 1024);
        assert_eq!(res.exit_code, 0);
    }

    #[test]
    fn test_signal_death_is_not_success() {
        let res = execute_supervised("kill -KILL $$", "", 5000, 1024);
        assert_eq!(res.exit_code, 128 + 9);
        assert!(!res.timed_out);
    }
}
