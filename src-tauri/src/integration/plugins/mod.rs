//! Local plugin packages, per-Vault grants and bounded invocation processes.

mod broker;
mod packages;
pub use packages::*;

use crate::app::vault_session::VaultHolders;
use agentero_plugin_host::{manifest, Invocation};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevelopmentPluginCommand {
    pub id: String,
    pub title: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevelopmentPluginInfo {
    pub grants: Vec<String>,
    pub instance_id: String,
    pub plugin_id: String,
    pub commands: Vec<DevelopmentPluginCommand>,
    #[specta(type = crate::core::json::Json)]
    pub manifest: serde_json::Value,
}

struct Loaded {
    window: String,
    vault: PathBuf,
    plugin: manifest::DevelopmentPlugin,
    cancel: CancellationToken,
    slot: Arc<Semaphore>,
    grants: Vec<String>,
    settings: serde_json::Value,
}

#[derive(Default)]
pub struct PluginManager(
    Mutex<HashMap<String, Arc<Loaded>>>,
    Mutex<()>,
    Mutex<HashMap<String, (PathBuf, Vec<String>)>>,
);

impl PluginManager {
    fn instance(&self, window: &str, id: &str) -> Result<Arc<Loaded>, String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .filter(|loaded| loaded.window == window)
            .cloned()
            .ok_or_else(|| "plugin_not_loaded".into())
    }

    /// Removing the grant cancels even a child currently blocked in a broker call.
    pub fn unload(&self, window: &str, instance: Option<&str>, vault: Option<&std::path::Path>) {
        if instance.is_none() {
            self.2
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(window);
        }
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|id, loaded| {
                let remove = loaded.window == window
                    && instance.is_none_or(|instance| instance == id)
                    && vault.is_none_or(|vault| vault == loaded.vault);
                if remove {
                    loaded.cancel.cancel();
                }
                !remove
            });
    }
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_dev_load(
    window: tauri::WebviewWindow,
    directory: String,
    vault_path: String,
) -> Result<DevelopmentPluginInfo, String> {
    if !cfg!(debug_assertions) {
        return Err("plugin_development_only".into());
    }
    let (plugin, vault) = tokio::task::spawn_blocking(move || {
        let vault = PathBuf::from(vault_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let plugin = manifest::load(std::path::Path::new(&directory))?;
        Ok::<_, String>((plugin, vault))
    })
    .await
    .map_err(|e| e.to_string())??;
    if plugin
        .manifest
        .permissions
        .iter()
        .any(|p| p != "vault:read")
    {
        return Err("plugin_install_to_grant_write_access".into());
    }
    let grants = plugin.manifest.permissions.clone();
    register(&window, plugin, vault, grants, serde_json::json!({}))
}

fn register(
    window: &tauri::WebviewWindow,
    plugin: manifest::DevelopmentPlugin,
    vault: PathBuf,
    grants: Vec<String>,
    settings: serde_json::Value,
) -> Result<DevelopmentPluginInfo, String> {
    let manager = window.state::<PluginManager>();
    let mut loaded = manager.0.lock().unwrap_or_else(|e| e.into_inner());
    if !window
        .state::<VaultHolders>()
        .holds(&vault.to_string_lossy(), window.label())
    {
        return Err("plugin_vault_not_open".into());
    }
    loaded.retain(|_, old| {
        let replace = old.window == window.label() && old.plugin.manifest.id == plugin.manifest.id;
        if replace {
            old.cancel.cancel();
        }
        !replace
    });
    if loaded
        .values()
        .filter(|old| old.window == window.label())
        .count()
        >= 32
    {
        return Err("plugin_load_limit".into());
    }
    let instance_id = uuid::Uuid::new_v4().to_string();
    let info = DevelopmentPluginInfo {
        grants: grants.clone(),
        manifest: serde_json::to_value(&plugin.manifest).map_err(|e| e.to_string())?,
        instance_id: instance_id.clone(),
        plugin_id: plugin.manifest.id.clone(),
        commands: plugin
            .manifest
            .commands
            .iter()
            .map(|c| DevelopmentPluginCommand {
                id: c.id.clone(),
                title: c.title.clone(),
            })
            .collect(),
    };
    loaded.insert(
        instance_id,
        Arc::new(Loaded {
            window: window.label().into(),
            vault,
            plugin,
            cancel: CancellationToken::new(),
            slot: Arc::new(Semaphore::new(1)),
            grants,
            settings,
        }),
    );
    Ok(info)
}

#[tauri::command]
#[specta::specta]
pub fn plugin_unload(window: tauri::WebviewWindow, instance_id: Option<String>) {
    window
        .state::<PluginManager>()
        .unload(window.label(), instance_id.as_deref(), None);
}

#[tauri::command]
#[specta::specta]
pub fn plugin_editor_state(
    window: tauri::WebviewWindow,
    vault_path: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.len() > 1024 || paths.iter().any(|p| p.len() > 4096) {
        return Err("plugin_invalid_context".into());
    }
    let vault = PathBuf::from(vault_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !window
        .state::<VaultHolders>()
        .holds(&vault.to_string_lossy(), window.label())
    {
        return Err("plugin_vault_not_open".into());
    }
    window
        .state::<PluginManager>()
        .2
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(window.label().into(), (vault, paths));
    Ok(())
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevelopmentPluginContext {
    #[serde(default)]
    pub paper_ref: String,
    #[serde(default = "command_kind")]
    pub kind: String,
    pub event: Option<String>,
    pub rel_path: Option<String>,
    pub selection_text: Option<String>,
    #[serde(default)]
    #[specta(type = crate::core::json::Json)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub blocked_paths: Vec<String>,
    pub locale: String,
}

fn command_kind() -> String {
    "command".into()
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_run(
    window: tauri::WebviewWindow,
    instance_id: String,
    command_id: String,
    context: DevelopmentPluginContext,
) -> Result<String, String> {
    let loaded = window
        .state::<PluginManager>()
        .instance(window.label(), &instance_id)?;
    if !window
        .state::<VaultHolders>()
        .holds(&loaded.vault.to_string_lossy(), window.label())
    {
        return Err("plugin_vault_not_open".into());
    }
    match context.kind.as_str() {
        "command"
            if loaded
                .plugin
                .manifest
                .commands
                .iter()
                .any(|c| c.id == command_id) => {}
        "event"
            if context
                .event
                .as_ref()
                .is_some_and(|e| loaded.plugin.manifest.events.contains(e)) => {}
        "activate" | "deactivate" => {}
        _ => return Err("plugin_unknown_entry".into()),
    }
    if context.paper_ref.len() > 1024
        || context.locale.len() > 32
        || context
            .selection_text
            .as_ref()
            .is_some_and(|s| s.len() > 32768)
        || context.rel_path.as_ref().is_some_and(|s| s.len() > 1024)
        || context.payload.to_string().len() > 32768
        || context.blocked_paths.len() > 1024
    {
        return Err("plugin_invalid_context".into());
    }
    let _permit = loaded
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "plugin_busy")?;
    let input = Invocation {
        source: loaded.plugin.source.clone(),
        command: command_id,
        context: serde_json::json!({
            "windowId": window.label(), "vaultId": instance_id,
            "paperRef": context.paper_ref, "locale": context.locale,
            "kind": context.kind, "event": context.event, "payload": context.payload,
            "relPath": context.rel_path, "selectionText": context.selection_text,
            "settings": loaded.settings,
        }),
    };
    let executable = agentero_plugin_host::resolve_plugin_worker()?;
    let value = agentero_plugin_host::run(&executable, input, loaded.cancel.clone(), |request| {
        broker::dispatch(
            loaded.clone(),
            request,
            context.blocked_paths.clone(),
            window.app_handle().clone(),
        )
    })
    .await?
    .value;
    if loaded.cancel.is_cancelled() {
        return Err("plugin_cancelled".into());
    }
    if value.is_null() {
        return Ok(String::new());
    }
    value
        .as_str()
        .filter(|s| s.len() <= 4096)
        .map(str::to_owned)
        .ok_or_else(|| "plugin_invalid_result".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentero_core::features::paper::catalog::papers::{self, PaperRecord};

    fn fixture(window: &str, title: &str) -> (tempfile::TempDir, Arc<Loaded>) {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("papers/demo")).unwrap();
        std::fs::write(root.path().join("papers/demo/NOTES.md"), "# Notes").unwrap();
        papers::upsert_paper(
            root.path(),
            &PaperRecord::local_pdf("demo".into(), title.into()).at_path("papers/demo"),
        )
        .unwrap();
        let loaded = Arc::new(Loaded {
            window: window.into(),
            vault: root.path().into(),
            cancel: CancellationToken::new(),
            slot: Arc::new(Semaphore::new(1)),
            grants: vec!["vault:read".into()],
            settings: serde_json::json!({}),
            plugin: manifest::DevelopmentPlugin {
                source: String::new(),
                manifest: manifest::Manifest {
                    api_version: 0,
                    id: "demo".into(),
                    permissions: vec!["vault:read".into()],
                    commands: vec![],
                    version: "0.1.0".into(),
                    name: Default::default(),
                    menus: vec![],
                    events: vec![],
                    settings: vec![],
                },
            },
        });
        (root, loaded)
    }

    #[test]
    fn unloading_is_scoped_and_revokes_running_instances() {
        let (_a, a) = fixture("main", "Paper A");
        let (_b, b) = fixture("other", "Paper B");
        let manager = PluginManager::default();
        manager.0.lock().unwrap().insert("a".into(), a.clone());
        manager.0.lock().unwrap().insert("b".into(), b.clone());
        assert!(manager.instance("main", "a").is_ok());
        assert!(manager.instance("main", "b").is_err());
        manager.unload("main", Some("b"), None);
        assert!(!b.cancel.is_cancelled());
        manager.unload("main", None, Some(&a.vault));
        assert!(a.cancel.is_cancelled());
        assert!(!b.cancel.is_cancelled());
        assert_eq!(manager.0.lock().unwrap().len(), 1);
        manager.unload("other", None, None);
        assert!(b.cancel.is_cancelled());
    }
}
