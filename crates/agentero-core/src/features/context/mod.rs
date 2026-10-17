//! Read-only research context for one ACP turn.
//!
//! Host turns a [`ContextRequest`] into a [`ContextPlan`]: the minimum evidence
//! that belongs in the prompt, the sources this turn may open, a budget, and a
//! fingerprint. A session-scoped MCP server enforces the same grant. The global
//! Vault MCP is a different permission model and is not reused here.
//!
//! See `docs/backend/context.md`.

mod grant;
mod plan;
mod service;
mod types;

pub use grant::{
    grant_path, load_grant, read_usage_uris, remember_session_fingerprint, resume_allowed,
    session_fingerprint, usage_path, write_grant,
};
pub use plan::{
    facts_from_anchors, plan_from_facts, render_prompt_block, resolve_in_vault, AnchorFacts,
};
pub use service::ContextSession;
pub use types::*;

/// argv token the desktop binary recognizes before starting the GUI.
/// The ACP agent spawns that binary with this flag and a grant file.
pub const MCP_WORKER_ARG: &str = "--agentero-context-mcp";

/// Tool profile name recorded in the fingerprint. Changing it starts a new session.
pub const TOOL_PROFILE: &str = "agentero-context/v1";
