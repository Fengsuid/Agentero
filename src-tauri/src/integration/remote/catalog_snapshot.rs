//! Read SQLite on its host, where its locks and WAL are available.

use crate::core::error::AppError;
use std::path::PathBuf;

#[derive(Clone)]
pub enum CatalogSource {
    Local(PathBuf),
    #[cfg(unix)]
    Ssh {
        destination: String,
        root: String,
    },
}

// Python's standard SQLite module avoids depending on an installed Agentero CLI
// (the `agentero` executable may actually be the desktop GUI).
#[cfg(unix)]
const SNAPSHOT_SCRIPT: &str = r#"
import pathlib, sqlite3, sys, tempfile
source = pathlib.Path('.agentero/catalog.sqlite').resolve()
with tempfile.TemporaryDirectory(prefix='agentero-catalog-') as directory:
    target = pathlib.Path(directory) / 'snapshot.sqlite'
    connection = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=15)
    try:
        connection.execute('VACUUM INTO ?', (str(target),))
    finally:
        connection.close()
    sys.stdout.buffer.write(target.read_bytes())
"#;

impl CatalogSource {
    pub async fn read(&self) -> Result<Vec<u8>, AppError> {
        match self {
            Self::Local(root) => {
                super::catalog_mirror::snapshot_catalog(&root.join(".agentero/catalog.sqlite"))
            }
            #[cfg(unix)]
            Self::Ssh { destination, root } => {
                use tokio::{
                    process::Command,
                    time::{timeout, Duration},
                };
                let command = super::agent_exec::remote_agent_shell_command(
                    root,
                    "python3",
                    &["-c".into(), SNAPSHOT_SCRIPT.into()],
                    &[],
                );
                let output = timeout(
                    Duration::from_secs(30),
                    Command::new("ssh")
                        .args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"])
                        .arg(destination)
                        .arg(command)
                        .kill_on_drop(true)
                        .output(),
                )
                .await
                .map_err(|_| AppError::message("remote catalog snapshot timed out"))??;
                if !output.status.success() {
                    return Err(AppError::message(format!(
                        "remote catalog snapshot failed (requires python3 with sqlite3): {}",
                        String::from_utf8_lossy(&output.stderr).trim(),
                    )));
                }
                if !output.stdout.starts_with(b"SQLite format 3\0") {
                    return Err(AppError::message("remote catalog snapshot is not SQLite"));
                }
                Ok(output.stdout)
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn ssh_script_includes_committed_wal_without_checkpointing() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".agentero")).unwrap();
        let db = root.path().join(".agentero/catalog.sqlite");
        let writer = Connection::open(&db).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE probe(value); INSERT INTO probe VALUES ('latest');
            BEGIN IMMEDIATE; INSERT INTO probe VALUES ('uncommitted');",
            )
            .unwrap();
        let wal = std::fs::read(db.with_extension("sqlite-wal")).unwrap();
        let output = std::process::Command::new("python3")
            .args(["-c", SNAPSHOT_SCRIPT])
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let target = root.path().join("snapshot.sqlite");
        std::fs::write(&target, output.stdout).unwrap();
        let reader = Connection::open(target).unwrap();
        assert_eq!(
            reader
                .query_row("SELECT value FROM probe", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "latest"
        );
        assert_eq!(
            reader
                .query_row("SELECT count(*) FROM probe", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(std::fs::read(db.with_extension("sqlite-wal")).unwrap(), wal);
        writer.execute_batch("ROLLBACK").unwrap();
    }
}
