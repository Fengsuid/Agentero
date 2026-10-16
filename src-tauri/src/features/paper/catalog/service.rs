//! Desktop execution adapter for the shared core paper use cases.
//!
//! Holds the single implementation of the `paper_*` command bodies that the
//! remote `remote_paper_*` family mirrors (get / set_tags / set_is_read).
//! Each command resolves its vault target first — local `PathBuf` via
//! `resolve_vault`, remote session work root via `RemoteRegistry` — then
//! calls the same use case here, so validation, error text and catalog
//! writes exist once. The remote shells add their catalog push
//! (`RemoteSession::push_catalog`) around the shared result.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::fs::resolve_vault;
use crate::features::paper::catalog::papers::{self, PaperRecord, PaperTag};
use crate::features::vault::rename::WikiIndex;
use serde::Deserialize;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub use agentero_core::features::paper::catalog::move_paper::PaperMoveResult;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperMoveArgs {
    pub vault_path: String,
    /// Vault-relative item to move (paper folder, org folder, or file under `papers/`).
    pub from_rel: String,
    /// Vault-relative destination parent (`papers` or under `papers/`).
    pub dest_parent_rel: String,
    /// Dirty open Markdown/NOTES paths supplied by the renderer. The Host
    /// rejects a transaction that would move or rewrite one of these files.
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

pub(crate) async fn paper_move_service(
    args: PaperMoveArgs,
    index: Arc<Mutex<WikiIndex>>,
) -> Result<PaperMoveResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = resolve_vault(&args.vault_path)?;
        let mut guard = index
            .lock()
            .map_err(|error| AppError::message(format!("wiki index lock: {error}")))?;
        agentero_core::features::paper::catalog::move_paper::move_with_index(
            &vault,
            &args.from_rel,
            &args.dest_parent_rel,
            &args.dirty_paths,
            &mut guard,
        )
    })
    .await
    .map_err(|error| AppError::message(format!("blocking task failed: {error}")))?
}

/// One-paper lookup behind `paper_get` / `remote_paper_get`: a trimmed `path`
/// wins over `id`; both empty is an error. Wire shapes differ per transport
/// (local `vaultPath`, remote `sessionId`) but validation, lookup and error
/// text are shared, including the `papers::get_by_path` separator
/// normalization.
pub(crate) fn get_paper(
    root: &Path,
    path: Option<&str>,
    id: Option<&str>,
) -> ApiResult<PaperRecord> {
    let result = if let Some(path) = path.map(str::trim).filter(|s| !s.is_empty()) {
        let path = path.trim_matches('/').replace('\\', "/");
        papers::get_by_path(root, &path)
    } else if let Some(id) = id.map(str::trim).filter(|s| !s.is_empty()) {
        papers::get_by_id(root, id)
    } else {
        return map_err(AppError::message("path or id is required"));
    };
    match result {
        Ok(Some(row)) => ApiResult::ok(row),
        Ok(None) => map_err(AppError::message("paper not found in catalog")),
        Err(e) => map_err(e),
    }
}

/// Normalize + validate a command-supplied vault-relative paper path:
/// whitespace trim, strip leading/trailing `/`, `\` → `/`, reject empty.
/// Shared by the set_tags / set_is_read / update_meta command bodies.
pub(crate) fn normalize_paper_path(path: &str) -> Result<String, AppError> {
    let path = path.trim().trim_matches('/').replace('\\', "/");
    if path.is_empty() {
        return Err(AppError::message("path is required"));
    }
    Ok(path)
}

/// Replace tags behind `paper_set_tags` / `remote_paper_set_tags`.
pub(crate) fn set_tags(root: &Path, path: &str, tags: &[PaperTag]) -> ApiResult<PaperRecord> {
    match normalize_paper_path(path).and_then(|path| papers::set_tags(root, &path, tags)) {
        Ok(row) => ApiResult::ok(row),
        Err(e) => map_err(e),
    }
}

