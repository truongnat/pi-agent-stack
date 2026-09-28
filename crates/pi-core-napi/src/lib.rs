//! Node-API bindings for pi-core. Loaded by pi-native-bridge under Node (Pi's runtime) and Bun.
//! napi-rs turns Rust panics into JS exceptions, and strings/arrays cross with their lengths,
//! so there are no C strings to free and no NUL truncation.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_core::{ast, dcp, scanner, supervisor, tokenizer, vector};
use serde_json::Value;
use std::path::Path;

fn json<T: serde::Serialize>(value: &T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn count_tokens(text: String, model_family: String) -> u32 {
    tokenizer::count_tokens(&text, model_family.as_str().into()) as u32
}

#[napi]
pub fn count_tokens_bpe(text: String, encoding: String) -> u32 {
    tokenizer::count_tokens_with_encoding(&text, &encoding) as u32
}

/// Hex, like the TS fallback's output format.
#[napi]
pub fn hash_tool_signature(tool_name: String, canonical_args: String) -> String {
    format!(
        "{:x}",
        dcp::hash_tool_signature(&tool_name, &canonical_args)
    )
}

#[napi]
pub fn hash_prompt(text: String) -> String {
    format!("{:x}", dcp::hash_prompt(&text))
}

#[napi]
pub fn scan_directory(dir_path: String, max_depth: u32) -> Result<Value> {
    json(&scanner::scan_directory(
        Path::new(&dir_path),
        max_depth as usize,
    ))
}

#[napi]
pub fn search_workspace(dir_path: String, query: String, max_results: u32) -> Result<Value> {
    json(&scanner::search_workspace(
        Path::new(&dir_path),
        &query,
        max_results as usize,
    ))
}

#[napi]
pub fn skeletonize_code(source: String, language: String) -> Result<Value> {
    json(&ast::skeletonize_code(&source, &language))
}

#[napi]
pub fn spawn_supervised(
    cmd: String,
    cwd: String,
    timeout_ms: u32,
    max_output_bytes: u32,
) -> Result<Value> {
    json(&supervisor::execute_supervised(
        &cmd,
        &cwd,
        timeout_ms as u64,
        max_output_bytes as usize,
    ))
}

/// 0 for empty or mismatched vectors (the C ABI read past the shorter one).
#[napi]
pub fn cosine_similarity(a: Vec<f64>, b: Vec<f64>) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let a: Vec<f32> = a.into_iter().map(|v| v as f32).collect();
    let b: Vec<f32> = b.into_iter().map(|v| v as f32).collect();
    vector::cosine_similarity(&a, &b) as f64
}

#[napi]
pub fn trigram_similarity(a: String, b: String) -> f64 {
    vector::trigram_similarity(&a, &b) as f64
}

#[napi]
pub fn rank_documents(query: String, documents: Value, top_k: u32) -> Result<Value> {
    let docs: Vec<vector::DocumentItem> =
        serde_json::from_value(documents).map_err(|e| Error::from_reason(e.to_string()))?;
    json(&vector::rank_documents(&query, &docs, top_k as usize))
}

#[napi]
pub fn kill_process_group(pgid: i32, signal: i32) -> i32 {
    supervisor::kill_process_group(pgid, signal)
}

#[napi]
pub fn is_process_alive(pid: i32) -> bool {
    supervisor::is_process_alive(pid)
}
