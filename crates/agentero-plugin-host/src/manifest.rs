use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::Read,
    path::Path,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub api_version: u32,
    pub id: String,
    pub permissions: Vec<String>,
    pub commands: Vec<Command>,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub name: BTreeMap<String, String>,
    #[serde(default)]
    pub menus: Vec<Menu>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub settings: Vec<Setting>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub title: BTreeMap<String, String>,
}

fn default_version() -> String {
    "0.1.0".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Menu {
    pub command: String,
    pub menu: String,
    #[serde(default)]
    pub order: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Setting {
    pub key: String,
    pub title: BTreeMap<String, String>,
    pub kind: String,
    pub default: serde_json::Value,
}

pub const PERMISSIONS: &[&str] = &[
    "vault:read",
    "catalog:write",
    "vault:notes:write",
    "vault:write",
];
pub const EVENTS: &[&str] = &[
    "vault:opened",
    "paper:opened",
    "paper:imported",
    "paper:assets-ready",
    "paper:renamed",
];

#[derive(Clone)]
pub struct DevelopmentPlugin {
    pub manifest: Manifest,
    pub source: String,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-".contains(&c))
        && id.as_bytes()[0].is_ascii_lowercase()
}

fn read_asset(root: &Path, name: &str, limit: u64) -> Result<String, String> {
    let path = root.join(name).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("plugin_asset_outside_directory".into());
    }
    let mut text = String::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > limit {
        return Err("plugin_asset_too_large".into());
    }
    Ok(text)
}

/// Capture the source at explicit load time. Editing files never changes the
/// code behind an existing grant; the developer must load the directory again.
pub fn load(directory: &Path) -> Result<DevelopmentPlugin, String> {
    let root = directory.canonicalize().map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_str(&read_asset(&root, "manifest.json", 16 * 1024)?)
        .map_err(|e| e.to_string())?;
    validate(&manifest)?;
    let source = read_asset(&root, "main.js", 128 * 1024)?;
    Ok(DevelopmentPlugin { manifest, source })
}

pub fn validate(manifest: &Manifest) -> Result<(), String> {
    if manifest.api_version > 1 || !valid_id(&manifest.id) || manifest.version.len() > 80 {
        return Err("plugin_invalid_manifest".into());
    }
    if manifest
        .permissions
        .iter()
        .any(|permission| !PERMISSIONS.contains(&permission.as_str()))
    {
        return Err("plugin_unsupported_permission".into());
    }
    if manifest.commands.is_empty() || manifest.commands.len() > 16 {
        return Err("plugin_invalid_commands".into());
    }
    let mut ids = HashSet::new();
    for command in &manifest.commands {
        if !valid_id(&command.id)
            || !ids.insert(&command.id)
            || !["en", "zh-CN"]
                .iter()
                .all(|locale| command.title.contains_key(*locale))
            || command.title.len() > 16
            || command
                .title
                .values()
                .any(|title| title.trim().is_empty() || title.len() > 240)
        {
            return Err("plugin_invalid_commands".into());
        }
    }
    if manifest.menus.len() > 32
        || manifest.events.len() > EVENTS.len()
        || manifest.settings.len() > 32
    {
        return Err("plugin_manifest_limit".into());
    }
    for menu in &manifest.menus {
        if !["fileTree.item", "library.row", "pdf.selection"].contains(&menu.menu.as_str())
            || !manifest.commands.iter().any(|c| c.id == menu.command)
        {
            return Err("plugin_invalid_menu".into());
        }
    }
    if manifest
        .events
        .iter()
        .any(|e| !EVENTS.contains(&e.as_str()))
    {
        return Err("plugin_invalid_event".into());
    }
    let mut keys = HashSet::new();
    for setting in &manifest.settings {
        if !valid_id(&setting.key)
            || !keys.insert(&setting.key)
            || !["en", "zh-CN"].iter().all(|locale| {
                setting
                    .title
                    .get(*locale)
                    .is_some_and(|v| !v.is_empty() && v.len() <= 240)
            })
            || !valid_setting(setting, &setting.default)
        {
            return Err("plugin_invalid_setting".into());
        }
    }
    Ok(())
}

pub fn valid_setting(setting: &Setting, value: &serde_json::Value) -> bool {
    match setting.kind.as_str() {
        "string" => value.as_str().is_some_and(|s| s.len() <= 4096),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        _ => false,
    }
}

/// M0 deliberately implements just paper.get. No wildcard delegation to Tauri
/// or internal ops; extra fields cannot smuggle a different vault into a call.
pub fn paper_ref(manifest: &Manifest, request: crate::Request) -> Result<String, String> {
    if !manifest.permissions.iter().any(|p| p == "vault:read") {
        return Err("plugin_permission_denied".into());
    }
    if request.op != "paper.get" {
        return Err("plugin_operation_denied".into());
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Args {
        r#ref: String,
    }
    let args: Args =
        serde_json::from_value(request.args).map_err(|_| "plugin_invalid_arguments")?;
    if args.r#ref.is_empty() || args.r#ref.len() > 1024 {
        return Err("plugin_invalid_arguments".into());
    }
    Ok(args.r#ref)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn permissions_and_operation_allowlist_are_enforced() {
        let mut manifest = Manifest {
            api_version: 0,
            id: "demo".into(),
            permissions: vec![],
            commands: vec![],
            version: default_version(),
            name: BTreeMap::new(),
            menus: vec![],
            events: vec![],
            settings: vec![],
        };
        let request = || crate::Request {
            op: "paper.get".into(),
            args: json!({"ref":"demo"}),
        };
        assert_eq!(
            paper_ref(&manifest, request()).unwrap_err(),
            "plugin_permission_denied"
        );
        manifest.permissions.push("vault:read".into());
        assert_eq!(paper_ref(&manifest, request()).unwrap(), "demo");
        assert!(paper_ref(
            &manifest,
            crate::Request {
                op: "file.write".into(),
                args: json!({})
            }
        )
        .is_err());
        assert!(paper_ref(
            &manifest,
            crate::Request {
                op: "paper.get".into(),
                args: json!({"ref":"demo","vault":"/other"})
            }
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn source_symlink_cannot_escape_plugin_directory() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(other.path(), root.path().join("main.js")).unwrap();
        assert_eq!(
            read_asset(root.path(), "main.js", 128).unwrap_err(),
            "plugin_asset_outside_directory"
        );
    }
}