/// Set the read flag behind `paper_set_is_read` / `remote_paper_set_is_read`.
pub(crate) fn set_is_read(root: &Path, path: &str, is_read: bool) -> ApiResult<PaperRecord> {
    match normalize_paper_path(path).and_then(|path| papers::set_is_read(root, &path, is_read)) {
        Ok(row) => ApiResult::ok(row),
        Err(e) => map_err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::paper::catalog::{self, papers};
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("papers/inbox/demo")).unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("papers/inbox/demo/NOTES.md"), "# Demo\n").unwrap();
        fs::write(
            root.path().join("notes/source.md"),
            "[[papers/inbox/demo/NOTES]]\n",
        )
        .unwrap();
        papers::upsert_paper(
            root.path(),
            &papers::PaperRecord::local_pdf("demo".into(), "Demo".into())
                .at_path("papers/inbox/demo"),
        )
        .unwrap();
        root
    }

    #[tokio::test]
    async fn desktop_adapter_and_headless_entry_produce_same_move() {
        let desktop = fixture();
        let headless = fixture();
        let index = Arc::new(Mutex::new(WikiIndex::default()));
        let args = |from: &str, dirty_paths: Vec<String>| PaperMoveArgs {
            vault_path: desktop.path().to_string_lossy().into_owned(),
            from_rel: from.into(),
            dest_parent_rel: "papers/archive".into(),
            dirty_paths,
        };
        // The desktop adapter must carry unsaved-editor protection through.
        assert!(paper_move_service(
            args("papers/inbox/demo", vec!["notes/source.md".into()]),
            Arc::clone(&index)
        )
        .await
        .is_err());
        assert!(desktop.path().join("papers/inbox/demo/NOTES.md").is_file());
        let desktop_result =
            paper_move_service(args("papers/inbox/demo", vec![]), Arc::clone(&index))
                .await
                .unwrap();
        let headless_result =
            catalog::move_paper_under(headless.path(), "papers/inbox/demo", "papers/archive")
                .unwrap();
        assert_eq!(desktop_result.new_rel, headless_result);
        for root in [desktop.path(), headless.path()] {
            assert!(root.join("papers/archive/demo/NOTES.md").is_file());
            assert!(!root.join("papers/inbox/demo").exists());
            assert_eq!(
                papers::get_by_path(root, &headless_result)
                    .unwrap()
                    .unwrap()
                    .id,
                "demo"
            );
            assert!(papers::get_by_path(root, "papers/inbox/demo")
                .unwrap()
                .is_none());
            assert_eq!(
                fs::read_to_string(root.join("notes/source.md")).unwrap(),
                "[[papers/archive/demo/NOTES]]\n"
            );
            catalog::evict_catalog_conn(root);
        }
        let noop = paper_move_service(args(&desktop_result.new_rel, vec![]), index)
            .await
            .unwrap();
        assert_eq!(noop.new_rel, desktop_result.new_rel);
        assert!(noop.link_update.updated_sources.is_empty());
    }

    /// Wire-level behavior of the shared `paper_*` / `remote_paper_*` entry
    /// (validation strings, path normalization, catalog writes): the local and
    /// remote commands both delegate here, so this pins the former inline
    /// bodies' semantics for both transports.
    #[test]
    fn shared_paper_entry_keeps_command_semantics() {
        let root = fixture();
        let root = root.path();

        // get: separator/whitespace normalization, id fallback, error text.
        let by_path = get_paper(root, Some(" /papers\\inbox/demo/ "), None);
        assert!(by_path.ok);
        assert_eq!(by_path.data.unwrap().id, "demo");
        assert!(get_paper(root, None, Some(" demo ")).ok);
        assert_eq!(
            get_paper(root, None, None).error.unwrap().message,
            "path or id is required"
        );
        assert_eq!(
            get_paper(root, Some("///"), None).error.unwrap().message,
            "paper not found in catalog"
        );
        assert_eq!(
            get_paper(root, Some("papers/missing"), None)
                .error
                .unwrap()
                .message,
            "paper not found in catalog"
        );

        // set_is_read / set_tags: empty path rejected before any write,
        // normalized path accepted on both.
        assert_eq!(
            set_is_read(root, "  ", true).error.unwrap().message,
            "path is required"
        );
        assert!(
            set_is_read(root, "papers/inbox/demo", true)
                .data
                .unwrap()
                .is_read
        );
        let tagged = set_tags(root, "\\papers\\inbox\\demo", &[papers::PaperTag::new("x")]);
        assert_eq!(tagged.data.unwrap().tags.len(), 1);
        assert!(
            papers::get_by_path(root, "papers/inbox/demo")
                .unwrap()
                .unwrap()
                .is_read
        );
        catalog::evict_catalog_conn(root);
    }
}
