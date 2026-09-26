//! High-Performance Local Vector Math, Trigram Similarity & Memory Ranker
//!
//! Provides SIMD-accelerated vector cosine similarity, Trigram fuzzy text matching,
//! and parallel document ranking for pi-rl-engine and memory search.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentItem {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub utility: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankedDocument {
    pub id: String,
    pub score: f32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorItem {
    pub id: String,
    pub vector: Vec<f32>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorSearchResult {
    pub id: String,
    pub score: f32,
    pub metadata: Option<Value>,
}

/// SIMD-friendly Cosine Similarity between two float vectors.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }

    let mut dot_product = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for i in 0..a.len() {
        let va = a[i];
        let vb = b[i];
        dot_product += va * vb;
        norm_a += va * va;
        norm_b += vb * vb;
    }

    let denom = (norm_a.sqrt() * norm_b.sqrt()).max(1e-9);
    dot_product / denom
}

/// Extracts character trigrams from text (lowercased).
pub fn extract_trigrams(text: &str) -> HashSet<[char; 3]> {
    let chars: Vec<char> = text.to_lowercase().chars().collect();
    let mut trigrams = HashSet::new();

    if chars.len() < 3 {
        return trigrams;
    }

    for window in chars.windows(3) {
        trigrams.insert([window[0], window[1], window[2]]);
    }

    trigrams
}

/// Computes Trigram Dice Similarity between two strings (0.0 to 1.0).
pub fn trigram_similarity(a: &str, b: &str) -> f32 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    let tri_a = extract_trigrams(a);
    let tri_b = extract_trigrams(b);

    if tri_a.is_empty() || tri_b.is_empty() {
        // Fallback for very short strings
        if a.to_lowercase().contains(&b.to_lowercase())
            || b.to_lowercase().contains(&a.to_lowercase())
        {
            return 0.5;
        }
        return 0.0;
    }

    let intersection_count = tri_a.intersection(&tri_b).count();
    let total_count = tri_a.len() + tri_b.len();

    (2.0 * intersection_count as f32) / (total_count as f32)
}

/// Hybrid document ranker combining exact keywords, trigram fuzzy matching, and utility weights.
pub fn rank_documents(
    query: &str,
    documents: &[DocumentItem],
    top_k: usize,
) -> Vec<RankedDocument> {
    if documents.is_empty() {
        return Vec::new();
    }

    let query_lower = query.to_lowercase();
    let query_words: Vec<&str> = query_lower
        .split_whitespace()
        .filter(|w| w.len() > 1)
        .collect();
    let query_trigrams = extract_trigrams(&query_lower);

    let mut ranked: Vec<RankedDocument> = documents
        .par_iter()
        .map(|doc| {
            let doc_lower = doc.text.to_lowercase();
            let mut score = 0.0f32;

            // 1. Trigram text similarity (weight: 0.5)
            if !query_trigrams.is_empty() {
                let doc_trigrams = extract_trigrams(&doc_lower);
                if !doc_trigrams.is_empty() {
                    let inter = query_trigrams.intersection(&doc_trigrams).count();
                    let total = query_trigrams.len() + doc_trigrams.len();
                    score += 0.5 * ((2.0 * inter as f32) / (total as f32));
                }
            }

            // 2. Keyword containment bonus (weight: 0.3)
            let mut word_hits = 0;
            for word in &query_words {
                if doc_lower.contains(word) {
                    word_hits += 1;
                }
            }
            if !query_words.is_empty() {
                score += 0.3 * (word_hits as f32 / query_words.len() as f32);
            }

            // 3. Tag match bonus (weight: 0.15)
            for tag in &doc.tags {
                if query_lower.contains(&tag.to_lowercase()) {
                    score += 0.15;
                }
            }

            // 4. Utility / reinforcement weight (weight: 0.05)
            score += 0.05 * doc.utility.clamp(0.0, 1.0);

            RankedDocument {
                id: doc.id.clone(),
                score,
                text: doc.text.clone(),
            }
        })
        .collect();

    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ranked.truncate(top_k);
    ranked
}

/// High-speed parallel vector search across an in-memory index.
pub fn search_vector_index(
    query_vector: &[f32],
    index: &[VectorItem],
    top_k: usize,
) -> Vec<VectorSearchResult> {
    if query_vector.is_empty() || index.is_empty() {
        return Vec::new();
    }

    let mut results: Vec<VectorSearchResult> = index
        .par_iter()
        .map(|item| {
            let score = cosine_similarity(query_vector, &item.vector);
            VectorSearchResult {
                id: item.id.clone(),
                score,
                metadata: item.metadata.clone(),
            }
        })
        .collect();

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(top_k);
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity() {
        let a = [1.0, 0.0, 1.0];
        let b = [1.0, 0.0, 1.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-5);

        let c = [0.0, 1.0, 0.0];
        let sim_ortho = cosine_similarity(&a, &c);
        assert!(sim_ortho.abs() < 1e-5);
    }

    #[test]
    fn test_trigram_similarity() {
        let s1 = "function calculateMonthlyInterest()";
        let s2 = "calculateMonthlyInterest";
        let sim = trigram_similarity(s1, s2);
        assert!(sim > 0.6, "Trigram similarity was: {sim}");

        let s3 = "completely unrelated string";
        let sim_unrelated = trigram_similarity(s1, s3);
        assert!(sim_unrelated < 0.2);
    }

    #[test]
    fn test_rank_documents() {
        let docs = vec![
            DocumentItem {
                id: "1".to_string(),
                text: "Always use bun test for unit tests".to_string(),
                tags: vec!["testing".to_string(), "bun".to_string()],
                utility: 0.9,
            },
            DocumentItem {
                id: "2".to_string(),
                text: "Database migrations must use sqlx".to_string(),
                tags: vec!["database".to_string()],
                utility: 0.5,
            },
            DocumentItem {
                id: "3".to_string(),
                text: "Run prettier before commit".to_string(),
                tags: vec!["formatting".to_string()],
                utility: 0.8,
            },
        ];

        let ranked = rank_documents("how to run unit test with bun", &docs, 2);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].id, "1");
        assert!(ranked[0].score > ranked[1].score);
    }
}
