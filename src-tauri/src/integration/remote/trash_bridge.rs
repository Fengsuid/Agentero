//! Recycle bin over remote `VaultFs` (SFTP / local-sim).
//!
//! Eligibility, stored names, manifest types, and batch-id checks come from
//! core `plan_trash`. Files move via rename (copy+remove fallback). Catalog
//! mutations hit the session work mirror, then the existing `cat.push`.

use super::session::{RemoteRegistry, RemoteSession};
use crate::core::error::AppError;
use crate::core::fs::{normalize_rel_separators, VaultFs, WriteOpts};
use crate::features::paper::catalog::papers;
use crate::features::vault::trash::remote_ops::RemoteTrashOps;
use crate::features::vault::trash::{
    delete_trashed_catalog, is_trash_candidate, manifest_write_failed, plan_trash, snapshot_title,
    trash_batch_rel, validate_batch_id, TrashEntry, TrashItem, TrashManifest, TrashResult,
    TRASH_REL,
};
use std::collections::HashMap;
use std::path::Path;

/// Move vault-relative paths into a new remote recycle-bin batch.
pub async fn trash_paths(
    session: &RemoteSession,
    rels: &[String],
) -> Result<TrashResult, AppError> {
    let fs = session.fs.clone();
    let now = chrono::Utc::now();
    let batch_id = format!(
        "{}-{}",
        now.format("%Y%m%dT%H%M%S"),
        now.timestamp_subsec_nanos()
    );

    // Existence is async, so resolve it before the sync plan. An exists error
    // still aborts before any move. Ineligible shapes are not probed.
    let mut present_map = HashMap::new();
    for raw in rels {
        let rel = normalize_rel_separators(raw);
        if !is_trash_candidate(&rel) {
            continue;
        }
        present_map.insert(rel.clone(), fs.exists(&rel).await?);
    }

    let work_root = session.work_root.clone();
    let plan = plan_trash(
        rels,
        &batch_id,
        |rel| present_map.get(rel).copied().unwrap_or(false),
        |rel| papers::list_under_path(&work_root, rel).unwrap_or_default(),
    )?;
    if plan.items.is_empty() {
        return Ok(TrashResult {
            batch_id,
            count: 0,
            rels: Vec::new(),
        });
    }

    let batch_rel = trash_batch_rel(&plan.batch_id);
    let mut items: Vec<TrashItem> = Vec::new();
    for item in plan.items {
        let dest = format!("{batch_rel}/{}", item.stored);
        let _ = fs.mkdir(TRASH_REL).await;
        let _ = fs.mkdir(&batch_rel).await;
        if let Err(e) = move_path(fs.as_ref(), &item.rel, &dest).await {
            // Leave item in place; do not touch catalog for this path.
            log::warn!("remote trash move {} → {dest}: {e}", item.rel);
            continue;
        }
        items.push(item.into());
    }

    if items.is_empty() {
        let _ = fs.remove(&batch_rel, true).await;
        return Ok(TrashResult {
            batch_id,
            count: 0,
            rels: Vec::new(),
        });
    }

    let rels_out: Vec<String> = items.iter().map(|item| item.rel.clone()).collect();
    let manifest = TrashManifest {
        batch_id: plan.batch_id.clone(),
        created_at: crate::core::time::now_rfc3339_millis(),
        items,
    };
    write_manifest(fs.as_ref(), &batch_rel, &manifest)
        .await
        .map_err(|err| manifest_write_failed(&manifest.batch_id, &err))?;
    let catalog_result =
        delete_trashed_catalog(&session.work_root, &manifest.batch_id, &manifest.items);

    // Publish even when a catalog delete failed, so the mirror does not keep
    // a partial delete that the server has not seen. A push failure leaves
    // the batch in place.
    {
        let mut cat = session.catalog.lock().await;
        cat.push(fs.clone()).await?;
    }
    catalog_result?;

    Ok(TrashResult {
        batch_id: manifest.batch_id,
        count: manifest.items.len(),
        rels: rels_out,
    })
}

