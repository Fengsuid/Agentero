//! Offline integration tests for `agentero sync` (no network): config
//! resolution, unconfigured errors and the secret-channel guard. The engine
//! itself (merge / conflicts / resume) is covered by the in-memory-store
//! tests in `agentero-core::features::sync`.

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn agentero() -> assert_cmd::Command {
    cargo_bin_cmd!("agentero-cli")
}

fn create_vault(dir: &Path) {
    let home = dir.parent().unwrap_or(dir).join(".test-home");
    fs::create_dir_all(&home).unwrap();
    agentero()
        .env("HOME", &home)
        .args(["vault", "create", dir.to_str().unwrap(), "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"ok\":true"));
}

#[test]
fn sync_status_reports_unconfigured_vault() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    agentero()
        .env("HOME", tmp.path().join(".test-home"))
        .args([
            "sync",
            "status",
            "--vault",
            vault.to_str().unwrap(),
            "--json",
        ])
        .assert()
        .code(0)
        .stdout(predicate::str::contains("\"configured\":false"))
        .stdout(predicate::str::contains("\"lastVersion\":0"));
}

#[test]
fn sync_now_without_binding_fails_with_stable_code() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    agentero()
        .env("HOME", tmp.path().join(".test-home"))
        .args(["sync", "now", "--vault", vault.to_str().unwrap(), "--json"])
        .assert()
        .code(1)
        .stdout(predicate::str::contains("\"code\":\"sync_not_configured\""));
}

#[test]
fn sync_configure_never_prompts_or_leaks_secret_guidance_in_json_mode() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    // Non-TTY + no env secrets: must fail (not hang on a prompt) and point
    // at the secret channels instead of argv.
    agentero()
        .env("HOME", tmp.path().join(".test-home"))
        .args([
            "sync",
            "configure",
            "--vault",
            vault.to_str().unwrap(),
            "--backend",
            "s3",
            "--endpoint",
            "https://example.r2.cloudflarestorage.com",
            "--bucket",
            "b",
            "--json",
        ])
        .assert()
        .code(1)
        .stdout(predicate::str::contains("\"code\":\"sync_config_invalid\""))
        .stdout(predicate::str::contains("AGENTERO_SYNC_ACCESS_KEY"));
}

#[test]
fn sync_configure_rejects_plain_http_endpoint_via_stdin() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    let cfg = r#"{
        "backend": "s3",
        "endpoint": "http://minio.example.com",
        "bucket": "b",
        "accessKey": "a",
        "secretKey": "s"
    }"#;
    let mut cmd = agentero();
    cmd.env("HOME", tmp.path().join(".test-home"))
        .args([
            "sync",
            "configure",
            "--vault",
            vault.to_str().unwrap(),
            "--stdin",
            "--json",
        ])
        .write_stdin(cfg)
        .assert()
        .code(1)
        .stdout(predicate::str::contains("must use https"));
}

#[test]
fn sync_test_and_disconnect_without_binding_fail_fast() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("vault");
    create_vault(&vault);

    for sub in ["test", "disconnect"] {
        agentero()
            .env("HOME", tmp.path().join(".test-home"))
            .args(["sync", sub, "--vault", vault.to_str().unwrap(), "--json"])
            .assert()
            .code(1)
            .stdout(predicate::str::contains("\"code\":\"sync_not_configured\""));
    }
}
