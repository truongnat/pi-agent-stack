//! Pi Core Native Engine - C-ABI FFI Exports

pub mod ast;
pub mod dcp;
pub mod scanner;
pub mod supervisor;
pub mod tokenizer;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;

/// Returns the version string of pi-core.
#[no_mangle]
pub extern "C" fn pi_core_version() -> *mut c_char {
    let s = CString::new("0.4.0").unwrap();
    s.into_raw()
}

/// Counts tokens in a given null-terminated UTF-8 text for a specified model family using BPE.
#[no_mangle]
pub extern "C" fn pi_count_tokens(text: *const c_char, model_family: *const c_char) -> u32 {
    if text.is_null() {
        return 0;
    }

    let c_str = unsafe { CStr::from_ptr(text) };
    let Ok(text_slice) = c_str.to_str() else {
        return 0;
    };

    let family_slice = if !model_family.is_null() {
        unsafe { CStr::from_ptr(model_family) }
            .to_str()
            .unwrap_or("generic")
    } else {
        "generic"
    };

    tokenizer::count_tokens(text_slice, family_slice.into()) as u32
}

/// Counts tokens in a given text using explicit BPE encoding (e.g. "cl100k_base", "o200k_base", "p50k_base").
#[no_mangle]
pub extern "C" fn pi_count_tokens_bpe(text: *const c_char, encoding: *const c_char) -> u32 {
    if text.is_null() {
        return 0;
    }

    let c_str = unsafe { CStr::from_ptr(text) };
    let Ok(text_slice) = c_str.to_str() else {
        return 0;
    };

    let enc_slice = if !encoding.is_null() {
        unsafe { CStr::from_ptr(encoding) }
            .to_str()
            .unwrap_or("cl100k_base")
    } else {
        "cl100k_base"
    };

    tokenizer::count_tokens_with_encoding(text_slice, enc_slice) as u32
}

/// Calculates an ultra-fast XXHash64 signature for a tool name + canonical arguments.
#[no_mangle]
pub extern "C" fn pi_hash_tool_signature(
    tool_name: *const c_char,
    canonical_args: *const c_char,
) -> u64 {
    if tool_name.is_null() || canonical_args.is_null() {
        return 0;
    }

    let Ok(t_name) = (unsafe { CStr::from_ptr(tool_name) }).to_str() else {
        return 0;
    };
    let Ok(args) = (unsafe { CStr::from_ptr(canonical_args) }).to_str() else {
        return 0;
    };

    dcp::hash_tool_signature(t_name, args)
}

/// Scans a directory and returns JSON serialized array of FileEntry using Ripgrep engine.
#[no_mangle]
pub extern "C" fn pi_scan_directory(dir_path: *const c_char, max_depth: u32) -> *mut c_char {
    if dir_path.is_null() {
        return CString::new("[]").unwrap().into_raw();
    }

    let Ok(path_str) = (unsafe { CStr::from_ptr(dir_path) }).to_str() else {
        return CString::new("[]").unwrap().into_raw();
    };

    let entries = scanner::scan_directory(Path::new(path_str), max_depth as usize);
    let json_str = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string());

    CString::new(json_str)
        .unwrap_or_else(|_| CString::new("[]").unwrap())
        .into_raw()
}

/// Searches files matching substring across workspace using parallel Rayon threads.
#[no_mangle]
pub extern "C" fn pi_search_workspace(
    dir_path: *const c_char,
    query: *const c_char,
    max_results: u32,
) -> *mut c_char {
    if dir_path.is_null() || query.is_null() {
        return CString::new("[]").unwrap().into_raw();
    }

    let Ok(path_str) = (unsafe { CStr::from_ptr(dir_path) }).to_str() else {
        return CString::new("[]").unwrap().into_raw();
    };
    let Ok(query_str) = (unsafe { CStr::from_ptr(query) }).to_str() else {
        return CString::new("[]").unwrap().into_raw();
    };

    let matches = scanner::search_workspace(Path::new(path_str), query_str, max_results as usize);
    let json_str = serde_json::to_string(&matches).unwrap_or_else(|_| "[]".to_string());

    CString::new(json_str)
        .unwrap_or_else(|_| CString::new("[]").unwrap())
        .into_raw()
}

/// Skeletonizes source code using Tree-Sitter AST parser, stripping function bodies.
#[no_mangle]
pub extern "C" fn pi_skeletonize_code(
    source: *const c_char,
    language: *const c_char,
) -> *mut c_char {
    if source.is_null() {
        return CString::new("{}").unwrap().into_raw();
    }

    let Ok(src_str) = (unsafe { CStr::from_ptr(source) }).to_str() else {
        return CString::new("{}").unwrap().into_raw();
    };

    let lang_str = if !language.is_null() {
        (unsafe { CStr::from_ptr(language) })
            .to_str()
            .unwrap_or("ts")
    } else {
        "ts"
    };

    let res = ast::skeletonize_code(src_str, lang_str);
    let json_str = serde_json::to_string(&res).unwrap_or_else(|_| "{}".to_string());

    CString::new(json_str)
        .unwrap_or_else(|_| CString::new("{}").unwrap())
        .into_raw()
}

/// Spawns a command with POSIX process group supervision and hard timeout.
#[no_mangle]
pub extern "C" fn pi_spawn_supervised(
    cmd: *const c_char,
    cwd: *const c_char,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> *mut c_char {
    if cmd.is_null() {
        return CString::new("{}").unwrap().into_raw();
    }

    let Ok(cmd_str) = (unsafe { CStr::from_ptr(cmd) }).to_str() else {
        return CString::new("{}").unwrap().into_raw();
    };

    let cwd_str = if !cwd.is_null() {
        (unsafe { CStr::from_ptr(cwd) }).to_str().unwrap_or("")
    } else {
        ""
    };

    let res = supervisor::execute_supervised(cmd_str, cwd_str, timeout_ms, max_output_bytes);
    let json_str = serde_json::to_string(&res).unwrap_or_else(|_| "{}".to_string());

    CString::new(json_str)
        .unwrap_or_else(|_| CString::new("{}").unwrap())
        .into_raw()
}

/// Kills an entire process group using POSIX signals.
#[no_mangle]
pub extern "C" fn pi_kill_process_group(pgid: i32, sig: i32) -> i32 {
    supervisor::kill_process_group(pgid, sig)
}

/// Checks if a PID is alive.
#[no_mangle]
pub extern "C" fn pi_is_process_alive(pid: i32) -> bool {
    supervisor::is_process_alive(pid)
}

/// Frees a string allocated by the Rust core.
#[no_mangle]
pub extern "C" fn pi_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe {
            let _ = CString::from_raw(ptr);
        }
    }
}
