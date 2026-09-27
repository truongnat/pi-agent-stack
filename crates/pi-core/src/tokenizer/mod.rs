//! Fast native BPE tokenizer module for Pi Agent Stack powered by tiktoken-rs.

use tiktoken_rs::{
    cl100k_base_singleton, o200k_base_singleton, p50k_base_singleton, r50k_base_singleton,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFamily {
    OpenAI,
    OpenAIO200k,
    Anthropic,
    Gemini,
    Generic,
}

impl From<&str> for ModelFamily {
    fn from(s: &str) -> Self {
        let lower = s.to_lowercase();
        if lower.contains("claude") || lower.contains("anthropic") {
            ModelFamily::Anthropic
        } else if lower.contains("gemini")
            || lower.contains("google")
            || lower.contains("antigravity")
        {
            ModelFamily::Gemini
        } else if lower.contains("o200k")
            || lower.contains("gpt-4o")
            || lower.contains("gpt-5")
            || lower.contains("gpt-6")
            || lower.contains("codex")
            || lower.contains("luna")
        {
            ModelFamily::OpenAIO200k
        } else if lower.contains("gpt")
            || lower.contains("openai")
            || lower.contains("o1")
            || lower.contains("o3")
        {
            ModelFamily::OpenAI
        } else {
            ModelFamily::Generic
        }
    }
}

/// Token count using real BPE Byte-Pair Encoding or fallback.
pub fn count_tokens(text: &str, family: ModelFamily) -> usize {
    if text.is_empty() {
        return 0;
    }

    // Use cl100k_base / o200k_base for precise BPE calculations
    match family {
        ModelFamily::OpenAI => {
            let bpe = cl100k_base_singleton();
            let bpe_guard = bpe.lock();
            bpe_guard.encode_with_special_tokens(text).len()
        }
        ModelFamily::OpenAIO200k => {
            let bpe = o200k_base_singleton();
            let bpe_guard = bpe.lock();
            bpe_guard.encode_with_special_tokens(text).len()
        }
        ModelFamily::Anthropic => {
            // Claude's tokenizer is byte-level BPE very close to cl100k
            let bpe = cl100k_base_singleton();
            let bpe_guard = bpe.lock();
            bpe_guard.encode_with_special_tokens(text).len()
        }
        ModelFamily::Gemini | ModelFamily::Generic => {
            let bpe = cl100k_base_singleton();
            let bpe_guard = bpe.lock();
            bpe_guard.encode_with_special_tokens(text).len()
        }
    }
}

/// Exact token count with specified encoding name (e.g. "cl100k_base", "o200k_base", "p50k_base", "r50k_base").
pub fn count_tokens_with_encoding(text: &str, encoding: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    match encoding {
        "o200k_base" => {
            let bpe = o200k_base_singleton();
            let bpe_guard = bpe.lock();
            bpe_guard.encode_with_special_tokens(text).len()
        }
        "p50k_base" => {
            let bpe = p50k_base_singleton();
            let bpe_guard = bpe.lock();
            bpe_guard.encode_with_special_tokens(text).len()
        }
        "r50k_base" => {
            let bpe = r50k_base_singleton();
            let bpe_guard = bpe.lock();
            bpe_guard.encode_with_special_tokens(text).len()
        }
        _ => {
            let bpe = cl100k_base_singleton();
            let bpe_guard = bpe.lock();
            bpe_guard.encode_with_special_tokens(text).len()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_count_empty() {
        assert_eq!(count_tokens("", ModelFamily::OpenAI), 0);
        assert_eq!(count_tokens_with_encoding("", "cl100k_base"), 0);
    }

    #[test]
    fn test_count_simple() {
        let text = "Hello world! This is a fast Rust BPE tokenizer.";
        let count = count_tokens(text, ModelFamily::OpenAI);
        assert!(count >= 8 && count <= 15, "Actual count was: {count}");
    }

    #[test]
    fn test_count_code_exact() {
        let code = r#"
            function add(a: number, b: number): number {
                return a + b;
            }
        "#;
        let count = count_tokens(code, ModelFamily::Anthropic);
        assert!(count >= 15 && count <= 35, "Actual count was: {count}");
    }

    #[test]
    fn test_count_with_o200k() {
        let text = "Complex mathematical symbols: ∀x ∈ ℝ, x² ≥ 0";
        let count = count_tokens_with_encoding(text, "o200k_base");
        assert!(count > 0);
    }

    #[test]
    fn gpt5_and_codex_use_o200k() {
        assert_eq!(ModelFamily::from("openai-codex/gpt-5.5"), ModelFamily::OpenAIO200k);
        assert_eq!(ModelFamily::from("gpt-4o"), ModelFamily::OpenAIO200k);
        let n = count_tokens("hello from rust tokenizer", ModelFamily::OpenAIO200k);
        assert!(n > 0);
    }
}
