//! `agentero mcp serve` — foreground Streamable HTTP MCP for one local vault.
//!
//! Same tools as the desktop listener (`agentero-mcp`). Loopback only: there
//! is no authentication. Reach it from another machine with an SSH local
//! forward, not by binding a public address.

use crate::error::{CliError, ExitCode};
use crate::resolve::GlobalOpts;
use agentero_mcp::{McpController, McpHost};
use clap::Args;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Loopback address. Only 127.0.0.1 and ::1 are accepted.
    #[arg(long = "listen", value_name = "ADDR", default_value = "127.0.0.1:8765")]
    pub listen: String,
    /// Extra vaults `vault_list` may target, besides `--vault`.
    #[arg(long = "allow-vault", value_name = "PATH")]
    pub allow_vault: Vec<PathBuf>,
    /// Send PDF page text to clients. Off unless set.
    #[arg(long = "expose-paper-text")]
    pub expose_paper_text: bool,
    /// Default import parent inside the vault.
    #[arg(long = "parent", value_name = "DIR", default_value = "papers")]
    pub parent: String,
    /// NOTES.md shell for imports: standard, title-only, blank, or custom.
    #[arg(long = "note-mode", value_name = "MODE", default_value = "standard")]
    pub note_mode: String,
}

struct CliHost {
    expose_paper_text: bool,
}

impl McpHost for CliHost {
    fn expose_paper_text(&self) -> bool {
        self.expose_paper_text
    }
}

pub async fn serve(args: ServeArgs, globals: &GlobalOpts) -> Result<Value, CliError> {
    let vault = require_explicit_vault(globals)?;
    let mut allowed = Vec::with_capacity(args.allow_vault.len());
    for path in &args.allow_vault {
        allowed.push(canonical_dir(path)?);
    }

    let addr = agentero_mcp::parse_loopback_listen(&args.listen)?;
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|err| {
        CliError::new(
            "mcp_bind",
            format!("failed to bind {addr}: {err}"),
            ExitCode::Business,
        )
    })?;
    let bound = listener.local_addr().unwrap_or(addr);

    let ctrl = Arc::new(McpController::new());
    ctrl.set_host(Arc::new(CliHost {
        expose_paper_text: args.expose_paper_text,
    }));
    ctrl.set_known_vaults(
        allowed
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    );
    ctrl.set_vault(Some(vault.to_string_lossy().into_owned()));
    let parent = args.parent.trim();
    if !parent.is_empty() {
        ctrl.set_parent_dir(parent.to_string());
    }
    ctrl.set_paper_note_mode(args.note_mode);
    ctrl.set_translator_url(globals.translator_base_url());

    let url = format!("http://{bound}/mcp");
    eprintln!("MCP listening on {url}");
    log::info!(target: "agentero::mcp", "listening on {url}");
    agentero_mcp::serve_until_signal(Arc::clone(&ctrl), listener).await?;
    Ok(json!({
        "url": url,
        "vault": vault.to_string_lossy(),
    }))
}

/// Servers must name a vault. Walk-up from the working directory is for
/// one-shot commands; a long-running process should not guess.
fn require_explicit_vault(globals: &GlobalOpts) -> Result<PathBuf, CliError> {
    if let Some(path) = &globals.vault_flag {
        return canonical_dir(path);
    }
    if let Ok(env) = std::env::var("AGENTERO_VAULT") {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return canonical_dir(Path::new(trimmed));
        }
    }
    Err(CliError::usage(
        "mcp serve requires --vault or AGENTERO_VAULT",
    ))
}

fn canonical_dir(path: &Path) -> Result<PathBuf, CliError> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    if !abs.is_dir() {
        return Err(CliError::vault_not_found(format!(
            "not a directory: {}",
            abs.display()
        )));
    }
    Ok(agentero_core::fs::canonicalize_best_effort(&abs))
}
