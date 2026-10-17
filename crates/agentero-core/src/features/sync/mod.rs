//! Vault cloud sync over S3-compatible object storage or WebDAV.
//!
//! Design doc: `docs/development/cloud-sync-s3.md`. The engine is
//! state-based: content-addressed blobs + immutable manifests + a CAS `HEAD`
//! pointer. Credentials live in XDG `sync.json` (never inside the vault).
//!
//! This module is shared as-is by the desktop Host (`integration::sync` adds
//! the IPC commands, the auto-sync scheduler and the in-process run lease)
//! and the headless CLI (`agentero sync …`), so both sides get the same
//! merge, conflict and failure-recovery semantics.

pub mod config;
pub mod engine;
pub mod local;
mod lock;
mod s3;
pub mod snapshot;
mod store;
mod webdav;
