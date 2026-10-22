//! Vault recycle bin, shared by the local filesystem and the remote `VaultFs`
//! executor.
//!
//! Deleting an item moves it into `.agentero/.trash/<batchId>/` together with a
//! `manifest.json` that records each item's original vault-relative path and a
//! snapshot of the catalog rows removed for it. This makes a delete fully
//! undoable — files move back and catalog rows are re-inserted — without
//! depending on platform-specific OS trash restore.
//!
//! [`plan_trash`] decides eligibility, stored names, and catalog snapshots.
//! Each executor performs its own move, manifest write, and catalog delete.

use crate::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord};
use crate::fs::normalize_rel_separators;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Vault-relative location of the recycle bin (hidden from the file tree,
/// which skips dot-entries). Components are `/`-separated for `VaultFs`.
pub const TRASH_REL: &str = ".agentero/.trash";

/// One manifest entry. Field names stay camelCase so existing `manifest.json`
/// files still deserialize.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    /// Original vault-relative path the item lived at.
    pub rel: String,
    /// Basename of the stored copy inside the batch directory.
    pub stored: String,
    /// Catalog rows removed for this item (empty when not under `papers/`).
    #[serde(default)]
    pub catalog_rows: Vec<PaperRecord>,
}

/// Recycle-bin batch manifest (`manifest.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashManifest {
    pub batch_id: String,
    pub created_at: String,
    pub items: Vec<TrashItem>,
}

/// One eligible path in a [`TrashPlan`], including the catalog snapshot taken
/// before any file move or catalog delete.
#[derive(Debug, Clone)]
pub struct TrashPlanItem {
    pub rel: String,
    pub stored: String,
    pub catalog_rows: Vec<PaperRecord>,
}

/// Pure trash decision: which rels to move, under which stored names.
#[derive(Debug, Clone)]
pub struct TrashPlan {
    pub batch_id: String,
    pub items: Vec<TrashPlanItem>,
}

impl From<TrashPlanItem> for TrashItem {
    fn from(item: TrashPlanItem) -> Self {
        Self {
            rel: item.rel,
            stored: item.stored,
            catalog_rows: item.catalog_rows,
        }
    }
}

/// Result of a trash operation returned to the UI.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    /// Batch id used to undo (restore) the whole delete.
    pub batch_id: String,
    /// Number of items actually moved into the recycle bin.
    pub count: usize,
    /// Vault-relative paths actually moved (subset of the requested rels).
    pub rels: Vec<String>,
}

/// One item in the recycle bin (flattened across batches) for the UI list.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// Stable id: "{batchId}::{stored}".
    pub id: String,
    pub batch_id: String,
    pub stored: String,
    /// Original vault-relative path.
    pub rel: String,
    /// Basename for display.
    pub name: String,
    /// Paper title when the item snapshots exactly one catalog row (a paper
    /// directory); `None` for plain files or folders holding several papers.
    pub title: Option<String>,
    pub deleted_at: String,
    pub is_dir: bool,
}

