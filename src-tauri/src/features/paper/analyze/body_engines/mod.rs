//! Desktop cloud body-parse engines (MinerU / Paddle / OpenAI-compatible VLM,
//! the latter also serving the built-in provider).
//!
//! These implement agentero-core's [`engines::BodyParseEngine`] trait and produce the
//! markdown written to PAPER.md. They register into the core dynamic engine
//! registry via [`register_body_engines`], called from [`refresh_parser_config`]
//! at startup and on every settings change.
//!
//! # Relationship to `layout::hosted`
//!
//! The MinerU and Paddle engines here are thin markdown-extraction layers over
//! the cloud job runners in [`crate::features::paper::analyze::layout::hosted`] (upload →
//! poll → zip/JSONL). Sharing those runners avoids duplicating the HTTP
//! orchestration; the same cloud job is run once and consumed differently
//! (zip → `full.md` plus `images/` assets here; zip → `content_list.json` boxes there).
//! `openai_vlm` is self-contained and does not touch `layout::hosted`.
//!
//! Both trees draw credentials from the single `layout.providerConfigs`
//! settings pool via the `layout_*` accessors — the naming is historical, the
//! sharing is intentional. `openaiCompatible` is deliberately split:
//! `layout::hosted` holds a probe-only stub (connectivity check for the
//! settings UI), while the full VLM OCR engine lives here.
//!
//! The tauri-free engine framework (trait, snapshot, dispatch, local liteparse
//! engine) lives in `agentero_core::features::paper::analyze::parse::engines`.

mod mineru;
mod openai_vlm;
mod paddle;

use crate::features::paper::analyze::parse::engines;
use crate::features::system::settings::{AppSettingsStore, BUILTIN_PROVIDER_ID};
use std::collections::HashMap;
use std::sync::Arc;

/// Providers whose credentials are snapshotted into the parser registry.
const CREDENTIAL_PROVIDERS: &[&str] =
    &["paddle", "mineru", "openaiCompatible", BUILTIN_PROVIDER_ID];

/// Register the cloud engines and the settings-backed provider resolver with
/// the core engine registry. Idempotent (replaces existing entries).
pub fn register_body_engines() {
    engines::register_engine("mineru", || Arc::new(mineru::MineruBodyEngine));
    engines::register_engine("paddle", || Arc::new(paddle::PaddleBodyEngine));
    engines::register_engine("openaicompatible", || {
        Arc::new(openai_vlm::OpenAiVlmBodyEngine::new("openaiCompatible"))
    });
    // The built-in provider is the same VLM engine against a build-time
    // gateway; carrying its own id keeps failure notes naming the backend the
    // user selected.
    engines::register_engine(BUILTIN_PROVIDER_ID, || {
        Arc::new(openai_vlm::OpenAiVlmBodyEngine::new(BUILTIN_PROVIDER_ID))
    });
    engines::set_provider_resolver(crate::features::system::settings::layout_provider_settings_key);
}

/// Rebuild the snapshot from the settings store; plaintext keys never leave
/// the Host process.
pub fn refresh_parser_config(store: &AppSettingsStore) {
    register_body_engines();
    engines::configure_parser(engines::ParserEngineConfig {
        backend: store.parser_backend(),
        credentials: parser_credentials(store),
    });
}

/// Credential snapshot per provider, keyed by the id `provider_for_backend`
/// returns. The built-in entry resolves from the build, not from a settings
/// card, so it can never be persisted.
fn parser_credentials(store: &AppSettingsStore) -> HashMap<String, engines::EngineCredentials> {
    let mut credentials = HashMap::new();
    for provider in CREDENTIAL_PROVIDERS {
        credentials.insert(
            (*provider).to_string(),
            engines::EngineCredentials {
                api_key: store.layout_api_key(provider),
                base_url: store.layout_base_url(provider),
                model: store.layout_model(provider),
                prompt: store.layout_prompt(provider),
                language: store.layout_language(provider),
                is_ocr: store.layout_is_ocr(provider),
                self_hosted: store.layout_self_hosted(provider),
            },
        );
    }
    credentials
}

#[cfg(test)]
mod tests {
    use super::engines::*;
    use super::*;
    use crate::features::system::builtin;
    use crate::features::system::settings::AppSettings;
    use std::path::Path;

    #[test]
    fn engine_registry_resolves_backends() {
        register_body_engines();
        assert_eq!(engine_for("local").id(), "local");
        assert_eq!(engine_for("mineru").id(), "mineru");
        assert_eq!(engine_for("paddle").id(), "paddle");
        assert_eq!(engine_for("openaiCompatible").id(), "openaiCompatible");
        assert_eq!(engine_for("bogus").id(), "local");
        assert_eq!(engine_for("").id(), "local");
    }

    #[test]
    fn provider_lookup_matches_settings_keys() {
        register_body_engines();
        assert_eq!(provider_for_backend("mineru"), Some("mineru"));
        assert_eq!(
            provider_for_backend("openaiCompatible"),
            Some("openaiCompatible")
        );
        assert_eq!(provider_for_backend("local"), None);
        assert_eq!(
            provider_for_backend(BUILTIN_PROVIDER_ID),
            Some(BUILTIN_PROVIDER_ID)
        );
    }

    /// An unregistered backend silently degrades to the local parser instead of
    /// erroring, so the built-in registration needs an explicit guard.
    #[test]
    fn builtin_backend_resolves_to_the_vlm_engine() {
        register_body_engines();
        assert_eq!(engine_for(BUILTIN_PROVIDER_ID).id(), BUILTIN_PROVIDER_ID);
        assert_eq!(engine_for("Agentero").id(), BUILTIN_PROVIDER_ID);
        // The shared engine still reports the id it was registered under.
        assert_eq!(engine_for("openaiCompatible").id(), "openaiCompatible");
    }

    #[test]
    fn builtin_credentials_come_from_the_build_not_a_settings_card() {
        let store = AppSettingsStore::for_tests(AppSettings::default());
        let credentials = parser_credentials(&store);
        let entry = credentials
            .get(BUILTIN_PROVIDER_ID)
            .expect("built-in credentials entry");

        let status = builtin::status();
        assert_eq!(entry.base_url.as_deref(), Some(status.base_url.as_str()));
        assert_eq!(entry.model.as_deref(), Some(status.ocr_model.as_str()));
        assert_eq!(entry.api_key.is_some(), builtin::available());
        // No prompt override: the engine derives one from the model id.
        assert!(entry.prompt.is_none());
        assert!(!entry.is_ocr);
    }

    /// A cloud engine that cannot even start (no API key) must hand over to
    /// the local parser and leave the reason in `messages`.
    ///
    /// Mutates the process-wide snapshot, so it restores the default; no other
    /// test reads `PARSER_CONFIG`.
    #[tokio::test]
    async fn cloud_failure_falls_back_to_local_with_reason() {
        register_body_engines();
        configure_parser(ParserEngineConfig {
            backend: "mineru".to_string(),
            credentials: HashMap::from([("mineru".to_string(), EngineCredentials::default())]),
        });

        let mut messages = Vec::new();
        // The local hop then fails too (no such PDF), which is fine: the
        // assertion is about the handover, not the local parse.
        let _ =
            parse_body_with_engine(Path::new("missing-test-input.pdf"), None, &mut messages).await;

        configure_parser(ParserEngineConfig::default());

        assert!(
            messages
                .iter()
                .any(|m| m.contains("mineru failed") && m.contains("falling back to local")),
            "expected a mineru fallback note, got {messages:?}"
        );
    }
}
