use crate::protocol::{encode, encode_invocation, Frame, Invocation, Request};
use serde_json::Value;
use std::{
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct RunOutput {
    pub value: Value,
    pub clean_env: bool,
}

/// One invocation owns one process. All exits (including cancelled callers)
/// kill the child; normal completion also reaps it. The broker owns authority.
/// Spawn and the invocation write sit outside [`crate::TIME_LIMIT`]. That budget
/// starts only after the child sends `ready`.
pub async fn run<F, Fut>(
    executable: &Path,
    input: Invocation,
    cancel: CancellationToken,
    mut broker: F,
) -> Result<RunOutput, String>
where
    F: FnMut(Request) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    if cancel.is_cancelled() {
        return Err(closed("plugin_cancelled", ""));
    }
    let initial = encode_invocation(&input)?;
    if !executable.is_file() {
        return Err(closed("plugin_worker_missing", ""));
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
    let mut child = command.spawn().map_err(|err| spawn_error(&err))?;
    let mut input_pipe = child
        .stdin
        .take()
        .ok_or_else(|| closed("plugin_worker_failed", "missing stdin"))?;
    let mut output = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| closed("plugin_worker_failed", "missing stdout"))?,
    );
    let exchange = async {
        input_pipe
            .write_all(&initial)
            .await
            .map_err(|err| io_error(&err))?;
        input_pipe.flush().await.map_err(|err| io_error(&err))?;
        let started = tokio::time::timeout(crate::START_TIMEOUT, read_child_frame(&mut output))
            .await
            .map_err(|_| closed("plugin_worker_start_timeout", ""))??;
        let clean_env = match started {
            Frame::Ready { clean_env } => clean_env,
            Frame::Failed { code, message } => return Err(from_child(&code, &message)),
            _ => return Err(closed("plugin_invalid_frame", "")),
        };
        let value = tokio::time::timeout(
            crate::TIME_LIMIT,
            call_loop(&mut input_pipe, &mut output, &mut broker),
        )
        .await
        .map_err(|_| closed("plugin_timeout", ""))??;
        Ok(RunOutput { value, clean_env })
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(closed("plugin_cancelled", "")),
        result = exchange => result,
    };
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

async fn call_loop<R, F, Fut>(
    input_pipe: &mut tokio::process::ChildStdin,
    output: &mut R,
    broker: &mut F,
) -> Result<Value, String>
where
    R: AsyncBufRead + Unpin,
    F: FnMut(Request) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let mut calls = 0usize;
    loop {
        match read_child_frame(output).await? {
            Frame::Done { value } => return accept_result(value),
            Frame::Failed { code, message } => return Err(from_child(&code, &message)),
            Frame::Ready { .. } => return Err(closed("plugin_invalid_frame", "")),
            Frame::Call { request } => {
                if calls >= crate::MAX_CALLS {
                    // The extra Call must not reach the broker.
                    return Err(closed("plugin_call_limit", ""));
                }
                calls += 1;
                let reply = match broker(request).await {
                    Ok(data) => serde_json::json!({"data": data}),
                    Err(error) => serde_json::json!({"error": error}),
                };
                let bytes = encode(&reply)?;
                input_pipe
                    .write_all(&bytes)
                    .await
                    .map_err(|err| io_error(&err))?;
                input_pipe.flush().await.map_err(|err| io_error(&err))?;
            }
        }
    }
}

fn accept_result(value: Value) -> Result<Value, String> {
    if value.is_null() {
        return Ok(value);
    }
    match value.as_str() {
        Some(text) if text.len() <= crate::MAX_RESULT_BYTES => Ok(value),
        _ => Err(closed("plugin_invalid_result", "")),
    }
}

async fn read_child_frame<R>(reader: &mut R) -> Result<Frame, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    loop {
        let (take, done) = {
            let buf = reader.fill_buf().await.map_err(|err| io_error(&err))?;
            if buf.is_empty() {
                (0, true)
            } else if let Some(pos) = buf.iter().position(|byte| *byte == b'\n') {
                let take = pos + 1;
                if line.len() + take > crate::MAX_FRAME {
                    return Err(closed("plugin_invalid_frame", ""));
                }
                line.extend_from_slice(&buf[..take]);
                (take, true)
            } else {
                let take = buf.len();
                if line.len() + take > crate::MAX_FRAME {
                    return Err(closed("plugin_invalid_frame", ""));
                }
                line.extend_from_slice(buf);
                (take, false)
            }
        };
        if take == 0 {
            break;
        }
        reader.consume(take);
        if done {
            break;
        }
    }
    if line.last() != Some(&b'\n') {
        return Err(if line.is_empty() {
            closed("plugin_worker_failed", "no frame")
        } else {
            closed("plugin_invalid_frame", "")
        });
    }
    serde_json::from_slice(&line).map_err(|_| closed("plugin_invalid_frame", ""))
}

pub fn resolve_plugin_worker() -> Result<PathBuf, String> {
    if let Some(raw) = std::env::var_os("AGENTERO_PLUGIN_WORKER") {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Some(path) = sibling_worker() {
        return Ok(path);
    }
    #[cfg(debug_assertions)]
    if let Some(path) = debug_worker() {
        return Ok(path);
    }
    Err(closed("plugin_worker_missing", ""))
}

fn sibling_worker() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    first_worker(exe.parent()?)
}

#[cfg(debug_assertions)]
fn debug_worker() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for rel in ["target/debug", "src-tauri/target/debug"] {
        if let Some(path) = first_worker(&root.join(rel)) {
            return Some(path);
        }
    }
    None
}

fn first_worker(dir: &Path) -> Option<PathBuf> {
    worker_file_names()
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn worker_file_names() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &["agentero-plugin-host.exe", "agentero-plugin-host"]
    }
    #[cfg(not(windows))]
    {
        &["agentero-plugin-host", "agentero-plugin-host.exe"]
    }
}

fn spawn_error(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        closed("plugin_worker_missing", "")
    } else {
        io_error(error)
    }
}

fn io_error(error: &std::io::Error) -> String {
    closed("plugin_worker_failed", &error.to_string())
}

fn from_child(code: &str, message: &str) -> String {
    match known_code(code) {
        Some(code) => closed(code, message),
        None => closed("plugin_worker_failed", ""),
    }
}

fn known_code(code: &str) -> Option<&'static str> {
    Some(match code {
        "plugin_exception" => "plugin_exception",
        "plugin_timeout" => "plugin_timeout",
        "plugin_worker_start_timeout" => "plugin_worker_start_timeout",
        "plugin_frame_too_large" => "plugin_frame_too_large",
        "plugin_invalid_frame" => "plugin_invalid_frame",
        "plugin_invalid_result" => "plugin_invalid_result",
        "plugin_call_limit" => "plugin_call_limit",
        "plugin_cancelled" => "plugin_cancelled",
        "plugin_worker_missing" => "plugin_worker_missing",
        "plugin_worker_failed" => "plugin_worker_failed",
        _ => return None,
    })
}

fn closed(code: &'static str, message: &str) -> String {
    let message = flat(message);
    if cfg!(debug_assertions) && !message.is_empty() {
        format!("{code}: {message}")
    } else {
        code.to_string()
    }
}

fn flat(raw: &str) -> String {
    raw.chars()
        .take(500)
        .map(|c| match c {
            '\n' | '\r' => ' ',
            other => other,
        })
        .collect()
}
