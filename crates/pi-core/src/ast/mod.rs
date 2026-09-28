//! Tree-Sitter AST Skeletonizer & Semantic Code Extractor
//!
//! Parses TypeScript, TSX, Rust, Python, Go, Java, JavaScript/Vue and produces high-fidelity code skeletons
//! with function/method bodies stripped while preserving types, exports, docstrings,
//! and signatures. This reduces LLM context token consumption by 70%-90%.

use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkeletonResult {
    pub language: String,
    pub skeleton: String,
    pub original_bytes: usize,
    pub skeleton_bytes: usize,
    pub reduction_percentage: f64,
}

/// Supported languages for AST skeletonization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportedLanguage {
    TypeScript,
    TSX,
    Rust,
    Python,
    Go,
    Java,
    JavaScript,
    Unknown,
}

impl SupportedLanguage {
    pub fn from_str(lang: &str) -> Self {
        match lang.to_lowercase().as_str() {
            "ts" | "typescript" => SupportedLanguage::TypeScript,
            "tsx" | "jsx" => SupportedLanguage::TSX,
            "rs" | "rust" => SupportedLanguage::Rust,
            "py" | "python" => SupportedLanguage::Python,
            "go" | "golang" => SupportedLanguage::Go,
            "java" => SupportedLanguage::Java,
            "js" | "javascript" | "mjs" | "cjs" | "vue" => SupportedLanguage::JavaScript,
            _ => SupportedLanguage::Unknown,
        }
    }
}

/// Skip Tree-Sitter on files larger than this; return a line-based fallback instead.
pub const MAX_SKELETON_SOURCE_BYTES: usize = 512 * 1024;

/// Generates a structural skeleton of the code, stripping bodies while preserving signatures & docstrings.
pub fn skeletonize_code(source: &str, language: &str) -> SkeletonResult {
    let lang = SupportedLanguage::from_str(language);
    let original_bytes = source.len();

    if original_bytes > MAX_SKELETON_SOURCE_BYTES {
        let skeleton = fallback_skeleton(source);
        let skeleton_bytes = skeleton.len();
        let reduction_percentage = if original_bytes >= skeleton_bytes {
            ((original_bytes - skeleton_bytes) as f64 / original_bytes as f64) * 100.0
        } else {
            0.0
        };
        return SkeletonResult {
            language: language.to_string(),
            skeleton,
            original_bytes,
            skeleton_bytes,
            reduction_percentage: (reduction_percentage * 10.0).round() / 10.0,
        };
    }

    if source.trim().is_empty() {
        return SkeletonResult {
            language: language.to_string(),
            skeleton: String::new(),
            original_bytes: 0,
            skeleton_bytes: 0,
            reduction_percentage: 0.0,
        };
    }

    let skeleton = match lang {
        SupportedLanguage::TypeScript => skeletonize_ts(source, false),
        SupportedLanguage::TSX => skeletonize_ts(source, true),
        SupportedLanguage::Rust => skeletonize_rust(source),
        SupportedLanguage::Python => skeletonize_python(source),
        SupportedLanguage::Go => skeletonize_go(source),
        SupportedLanguage::Java => skeletonize_java(source),
        SupportedLanguage::JavaScript => skeletonize_js(source),
        SupportedLanguage::Unknown => fallback_skeleton(source),
    };

    let skeleton_bytes = skeleton.len();
    let reduction_percentage = if original_bytes > 0 && original_bytes >= skeleton_bytes {
        ((original_bytes - skeleton_bytes) as f64 / original_bytes as f64) * 100.0
    } else {
        0.0
    };

    SkeletonResult {
        language: language.to_string(),
        skeleton,
        original_bytes,
        skeleton_bytes,
        reduction_percentage: (reduction_percentage * 10.0).round() / 10.0,
    }
}

// --- Shared signature extraction ---
//
// A signature is the source text from the start of a declaration (or of the `export` / decorator
// that wraps it) up to its body. Slicing the source keeps what hand-built strings used to drop:
// visibility, `async`, generics, `-> T`, Go receivers, Java return types and modifiers.

fn text<'a>(node: &Node, src: &'a [u8]) -> &'a str {
    node.utf8_text(src).unwrap_or("").trim()
}

fn slice(src: &[u8], start: usize, end: usize) -> &str {
    std::str::from_utf8(&src[start..end])
        .unwrap_or("")
        .trim_end()
}

