//! Real-time LuaLaTeX preview host.
//!
//! `rtex-core` owns the LaTeX side (persistent live engine, display lists,
//! background passes). This module is the desktop shell around it:
//!
//! - one `Session` per TeX project root (not per editor pane),
//! - a dedicated poll thread that forwards `rtex:event` to the owning window,
//! - commands for edits/document sync/background control,
//! - a narrow, allow-listed file reader used by the canvas renderer for font
//!   and image bytes (the WebView cannot read outside the vault fs scope).
//!
//! Everything is target-gated off mobile: there is no local `lualatex` there.

use crate::core::error::{ApiResult, AppError};
use rtex_core::{Edit, Session, SessionConfig};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct RtexSessions(Mutex<HashMap<String, Arc<SessionHandle>>>);

impl RtexSessions {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, id: &str) -> Option<Arc<SessionHandle>> {
        self.0.lock().ok()?.get(id).cloned()
    }

    /// Existing session for the same project root (canonical path).
    fn find_by_root(&self, root: &Path) -> Option<(String, Arc<SessionHandle>)> {
        let sessions = self.0.lock().ok()?;
        sessions
            .iter()
            .find(|(_, handle)| handle.root_path == root)
            .map(|(id, handle)| (id.clone(), handle.clone()))
    }

    /// Best-effort shutdown for app exit. Session drops kill the live engine
    /// and standby compiler instead of leaving orphaned `lualatex` children.
    pub fn stop_all(&self) {
        let handles = self
            .0
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, handle)| handle)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for handle in handles {
            handle.stop.store(true, Ordering::SeqCst);
        }
    }
}

