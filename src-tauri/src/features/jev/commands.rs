//! Tauri commands for TypeSafe jEV smart highlighting.

use crate::core::decision::SystemOneProvider;
use crate::core::error::{map_err, ApiResult};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn jev_probe_health(
    provider: State<'_, Arc<SystemOneProvider>>,
) -> Result<ApiResult<()>, String> {
    match crate::features::jev::service::jev_probe_health(&provider).await {
        Ok(()) => Ok(ApiResult::ok(())),
        Err(err) => Ok(map_err(err)),
    }
}
