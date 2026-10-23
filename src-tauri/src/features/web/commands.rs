//! Web viewer commands: remote-host allowlist and local HTML preview grants.

use crate::app::vault_session::VaultHolders;
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebProxyAllowHostArgs {
    /// Public DNS host the viewer is about to load through the proxy.
    pub host: String,
}

/// Ensure `host` may be served by the `agentero-web` proxy before its viewer
/// frame loads.
///
/// Idempotent. Non-public hosts (IP literals, intranet names) are refused, so
/// the entry point itself cannot aim the proxy at link-local endpoints; the
/// caller learns that through `false` and can surface it before the frame
/// fails to load.
#[tauri::command]
#[specta::specta]
pub async fn web_proxy_allow_host(args: WebProxyAllowHostArgs) -> Result<ApiResult<bool>, String> {
    let host = super::allowlist::normalize_host(&args.host);
    let accepted = super::allowlist::is_public_dns_host(&host);
    if accepted {
        super::allowlist::allow_host(&host);
    } else {
        log::warn!(target: "agentero::web_proxy", "refused to allow non-public host: {host}");
    }
    Ok(ApiResult::ok(accepted))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewGrantArgs {
    /// Absolute path of the `.html` / `.htm` file to preview.
    pub path: String,
}

/// Token plus the file name used as the last segment of the preview URL.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewGrant {
    pub token: String,
    pub name: String,
}

/// Mint a preview token for one HTML file inside a vault this window holds.
///
/// The token names that file's directory. The `agentero-html` scheme serves
/// only paths under it. Closing the vault revokes the token.
#[tauri::command]
#[specta::specta]
pub async fn html_preview_grant(
    app: tauri::AppHandle,
    args: HtmlPreviewGrantArgs,
) -> Result<ApiResult<HtmlPreviewGrant>, String> {
    let roots = app.state::<VaultHolders>().vault_keys();
    let path = args.path;
    let prepared = run_blocking(move || match super::html_preview::prepare(&roots, &path) {
        Ok(prepared) => ApiResult::ok(PreparedWire {
            dir: prepared.dir.to_string_lossy().into_owned(),
            name: prepared.name,
        }),
        Err(err) => map_err(err),
    })
    .await;
    if !prepared.ok {
        return Ok(ApiResult {
            ok: false,
            data: None,
            error: prepared.error,
        });
    }
    let Some(wire) = prepared.data else {
        return Ok(map_err(crate::core::error::AppError::message(
            "html preview file is unreadable",
        )));
    };
    let token = app
        .state::<super::html_preview::HtmlPreviewGrants>()
        .insert(std::path::PathBuf::from(wire.dir));
    Ok(ApiResult::ok(HtmlPreviewGrant {
        token,
        name: wire.name,
    }))
}

#[derive(Serialize)]
struct PreparedWire {
    dir: String,
    name: String,
}
