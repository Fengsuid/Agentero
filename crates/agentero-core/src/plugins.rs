//! `plugins.json` beside [`crate::paths::settings_path`].
//!
//! The document is a JSON object. `schemaVersion` must be `1` and `plugins`
//! must be an array. Entries are not interpreted; they stay JSON values so a
//! later object shape round-trips, including unknown fields. Unknown top-level
//! keys are kept. A missing file is the empty document. This module is not
//! called at startup. See `docs/development/plugin-api.md`.

use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use crate::fs::json_store;

/// `plugins.json` schema this loader accepts.
pub const PLUGINS_SCHEMA_VERSION: u64 = 1;

/// Loaded `plugins.json`. Always an object with `schemaVersion` 1 and a
/// `plugins` array. Other keys are preserved on [`store_plugins`].
#[derive(Debug, Clone, PartialEq)]
pub struct PluginsDocument {
    value: Value,
}

/// Why `plugins.json` could not be loaded or stored.
///
/// Invalid documents return one of the schema variants. They do not panic.
#[derive(Debug, thiserror::Error)]
pub enum PluginsError {
    #[error("plugins.json is not a JSON object")]
    NotObject,
    #[error("plugins.json schemaVersion must be 1")]
    BadSchemaVersion,
    #[error("plugins.json plugins must be an array")]
    PluginsNotArray,
    #[error("plugins.json is not valid JSON: {0}")]
    InvalidJson(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Store(String),
}

impl PluginsDocument {
    /// `{ "schemaVersion": 1, "plugins": [] }`.
    pub fn empty() -> Self {
        let mut root = Map::new();
        root.insert(
            "schemaVersion".to_string(),
            Value::Number(PLUGINS_SCHEMA_VERSION.into()),
        );
        root.insert("plugins".to_string(), Value::Array(Vec::new()));
        Self {
            value: Value::Object(root),
        }
    }

    pub fn schema_version(&self) -> u64 {
        PLUGINS_SCHEMA_VERSION
    }

    pub fn plugins(&self) -> &[Value] {
        self.value["plugins"]
            .as_array()
            .expect("plugins.json plugins is an array")
    }

    /// Full object, including unknown keys.
    pub fn as_value(&self) -> &Value {
        &self.value
    }

    fn from_value(value: Value) -> Result<Self, PluginsError> {
        let Some(root) = value.as_object() else {
            return Err(PluginsError::NotObject);
        };
        match root.get("schemaVersion") {
            Some(Value::Number(number)) if number.as_u64() == Some(PLUGINS_SCHEMA_VERSION) => {}
            _ => return Err(PluginsError::BadSchemaVersion),
        }
        match root.get("plugins") {
            Some(Value::Array(_)) => {}
            _ => return Err(PluginsError::PluginsNotArray),
        }
        Ok(Self { value })
    }
}

/// Read `path`. A missing file is [`PluginsDocument::empty`] and does not
/// create the file. Any other failure is a [`PluginsError`].
pub fn load_plugins(path: &Path) -> Result<PluginsDocument, PluginsError> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PluginsDocument::empty());
        }
        Err(error) => return Err(PluginsError::Io(error)),
    };
    let value =
        serde_json::from_str(&raw).map_err(|error| PluginsError::InvalidJson(error.to_string()))?;
    PluginsDocument::from_value(value)
}

/// Pretty-print `document` to `path`, creating parent directories.
/// Unknown keys already on the document are written back.
pub fn store_plugins(path: &Path, document: &PluginsDocument) -> Result<(), PluginsError> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    json_store(path, document.as_value()).map_err(|error| PluginsError::Store(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_raw(raw: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("plugins.json");
        fs::write(&path, raw).expect("write");
        (dir, path)
    }

    #[test]
    fn missing_file_is_empty_document_and_is_not_created() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("plugins.json");

        let doc = load_plugins(&path).expect("load");

        assert_eq!(doc.schema_version(), 1);
        assert!(doc.plugins().is_empty());
        assert_eq!(
            doc.as_value(),
            &json!({ "schemaVersion": 1, "plugins": [] })
        );
        assert!(!path.exists());
    }

    #[test]
    fn invalid_documents_return_structured_errors() {
        let cases: &[(&str, fn(&PluginsError) -> bool)] = &[
            ("[]", |e| matches!(e, PluginsError::NotObject)),
            ("null", |e| matches!(e, PluginsError::NotObject)),
            (r#"{ "plugins": [] }"#, |e| {
                matches!(e, PluginsError::BadSchemaVersion)
            }),
            (r#"{ "schemaVersion": 2, "plugins": [] }"#, |e| {
                matches!(e, PluginsError::BadSchemaVersion)
            }),
            (r#"{ "schemaVersion": "1", "plugins": [] }"#, |e| {
                matches!(e, PluginsError::BadSchemaVersion)
            }),
            (r#"{ "schemaVersion": 1, "plugins": {} }"#, |e| {
                matches!(e, PluginsError::PluginsNotArray)
            }),
            (r#"{ "schemaVersion": 1 }"#, |e| {
                matches!(e, PluginsError::PluginsNotArray)
            }),
            ("{", |e| matches!(e, PluginsError::InvalidJson(_))),
        ];
        for (raw, pred) in cases {
            let (_dir, path) = write_raw(raw);
            let err = load_plugins(&path).expect_err(raw);
            assert!(pred(&err), "{raw} -> {err}");
        }
    }

    #[test]
    fn round_trip_keeps_unknown_keys_and_plugin_entry_fields() {
        let raw = r#"{ "schemaVersion": 1, "plugins": [{ "id": "demo", "enabled": false, "extra": true }], "future": { "a": 1 } }"#;
        let (_dir, path) = write_raw(raw);
        let loaded = load_plugins(&path).expect("load");

        store_plugins(&path, &loaded).expect("store");
        let stored_text = fs::read_to_string(&path).expect("read");
        let expected = serde_json::to_string_pretty(loaded.as_value()).expect("pretty");
        assert_eq!(stored_text, expected);

        let again = load_plugins(&path).expect("reload");
        assert_eq!(
            again.as_value(),
            &json!({
                "schemaVersion": 1,
                "plugins": [{ "id": "demo", "enabled": false, "extra": true }],
                "future": { "a": 1 }
            })
        );
        assert_eq!(again.plugins()[0]["extra"], json!(true));
        assert_eq!(again.as_value()["future"]["a"], json!(1));
    }

    #[test]
    fn store_creates_parent_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("plugins.json");

        store_plugins(&path, &PluginsDocument::empty()).expect("store");

        let doc = load_plugins(&path).expect("load");
        assert_eq!(doc, PluginsDocument::empty());
    }
}
