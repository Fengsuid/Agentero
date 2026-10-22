use crate::protocol::{encode, Frame, Invocation, Request};
use serde_json::Value;
use std::{future::Future, path::Path, process::Stdio};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

/// One invocation owns one process. All exits (including cancelled callers)
/// kill the child; normal completion also reaps it. The broker owns authority.
pub async fn run<F, Fut>(
    executable: &Path,
    input: Invocation,
    cancel: CancellationToken,
    mut broker: F,
) -> Result<Value, String>
where
    F: FnMut(Request) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let initial = encode(&input)?;
    if cancel.is_cancelled() {
        return Err("plugin_cancelled".into());
    }
    let mut command = tokio::process::Command::new(executable);
    command
        .arg(crate::WORKER_ARG)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut input_pipe = child.stdin.take().ok_or("plugin_missing_stdin")?;
    let mut output = BufReader::new(child.stdout.take().ok_or("plugin_missing_stdout")?);
    let exchange = async {
        input_pipe
            .write_all(&initial)
            .await
            .map_err(|e| e.to_string())?;
        // A bounded call count also prevents unbounded IPC churn.
        for _ in 0..64 {
            let mut line = Vec::new();
            (&mut output)
                .take(crate::MAX_FRAME as u64 + 1)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|e| e.to_string())?;
            if line.len() > crate::MAX_FRAME || line.last() != Some(&b'\n') {
                return Err("plugin_invalid_frame".into());
            }
            match serde_json::from_slice::<Frame>(&line).map_err(|e| e.to_string())? {
                Frame::Done { value } => return Ok(value),
                Frame::Failed { message } => return Err(message),
                Frame::Call { request } => {
                    let reply = match broker(request).await {
                        Ok(data) => serde_json::json!({"data": data}),
                        Err(error) => serde_json::json!({"error": error}),
                    };
                    input_pipe
                        .write_all(&encode(&reply)?)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Err("plugin_call_limit".into())
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("plugin_cancelled".into()),
        result = tokio::time::timeout(crate::TIME_LIMIT, exchange) =>
            result.unwrap_or_else(|_| Err("plugin_timeout".into())),
    };
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}
