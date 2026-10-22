use crate::protocol::{self, Frame, Invocation, Request};
use rquickjs::{Context, Ctx, Function, Module, Runtime, Value};
use std::{
    cell::Cell,
    io::BufReader,
    rc::Rc,
    sync::{Mutex, OnceLock},
    time::Instant,
};

const GUEST_MESSAGE_CHARS: usize = 500;

struct HostError {
    code: &'static str,
    message: String,
}

impl HostError {
    fn code(code: &'static str) -> Self {
        Self {
            code,
            message: String::new(),
        }
    }

    fn from_protocol(code: String) -> Self {
        match code.as_str() {
            "plugin_frame_too_large" => Self::code("plugin_frame_too_large"),
            "plugin_invalid_frame" => Self::code("plugin_invalid_frame"),
            "plugin_worker_failed" => Self::code("plugin_worker_failed"),
            other => Self::worker(other),
        }
    }

    fn worker(detail: impl AsRef<str>) -> Self {
        Self {
            code: "plugin_worker_failed",
            message: flat(detail.as_ref(), GUEST_MESSAGE_CHARS),
        }
    }

    fn exception(detail: impl AsRef<str>) -> Self {
        Self {
            code: "plugin_exception",
            message: flat(detail.as_ref(), GUEST_MESSAGE_CHARS),
        }
    }
}

fn flat(raw: &str, max_chars: usize) -> String {
    raw.chars()
        .take(max_chars)
        .map(|c| match c {
            '\n' | '\r' => ' ',
            other => other,
        })
        .collect()
}

fn stdin_reader() -> &'static Mutex<BufReader<std::io::Stdin>> {
    static READER: OnceLock<Mutex<BufReader<std::io::Stdin>>> = OnceLock::new();
    READER.get_or_init(|| Mutex::new(BufReader::new(std::io::stdin())))
}

fn lock_stdin() -> std::sync::MutexGuard<'static, BufReader<std::io::Stdin>> {
    stdin_reader().lock().unwrap_or_else(|err| err.into_inner())
}

fn execute(input: Invocation) -> Result<serde_json::Value, HostError> {
    let runtime = Runtime::new().map_err(|err| HostError::worker(err.to_string()))?;
    runtime.set_memory_limit(32 * 1024 * 1024);
    runtime.set_max_stack_size(256 * 1024);
    let deadline = Rc::new(Cell::new(None));
    {
        let deadline = Rc::clone(&deadline);
        runtime.set_interrupt_handler(Some(Box::new(move || match deadline.get() {
            Some(end) => Instant::now() >= end,
            None => false,
        })));
    }
    let context = Context::full(&runtime).map_err(|err| HostError::worker(err.to_string()))?;
    context.with(|ctx| {
        install_host(&ctx)?;
        let clean_env = std::env::vars().next().is_none();
        // Guest budget starts with ready, not process spawn.
        deadline.set(Some(Instant::now() + crate::TIME_LIMIT));
        protocol::send(&Frame::Ready { clean_env }).map_err(HostError::from_protocol)?;
        eval_user(&ctx, &input)
    })
}

fn install_host(ctx: &Ctx<'_>) -> Result<(), HostError> {
    let rpc = Function::new(ctx.clone(), |op: String, args: String| -> String {
        let reply = (|| {
            let args =
                serde_json::from_str(&args).map_err(|_| "plugin_invalid_frame".to_string())?;
            protocol::send(&Frame::Call {
                request: Request { op, args },
            })?;
            let mut reader = lock_stdin();
            protocol::read_line(&mut *reader)
        })();
        reply.unwrap_or_else(|error| serde_json::json!({"error": error}).to_string())
    })
    .map_err(|err| HostError::worker(err.to_string()))?;
    ctx.globals()
        .set("__rpc", rpc)
        .map_err(|err| HostError::worker(err.to_string()))?;
    ctx.eval::<(), _>(
        r#"
        globalThis.agentero = Object.freeze({
            call: async (op, args = {}) => {
                const reply = JSON.parse(__rpc(op, JSON.stringify(args)));
                if (reply.error) { const error = new Error(reply.error); error.code = reply.error.split(":")[0]; throw error; }
                return reply.data;
            }
        });
    "#,
    )
    .map_err(|err| HostError::worker(err.to_string()))
}

fn eval_user(ctx: &Ctx<'_>, input: &Invocation) -> Result<serde_json::Value, HostError> {
    let result = (|| -> rquickjs::Result<String> {
        let (module, ready) =
            Module::declare(ctx.clone(), "plugin", input.source.clone())?.eval()?;
        ready.finish::<()>()?;
        let kind = input
            .context
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or("command");
        let export = match kind {
            "activate" => "activate",
            "deactivate" => "deactivate",
            "event" => "onEvent",
            _ => "run",
        };
        let payload: Value = ctx.json_parse(input.context.to_string())?;
        let value: Value = if export == "run" {
            let run: Function = module.get(export)?;
            run.call((input.command.clone(), payload))?
        } else {
            match module.get::<_, Function>(export) {
                Ok(handler) if export == "onEvent" => {
                    handler.call((input.context["event"].as_str().unwrap_or(""), payload))?
                }
                Ok(handler) => handler.call((payload,))?,
                Err(_) => Value::new_null(ctx.clone()),
            }
        };
        // Promise.resolve also accepts a synchronous plugin result.
        ctx.globals().set("__result", value)?;
        let promise: rquickjs::Promise =
            ctx.eval("Promise.resolve(__result).then(value => JSON.stringify(value ?? null))")?;
        promise.finish()
    })();
    match result {
        Ok(json) => {
            serde_json::from_str(&json).map_err(|_| HostError::code("plugin_invalid_result"))
        }
        Err(error) => Err(HostError::exception(caught_message(ctx, &error))),
    }
}

fn caught_message(ctx: &Ctx<'_>, error: &rquickjs::Error) -> String {
    let caught = ctx.catch();
    if let Some(text) = caught.as_string().and_then(|text| text.to_string().ok()) {
        return text;
    }
    if let Some(exception) = caught.as_exception() {
        return exception.to_string();
    }
    error.to_string()
}

fn exit_with(result: Result<serde_json::Value, HostError>) -> i32 {
    let sent = match result {
        Ok(value) => match protocol::encode(&Frame::Done { value }) {
            Ok(bytes) => protocol::write_frame(&bytes).is_ok(),
            Err(code) => {
                let code = if code == "plugin_frame_too_large" {
                    "plugin_frame_too_large"
                } else {
                    "plugin_worker_failed"
                };
                protocol::send(&Frame::Failed {
                    code: code.into(),
                    message: String::new(),
                })
                .is_ok()
            }
        },
        Err(error) => protocol::send(&Frame::Failed {
            code: error.code.into(),
            message: error.message,
        })
        .is_ok(),
    };
    i32::from(!sent)
}

pub fn worker_main() -> i32 {
    let parsed = (|| {
        let line = {
            let mut reader = lock_stdin();
            protocol::read_limited(&mut *reader, crate::MAX_INVOCATION)
                .map_err(HostError::from_protocol)?
        };
        serde_json::from_str(&line).map_err(|_| HostError::code("plugin_invalid_frame"))
    })();
    exit_with(parsed.and_then(execute))
}
