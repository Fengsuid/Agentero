use agentero_plugin_host::{run, Invocation};
use serde_json::json;
use std::path::Path;
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
    assert_eq!(result, "inspect: Demo");
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
    assert_eq!(result, "plugin_operation_denied");
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
    assert_eq!(next, "ok");
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
        assert!(result.is_err());
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
    assert!(result.is_err());
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
        assert_eq!(result, expected);
    }
}
