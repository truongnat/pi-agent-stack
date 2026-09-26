//! Fast native tokenizer module for Pi Agent Stack.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFamily {
    OpenAI,
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
        } else if lower.contains("gpt") || lower.contains("openai") || lower.contains("codex") {
            ModelFamily::OpenAI
        } else {
            ModelFamily::Generic
        }
    }
}

/// Fast BPE token counter that pairs whitespace with following words and estimates byte pairs.
pub fn count_tokens(text: &str, _family: ModelFamily) -> usize {
    if text.is_empty() {
        return 0;
    }

    let mut tokens = 0;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            // Consume leading whitespace run
            let mut ws_count = 1;
            while let Some(&next_c) = chars.peek() {
                if next_c.is_whitespace() {
                    chars.next();
                    ws_count += 1;
                } else {
                    break;
                }
            }
            // In BPE, every 4 consecutive spaces or 2 newlines is ~1 token
            if ws_count > 4 {
                tokens += (ws_count - 1) / 4;
            }
            // The remaining whitespace attaches to the next token, or if trailing, counts as 1
            if chars.peek().is_none() {
                tokens += 1;
            }
        } else if c.is_ascii_punctuation() {
            tokens += 1;
        } else if c.is_alphanumeric() {
            let mut byte_len = c.len_utf8();
            while let Some(&next_c) = chars.peek() {
                if next_c.is_alphanumeric() || next_c == '_' {
                    chars.next();
                    byte_len += next_c.len_utf8();
                } else {
                    break;
                }
            }
            tokens += if byte_len <= 4 { 1 } else { (byte_len + 3) / 4 };
        } else {
            tokens += 1;
        }
    }

    tokens.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_count_empty() {
        assert_eq!(count_tokens("", ModelFamily::OpenAI), 0);
    }

    #[test]
    fn test_count_simple() {
        let text = "Hello world! This is a fast Rust tokenizer.";
        let count = count_tokens(text, ModelFamily::OpenAI);
        assert!(count >= 8 && count <= 15, "Actual count was: {count}");
    }

    #[test]
    fn test_count_code() {
        let code = r#"
            function add(a: number, b: number): number {
                return a + b;
            }
        "#;
        let count = count_tokens(code, ModelFamily::Anthropic);
        assert!(count >= 15 && count <= 45, "Actual count was: {count}");
    }
}
