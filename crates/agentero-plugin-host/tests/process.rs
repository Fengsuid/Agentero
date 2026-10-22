use agentero_plugin_host::{
    is_plugin_worker_arg, read_line, run, Invocation, MAX_INVOCATION, WORKER_ARG,
};
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_util::sync::CancellationToken;

fn executable() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_agentero-plugin-host"))
}
fn invocation(source: &str) -> Invocation {
    Invocation {
        source: source.into(),
        command: "inspect".into(),
        context: json!({"paperRef":"papers/demo"}),
    }
}

fn failure_code(err: &str) -> &str {
    err.split_once(": ").map(|(code, _)| code).unwrap_or(err)
}

#[tokio::test]
async fn command_crosses_real_process_boundary_and_uses_broker() {
    let result = run(
        executable(),
        invocation(
            r#"
        export async function run(command, context) {
            const paper = await agentero.call("paper.get", {ref: context.paperRef});
            return `${command}: ${paper.title}`;
        }
    "#,
        ),
        CancellationToken::new(),
        |request| async move {
            assert_eq!(request.op, "paper.get");
            assert_eq!(request.args, json!({"ref":"papers/demo"}));
            Ok(json!({"title":"Demo"}))
        },
    )
    .await
    .unwrap();
    assert_eq!(result.value, "inspect: Demo");
}

#[tokio::test]
async fn guest_has_no_ambient_io_and_broker_denial_reaches_guest() {
    let result = run(executable(), invocation(r#"
        export async function run() {
            if ([typeof process, typeof require, typeof fetch, typeof document, typeof std, typeof os].some(x => x !== "undefined")) throw Error("ambient IO");
            try { await agentero.call("file.write", {}); }
            catch (e) { return e.message; }
            throw Error("permission bypass");
        }
    "#), CancellationToken::new(), |_| async { Err("plugin_operation_denied".into()) }).await.unwrap();
    assert_eq!(result.value, "plugin_operation_denied");
}

#[tokio::test]
async fn cancellation_terminates_a_looping_child_and_next_run_works() {
    let token = CancellationToken::new();
    let cancel = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        cancel.cancel();
    });
    let result = run(
        executable(),
        invocation("export function run() { while (true) {} }"),
        token,
        |_| async { Ok(json!(null)) },
    )
    .await;
    assert_eq!(result.unwrap_err(), "plugin_cancelled");
    let next = run(
        executable(),
        invocation("export function run() { return 'ok'; }"),
        CancellationToken::new(),
        |_| async { Ok(json!(null)) },
    )
    .await
    .unwrap();
    assert_eq!(next.value, "ok");
}

#[tokio::test]
async fn runaway_code_and_memory_exhaustion_fail_within_deadline() {
    for source in [
        "export function run() { while (true) {} }",
        "export function run() { const a = []; while (true) a.push(new Array(100000).fill(1)); }",
        "import * as os from 'os'; export function run() { return os; }",
        "export function run() { throw Error('plugin crashed'); }",
    ] {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            run(
                executable(),
                invocation(source),
                CancellationToken::new(),
                |_| async { Ok(json!(null)) },
            ),
        )
        .await
        .expect("supervisor must terminate child");
        let err = result.expect_err("runaway must fail");
        if source == "export function run() { while (true) {} }" {
            let code = failure_code(&err);
            assert!(
                code == "plugin_timeout" || code == "plugin_exception",
                "{err}"
            );
        }
    }
}

#[tokio::test]
async fn oversized_output_cannot_escape_frame_limit() {
    let result = run(
        executable(),
        invocation("export function run() { return 'x'.repeat(300000); }"),
        CancellationToken::new(),
        |_| async { Ok(json!(null)) },
    )
    .await;
    assert_eq!(failure_code(&result.unwrap_err()), "plugin_frame_too_large");
}

#[tokio::test]
async fn overlong_string_result_is_invalid() {
    let result = run(
        executable(),
        invocation("export function run() { return 'x'.repeat(5000); }"),
        CancellationToken::new(),
        |_| async { Ok(json!(null)) },
    )
    .await;
    assert_eq!(failure_code(&result.unwrap_err()), "plugin_invalid_result");
}

