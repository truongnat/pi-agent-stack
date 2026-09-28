//! Pi Core native engine. JavaScript reaches it through the Node-API addon in
//! `crates/pi-core-napi`; this crate stays plain Rust so `cargo test` needs no JS runtime.

pub mod ast;
pub mod dcp;
pub mod scanner;
pub mod supervisor;
pub mod tokenizer;
pub mod vector;
