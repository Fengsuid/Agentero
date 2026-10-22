//! The only authority available to plugin JavaScript. Never forwards arbitrary IPC.
use super::*;
use agentero_core::{
    features::paper::catalog::papers,
    fs::{atomic_write, sanitize_vault_rel},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use tauri::Emitter;

type Reply = Result<Value, String>;
fn encode(value: impl Serialize) -> Reply {
    serde_json::to_value(value).map_err(|e| e.to_string())
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 131072)
        .ok_or_else(|| format!("plugin_invalid_argument: {key}"))
}
fn fields(args: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = args.as_object().ok_or("plugin_invalid_arguments")?;
    if object.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("plugin_invalid_arguments".into());
    }
    Ok(())
}
fn revision(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}
fn paper(vault: &Path, args: &Value) -> Result<papers::PaperRecord, String> {
    match papers::lookup_paper_ref(vault, text(args, "ref")?).map_err(|e| e.to_string())? {
        papers::PaperRefLookup::Found(row) => Ok(*row),
        papers::PaperRefLookup::NotFound => Err("paper_not_found".into()),
        _ => Err("paper_ambiguous".into()),
    }
}
fn projection(row: papers::PaperRecord) -> Value {
    json!({"id":row.id,"path":row.path,"title":row.title,"authors":row.authors,"year":row.year,
        "abstract":row.abstract_text,"isRead":row.is_read,"tags":row.tags})
}
/// Reject hidden/managed paths and symlink traversal, including missing write targets.
fn target(root: &Path, raw: &str) -> Result<PathBuf, String> {
    if raw.starts_with(['/', '\\']) || raw.contains(':') {
        return Err("plugin_invalid_path".into());
    }
    let rel = sanitize_vault_rel(raw)?;
    let mut path = root.to_path_buf();
    for segment in rel.split('/') {
        if segment.starts_with('.') || segment.eq_ignore_ascii_case("AGENTS.md") {
            return Err("plugin_managed_path".into());
        }
        path.push(segment);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => return Err("plugin_symlink_denied".into()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(path)
}
fn read_text(path: &Path) -> Result<String, String> {
    match fs::metadata(path) {
        Ok(meta) if meta.len() > 128 * 1024 => return Err("plugin_text_limit".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
        _ => {}
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}
fn write_guard(
    loaded: &Loaded,
    app: &tauri::AppHandle,
    blocked: &[String],
    rel: &str,
) -> Result<(), String> {
    if loaded.cancel.is_cancelled() {
        return Err("plugin_cancelled".into());
    }
    // Until every editor can provide a cross-window transaction, never write
    // text while the same Vault is also open in a second window.
    if app
        .state::<VaultHolders>()
        .holder_count(&loaded.vault.to_string_lossy())
        > 1
    {
        return Err("plugin_vault_open_in_multiple_windows".into());
    }
    let rel = sanitize_vault_rel(rel)?;
    let manager = app.state::<PluginManager>();
    let editors = manager.2.lock().unwrap_or_else(|e| e.into_inner());
    if editors
        .values()
        .filter(|(vault, _)| vault == &loaded.vault)
        .flat_map(|(_, paths)| paths)
        .any(|p| p.replace('\\', "/").eq_ignore_ascii_case(&rel))
    {
        return Err("plugin_unsaved_editor".into());
    }
    if blocked
        .iter()
        .any(|p| p.replace('\\', "/").eq_ignore_ascii_case(&rel))
    {
        return Err("plugin_unsaved_editor".into());
    }
    Ok(())
}

fn authorize(grants: &[String], op: &str) -> Result<&'static agentero_core::ops::OpSpec, String> {
    let spec = agentero_core::ops::get(op).ok_or("plugin_operation_denied")?;
    if spec.stability != agentero_core::ops::OpStability::Stable {
        return Err("plugin_operation_denied".into());
    }
    let permission = serde_json::to_value(spec.permission).map_err(|e| e.to_string())?;
    if !grants
        .iter()
        .any(|p| Some(p.as_str()) == permission.as_str())
    {
        return Err("plugin_permission_denied".into());
    }
    Ok(spec)
}

pub async fn dispatch(
    loaded: Arc<Loaded>,
    request: agentero_plugin_host::Request,
    blocked: Vec<String>,
    app: tauri::AppHandle,
) -> Reply {
    tokio::task::spawn_blocking(move || {
        let mut blocked = blocked;
        let manager = app.state::<PluginManager>();
        // Serializes writes with revocation/configuration and other plugin calls.
        let _lock = manager.1.lock().unwrap_or_else(|e| e.into_inner());
        if loaded.cancel.is_cancelled() { return Err("plugin_cancelled".into()); }
        let op = request.op.as_str();
        let args = &request.args;
        if op.starts_with("storage.") { return storage(&loaded, op, args); }
        let spec = authorize(&loaded.grants, op)?;
        blocked.extend(manager.2.lock().unwrap_or_else(|e|e.into_inner()).values()
            .filter(|(vault,_)| vault == &loaded.vault).flat_map(|(_,paths)| paths.clone()));
        let root = &loaded.vault;
        let output = match op {
            "vault.list" => { fields(args, &[])?; Ok(json!([{"id":"current","name":root.file_name().unwrap_or_default().to_string_lossy()}])) },
            "paper.get" => { fields(args, &["ref"])?; Ok(projection(paper(root, args)?)) },
            "paper.list" => {
                fields(args, &["query", "offset", "limit"])?;
                let query = args["query"].as_str().unwrap_or("").to_lowercase();
                let offset = args["offset"].as_u64().unwrap_or(0) as usize;
                let limit = args["limit"].as_u64().unwrap_or(50).min(100) as usize;
                let rows = papers::list_all(root).map_err(|e| e.to_string())?;
                Ok(json!({"items":rows.into_iter().filter(|p| p.title.to_lowercase().contains(&query)).skip(offset).take(limit).map(projection).collect::<Vec<_>>()}))
            },
            "paper.paths" => {
                fields(args, &["ref"])?; let row = paper(root,args)?;
                let dir = target(root,&row.path)?;
                let mut files = Vec::new();
                for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.take(100) {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !name.starts_with('.') && !entry.file_type().map_err(|e| e.to_string())?.is_symlink() { files.push(format!("{}/{name}",row.path)); }
                }
                Ok(json!({"path":row.path,"files":files}))
            },
            "paper.set_read" => {
                fields(args, &["ref","isRead"])?; let row = paper(root,args)?;
                let value = args["isRead"].as_bool().ok_or("plugin_invalid_arguments")?;
                papers::set_is_read(root,&row.path,value).map(projection).map_err(|e| e.to_string())
            },
            "paper.tag.list" => { fields(args,&[])?; Ok(json!(papers::list_tags(root,false).map_err(|e| e.to_string())?.into_iter().map(|tag| json!({"name":tag.name,"count":tag.count})).collect::<Vec<_>>())) },
            "paper.tag.add" | "paper.tag.rm" | "paper.tag.set" => {
                fields(args,&["ref","tags"])?; let row = paper(root,args)?;
                let raw: Vec<String> = serde_json::from_value(args["tags"].clone()).map_err(|_|"plugin_invalid_tags")?;
                if raw.len()>100 { return Err("plugin_invalid_tags".into()); }
                let tags = raw.iter().map(|t| papers::parse_tag_spec(t).map_err(|e|e.to_string())).collect::<Result<Vec<_>,_>>()?;
                if tags.iter().any(|t| papers::is_internal_tag_name(&t.name)) { return Err("plugin_managed_tag".into()); }
                let row = match op {
                    "paper.tag.add" => papers::add_tags(root,&row.path,&tags),
                    "paper.tag.rm" => papers::remove_tags(root,&row.path,&raw),
                    _ => papers::set_user_tags(root,&row.path,&tags),
                }.map_err(|e|e.to_string())?;
                Ok(projection(row))
            },
            "file.list" => {
                fields(args,&["path"])?;
                let rel = args["path"].as_str().unwrap_or("");
                let dir = if rel.is_empty() { root.clone() } else {target(root,rel)?};
                let mut entries = Vec::new();
                for entry in fs::read_dir(dir).map_err(|e|e.to_string())?.take(200) {
                    let entry=entry.map_err(|e|e.to_string())?; let name=entry.file_name().to_string_lossy().into_owned();
                    let kind=entry.file_type().map_err(|e|e.to_string())?;
                    if name.starts_with('.') || kind.is_symlink() {continue;}
                    entries.push(json!({"path":if rel.is_empty(){name.clone()}else{format!("{rel}/{name}")},"name":name,"isDirectory":kind.is_dir()}));
                }
                Ok(json!({"entries":entries}))
            },
            "file.read" | "file.write" | "paper.notes.get" | "paper.notes.write" => {
                let writing=op.ends_with("write"); let notes=op.starts_with("paper.");
                fields(args, if notes { &["ref","content","expectedRevision","mode"] } else { &["path","content","expectedRevision","mode"] })?;
                let rel=if notes {format!("{}/NOTES.md",paper(root,args)?.path)}else{text(args,"path")?.to_owned()};
                let path=target(root,&rel)?;
                if !notes && path.file_name().is_some_and(|n|n.to_string_lossy().eq_ignore_ascii_case("NOTES.md")) && writing {return Err("plugin_use_notes_write".into());}
                let existing=read_text(&path)?;
                if !writing {return Ok(json!({"path":rel,"content":existing,"revision":revision(&existing)}));}
                write_guard(&loaded,&app,&blocked,&rel)?;
                let next = write_snapshot(&path, &existing, args, notes)?;
                Ok(json!({"path":rel,"revision":revision(&next)}))
            },
            "vault.search" => {
                fields(args, &["query", "limit"])?;
                let query = text(args, "query")?;
                if query.len() > 512 { return Err("plugin_invalid_query".into()); }
                encode(crate::features::markdown::search::vault_search(
                    crate::features::markdown::search::VaultSearchArgs {
                        vault_path: root.to_string_lossy().into_owned(), query: query.into(),
                        limit: Some(args["limit"].as_u64().unwrap_or(30).min(100) as usize),
                        year: None, publication: None, doi: None, is_read: None,
                    }).map_err(|e|e.to_string())?)
            },
            "page.read" => {
                fields(args, &["ref", "page"])?;
                let row = paper(root,args)?;
                let page = args["page"].as_u64().filter(|p| *p > 0 && *p <= u32::MAX as u64).ok_or("plugin_invalid_page")? as u32;
                use agentero_core::features::pdf::layout_index;
                let layout = layout_index::load_raw_layout(root,&row.path).map_err(|e|e.to_string())?;
                let regions = layout_index::page_regions(&layout,page-1).into_iter().map(|r| json!({"kind":r.kind,"text":r.text})).collect::<Vec<_>>();
                Ok(json!({"page":page,"pageCount":layout_index::page_count(&layout),"regions":regions}))
            },
            "paper.move" => {
                fields(args, &["ref", "destination"])?;
                let row = paper(root,args)?;
                let destination = text(args,"destination")?;
                target(root,&row.path)?; target(root,destination)?;
                write_guard(&loaded,&app,&blocked,&row.path)?;
                let handle = app.state::<crate::features::markdown::wiki::WikiIndexState>().handle();
                let mut index = handle.lock().map_err(|e|e.to_string())?;
                encode(agentero_core::features::paper::catalog::move_paper::move_with_index(root,&row.path,destination,&blocked,&mut index).map_err(|e|e.to_string())?)
            },
            "layout.list" => {
                fields(args,&["ref"])?; let row=paper(root,args)?;
                encode(agentero_core::features::pdf::layout_index::list_regions(root,&row.path,&[],None).map_err(|e|e.to_string())?)
            },
            "layout.get" => {
                fields(args,&["ref","id"])?; let row=paper(root,args)?;
                encode(agentero_core::features::pdf::layout_index::get_region(root,&row.path,text(args,"id")?).map_err(|e|e.to_string())?)
            },
            _=>Err("plugin_operation_denied".into()),
        }?;
        if spec.permission != agentero_core::ops::OpPermission::VaultRead {
            let _=app.emit("plugins:data-changed",loaded.vault.to_string_lossy().to_string());
        }
        Ok(output)
    }).await.map_err(|e|e.to_string())?
}

fn write_snapshot(
    path: &Path,
    existing: &str,
    args: &Value,
    notes: bool,
) -> Result<String, String> {
    if text(args, "expectedRevision")? != revision(existing) {
        return Err("plugin_revision_conflict".into());
    }
    let content = text(args, "content")?;
    let mode = args["mode"].as_str().unwrap_or("replace");
    let next = match mode {
        "append" => format!("{existing}{content}"),
        "replace" if notes => {
            let (front, _) =
                agentero_core::features::markdown::frontmatter::split_off_frontmatter(existing);
            let (_, body) =
                agentero_core::features::markdown::frontmatter::split_off_frontmatter(content);
            format!("{front}{body}")
        }
        "replace" => content.to_owned(),
        _ => return Err("plugin_invalid_mode".into()),
    };
    if next.len() > 128 * 1024 || next.contains('\0') {
        return Err("plugin_text_limit".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(path, next.as_bytes()).map_err(|e| e.to_string())?;
    Ok(next)
}

fn storage(loaded: &Loaded, op: &str, args: &Value) -> Reply {
    fields(
        args,
        if op == "storage.set" {
            &["key", "value"]
        } else {
            &["key"]
        },
    )?;
    let key = text(args, "key")?;
    if key.len() > 128 || key.is_empty() {
        return Err("plugin_invalid_key".into());
    }
    let root = agentero_core::paths::agentero_data_dir()
        .join("plugins")
        .join(&loaded.plugin.manifest.id);
    let path = root.join(format!(
        "{}.json",
        revision(&loaded.vault.to_string_lossy())
    ));
    let mut data: Value = if path.exists() {
        serde_json::from_str(&read_text(&path)?).map_err(|e| e.to_string())?
    } else {
        json!({})
    };
    match op {
        "storage.get" => Ok(data.get(key).cloned().unwrap_or(Value::Null)),
        "storage.set" | "storage.delete" => {
            let object = data.as_object_mut().ok_or("plugin_invalid_storage")?;
            if op == "storage.set" {
                object.insert(
                    key.into(),
                    args.get("value").cloned().ok_or("plugin_invalid_value")?,
                );
            } else {
                object.remove(key);
            }
            let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
            if bytes.len() > 128 * 1024 {
                return Err("plugin_storage_limit".into());
            }
            fs::create_dir_all(root).map_err(|e| e.to_string())?;
            atomic_write(&path, &bytes).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err("plugin_operation_denied".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paper_lookup_is_bound_to_the_supplied_vault() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        for (root, title) in [(a.path(), "A"), (b.path(), "B")] {
            fs::create_dir_all(root.join("papers/demo")).unwrap();
            papers::upsert_paper(
                root,
                &papers::PaperRecord::local_pdf("same".into(), title.into()).at_path("papers/demo"),
            )
            .unwrap();
        }
        let args = json!({"ref":"same"});
        assert_eq!(paper(a.path(), &args).unwrap().title, "A");
        assert_eq!(paper(b.path(), &args).unwrap().title, "B");
        assert!(fields(&json!({"ref":"same","vault":"other"}), &["ref"]).is_err());
    }
    #[test]
    fn only_explicit_stable_permissions_are_accepted() {
        let read = vec!["vault:read".into()];
        assert!(authorize(&read, "paper.get").is_ok());
        assert!(authorize(&read, "file.write").is_err());
        assert!(authorize(&["vault:write".into()], "file.delete").is_err());
        assert!(authorize(&[], "paper.get").is_err());
    }
    #[test]
    fn stale_text_is_rejected_and_notes_frontmatter_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("NOTES.md");
        let existing = "---\naliases: [paper]\n---\nOld\n";
        fs::write(&path, existing).unwrap();
        let mut args =
            json!({"expectedRevision":"stale","content":"---\naliases: [evil]\n---\nNew\n"});
        assert_eq!(
            write_snapshot(&path, existing, &args, true).unwrap_err(),
            "plugin_revision_conflict"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), existing);
        args["expectedRevision"] = revision(existing).into();
        let next = write_snapshot(&path, existing, &args, true).unwrap();
        assert!(next.contains("aliases: [paper]"));
        assert!(!next.contains("evil"));
        assert!(next.contains("New"));
        assert_eq!(fs::read_to_string(&path).unwrap(), next);
    }
    #[test]
    fn paths_cannot_escape_or_touch_managed_files() {
        let root = tempfile::tempdir().unwrap();
        for path in [
            "../outside",
            "/tmp/outside",
            "C:\\outside",
            ".agentero/catalog.sqlite",
            "nested/AGENTS.md",
        ] {
            assert!(target(root.path(), path).is_err(), "{path}");
        }
        assert!(target(root.path(), "notes/new.md").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_parent_is_rejected_for_new_files() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
        assert!(target(root.path(), "linked/new.md").is_err());
    }
}
