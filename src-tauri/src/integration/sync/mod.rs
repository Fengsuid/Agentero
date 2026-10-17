//! Desktop shell around the shared sync engine in
//! `agentero_core::features::sync`: IPC commands (`commands`), the auto-sync
//! scheduler and the in-process run lease below. The engine itself (S3 /
//! WebDAV stores, three-way merge, CAS protocol, conflict copies) lives in
//! core and is shared with the headless CLI (`agentero sync …`).

pub mod commands;
pub mod scheduler;

pub use agentero_core::features::sync::{config, engine, local, snapshot};

use std::collections::HashSet;
use std::sync::Mutex;

/// Serializes sync passes per vault and owns the auto-sync scheduler tasks
/// (managed tauri state). Cross-process passes (CLI alongside the Host) are
/// serialized by the file lock inside `engine::sync_vault_locked`; this lease
/// additionally drives the in-app `running` status.
#[derive(Default)]
pub struct SyncService {
    running: Mutex<HashSet<String>>,
    schedulers: Mutex<scheduler::SchedulerMap>,
}

/// Ownership of one vault's in-flight sync. Dropping the future on timeout or
/// abort drops this lease too; callers cannot forget a separate `end` call.
#[must_use = "keep the lease alive for the entire sync pass"]
pub(crate) struct SyncRunLease<'a> {
    service: &'a SyncService,
    vault: String,
}

impl Drop for SyncRunLease<'_> {
    fn drop(&mut self) {
        self.service
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.vault);
    }
}

impl SyncService {
    /// Claim the vault for a sync pass; None when one is already running.
    pub(crate) fn try_begin(&self, vault: &str) -> Option<SyncRunLease<'_>> {
        let vault = vault.to_string();
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !running.insert(vault.clone()) {
            return None;
        }
        Some(SyncRunLease {
            service: self,
            vault,
        })
    }

    pub fn is_running(&self, vault: &str) -> bool {
        self.running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(vault)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn sync_leases_exclude_same_vault_and_release_on_return() {
        let service = SyncService::default();
        let a = service.try_begin("a").unwrap();
        let b = service.try_begin("b").unwrap();
        assert!(service.try_begin("a").is_none());
        assert!(service.try_begin("b").is_none());
        assert!(service.is_running("a"));
        drop(a);
        assert!(!service.is_running("a"));
        assert!(service.is_running("b"));
        assert!(service.try_begin("a").is_some());
        drop(b);
        assert!(!service.is_running("b"));

        let fail = || -> Result<(), &'static str> {
            let _lease = service.try_begin("a").unwrap();
            Err("sync failed")?;
            Ok(())
        };
        assert!(fail().is_err());
        assert!(service.try_begin("a").is_some());
    }

    #[tokio::test]
    async fn aborting_inflight_sync_releases_vault() {
        let service = Arc::new(SyncService::default());
        let task_service = Arc::clone(&service);
        let (ready, acquired) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _lease = task_service.try_begin("a").unwrap();
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        acquired.await.unwrap();
        assert!(service.try_begin("a").is_none());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!service.is_running("a"));
        assert!(service.try_begin("a").is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn timing_out_sync_releases_vault() {
        let service = SyncService::default();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let _lease = service.try_begin("a").unwrap();
            std::future::pending::<()>().await;
        })
        .await;
        assert!(result.is_err());
        assert!(service.try_begin("a").is_some());
    }
}
