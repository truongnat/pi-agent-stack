//! Fast workspace and file scanner module.

use std::fs;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Fast directory scan filtering common ignored directories (node_modules, .git, target, etc.).
pub fn scan_directory(root: &Path, max_depth: usize) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    scan_recursive(root, root, 0, max_depth, &mut entries);
    entries
}

fn scan_recursive(
    current: &Path,
    root: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<FileEntry>,
) {
    if depth > max_depth {
        return;
    }

    let Ok(read_dir) = fs::read_dir(current) else {
        return;
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();

        // Default fast ignore list
        if name_str == "node_modules"
            || name_str == ".git"
            || name_str == "target"
            || name_str == "dist"
            || name_str == ".pi"
            || name_str.starts_with(".DS_Store")
        {
            continue;
        }

        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        out.push(FileEntry {
            path: relative_path,
            is_dir,
            size,
        });

        if is_dir {
            scan_recursive(&path, root, depth + 1, max_depth, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_dir() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn test() {}").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/fake.js"), "console.log()").unwrap();

        let scanned = scan_directory(root, 5);
        let paths: Vec<String> = scanned.into_iter().map(|e| e.path).collect();

        assert!(paths.contains(&"src".to_string()));
        assert!(paths.contains(&"src/lib.rs".to_string()));
        assert!(!paths.contains(&"node_modules".to_string()));
    }
}