#[tokio::test]
async fn guest_throw_cannot_impersonate_permission_denied() {
    let err = run(
        executable(),
        invocation(r#"export function run() { throw "plugin_permission_denied"; }"#),
        CancellationToken::new(),
        |_| async { Ok(json!(null)) },
    )
    .await
    .unwrap_err();
    assert_eq!(failure_code(&err), "plugin_exception");
    assert_ne!(err, "plugin_permission_denied");
}

#[tokio::test]
async fn call_limit_counts_only_broker_calls() {
    let calls = AtomicUsize::new(0);
    let ok = run(
        executable(),
        invocation(
            r#"
            export async function run() {
                for (let i = 0; i < 64; i++) await agentero.call("ping", {});
                return "done";
            }
            "#,
        ),
        CancellationToken::new(),
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(json!(null)) }
        },
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 64);
    assert_eq!(ok.value, "done");

    let calls = AtomicUsize::new(0);
    let err = run(
        executable(),
        invocation(
            r#"
            export async function run() {
                for (let i = 0; i < 65; i++) await agentero.call("ping", {});
                return "done";
            }
            "#,
        ),
        CancellationToken::new(),
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(json!(null)) }
        },
    )
    .await
    .unwrap_err();
    assert_eq!(calls.load(Ordering::SeqCst), 64);
    assert_eq!(failure_code(&err), "plugin_call_limit");
}

#[tokio::test]
async fn ready_clean_env_is_true_when_parent_clears_env() {
    let output = run(
        executable(),
        invocation("export function run() { return 'ok'; }"),
        CancellationToken::new(),
        |_| async { Ok(json!(null)) },
    )
    .await
    .unwrap();
    assert!(output.clean_env);
    assert_eq!(output.value, "ok");
}

#[tokio::test]
async fn quoted_source_within_invocation_budget_runs() {
    let mut source = String::from("export function run() { return \"ok\"; }\n/*");
    source.push_str(&"\"".repeat(100 * 1024));
    source.push_str("*/");
    assert!(source.len() <= 128 * 1024);
    let output = run(
        executable(),
        invocation(&source),
        CancellationToken::new(),
        |_| async { Ok(json!(null)) },
    )
    .await
    .unwrap();
    assert_eq!(output.value, "ok");
}

#[tokio::test]
async fn oversized_invocation_is_rejected_without_spawn() {
    let mut input = invocation("export function run() { return 'no'; }");
    input.source = "a".repeat(MAX_INVOCATION);
    let err = run(
        Path::new("missing-plugin-worker"),
        input,
        CancellationToken::new(),
        |_| async { Ok(json!(null)) },
    )
    .await
    .unwrap_err();
    assert_eq!(failure_code(&err), "plugin_frame_too_large");
}

#[tokio::test]
async fn lifecycle_and_event_exports_receive_their_snapshot() {
    let mut input = invocation(
        r#"
        export function activate(context) { return context.settings.label; }
        export function onEvent(event, context) { return `${event}:${context.payload.paperId}`; }
        export function deactivate() { return "released"; }
    "#,
    );
    for (kind, expected) in [
        ("activate", "ready"),
        ("event", "paper:opened:demo"),
        ("deactivate", "released"),
    ] {
        input.context = json!({"kind":kind,"event":"paper:opened","payload":{"paperId":"demo"},"settings":{"label":"ready"}});
        let result = run(
            executable(),
            input.clone(),
            CancellationToken::new(),
            |_| async { Err("unexpected call".into()) },
        )
        .await
        .unwrap();
        assert_eq!(result.value, expected);
    }
}

#[test]
fn read_line_returns_both_frames_from_one_buffer() {
    let mut input = std::io::Cursor::new(
        "{\"type\":\"ready\",\"cleanEnv\":true}\n{\"type\":\"done\",\"value\":null}\n",
    );
    let first = read_line(&mut input).unwrap();
    let second = read_line(&mut input).unwrap();
    assert_eq!(first, "{\"type\":\"ready\",\"cleanEnv\":true}\n");
    assert_eq!(second, "{\"type\":\"done\",\"value\":null}\n");
}

#[test]
fn plugin_worker_arg_matches_only_the_exact_flag() {
    assert!(is_plugin_worker_arg(Some(WORKER_ARG)));
    assert!(!is_plugin_worker_arg(None));
    assert!(!is_plugin_worker_arg(Some(
        "--agentero-plugin-worker-extra"
    )));
    assert!(!is_plugin_worker_arg(Some("agentero-plugin-worker")));
}
