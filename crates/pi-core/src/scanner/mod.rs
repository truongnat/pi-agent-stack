//! Ripgrep-class fast workspace and file scanner module using the `ignore` crate.

use ignore::WalkBuilder;
use rayon::prelude::*;
use std::fs;
use std::path::Path;

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
    }

    entries
}

/// Ultra-fast parallel search across workspace files matching a substring query.
pub fn search_workspace(root: &Path, query: &str, max_results: usize) -> Vec<SearchMatch> {
    if query.is_empty() {
        return Vec::new();
    }

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .standard_filters(true);

    let file_paths: Vec<std::path::PathBuf> = builder
        .build()
        .filter_map(|r| r.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.into_path())
        .collect();

    // Search in parallel across CPU cores using Rayon
    let query_lower = query.to_lowercase();
    let matches: Vec<SearchMatch> = file_paths
        .par_iter()
        .flat_map(|path| {
            let Ok(content) = fs::read_to_string(path) else {
                return Vec::new();
            };

            let rel_path = path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            let mut file_matches = Vec::new();
            for (line_idx, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&query_lower) {
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
        .collect();

    matches
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
        fs::write(root.join("src/main.rs"), "fn main() {\n    println!(\"TargetFound\");\n}\n").unwrap();
        fs::write(root.join("src/lib.rs"), "pub const FLAG: &str = \"NotThis\";\n").unwrap();

        let matches = search_workspace(root, "TargetFound", 10);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/main.rs");
        assert_eq!(matches[0].line_number, 2);
    }
}
