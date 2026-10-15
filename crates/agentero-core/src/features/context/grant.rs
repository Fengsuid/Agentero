//! Grant file, usage log, and the fingerprint remembered for an ACP session.

use super::types::*;
use crate::error::AppError;
use std::fs;
use std::path::{Path, PathBuf};

const SESSIONS_REL: &str = ".agentero/context-sessions";
const FINGERPRINTS_FILE: &str = "fingerprints.json";

pub fn write_grant(path: &Path, grant: &ContextGrant) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(grant)?;
    fs::write(path, body)?;
    Ok(())
}

pub fn load_grant(path: &Path) -> Result<ContextGrant, AppError> {
    let body = fs::read_to_string(path)
        .map_err(|error| AppError::message(format!("read context grant: {error}")))?;
    let grant: ContextGrant = serde_json::from_str(&body)
        .map_err(|error| AppError::message(format!("invalid context grant: {error}")))?;
    if grant.schema_version != GRANT_SCHEMA_VERSION {
        return Err(AppError::domain(
            "context_grant",
            format!("unsupported context grant schema {}", grant.schema_version),
        ));
    }
    if grant.mode != ContextMode::ReadOnly {
        return Err(AppError::domain(
            "context_grant",
            "context grant is not read-only",
        ));
    }
    Ok(grant)
}

/// Directory the host uses for one Agentero runtime session.
pub fn session_dir(vault: &Path, runtime_session_id: &str) -> PathBuf {
    vault
        .join(SESSIONS_REL)
        .join(sanitize_id(runtime_session_id))
}

pub fn grant_path(vault: &Path, runtime_session_id: &str) -> PathBuf {
    session_dir(vault, runtime_session_id).join("grant.json")
}

pub fn usage_path(vault: &Path, runtime_session_id: &str) -> PathBuf {
    session_dir(vault, runtime_session_id).join("usage.jsonl")
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// Append the citation URIs a tool actually returned.
pub fn record_usage(path: &Path, tool: &str, uris: &[String]) -> Result<(), AppError> {
    if uris.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let line = serde_json::json!({
        "tool": tool,
        "citationUris": uris,
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    use std::io::Write;
    writeln!(file, "{line}")?;
    Ok(())
}

/// Citation URIs recorded for this session, in first-seen order.
pub fn read_usage_uris(path: &Path) -> Vec<String> {
    let Ok(body) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in body.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(uris) = value.get("citationUris").and_then(|item| item.as_array()) else {
            continue;
        };
        for uri in uris {
            let Some(uri) = uri.as_str() else {
                continue;
            };
            if !uri.is_empty() && !out.iter().any(|existing| existing == uri) {
                out.push(uri.to_string());
            }
        }
    }
    out
}

/// Resume only when the stored fingerprint is exactly this turn's fingerprint.
/// A missing record is a refusal: an older session must not gain a new grant.
pub fn resume_allowed(stored: Option<&str>, next: &str) -> bool {
    stored == Some(next)
}

pub fn session_fingerprint(vault: &Path, provider_session_id: &str) -> Option<String> {
    let map = read_fingerprints(vault);
    map.get(provider_session_id).cloned()
}

pub fn remember_session_fingerprint(
    vault: &Path,
    provider_session_id: &str,
    fingerprint: &str,
) -> Result<(), AppError> {
    if provider_session_id.trim().is_empty() || fingerprint.is_empty() {
        return Ok(());
    }
    let mut map = read_fingerprints(vault);
    map.insert(provider_session_id.to_string(), fingerprint.to_string());
    let path = fingerprint_file(vault);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(&map)?)?;
    Ok(())
}

fn fingerprint_file(vault: &Path) -> PathBuf {
    vault.join(SESSIONS_REL).join(FINGERPRINTS_FILE)
}

fn read_fingerprints(vault: &Path) -> std::collections::BTreeMap<String, String> {
    let Ok(body) = fs::read_to_string(fingerprint_file(vault)) else {
        return std::collections::BTreeMap::new();
    };
    serde_json::from_str(&body).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fingerprint_does_not_resume() {
        assert!(!resume_allowed(None, "abc"));
        assert!(!resume_allowed(Some("old"), "abc"));
        assert!(resume_allowed(Some("abc"), "abc"));
    }

    #[test]
    fn usage_log_keeps_first_seen_uris() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-context-usage-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage.jsonl");
        record_usage(&path, "context_read", &["papers/a.pdf#page=2".into()]).unwrap();
        record_usage(
            &path,
            "context_search",
            &["papers/a.pdf#page=2".into(), "papers/a.pdf#page=4".into()],
        )
        .unwrap();
        assert_eq!(
            read_usage_uris(&path),
            vec![
                "papers/a.pdf#page=2".to_string(),
                "papers/a.pdf#page=4".to_string()
            ]
        );
        let _ = fs::remove_dir_all(dir);
    }
}