/// Display title for a trashed item: the catalog title when the snapshot holds
/// a single paper row, otherwise `None` (caller falls back to the basename).
pub fn snapshot_title(rows: &[PaperRecord]) -> Option<String> {
    if rows.len() != 1 {
        return None;
    }
    let title = rows[0].title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn is_under_papers(rel: &str) -> bool {
    rel == "papers" || rel.starts_with("papers/")
}

/// Reject batch ids that would escape `.agentero/.trash/` or add path segments.
/// Both `/` and `\` are rejected so a Windows join cannot split the id.
pub fn validate_batch_id(batch_id: &str) -> Result<(), AppError> {
    if batch_id.is_empty()
        || batch_id.contains('/')
        || batch_id.contains('\\')
        || batch_id.contains("..")
    {
        return Err(AppError::message("invalid batch id"));
    }
    Ok(())
}

/// Vault-relative batch directory (`.agentero/.trash/<batch_id>`), using `/`.
/// `batch_id` must already have passed [`validate_batch_id`]. Local executors
/// join [`TRASH_REL`] and the id with `Path::join` instead of concatenating an
/// absolute vault path.
pub fn trash_batch_rel(batch_id: &str) -> String {
    format!("{TRASH_REL}/{batch_id}")
}

/// Shape check on an already separator-normalized rel, before the existence
/// probe. Matches local trash: empty, the `papers` root, any rel containing
/// `..`, and anything whose path starts with `.agentero` (including the
/// directory itself).
pub fn is_trash_candidate(rel: &str) -> bool {
    !rel.is_empty() && rel != "papers" && !rel.contains("..") && !rel.starts_with(".agentero")
}

/// Manifest write failed after files were moved. The message includes the
/// batch id so a later restore can find `.agentero/.trash/<batch_id>/`.
/// Callers must not delete the moved files.
pub fn manifest_write_failed(batch_id: &str, err: &impl std::fmt::Display) -> AppError {
    AppError::message(format!(
        "trash manifest write failed; moved files remain in .agentero/.trash/{batch_id}: {err}"
    ))
}

/// Decide which rels are eligible and their stored names.
///
/// `present` reports whether a normalized rel exists. `rows_for` supplies the
/// catalog snapshot for a rel under `papers/` (the caller loads it). Skips
/// empty rels, the `papers` root, any rel containing `..`, anything under
/// `.agentero`, and rels `present` says are missing. Stored names keep the
/// request index (`{i}__{basename}`) so two items that share a basename stay
/// distinct. Local and remote skip rules already matched; this does not drop
/// a path the local command trashes.
///
/// Failure point for both executors (this function does not touch the
/// filesystem): an invalid batch id returns here, before any move. After
/// moves, a manifest write failure returns [`manifest_write_failed`] and
/// leaves the files in the batch. Catalog `delete_under_path` runs only after
/// that manifest is stored, via [`delete_trashed_catalog`]; a catalog error
/// also returns `Err` and leaves the batch in place so restore can replay it.
/// Both sides used to ignore per-item catalog delete errors (remote still
/// aborted later if `cat.push` failed, without rolling files back). Remote
/// catalog publish stays in the existing `trash_paths` `cat.push` call.
pub fn plan_trash<P, R>(
    rels: &[String],
    batch_id: &str,
    mut present: P,
    mut rows_for: R,
) -> Result<TrashPlan, AppError>
where
    P: FnMut(&str) -> bool,
    R: FnMut(&str) -> Vec<PaperRecord>,
{
    validate_batch_id(batch_id)?;
    let mut items = Vec::new();
    for (i, raw) in rels.iter().enumerate() {
        let rel = normalize_rel_separators(raw);
        if !is_trash_candidate(&rel) || !present(&rel) {
            continue;
        }
        let base = Path::new(&rel)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("item")
            .to_string();
        let catalog_rows = if is_under_papers(&rel) {
            rows_for(&rel)
        } else {
            Vec::new()
        };
        items.push(TrashPlanItem {
            rel,
            stored: format!("{i}__{base}"),
            catalog_rows,
        });
    }
    // Snapshots are taken before any delete. A parent requested together with
    // a child would otherwise keep the child's rows; give each row to the
    // longest planned path that covers it.
    retain_rows_for_deepest_item(&mut items);
    Ok(TrashPlan {
        batch_id: batch_id.to_string(),
        items,
    })
}

/// `row_path` is `rel` or a descendant (`rel/...`), not a sibling with a shared prefix.
fn path_covers(rel: &str, row_path: &str) -> bool {
    row_path == rel || row_path.starts_with(&format!("{rel}/"))
}

fn retain_rows_for_deepest_item(items: &mut [TrashPlanItem]) {
    let rels: Vec<String> = items.iter().map(|item| item.rel.clone()).collect();
    for item in items.iter_mut() {
        item.catalog_rows.retain(|row| {
            rels.iter()
                .filter(|rel| path_covers(rel, &row.path))
                .max_by_key(|rel| rel.len())
                .is_some_and(|owner| owner == &item.rel)
        });
    }
}

/// Delete catalog rows for papers whose files are already in the trash batch.
/// Runs only after the manifest is on disk. On failure the batch is left in
/// place (no file rollback) and the error names `batch_id`.
pub fn delete_trashed_catalog(
    vault_root: &Path,
    batch_id: &str,
    items: &[TrashItem],
) -> Result<(), AppError> {
    let mut first_error = None;
    for item in items {
        if !is_under_papers(&item.rel) {
            continue;
        }
        if let Err(err) = papers::delete_under_path(vault_root, &item.rel) {
            if first_error.is_none() {
                first_error = Some(AppError::domain(
                    "trash_catalog",
                    format!(
                        "trash catalog update failed for batch {batch_id}; files remain in .agentero/.trash/{batch_id}: {err}"
                    ),
                ));
            }
        }
    }
    match first_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

fn read_manifest(batch_dir: &Path) -> Result<TrashManifest, AppError> {
    let raw = fs::read_to_string(batch_dir.join("manifest.json"))
        .map_err(|_| AppError::message("trash batch not found"))?;
    serde_json::from_str(&raw).map_err(|e| AppError::message(e.to_string()))
}

fn write_manifest(batch_dir: &Path, manifest: &TrashManifest) -> Result<(), AppError> {
    let json =
        serde_json::to_string_pretty(manifest).map_err(|e| AppError::message(e.to_string()))?;
    fs::write(batch_dir.join("manifest.json"), json)?;
    Ok(())
}

/// Move the given vault-relative paths into a new recycle-bin batch.
///
/// Eligibility and catalog snapshots come from [`plan_trash`]. For anything
/// under `papers/`, catalog rows are removed only after the manifest is stored
/// so a failed manifest write does not hide the paper while its files sit in
/// an unrecorded batch. Both are restored on [`restore_batch`].
pub fn trash_paths(vault_root: &Path, rels: &[String]) -> Result<TrashResult, AppError> {
    crate::fs::ensure_vault_dir(vault_root)?;
    let now = chrono::Utc::now();
    let batch_id = format!(
        "{}-{}",
        now.format("%Y%m%dT%H%M%S"),
        now.timestamp_subsec_nanos()
    );
    let plan = plan_trash(
        rels,
        &batch_id,
        |rel| vault_root.join(rel).exists(),
        |rel| papers::list_under_path(vault_root, rel).unwrap_or_default(),
    )?;
    if plan.items.is_empty() {
        return Ok(TrashResult {
            batch_id,
            count: 0,
            rels: Vec::new(),
        });
    }

    // Join the trash root and the batch id as path components. The id has
    // already rejected `/` and `\`, so it cannot add another segment.
    let batch_dir = vault_root.join(TRASH_REL).join(&plan.batch_id);
    let mut items: Vec<TrashItem> = Vec::new();
    for item in plan.items {
        if fs::create_dir_all(&batch_dir).is_err() {
            continue;
        }
        let abs = vault_root.join(&item.rel);
        if fs::rename(&abs, batch_dir.join(&item.stored)).is_err() {
            // Leave the item in place and the catalog untouched.
            continue;
        }
        items.push(item.into());
    }

    if items.is_empty() {
        // Nothing moved — drop the (possibly created) empty batch dir.
        let _ = fs::remove_dir(&batch_dir);
        return Ok(TrashResult {
            batch_id,
            count: 0,
            rels: Vec::new(),
        });
    }

    let rels_out: Vec<String> = items.iter().map(|item| item.rel.clone()).collect();
    let manifest = TrashManifest {
        batch_id: plan.batch_id.clone(),
        created_at: crate::time::now_rfc3339_millis(),
        items,
    };
    write_manifest(&batch_dir, &manifest)
        .map_err(|err| manifest_write_failed(&manifest.batch_id, &err))?;
    delete_trashed_catalog(vault_root, &manifest.batch_id, &manifest.items)?;

    Ok(TrashResult {
        batch_id: manifest.batch_id,
        count: manifest.items.len(),
        rels: rels_out,
    })
}

/// Result of a delete request (trash or permanent).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub permanent: bool,
    /// Present for recycle-bin deletes; `None` for permanent deletes.
    pub batch_id: Option<String>,
    pub count: usize,
    pub paths: Vec<String>,
    /// Catalog rows removed under `papers/` (permanent deletes only).
    pub removed_rows: usize,
}

/// Delete vault paths either into the recycle bin (default, undoable) or
/// permanently. Shared by CLI `paper delete` and MCP `file_delete`.
pub fn delete_paths(
    vault_root: &Path,
    rels: &[String],
    permanent: bool,
) -> Result<DeleteResult, AppError> {
    if !permanent {
        let result = trash_paths(vault_root, rels)?;
        return Ok(DeleteResult {
            permanent: false,
            batch_id: Some(result.batch_id),
            count: result.count,
            paths: result.rels,
            removed_rows: 0,
        });
    }

    crate::fs::ensure_vault_dir(vault_root)?;
    let root = vault_root.canonicalize()?;
    let mut clean: Vec<(String, std::path::PathBuf, bool)> = Vec::new();
    for raw in rels {
        let rel = crate::fs::normalize_rel_separators(raw);
        let rel = rel.trim_matches('/');
        if rel.is_empty() {
            continue;
        }
        if rel == "papers"
            || rel == ".agentero"
            || rel.starts_with(".agentero/")
            || rel.split('/').any(|s| s == "..")
        {
            return Err(AppError::message(format!(
                "cannot permanently delete protected path: {rel}"
            )));
        }
        let abs = vault_root.join(rel);
        let meta = fs::symlink_metadata(&abs)
            .map_err(|_| AppError::message(format!("path not found: {rel}")))?;
        let resolved = abs.canonicalize()?;
        if !resolved.starts_with(&root) {
            return Err(AppError::message(format!("path escapes vault root: {rel}")));
        }
        clean.push((rel.to_string(), abs, meta.is_dir()));
    }
    if clean.is_empty() {
        return Err(AppError::message("paths is required"));
    }

    let mut removed_rows = 0usize;
    let mut paths = Vec::new();
    for (rel, abs, is_dir) in clean {
        removed_rows += papers::delete_under_path(vault_root, &rel)?;
        if is_dir {
            fs::remove_dir_all(&abs)?;
        } else {
            fs::remove_file(&abs)?;
        }
        paths.push(rel);
    }
    Ok(DeleteResult {
        permanent: true,
        batch_id: None,
        count: paths.len(),
        paths,
        removed_rows,
    })
}

/// Restore a recycle-bin batch: move files back and re-insert catalog rows.
///
/// Aborts without changes if any original path has since been re-created, so a
/// restore never clobbers newer content.
pub fn restore_batch(vault_root: &Path, batch_id: &str) -> Result<usize, AppError> {
    crate::fs::ensure_vault_dir(vault_root)?;
    validate_batch_id(batch_id)?;
    let batch_dir = vault_root.join(TRASH_REL).join(batch_id);
    let manifest = read_manifest(&batch_dir)?;

    // Pre-check: never overwrite a path that has reappeared since deletion.
    for item in &manifest.items {
        if vault_root.join(&item.rel).exists() {
            return Err(AppError::message(format!(
                "cannot undo: '{}' already exists",
                item.rel
            )));
        }
    }

    for item in &manifest.items {
        let target = vault_root.join(&item.rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(batch_dir.join(&item.stored), &target)?;
        for row in &item.catalog_rows {
            papers::upsert_paper(vault_root, row)?;
        }
    }

    let _ = fs::remove_dir_all(&batch_dir);
    Ok(manifest.items.len())
}

/// List every item currently in the recycle bin, newest batch first.
pub fn list_trash(vault_root: &Path) -> Result<Vec<TrashEntry>, AppError> {
    let root = vault_root.join(TRASH_REL);
    let mut out: Vec<TrashEntry> = Vec::new();
    let Ok(read) = fs::read_dir(&root) else {
        return Ok(out);
    };
    for ent in read.flatten() {
        let batch_dir = ent.path();
        if !batch_dir.is_dir() {
            continue;
        }
        let Ok(manifest) = read_manifest(&batch_dir) else {
            continue;
        };
        for item in &manifest.items {
            let is_dir = batch_dir.join(&item.stored).is_dir();
            let name = Path::new(&item.rel)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(item.rel.as_str())
                .to_string();
            out.push(TrashEntry {
                id: format!("{}::{}", manifest.batch_id, item.stored),
                batch_id: manifest.batch_id.clone(),
                stored: item.stored.clone(),
                rel: item.rel.clone(),
                name,
                title: snapshot_title(&item.catalog_rows),
                deleted_at: manifest.created_at.clone(),
                is_dir,
            });
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

/// Restore a single recycle-bin item to its original path (files + catalog rows).
/// Aborts if the original path has reappeared. Returns the restored rel path.
pub fn restore_item(vault_root: &Path, batch_id: &str, stored: &str) -> Result<String, AppError> {
    crate::fs::ensure_vault_dir(vault_root)?;
    validate_batch_id(batch_id)?;
    let batch_dir = vault_root.join(TRASH_REL).join(batch_id);
    let mut manifest = read_manifest(&batch_dir)?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;

    let target = vault_root.join(&manifest.items[idx].rel);
    if target.exists() {
        return Err(AppError::message(format!(
            "cannot restore: '{}' already exists",
            manifest.items[idx].rel
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let item = manifest.items.remove(idx);
    fs::rename(batch_dir.join(&item.stored), &target)?;
    for row in &item.catalog_rows {
        papers::upsert_paper(vault_root, row)?;
    }
    if manifest.items.is_empty() {
        let _ = fs::remove_dir_all(&batch_dir);
    } else {
        write_manifest(&batch_dir, &manifest)?;
    }
    Ok(item.rel)
}

/// Permanently delete a single recycle-bin item.
pub fn purge_item(vault_root: &Path, batch_id: &str, stored: &str) -> Result<(), AppError> {
    crate::fs::ensure_vault_dir(vault_root)?;
    validate_batch_id(batch_id)?;
    let batch_dir = vault_root.join(TRASH_REL).join(batch_id);
    let mut manifest = read_manifest(&batch_dir)?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;
    let item = manifest.items.remove(idx);
    let stored_path = batch_dir.join(&item.stored);
    if stored_path.is_dir() {
        let _ = fs::remove_dir_all(&stored_path);
    } else {
        let _ = fs::remove_file(&stored_path);
    }
    if manifest.items.is_empty() {
        let _ = fs::remove_dir_all(&batch_dir);
    } else {
        write_manifest(&batch_dir, &manifest)?;
    }
    Ok(())
}

/// Empty the entire recycle bin (permanent).
pub fn purge_all(vault_root: &Path) -> Result<(), AppError> {
    let root = vault_root.join(TRASH_REL);
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn sample_record(path: &str, id: &str) -> PaperRecord {
        PaperRecord {
            path: path.into(),
            id: id.into(),
            paper_type: papers::PaperKind::Doi,
            title: "T".into(),
            authors: vec![],
            creators: None,
            year: None,
            date: None,
            abstract_text: None,
            tags: vec![crate::features::catalog::papers::PaperTag::new("NLP")],
            arxiv_id: None,
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: None,
            html_url: None,
            source_url: None,
            code_repo: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            added_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn plan_trash_skips_and_disambiguates_stored_names() {
        let rels = vec![
            String::new(),
            "papers".into(),
            "papers/../secret".into(),
            ".agentero/catalog.sqlite".into(),
            ".agentero".into(),
            "missing.md".into(),
            "notes/a.md".into(),
            "other/a.md".into(),
            "papers/x".into(),
            // `contains("..")` matches the local command, including this name.
            "notes..md".into(),
            r"papers\y".into(),
            // Not a `.agentero` prefix, so the local command trashes it.
            "notes/.agentero".into(),
        ];
        let present = [
            "notes/a.md",
            "other/a.md",
            "papers/x",
            "papers/y",
            "notes..md",
            "notes/.agentero",
        ];
        let mut present_calls = Vec::new();
        let mut row_calls = Vec::new();
        let plan = plan_trash(
            &rels,
            "batch-1",
            |rel| {
                present_calls.push(rel.to_string());
                present.contains(&rel)
            },
            |rel| {
                row_calls.push(rel.to_string());
                vec![sample_record(rel, "id")]
            },
        )
        .unwrap();

        let got: Vec<_> = plan
            .items
            .iter()
            .map(|item| {
                (
                    item.rel.as_str(),
                    item.stored.as_str(),
                    item.catalog_rows.len(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("notes/a.md", "6__a.md", 0),
                ("other/a.md", "7__a.md", 0),
                ("papers/x", "8__x", 1),
                ("papers/y", "10__y", 1),
                ("notes/.agentero", "11__.agentero", 0),
            ]
        );
        assert_eq!(plan.batch_id, "batch-1");
        // Skipped shapes are not probed; missing.md is probed and rejected.
        assert!(present_calls.contains(&"missing.md".to_string()));
        assert!(!present_calls.iter().any(|rel| rel.contains("..")));
        assert!(!present_calls.iter().any(|rel| rel.starts_with(".agentero")));
        assert_eq!(
            row_calls,
            vec!["papers/x".to_string(), "papers/y".to_string()]
        );
        assert_eq!(plan.items[2].catalog_rows[0].title, "T");
    }

    #[test]
    fn plan_trash_assigns_nested_rows_to_the_deeper_item() {
        let rels = vec!["papers/group/paperA".into(), "papers/group".into()];
        let plan = plan_trash(
            &rels,
            "batch-1",
            |_| true,
            |rel| {
                if rel == "papers/group" {
                    vec![
                        sample_record("papers/group/paperA", "a"),
                        sample_record("papers/group/paperB", "b"),
                    ]
                } else {
                    vec![sample_record("papers/group/paperA", "a")]
                }
            },
        )
        .unwrap();

        let child = plan
            .items
            .iter()
            .find(|item| item.rel == "papers/group/paperA")
            .expect("child item");
        assert_eq!(child.catalog_rows.len(), 1);
        assert_eq!(child.catalog_rows[0].path, "papers/group/paperA");

        let group = plan
            .items
            .iter()
            .find(|item| item.rel == "papers/group")
            .expect("group item");
        let paths: Vec<_> = group
            .catalog_rows
            .iter()
            .map(|row| row.path.as_str())
            .collect();
        assert_eq!(paths, vec!["papers/group/paperB"]);
    }

    #[test]
    fn plan_trash_rejects_batch_id_before_callbacks() {
        for bad in ["", "a/b", r"a\b", "..", "batch/../x", "foo..bar"] {
            let called = std::cell::Cell::new(false);
            let err = plan_trash(
                &["notes/a.md".into()],
                bad,
                |_| {
                    called.set(true);
                    true
                },
                |_| {
                    called.set(true);
                    Vec::new()
                },
            )
            .unwrap_err();
            assert!(!called.get(), "callbacks ran for {bad}");
            assert!(err.to_string().contains("invalid batch id"), "{bad}: {err}");
        }
        let empty = plan_trash(&[], "20261022T130000-1", |_| true, |_| Vec::new()).unwrap();
        assert!(empty.items.is_empty());
        assert!(validate_batch_id("ok-id").is_ok());
    }

    #[test]
    fn manifest_roundtrips_camel_case() {
        let raw = r#"{
            "batchId": "20260101T000000-1",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "items": [{ "rel": "notes/a.md", "stored": "0__a.md" }]
        }"#;
        let manifest: TrashManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(manifest.batch_id, "20260101T000000-1");
        assert_eq!(manifest.created_at, "2026-01-01T00:00:00.000Z");
        assert_eq!(manifest.items[0].rel, "notes/a.md");
        assert_eq!(manifest.items[0].stored, "0__a.md");
        assert!(manifest.items[0].catalog_rows.is_empty());

        let json = serde_json::to_value(&manifest).unwrap();
        assert!(json.get("batchId").is_some());
        assert!(json.get("batch_id").is_none());
        assert!(json["items"][0].get("catalogRows").is_some());
        assert!(json["items"][0].get("catalog_rows").is_none());
    }

    #[test]
    fn trash_and_restore_roundtrip() {
        let dir = env::temp_dir().join(format!("agentero-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paper_dir = dir.join("papers").join("x");
        fs::create_dir_all(&paper_dir).unwrap();
        fs::write(paper_dir.join("NOTES.md"), "# hi\n").unwrap();
        papers::upsert_paper(&dir, &sample_record("papers/x", "x")).unwrap();

        // Trash: files move out, catalog row gone.
        let res = trash_paths(&dir, &["papers/x".to_string()]).unwrap();
        assert_eq!(res.count, 1);
        assert!(!paper_dir.exists());
        assert!(papers::get_by_path(&dir, "papers/x").unwrap().is_none());

        // Restore: files back, catalog row re-inserted.
        let restored = restore_batch(&dir, &res.batch_id).unwrap();
        assert_eq!(restored, 1);
        assert!(paper_dir.join("NOTES.md").exists());
        assert!(papers::get_by_path(&dir, "papers/x").unwrap().is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_reports_paper_title() {
        let dir = env::temp_dir().join(format!("agentero-trash-title-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paper_dir = dir.join("papers").join("2501.00001");
        fs::create_dir_all(&paper_dir).unwrap();
        fs::write(paper_dir.join("NOTES.md"), "# hi\n").unwrap();
        papers::upsert_paper(&dir, &sample_record("papers/2501.00001", "2501.00001")).unwrap();
        let notes = dir.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("a.md"), "a\n").unwrap();

        let res = trash_paths(
            &dir,
            &["papers/2501.00001".to_string(), "notes/a.md".to_string()],
        )
        .unwrap();
        assert_eq!(res.count, 2);

        let items = list_trash(&dir).unwrap();
        let paper = items.iter().find(|e| e.rel == "papers/2501.00001").unwrap();
        // Paper entries surface the snapshotted catalog title for display.
        assert_eq!(paper.title.as_deref(), Some("T"));
        let note = items.iter().find(|e| e.rel == "notes/a.md").unwrap();
        assert!(note.title.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_aborts_when_path_reappears() {
        let dir = env::temp_dir().join(format!("agentero-trash-conflict-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let note = dir.join("notes");
        fs::create_dir_all(&note).unwrap();
        fs::write(note.join("a.md"), "one\n").unwrap();

        let res = trash_paths(&dir, &["notes/a.md".to_string()]).unwrap();
        assert_eq!(res.count, 1);
        // A new file reoccupies the path.
        fs::write(note.join("a.md"), "two\n").unwrap();

        assert!(restore_batch(&dir, &res.batch_id).is_err());
        // The reoccupying file is untouched.
        assert_eq!(fs::read_to_string(note.join("a.md")).unwrap(), "two\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_paths_supports_trash_and_permanent_modes() {
        let dir = env::temp_dir().join(format!("agentero-delete-mode-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("notes/a.md"), "a\n").unwrap();

        let trashed = delete_paths(&dir, &["notes/a.md".into()], false).unwrap();
        assert!(!trashed.permanent);
        assert!(trashed.batch_id.is_some());
        assert_eq!(trashed.count, 1);
        assert!(restore_batch(&dir, trashed.batch_id.as_deref().unwrap()).is_ok());

        let deleted = delete_paths(&dir, &["notes/a.md".into()], true).unwrap();
        assert!(deleted.permanent);
        assert!(deleted.batch_id.is_none());
        assert!(!dir.join("notes/a.md").exists());
        assert!(delete_paths(&dir, &["papers".into()], true).is_err());
        assert!(delete_paths(&dir, &[".agentero/x".into()], true).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_restore_and_purge_items() {
        let dir = env::temp_dir().join(format!("agentero-trash-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let notes = dir.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("a.md"), "a\n").unwrap();
        fs::write(notes.join("b.md"), "b\n").unwrap();

        // One batch with two items.
        let res = trash_paths(&dir, &["notes/a.md".to_string(), "notes/b.md".to_string()]).unwrap();
        assert_eq!(res.count, 2);
        assert_eq!(list_trash(&dir).unwrap().len(), 2);

        // Restore one item; the other stays in the bin.
        let a = list_trash(&dir)
            .unwrap()
            .into_iter()
            .find(|e| e.rel == "notes/a.md")
            .unwrap();
        restore_item(&dir, &a.batch_id, &a.stored).unwrap();
        assert!(notes.join("a.md").exists());
        assert_eq!(list_trash(&dir).unwrap().len(), 1);

        // Purge the remaining item; the bin becomes empty.
        let b = list_trash(&dir).unwrap().into_iter().next().unwrap();
        purge_item(&dir, &b.batch_id, &b.stored).unwrap();
        assert!(list_trash(&dir).unwrap().is_empty());
        assert!(!notes.join("b.md").exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
