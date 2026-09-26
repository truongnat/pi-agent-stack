//! Fast DCP (Dynamic Context Pruning) native module.

use std::collections::HashSet;
use std::hash::Hasher;
use twox_hash::XxHash64;

/// Computes an ultra-fast 64-bit hash of a tool name + canonical arguments string.
pub fn hash_tool_signature(tool_name: &str, canonical_args: &str) -> u64 {
    let mut hasher = XxHash64::default();
    hasher.write(tool_name.as_bytes());
    hasher.write_u8(0);
    hasher.write(canonical_args.as_bytes());
    hasher.finish()
}

/// Identifies duplicate tool call IDs given a list of (tool_call_id, signature_hash).
/// Iterates newest-first (from end to start) and marks older duplicates.
pub fn find_duplicate_tool_call_ids<'a>(
    records: &'a [(&'a str, u64)],
    protected_hashes: &HashSet<u64>,
) -> Vec<&'a str> {
    let mut seen_signatures = HashSet::new();
    let mut duplicates = Vec::new();

    for &(call_id, sig_hash) in records.iter().rev() {
        if protected_hashes.contains(&sig_hash) {
            continue;
        }

        if !seen_signatures.insert(sig_hash) {
            // Already seen a newer instance with the same signature: this older one is a duplicate!
            duplicates.push(call_id);
        }
    }

    duplicates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_signature_consistency() {
        let h1 = hash_tool_signature("read_file", r#"{"path":"/src/main.rs"}"#);
        let h2 = hash_tool_signature("read_file", r#"{"path":"/src/main.rs"}"#);
        let h3 = hash_tool_signature("read_file", r#"{"path":"/src/lib.rs"}"#);

        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
    }

    #[test]
    fn test_find_duplicates() {
        let records = vec![
            ("call_1", hash_tool_signature("read", "a")),
            ("call_2", hash_tool_signature("grep", "b")),
            ("call_3", hash_tool_signature("read", "a")), // Newer duplicate of call_1
        ];

        let protected = HashSet::new();
        let dups = find_duplicate_tool_call_ids(&records, &protected);

        assert_eq!(dups, vec!["call_1"]);
    }
}