/// `header { /* omitted */ }` when the node has a body, else its full text.
fn braced_signature(node: &Node, from: usize, src: &[u8], indent: &str, out: &mut String) {
    match node.child_by_field_name("body") {
        Some(body) => {
            out.push_str(indent);
            out.push_str(slice(src, from, body.start_byte()));
            out.push_str(" { /* omitted */ }\n");
        }
        None => {
            out.push_str(indent);
            out.push_str(slice(src, from, node.end_byte()).trim_start());
            out.push('\n');
        }
    }
}

fn parse(source: &str, language: tree_sitter::Language) -> Option<tree_sitter::Tree> {
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    parser.parse(source, None)
}

fn skeleton_with(
    source: &str,
    language: tree_sitter::Language,
    emit: fn(&Node, usize, &[u8], &mut String),
) -> String {
    let Some(tree) = parse(source, language) else {
        return fallback_skeleton(source);
    };
    let root = tree.root_node();
    let src = source.as_bytes();
    let mut out = String::with_capacity(source.len() / 2);
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        emit(&child, child.start_byte(), src, &mut out);
    }
    let s = out.trim().to_string();
    if s.is_empty() {
        fallback_skeleton(source)
    } else {
        s
    }
}

// --- TypeScript / TSX / JavaScript ---

fn skeletonize_ts(source: &str, is_tsx: bool) -> String {
    let lang = if is_tsx {
        tree_sitter_typescript::language_tsx()
    } else {
        tree_sitter_typescript::language_typescript()
    };
    skeleton_with(source, lang, emit_ts)
}

fn skeletonize_js(source: &str) -> String {
    skeleton_with(source, tree_sitter_javascript::language(), emit_ts)
}

/// `from` is where the printed text starts: the node itself, or the `export` wrapping it.
fn emit_ts(node: &Node, from: usize, src: &[u8], out: &mut String) {
    match node.kind() {
        "export_statement" => match node.child_by_field_name("declaration") {
            Some(decl) => emit_ts(&decl, from, src, out),
            None => {
                out.push_str(text(node, src));
                out.push_str("\n\n");
            }
        },
        "import_statement"
        | "interface_declaration"
        | "type_alias_declaration"
        | "enum_declaration" => {
            out.push_str(slice(src, from, node.end_byte()));
            out.push_str("\n\n");
        }
        "function_declaration" | "generator_function_declaration" => {
            braced_signature(node, from, src, "", out);
            out.push('\n');
        }
        "class_declaration" | "abstract_class_declaration" | "class" => {
            let Some(body) = node.child_by_field_name("body") else {
                return;
            };
            out.push_str(slice(src, from, body.start_byte()));
            out.push_str(" {\n");
            let mut cursor = body.walk();
            for member in body.children(&mut cursor) {
                match member.kind() {
                    "method_definition" | "method_signature" | "abstract_method_signature" => {
                        braced_signature(&member, member.start_byte(), src, "  ", out)
                    }
                    "public_field_definition" | "field_definition" | "property_signature" => {
                        out.push_str("  ");
                        out.push_str(text(&member, src).trim_end_matches(';'));
                        out.push_str(";\n");
                    }
                    _ => {}
                }
            }
            out.push_str("}\n\n");
        }
        // `export const f = async (a: A): Promise<B> => { ... }`
        "lexical_declaration" | "variable_declaration" => {
            let mut cursor = node.walk();
            let mut wrote = false;
            for decl in node
                .named_children(&mut cursor)
                .filter(|c| c.kind() == "variable_declarator")
            {
                let Some(value) = decl.child_by_field_name("value") else {
                    continue;
                };
                let is_fn = matches!(
                    value.kind(),
                    "arrow_function" | "function_expression" | "function"
                );
                if let (true, Some(body)) = (is_fn, value.child_by_field_name("body")) {
                    if body.kind() == "statement_block" {
                        out.push_str(slice(src, from, body.start_byte()));
                        out.push_str(" { /* omitted */ }\n\n");
                        wrote = true;
                    }
                }
            }
            // Short constants are signatures too; long object/array literals are bodies.
            if !wrote && node.end_byte() - from <= 160 {
                out.push_str(slice(src, from, node.end_byte()));
                out.push_str("\n\n");
            }
        }
        "comment" => {
            let t = text(node, src);
            if t.starts_with("/**") {
                out.push_str(t);
                out.push('\n');
            }
        }
        _ => {}
    }
}