pub async fn restore_batch(session: &RemoteSession, batch_id: &str) -> Result<usize, AppError> {
    validate_batch_id(batch_id)?;
    let fs = session.fs.clone();
    let batch_rel = trash_batch_rel(batch_id);
    let manifest = read_manifest(fs.as_ref(), &batch_rel).await?;

    for item in &manifest.items {
        if fs.exists(&item.rel).await? {
            return Err(AppError::message(format!(
                "cannot undo: '{}' already exists",
                item.rel
            )));
        }
    }

    for item in &manifest.items {
        let stored = format!("{batch_rel}/{}", item.stored);
        // Ensure parent of original path exists
        if let Some(parent) = Path::new(&item.rel).parent() {
            let p = parent.to_string_lossy().replace('\\', "/");
            if !p.is_empty() && p != "." {
                let _ = fs.mkdir(&p).await;
            }
        }
        move_path(fs.as_ref(), &stored, &item.rel).await?;
        for row in &item.catalog_rows {
            papers::upsert_paper(&session.work_root, row)?;
        }
    }

    let _ = fs.remove(&batch_rel, true).await;
    {
        let mut cat = session.catalog.lock().await;
        cat.push(fs.clone()).await?;
    }
    Ok(manifest.items.len())
}

pub async fn list_trash(session: &RemoteSession) -> Result<Vec<TrashEntry>, AppError> {
    let fs = session.fs.as_ref();
    let mut out: Vec<TrashEntry> = Vec::new();
    if !fs.exists(TRASH_REL).await? {
        return Ok(out);
    }
    let batches = fs.list(TRASH_REL).await.unwrap_or_default();
    for batch in batches {
        if !batch.is_dir {
            continue;
        }
        let batch_rel = trash_batch_rel(&batch.name);
        let Ok(manifest) = read_manifest(fs, &batch_rel).await else {
            continue;
        };
        for item in &manifest.items {
            let stored_path = format!("{batch_rel}/{}", item.stored);
            let is_dir = fs
                .stat(&stored_path)
                .await
                .map(|m| m.is_dir)
                .unwrap_or(false);
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

pub async fn restore_item(
    session: &RemoteSession,
    batch_id: &str,
    stored: &str,
) -> Result<String, AppError> {
    validate_batch_id(batch_id)?;
    let fs = session.fs.clone();
    let batch_rel = trash_batch_rel(batch_id);
    let mut manifest = read_manifest(fs.as_ref(), &batch_rel).await?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;

    if fs.exists(&manifest.items[idx].rel).await? {
        return Err(AppError::message(format!(
            "cannot restore: '{}' already exists",
            manifest.items[idx].rel
        )));
    }

    let item = manifest.items.remove(idx);
    let stored_path = format!("{batch_rel}/{}", item.stored);
    if let Some(parent) = Path::new(&item.rel).parent() {
        let p = parent.to_string_lossy().replace('\\', "/");
        if !p.is_empty() && p != "." {
            let _ = fs.mkdir(&p).await;
        }
    }
    move_path(fs.as_ref(), &stored_path, &item.rel).await?;
    for row in &item.catalog_rows {
        papers::upsert_paper(&session.work_root, row)?;
    }

    if manifest.items.is_empty() {
        let _ = fs.remove(&batch_rel, true).await;
    } else {
        write_manifest(fs.as_ref(), &batch_rel, &manifest).await?;
    }

    {
        let mut cat = session.catalog.lock().await;
        cat.push(fs.clone()).await?;
    }
    Ok(item.rel)
}

pub async fn purge_item(
    session: &RemoteSession,
    batch_id: &str,
    stored: &str,
) -> Result<(), AppError> {
    validate_batch_id(batch_id)?;
    let fs = session.fs.as_ref();
    let batch_rel = trash_batch_rel(batch_id);
    let mut manifest = read_manifest(fs, &batch_rel).await?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;
    let item = manifest.items.remove(idx);
    let stored_path = format!("{batch_rel}/{}", item.stored);
    let _ = fs.remove(&stored_path, true).await;
    if manifest.items.is_empty() {
        let _ = fs.remove(&batch_rel, true).await;
    } else {
        write_manifest(fs, &batch_rel, &manifest).await?;
    }
    Ok(())
}

pub async fn purge_all(session: &RemoteSession) -> Result<(), AppError> {
    let fs = session.fs.as_ref();
    if fs.exists(TRASH_REL).await? {
        fs.remove(TRASH_REL, true).await?;
    }
    Ok(())
}

async fn read_manifest(fs: &dyn VaultFs, batch_rel: &str) -> Result<TrashManifest, AppError> {
    let path = format!("{batch_rel}/manifest.json");
    let bytes = fs
        .read(&path)
        .await
        .map_err(|_| AppError::message("trash batch not found"))?;
    let raw = String::from_utf8(bytes).map_err(|e| AppError::message(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| AppError::message(e.to_string()))
}

async fn write_manifest(
    fs: &dyn VaultFs,
    batch_rel: &str,
    manifest: &TrashManifest,
) -> Result<(), AppError> {
    let json =
        serde_json::to_string_pretty(manifest).map_err(|e| AppError::message(e.to_string()))?;
    let path = format!("{batch_rel}/manifest.json");
    fs.write(
        &path,
        json.as_bytes(),
        WriteOpts {
            create_parents: true,
        },
    )
    .await
}

/// Rename when possible; otherwise copy tree then remove source.
async fn move_path(fs: &dyn VaultFs, from: &str, to: &str) -> Result<(), AppError> {
    match fs.rename(from, to).await {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            log::debug!("remote rename {from} → {to} failed ({rename_err}); copy fallback");
            copy_tree(fs, from, to).await?;
            fs.remove(from, true).await?;
            Ok(())
        }
    }
}

async fn copy_tree(fs: &dyn VaultFs, from: &str, to: &str) -> Result<(), AppError> {
    let meta = fs.stat(from).await?;
    if meta.is_dir {
        fs.mkdir(to).await?;
        let entries = fs.list(from).await?;
        for e in entries {
            let child_from = if from.is_empty() {
                e.name.clone()
            } else {
                format!("{from}/{}", e.name)
            };
            let child_to = format!("{to}/{}", e.name);
            Box::pin(copy_tree(fs, &child_from, &child_to)).await?;
        }
        Ok(())
    } else {
        let bytes = fs.read(from).await?;
        fs.write(
            to,
            &bytes,
            WriteOpts {
                create_parents: true,
            },
        )
        .await
    }
}

#[async_trait::async_trait]
impl RemoteTrashOps for RemoteRegistry {
    async fn trash_paths_remote(
        &self,
        session_id: &str,
        rels: &[String],
    ) -> Result<TrashResult, AppError> {
        let session = self.get(session_id).await?;
        trash_paths(&session, rels).await
    }

    async fn list_trash_remote(&self, session_id: &str) -> Result<Vec<TrashEntry>, AppError> {
        let session = self.get(session_id).await?;
        list_trash(&session).await
    }

    async fn purge_all_remote(&self, session_id: &str) -> Result<(), AppError> {
        let session = self.get(session_id).await?;
        purge_all(&session).await
    }

    async fn restore_item_remote(
        &self,
        session_id: &str,
        batch_id: &str,
        stored: &str,
    ) -> Result<String, AppError> {
        let session = self.get(session_id).await?;
        restore_item(&session, batch_id, stored).await
    }

    async fn purge_item_remote(
        &self,
        session_id: &str,
        batch_id: &str,
        stored: &str,
    ) -> Result<(), AppError> {
        let session = self.get(session_id).await?;
        purge_item(&session, batch_id, stored).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs::WriteOpts;
    use crate::features::paper::catalog::papers::PaperRecord;
    use crate::integration::remote::session::{RemoteRegistry, LOCAL_SIM_HOST};
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
            tags: vec![],
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
            openreview_url: None,
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

    #[tokio::test]
    async fn local_sim_trash_restore_roundtrip() {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("agentero-remote-trash-{n}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("papers/x")).unwrap();
        std::fs::write(root.join("papers/x/NOTES.md"), "# x\n").unwrap();
        std::fs::create_dir_all(root.join(".agentero")).unwrap();

        let reg = RemoteRegistry::new();
        let info = reg
            .connect(LOCAL_SIM_HOST, None, &root.to_string_lossy())
            .await
            .expect("connect");
        let session = reg.get(&info.session_id).await.unwrap();

        papers::upsert_paper(&session.work_root, &sample_record("papers/x", "x")).unwrap();
        {
            let mut cat = session.catalog.lock().await;
            cat.push(session.fs.clone()).await.unwrap();
        }

        let res = trash_paths(&session, &["papers/x".into()])
            .await
            .expect("trash");
        assert_eq!(res.count, 1);
        assert!(!session.fs.exists("papers/x").await.unwrap());
        assert!(papers::get_by_path(&session.work_root, "papers/x")
            .unwrap()
            .is_none());

        let listed = list_trash(&session).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].rel, "papers/x");

        let n = restore_batch(&session, &res.batch_id).await.unwrap();
        assert_eq!(n, 1);
        assert!(session.fs.exists("papers/x/NOTES.md").await.unwrap());
        assert!(papers::get_by_path(&session.work_root, "papers/x")
            .unwrap()
            .is_some());

        // trash file then purge
        session
            .fs
            .write(
                "notes/a.md",
                b"hi",
                WriteOpts {
                    create_parents: true,
                },
            )
            .await
            .unwrap();
        let res2 = trash_paths(&session, &["notes/a.md".into()]).await.unwrap();
        assert_eq!(res2.count, 1);
        purge_all(&session).await.unwrap();
        assert!(list_trash(&session).await.unwrap().is_empty());

        reg.disconnect(&info.session_id).await.unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
