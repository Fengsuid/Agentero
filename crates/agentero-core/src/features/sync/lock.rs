//! Cross-process pass lock.
//!
//! The desktop Host, the CLI (and cron jobs driving it) can all reach the
//! same vault on one machine. The remote CAS keeps the *store* consistent,
//! but two passes interleaving local writes would race `.agentero/sync/`
//! state files and vault content. An advisory OS lock (flock / LockFileEx)
//! serializes passes; it is tied to the file handle, so a crashed or killed
//! process releases it automatically — no stale locks to clean up.

use std::fs::{self, File};
use std::io;
use std::path::Path;

/// RAII guard: dropping it (or the process exiting) releases the lock.
#[must_use = "keep the guard alive for the entire sync pass"]
pub(crate) struct SyncLock {
    _file: File,
}

impl SyncLock {
    /// Try to claim this vault's sync pass. `Ok(None)` when another process
    /// is mid-pass; other IO failures propagate.
    pub fn try_acquire(vault: &Path) -> io::Result<Option<SyncLock>> {
        let dir = vault.join(".agentero").join("sync");
        fs::create_dir_all(&dir)?;
        let file = File::create(dir.join("lock"))?;
        // flock(EWOULDBLOCK) and LockFileEx(ERROR_LOCK_VIOLATION) both map
        // to `ErrorKind::WouldBlock` in std's decode tables.
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Some(SyncLock { _file: file })),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_on_the_same_vault_is_rejected_and_drop_releases() {
        let vault =
            std::env::temp_dir().join(format!("agentero-sync-lock-{}", uuid::Uuid::new_v4()));
        let first = SyncLock::try_acquire(&vault).unwrap();
        assert!(first.is_some());
        // A second claim (as another process would) reports busy, not error.
        assert!(SyncLock::try_acquire(&vault).unwrap().is_none());
        drop(first);
        // Releasing the guard frees the lock for the next pass.
        assert!(SyncLock::try_acquire(&vault).unwrap().is_some());
        let _ = fs::remove_dir_all(vault);
    }
}
