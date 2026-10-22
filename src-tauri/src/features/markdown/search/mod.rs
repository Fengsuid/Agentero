//! Vault-wide full-text Markdown search.
//!
//! The walk lives in `agentero-core` so the desktop command and the shared
//! MCP server use one implementation.

pub use agentero_core::features::markdown::search::*;

pub mod commands;