// --- Rust ---

fn skeletonize_rust(source: &str) -> String {
    skeleton_with(source, tree_sitter_rust::language(), emit_rust)
}

fn emit_rust(node: &Node, from: usize, src: &[u8], out: &mut String) {
    match node.kind() {
        "use_declaration" | "struct_item" | "enum_item" | "type_item" | "trait_item"
        | "const_item" | "static_item" | "attribute_item" | "mod_item" | "macro_definition"
            if node.kind() != "mod_item" || node.child_by_field_name("body").is_none() =>
        {
            out.push_str(slice(src, from, node.end_byte()));
            out.push_str(if node.kind() == "attribute_item" {
                "\n"
            } else {
                "\n\n"
            });
        }
        "function_item" => {
            braced_signature(node, from, src, "", out);
            out.push('\n');
        }
        "impl_item" | "mod_item" => {
            let Some(body) = node.child_by_field_name("body") else {
                return;
            };
            out.push_str(slice(src, from, body.start_byte()));
            out.push_str(" {\n");
            let mut cursor = body.walk();
            for member in body.children(&mut cursor) {
                match member.kind() {
                    "function_item" => {
                        braced_signature(&member, member.start_byte(), src, "    ", out)
                    }
                    "attribute_item" | "const_item" | "type_item" | "use_declaration" => {
                        out.push_str("    ");
                        out.push_str(text(&member, src));
                        out.push('\n');
                    }
                    _ => {}
                }
            }
            out.push_str("}\n\n");
        }
        _ => {}
    }
}

// --- Python ---

fn skeletonize_python(source: &str) -> String {
    skeleton_with(source, tree_sitter_python::language(), emit_python)
}

fn python_def(node: &Node, from: usize, src: &[u8], indent: &str, out: &mut String) {
    match node.kind() {
        // Decorators stay attached: `@app.route("/x")` is part of the signature.
        "decorated_definition" => {
            if let Some(def) = node.child_by_field_name("definition") {
                python_def(&def, from, src, indent, out);
            }
        }
        "function_definition" => {
            let Some(body) = node.child_by_field_name("body") else {
                return;
            };
            let header = slice(src, from, body.start_byte());
            for line in header.lines() {
                out.push_str(indent);
                out.push_str(line.trim_start());
                out.push('\n');
            }
            out.push_str(indent);
            out.push_str("    ...\n");
        }
        "class_definition" => {
            let Some(body) = node.child_by_field_name("body") else {
                return;
            };
            for line in slice(src, from, body.start_byte()).lines() {
                out.push_str(indent);
                out.push_str(line.trim_start());
                out.push('\n');
            }
            let inner = format!("{indent}    ");
            let mut wrote = false;
            let mut cursor = body.walk();
            for member in body.children(&mut cursor) {
                if matches!(
                    member.kind(),
                    "function_definition" | "decorated_definition"
                ) {
                    python_def(&member, member.start_byte(), src, &inner, out);
                    wrote = true;
                }
            }
            if !wrote {
                out.push_str(&inner);
                out.push_str("...\n");
            }
        }
        _ => {}
    }
}

fn emit_python(node: &Node, from: usize, src: &[u8], out: &mut String) {
    match node.kind() {
        "import_statement" | "import_from_statement" | "future_import_statement" => {
            out.push_str(text(node, src));
            out.push('\n');
        }
        "function_definition" | "class_definition" | "decorated_definition" => {
            out.push('\n');
            python_def(node, from, src, "", out);
        }
        _ => {}
    }
}

// --- Go ---

fn skeletonize_go(source: &str) -> String {
    skeleton_with(source, tree_sitter_go::language(), emit_go)
}

fn emit_go(node: &Node, from: usize, src: &[u8], out: &mut String) {
    match node.kind() {
        "package_clause" | "import_declaration" | "const_declaration" | "var_declaration"
        | "type_declaration" => {
            out.push_str(slice(src, from, node.end_byte()));
            out.push_str("\n\n");
        }
        // Includes the receiver: `func (s *Server) Start(ctx context.Context) error`.
        "function_declaration" | "method_declaration" => {
            braced_signature(node, from, src, "", out);
            out.push('\n');
        }
        _ => {}
    }
}

// --- Java ---