struct SessionHandle {
    session: Arc<Session>,
    stop: AtomicBool,
    /// Canonical root .tex path ("one session per root" lookup).
    root_path: PathBuf,
    project_root: PathBuf,
    build_dir: PathBuf,
    /// TeX Live install root (e.g. /usr/local/texlive/2025): font/map reads
    /// from absolute display-list paths are allowed below it.
    texlive_root: Option<PathBuf>,
    /// Files the renderer may read: `kpsewhich` results (fonts/maps) plus
    /// anything under `project_root` / `build_dir` (images, layout PDFs).
    allowed_paths: Mutex<HashSet<PathBuf>>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RtexStartResult {
    pub session_id: String,
    pub project_root: String,
    pub main_file: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RtexStatus {
    pub available: bool,
    pub lualatex: Option<String>,
    pub texdir: Option<String>,
    pub error: Option<String>,
}

/// Wire name of the event envelope forwarded to the owning window.
pub const RTEX_EVENT: &str = "rtex:event";

/// Event envelope; `event` is rtex's own tagged event JSON.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtexEventPayload {
    pub session_id: String,
    pub event: serde_json::Value,
}

fn short_key(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hex::encode(&hasher.finalize()[..10])
}

fn canonical(path: &Path) -> Result<PathBuf, AppError> {
    std::fs::canonicalize(path)
        .map_err(|e| AppError::message(format!("cannot resolve {}: {e}", path.display())))
}

/// Point rtex at the bundled support files and the detected TeX Live bin.
fn prepare_environment(app: &tauri::AppHandle) {
    if std::env::var_os("RTEX_TEXDIR").is_none() {
        let bundled = app
            .path()
            .resource_dir()
            .ok()
            .map(|dir| dir.join("rtex").join("tex"));
        // Dev builds do not copy bundle resources; use the checked-in copy so
        // the same support files are exercised before packaging.
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("rtex")
            .join("tex");
        for candidate in [bundled, Some(dev)].into_iter().flatten() {
            if candidate.join("rtex-dl.lua").is_file() {
                std::env::set_var("RTEX_TEXDIR", candidate);
                break;
            }
        }
    }
    if let Some(lualatex) = crate::features::compile::resolve_engine("lualatex") {
        if let Some(bin_dir) = lualatex.parent() {
            std::env::set_var("RTEX_TEXLIVE_BIN", bin_dir);
            // GUI apps inherit launchd's minimal PATH; kpsewhich/lualatex live
            // in TeX Live's bin directory, not in it.
            let inherited = std::env::var_os("PATH").unwrap_or_default();
            let mut path = std::ffi::OsString::from(bin_dir);
            path.push(":");
            path.push(inherited);
            std::env::set_var("PATH", path);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn rtex_status(app: tauri::AppHandle) -> ApiResult<RtexStatus> {
    prepare_environment(&app);
    let lualatex = rtex_core::texlive::find_lualatex();
    let texdir = rtex_core::texlive::find_rtex_texdir();
    let mut error = None;
    if let Err(e) = &lualatex {
        error = Some(e.to_string());
    } else if let Err(e) = &texdir {
        error = Some(e.to_string());
    }
    ApiResult::ok(RtexStatus {
        available: lualatex.is_ok() && texdir.is_ok(),
        lualatex: lualatex.ok().map(|(_, p)| p.to_string_lossy().to_string()),
        texdir: texdir.ok().map(|p| p.to_string_lossy().to_string()),
        error,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn rtex_start(
    app: tauri::AppHandle,
    window: tauri::Window,
    tex_path: String,
    vault_path: String,
    fresh: bool,
) -> ApiResult<RtexStartResult> {
    prepare_environment(&app);
    let state = app.state::<RtexSessions>();

    let tex_path = PathBuf::from(tex_path);
    if !tex_path.is_file() {
        return ApiResult::err(AppError::message(format!(
            "TeX root not found: {}",
            tex_path.display()
        )));
    }
    let project_root = match tex_path.parent() {
        Some(p) => p.to_path_buf(),
        None => return ApiResult::err(AppError::message("TeX root has no parent directory")),
    };
    let Some(main_file) = tex_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
    else {
        return ApiResult::err(AppError::message("TeX root has an invalid file name"));
    };

    let canonical_root = match canonical(&project_root) {
        Ok(p) => p,
        Err(e) => return ApiResult::err(e),
    };
    let canonical_tex = canonical(&tex_path).unwrap_or_else(|_| tex_path.clone());
    let mut session_id = short_key(&tex_path);
    if let Some((old_id, existing)) = state.find_by_root(&canonical_tex) {
        if !fresh {
            return ApiResult::ok(RtexStartResult {
                session_id: old_id,
                project_root: existing.project_root.to_string_lossy().to_string(),
                main_file,
            });
        }
        // A reloaded webview has no layout state; reuse would only replay an
        // old LayoutUpdate whose pages_changed set is empty. Replace the
        // session so the new host receives every page from its first pass.
        if let Ok(mut sessions) = state.0.lock() {
            sessions.remove(&old_id);
        }
        existing.stop.store(true, Ordering::SeqCst);
        session_id = format!(
            "{}-{}",
            session_id,
            SESSION_SEQ.fetch_add(1, Ordering::SeqCst)
        );
    }

    // Keep all pass output out of the watched vault tree: `.agentero` is
    // ignored by the file tree, watcher, sync and the LaTeX reverse scan.
    let build_dir = PathBuf::from(vault_path)
        .join(".agentero")
        .join("rtex")
        .join(&session_id);
    if let Err(e) = std::fs::create_dir_all(&build_dir) {
        return ApiResult::err(AppError::message(format!(
            "cannot create rtex build dir {}: {e}",
            build_dir.display()
        )));
    }
    let build_dir = match canonical(&build_dir) {
        Ok(p) => p,
        Err(e) => return ApiResult::err(e),
    };

    let mut cfg = SessionConfig::new(&canonical_root, &main_file);
    cfg.build_dir = build_dir.clone();
    cfg.warm_background = true;

    let session = match Session::open(cfg) {
        Ok(s) => Arc::new(s),
        Err(e) => return ApiResult::err(AppError::message(format!("rtex: {e}"))),
    };

    let texlive_root = crate::features::compile::resolve_engine("lualatex")
        .and_then(|path| path.parent().and_then(Path::parent).map(Path::to_path_buf))
        .and_then(|path| canonical(&path).ok());
    let handle = Arc::new(SessionHandle {
        session,
        stop: AtomicBool::new(false),
        root_path: canonical_tex,
        project_root: canonical_root.clone(),
        build_dir,
        texlive_root,
        allowed_paths: Mutex::new(HashSet::new()),
    });
    if let Ok(mut sessions) = state.0.lock() {
        sessions.insert(session_id.clone(), handle.clone());
    } else {
        return ApiResult::err(AppError::message("rtex session registry is poisoned"));
    }

    let app_handle = app.clone();
    let window_label = window.label().to_string();
    let forwarded_id = session_id.clone();
    std::thread::spawn(move || {
        while !handle.stop.load(Ordering::SeqCst) {
            for event in handle.session.poll(Duration::from_millis(32)) {
                let Ok(value) = serde_json::to_value(&event) else {
                    continue;
                };
                let _ = app_handle.emit_to(
                    window_label.as_str(),
                    RTEX_EVENT,
                    RtexEventPayload {
                        session_id: forwarded_id.clone(),
                        event: value,
                    },
                );
            }
        }
    });

    ApiResult::ok(RtexStartResult {
        session_id,
        project_root: canonical_root.to_string_lossy().to_string(),
        main_file,
    })
}

#[tauri::command]
#[specta::specta]
pub fn rtex_edit(
    state: tauri::State<'_, RtexSessions>,
    session_id: String,
    path: String,
    start: usize,
    end: usize,
    text: String,
) -> ApiResult<()> {
    let Some(handle) = state.get(&session_id) else {
        return ApiResult::err(AppError::message("unknown rtex session"));
    };
    match handle.session.apply_edit(
        &path,
        Edit {
            start_byte: start,
            end_byte: end,
            text,
        },
    ) {
        Ok(_) => ApiResult::ok(()),
        Err(e) => ApiResult::err(AppError::message(e.to_string())),
    }
}

#[tauri::command]
#[specta::specta]
pub fn rtex_set_document(
    state: tauri::State<'_, RtexSessions>,
    session_id: String,
    path: String,
    text: String,
) -> ApiResult<()> {
    let Some(handle) = state.get(&session_id) else {
        return ApiResult::err(AppError::message("unknown rtex session"));
    };
    match handle.session.set_document(&path, &text) {
        Ok(_) => ApiResult::ok(()),
        Err(e) => ApiResult::err(AppError::message(e.to_string())),
    }
}

#[tauri::command]
#[specta::specta]
pub fn rtex_request_layout(
    state: tauri::State<'_, RtexSessions>,
    session_id: String,
) -> ApiResult<()> {
    let Some(handle) = state.get(&session_id) else {
        return ApiResult::err(AppError::message("unknown rtex session"));
    };
    handle.session.request_layout();
    ApiResult::ok(())
}

#[tauri::command]
#[specta::specta]
pub fn rtex_pause_background(
    state: tauri::State<'_, RtexSessions>,
    session_id: String,
    paused: bool,
) -> ApiResult<()> {
    let Some(handle) = state.get(&session_id) else {
        return ApiResult::err(AppError::message("unknown rtex session"));
    };
    handle.session.pause_background(paused);
    ApiResult::ok(())
}

#[tauri::command]
#[specta::specta]
pub fn rtex_stop(state: tauri::State<'_, RtexSessions>, session_id: String) -> ApiResult<()> {
    let handle = match state.0.lock() {
        Ok(mut sessions) => sessions.remove(&session_id),
        Err(_) => None,
    };
    if let Some(handle) = handle {
        handle.stop.store(true, Ordering::SeqCst);
    }
    ApiResult::ok(())
}

/// `kpsewhich <name>` through the same TeX Live bin resolution as the rest of
/// the app. Resolved files are added to the session's read allow-list.
#[tauri::command]
#[specta::specta]
pub async fn rtex_kpsewhich(
    app: tauri::AppHandle,
    session_id: String,
    name: String,
) -> ApiResult<Option<String>> {
    let state = app.state::<RtexSessions>();
    let Some(handle) = state.get(&session_id) else {
        return ApiResult::err(AppError::message("unknown rtex session"));
    };
    let Some(kpsewhich) = crate::features::compile::resolve_engine("kpsewhich") else {
        return ApiResult::ok(None);
    };
    let mut cmd = tokio::process::Command::new(kpsewhich);
    cmd.arg(&name);
    if let Some(bin_dir) = crate::features::compile::resolve_engine("lualatex")
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        let mut path = std::ffi::OsString::from(bin_dir);
        path.push(":");
        path.push(inherited);
        cmd.env("PATH", path);
    }
    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) => return ApiResult::err(AppError::message(format!("kpsewhich: {e}"))),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(first) = stdout.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return ApiResult::ok(None);
    };
    let path = PathBuf::from(first);
    let path = canonical(&path).unwrap_or(path);
    if let Ok(mut allowed) = handle.allowed_paths.lock() {
        allowed.insert(path.clone());
    }
    ApiResult::ok(Some(path.to_string_lossy().to_string()))
}

/// Read a font/image/layout file for the renderer. Only files resolved by
/// `kpsewhich`, or under the project/build roots, are readable — this command
/// must never become a general filesystem read for the WebView.
#[tauri::command]
#[specta::specta]
pub async fn rtex_read_tex_file(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
) -> ApiResult<String> {
    let state = app.state::<RtexSessions>();
    let Some(handle) = state.get(&session_id) else {
        return ApiResult::err(AppError::message("unknown rtex session"));
    };
    let candidate = PathBuf::from(&path);
    let resolved = match canonical(&candidate) {
        Ok(p) => p,
        Err(e) => return ApiResult::err(e),
    };
    let is_kpse = handle
        .allowed_paths
        .lock()
        .map(|paths| paths.contains(&resolved))
        .unwrap_or(false);
    let is_project = resolved.starts_with(&handle.project_root)
        || resolved.starts_with(&handle.build_dir)
        || handle
            .texlive_root
            .as_ref()
            .is_some_and(|root| resolved.starts_with(root))
        || rtex_core::texlive::find_rtex_texdir()
            .map(|root| resolved.starts_with(root))
            .unwrap_or(false);
    if !is_kpse && !is_project {
        return ApiResult::err(AppError::message(format!(
            "rtex resource is outside the project: {}",
            resolved.display()
        )));
    }
    let bytes = match tokio::fs::read(&resolved).await {
        Ok(b) => b,
        Err(e) => return ApiResult::err(AppError::message(format!("read {path}: {e}"))),
    };
    use base64::Engine;
    ApiResult::ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual smoke test: needs a real LuaLaTeX install and rtex's support
    /// files. Run with `cargo test -p agentero --features desktop rtex_live_smoke -- --ignored`.
    #[test]
    #[ignore = "needs TeX Live lualatex"]
    fn rtex_live_smoke() {
        if let Some(lualatex) = crate::features::compile::resolve_engine("lualatex") {
            if let Some(bin) = lualatex.parent() {
                std::env::set_var("RTEX_TEXLIVE_BIN", bin);
            }
        }
        let dir = tempfile::tempdir().expect("temp dir");
        let main = dir.path().join("main.tex");
        std::fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\nHello world.\n\nSecond paragraph.\n\\end{document}\n",
        )
        .expect("write tex");

        let mut cfg = SessionConfig::new(dir.path(), "main.tex");
        cfg.build_dir = dir.path().join(".agentero").join("rtex");
        let session = Session::open(cfg).expect("open session");

        let (layout, _) = session.wait_for(Duration::from_secs(60), |event| {
            matches!(event, rtex_core::Event::LayoutUpdate { .. })
        });
        assert!(layout.is_some(), "no initial layout");

        let source = "\\documentclass{article}\n\\begin{document}\nHello world.\n\nSecond paragraph.\n\\end{document}\n";
        let at = source.find("Hello").expect("Hello");
        let result = session
            .apply_edit(
                "main.tex",
                Edit {
                    start_byte: at,
                    end_byte: at,
                    text: "X".into(),
                },
            )
            .expect("apply edit");
        assert!(!result.routed.is_empty());

        let (paragraph, _) = session.wait_for(Duration::from_secs(20), |event| {
            matches!(event, rtex_core::Event::ParagraphUpdate { .. })
        });
        assert!(paragraph.is_some(), "no paragraph update");
    }
}
