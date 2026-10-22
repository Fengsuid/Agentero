//! Agentero Host library (`agentero_lib`).
//!
//! - [`run`] — Tauri app entry (desktop / mobile).
//! - [`core`] / [`features`] — bridge the tauri-free `agentero-core` crate
//!   (which the headless CLI consumes directly) and keep the desktop shells
//!   (`#[tauri::command]` surfaces, JobCenter, watcher, integrations).
//!
//! Assembly lives in [`app`]; domain logic in [`features`].

#[cfg(feature = "desktop")]
mod app;
/// Cross-cutting foundations (error, fs, paths, logging helpers).
pub mod core;
/// Domain features (Vault / Catalog / Import / Wiki / …).
/// Service bodies live in `agentero_core::features::*`; this crate keeps the
/// desktop-only shells. `features::agent` (BYOA) is desktop-only.
pub mod features;
/// External integrations (bridge, MCP, remote vault, cloud sync).
/// Desktop-only; CLI must not depend on these.
pub mod integration;
#[cfg(feature = "desktop")]
pub use app::run;

/// Regenerate typed IPC without running the unit-test harness.
#[cfg(feature = "bindings-export")]
pub fn export_bindings() {
    std::env::set_current_dir(env!("CARGO_MANIFEST_DIR")).expect("bindings working directory");
    std::env::set_var("AGENTERO_UPDATE_BINDINGS", "1");
    app::bindings_test::export_typescript_bindings();
}