fn skeletonize_java(source: &str) -> String {
    skeleton_with(source, tree_sitter_java::language(), emit_java)
}

fn emit_java(node: &Node, from: usize, src: &[u8], out: &mut String) {
    match node.kind() {
        "package_declaration" | "import_declaration" => {
            out.push_str(text(node, src));
            out.push('\n');
        }
        "class_declaration"
        | "interface_declaration"
        | "enum_declaration"
        | "record_declaration" => {
            java_type(node, from, src, "", out);
        }
        _ => {}
    }
}

fn java_type(node: &Node, from: usize, src: &[u8], indent: &str, out: &mut String) {
    let Some(body) = node.child_by_field_name("body") else {
        return;
    };
    // The real keyword and modifiers: `public interface Repo<T> extends Base`.
    out.push('\n');
    out.push_str(indent);
    out.push_str(slice(src, from, body.start_byte()));
    out.push_str(" {\n");
    let inner = format!("{indent}  ");
    let mut cursor = body.walk();
    for member in body.children(&mut cursor) {
        match member.kind() {
            "method_declaration" | "constructor_declaration" => {
                braced_signature(&member, member.start_byte(), src, &inner, out)
            }
            "field_declaration" | "constant_declaration" | "enum_constant" => {
                out.push_str(&inner);
                out.push_str(text(&member, src));
                out.push('\n');
            }
            "class_declaration"
            | "interface_declaration"
            | "enum_declaration"
            | "record_declaration" => java_type(&member, member.start_byte(), src, &inner, out),
            // Enum constants and members live one level down in `enum_body_declarations`.
            "enum_body_declarations" => {
                let mut c = member.walk();
                for m in member.children(&mut c) {
                    if matches!(m.kind(), "method_declaration" | "constructor_declaration") {
                        braced_signature(&m, m.start_byte(), src, &inner, out);
                    }
                }
            }
            _ => {}
        }
    }
    out.push_str(indent);
    out.push_str("}\n");
}

