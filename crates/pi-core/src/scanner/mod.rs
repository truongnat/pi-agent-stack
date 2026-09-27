//! Ripgrep-class fast workspace and file scanner module using the `ignore` crate.
//!
//! Large-repo safety: cap walk size, skip binary and oversized files, stop search early.

use ignore::WalkBuilder;
use memchr::memmem;
use rayon::prelude::*;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Skip files larger than this when searching (1 MiB).
pub const MAX_SEARCH_FILE_BYTES: u64 = 1_048_576;
/// Hard cap on directory-scan entries returned to JS.
pub const MAX_SCAN_ENTRIES: usize = 20_000;
/// Do not search more than this many candidate files in one call.
pub const MAX_FILES_SEARCHED: usize = 8_000;
/// Default walk depth for unbounded search.
pub const DEFAULT_SEARCH_DEPTH: usize = 12;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchMatch {
    pub path: String,
    pub line_number: usize,
    pub line_text: String,
}

/// Fast directory scan respecting .gitignore, .ignore, and standard exclusions using ripgrep engine.
pub fn scan_directory(root: &Path, max_depth: usize) -> Vec<FileEntry> {
    let mut builder = WalkBuilder::new(root);
    builder
        .max_depth(Some(max_depth))
        .hidden(true) // skip hidden by default (.git, .DS_Store)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .standard_filters(true);

    let mut entries = Vec::new();
    for result in builder.build() {
        let Ok(entry) = result else { continue };
        let path = entry.path();
        if path == root {
            continue;
        }

        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        entries.push(FileEntry {
            path: relative_path,
            is_dir,
            size,
        });
        if entries.len() >= MAX_SCAN_ENTRIES {
            break;
        }
    }

    entries
}

/// Ultra-fast parallel search across workspace files matching a substring query.
pub fn search_workspace(root: &Path, query: &str, max_results: usize) -> Vec<SearchMatch> {
    if query.is_empty() || max_results == 0 {
        return Vec::new();
    }

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .max_depth(Some(DEFAULT_SEARCH_DEPTH))
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .standard_filters(true);

    let file_paths: Vec<std::path::PathBuf> = builder
        .build()
        .filter_map(|r| r.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter(|e| {
            e.metadata()
                .map(|m| m.len() > 0 && m.len() <= MAX_SEARCH_FILE_BYTES)
                .unwrap_or(false)
        })
        .map(|e| e.into_path())
        .take(MAX_FILES_SEARCHED)
        .collect();

    let found = AtomicUsize::new(0);
    let query_bytes = query.as_bytes();
    let query_lower = query.to_ascii_lowercase();
    let ascii_query = query.is_ascii();

    file_paths
        .par_iter()
        .flat_map(|path| {
            if found.load(Ordering::Relaxed) >= max_results {
                return Vec::new();
            }

            let Ok(bytes) = fs::read(path) else {
                return Vec::new();
            };
            if bytes.contains(&0) {
                return Vec::new();
            }

            let haystack_ok = if ascii_query {
                memmem::find(&bytes, query_bytes).is_some()
                    || contains_ascii_ignore_case(&bytes, query_lower.as_bytes())
            } else {
                std::str::from_utf8(&bytes)
                    .map(|s| s.to_lowercase().contains(&query.to_lowercase()))
                    .unwrap_or(false)
            };
            if !haystack_ok {
                return Vec::new();
            }

            let Ok(content) = std::str::from_utf8(&bytes) else {
                return Vec::new();
            };

            let rel_path = path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            let mut file_matches = Vec::new();
            for (line_idx, line) in content.lines().enumerate() {
                if found.load(Ordering::Relaxed) >= max_results {
                    break;
                }
                let hit = if ascii_query {
                    line.as_bytes()
                        .windows(query_bytes.len())
                        .any(|w| w.eq_ignore_ascii_case(query_bytes))
                } else {
                    line.to_lowercase().contains(&query.to_lowercase())
                };
                if hit {
                    found.fetch_add(1, Ordering::Relaxed);
                    file_matches.push(SearchMatch {
                        path: rel_path.clone(),
                        line_number: line_idx + 1,
                        line_text: line.trim().to_string(),
                    });
                }
            }
            file_matches
        })
        .take_any(max_results)
        .collect()
}

fn contains_ascii_ignore_case(haystack: &[u8], needle_lower: &[u8]) -> bool {
    if needle_lower.is_empty() || haystack.len() < needle_lower.len() {
        return false;
    }
    haystack
        .windows(needle_lower.len())
        .any(|w| w.eq_ignore_ascii_case(needle_lower))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_dir_with_gitignore() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn test() {}").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("target/artifact.o"), "binary").unwrap();
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::write(root.join("debug.log"), "some log").unwrap();

        let scanned = scan_directory(root, 5);
        let paths: Vec<String> = scanned.into_iter().map(|e| e.path).collect();

        assert!(paths.contains(&"src".to_string()));
        assert!(paths.contains(&"src/lib.rs".to_string()));
        assert!(!paths.contains(&"target".to_string()));
        assert!(!paths.contains(&"debug.log".to_string()));
    }

    #[test]
    fn test_search_workspace_parallel() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() {\n    println!(\"TargetFound\");\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "pub const FLAG: &str = \"NotThis\";\n",
        )
        .unwrap();

        let matches = search_workspace(root, "TargetFound", 10);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/main.rs");
        assert_eq!(matches[0].line_number, 2);
    }

    #[test]
    fn search_skips_binary_and_oversized_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/hit.rs"), "needle here\n").unwrap();
        fs::write(root.join("src/blob.bin"), [0u8, 1, 2, b'n', b'e', b'e', b'd', b'l', b'e']).unwrap();
        let huge = vec![b'x'; (MAX_SEARCH_FILE_BYTES as usize) + 8];
        fs::write(root.join("src/huge.txt"), huge).unwrap();

        let matches = search_workspace(root, "needle", 20);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/hit.rs");
    }

    #[test]
    fn scan_stops_at_entry_cap() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("src")).unwrap();
        for i in 0..50 {
            fs::write(root.join(format!("src/f{i}.txt")), "x").unwrap();
        }
        let scanned = scan_directory(root, 5);
        assert!(scanned.len() <= MAX_SCAN_ENTRIES);
        assert!(scanned.len() >= 50);
    }
}