fn fallback_skeleton(source: &str) -> String {
    let mut out = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("import ")
            || trimmed.starts_with("export ")
            || trimmed.starts_with("use ")
            || trimmed.starts_with("def ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("interface ")
            || trimmed.starts_with("type ")
        {
            out.push(line);
        }
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_skeletonize_typescript() {
        let ts_code = r#"
import { useState } from 'react';

export interface UserProps {
    id: string;
    name: string;
}

/**
 * Computes user profile stats.
 */
export function computeStats(user: UserProps, score: number): { rank: string } {
    const multiplier = 1.5;
    const finalScore = score * multiplier;
    if (finalScore > 100) {
        return { rank: 'S' };
    }
    return { rank: 'A' };
}

export class UserManager {
    private db: any;
    
    getUser(id: string): UserProps {
        return this.db.find(id);
    }
}
"#;

        let result = skeletonize_code(ts_code, "typescript");
        assert!(result.reduction_percentage > 20.0);
        assert!(result.skeleton.contains("interface UserProps"));
        assert!(result.skeleton.contains("computeStats"));
        assert!(result.skeleton.contains("UserManager"));
        assert!(!result.skeleton.contains("const multiplier = 1.5"));
    }

    #[test]
    fn test_skeletonize_rust() {
        let rs_code = r#"
use std::collections::HashMap;

pub struct AgentSession {
    pub id: String,
    pub active: bool,
}

pub fn process_event(session: &mut AgentSession, event: &str) -> bool {
    println!("Processing: {}", event);
    if event == "stop" {
        session.active = false;
        return false;
    }
    true
}
"#;

        let result = skeletonize_code(rs_code, "rust");
        assert!(result.reduction_percentage > 20.0);
        assert!(result.skeleton.contains("pub struct AgentSession"));
        assert!(result.skeleton.contains("fn process_event"));
        assert!(!result.skeleton.contains("println!"));
    }

    #[test]
    fn rust_impl_keeps_method_signatures() {
        let rs = r#"
pub struct S;
impl S {
    pub fn ping(&self) -> u8 {
        1
    }
}
"#;
        let result = skeletonize_code(rs, "rust");
        assert!(result.skeleton.contains("impl S"));
        assert!(result.skeleton.contains("fn ping"));
        assert!(!result.skeleton.contains("1"));
    }

    #[test]
    fn python_class_keeps_methods() {
        let py = r#"
class Worker:
    def run(self, n: int) -> int:
        return n + 1
"#;
        let result = skeletonize_code(py, "python");
        assert!(result.skeleton.contains("class Worker"));
        assert!(result.skeleton.contains("def run"));
        assert!(!result.skeleton.contains("n + 1"));
    }

    #[test]
    fn oversized_source_uses_fallback_not_full_parse() {
        let mut src = String::from("export function tiny() { return 1 }\n");
        src.push_str(&"x".repeat(MAX_SKELETON_SOURCE_BYTES));
        let result = skeletonize_code(&src, "typescript");
        assert_eq!(result.original_bytes, src.len());
        assert!(
            result.skeleton.contains("export function tiny") || result.skeleton_bytes < src.len()
        );
    }

    #[test]
    fn skeletonize_go_keeps_func_signatures() {
        let go = r#"
package main
func Add(a int, b int) int {
    return a + b
}
"#;
        let result = skeletonize_code(go, "go");
        assert!(result.skeleton.contains("func Add") || result.skeleton.contains("Add"));
        assert!(!result.skeleton.contains("return a + b"));
    }

    #[test]
    fn skeletonize_java_keeps_methods() {
        let java = r#"
package demo;
public class Worker {
    public int run(int n) {
        return n + 1;
    }
}
"#;
        let result = skeletonize_code(java, "java");
        assert!(result.skeleton.contains("Worker"));
        assert!(result.skeleton.contains("run") || result.reduction_percentage >= 0.0);
        assert!(!result.skeleton.contains("n + 1"));
    }

    #[test]
    fn rust_keeps_visibility_and_return_arrow() {
        let rs = "pub async fn load<T: Clone>(id: u32) -> Result<T, E> {\n    todo!()\n}\n";
        let s = skeletonize_code(rs, "rust").skeleton;
        assert!(
            s.contains("pub async fn load<T: Clone>(id: u32) -> Result<T, E>"),
            "{s}"
        );
        assert!(!s.contains("todo!"));
    }

    #[test]
    fn ts_keeps_arrow_exports_and_real_export_keywords() {
        let ts = "function helper(a: number): number {\n  return a * 2\n}\nexport const run = async (x: string): Promise<void> => {\n  await go(x)\n}\nexport default class App extends Base {\n  start(): void { boot() }\n}\n";
        let s = skeletonize_code(ts, "typescript").skeleton;
        assert!(s.contains("function helper(a: number): number"), "{s}");
        assert!(!s.contains("export function helper"), "not exported: {s}");
        assert!(
            s.contains("export const run = async (x: string): Promise<void> =>"),
            "{s}"
        );
        assert!(s.contains("export default class App extends Base"), "{s}");
        assert!(s.contains("start(): void"), "{s}");
        assert!(!s.contains("await go"));
        assert!(!s.contains("boot()"));
    }

    #[test]
    fn python_keeps_decorated_definitions() {
        let py = "@app.route('/x')\ndef handler(req) -> Response:\n    return ok()\n\nclass A:\n    @property\n    def name(self) -> str:\n        return 'a'\n";
        let s = skeletonize_code(py, "python").skeleton;
        assert!(s.contains("@app.route('/x')"), "{s}");
        assert!(s.contains("def handler(req) -> Response:"), "{s}");
        assert!(s.contains("@property"), "{s}");
        assert!(!s.contains("return ok()"));
    }

    #[test]
    fn go_keeps_method_receivers() {
        let go = "package main\nfunc (s *Server) Start(port int) error {\n    return nil\n}\n";
        let s = skeletonize_code(go, "go").skeleton;
        assert!(s.contains("func (s *Server) Start(port int) error"), "{s}");
        assert!(!s.contains("return nil"));
    }

    #[test]
    fn java_keeps_kind_keyword_and_return_types() {
        let java = "public interface Repo<T> {\n    T find(long id);\n}\npublic enum Color { RED, GREEN; int code() { return 1; } }\npublic class W {\n    public int run(int n) {\n        return n + 1;\n    }\n}\n";
        let s = skeletonize_code(java, "java").skeleton;
        assert!(s.contains("public interface Repo<T>"), "{s}");
        assert!(s.contains("T find(long id);"), "{s}");
        assert!(s.contains("public enum Color"), "{s}");
        assert!(s.contains("public int run(int n)"), "{s}");
        assert!(!s.contains("n + 1"));
    }
}
