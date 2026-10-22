use crate::protocol::{self, Frame, Invocation, Request};
use rquickjs::{Context, Function, Module, Runtime, Value};
use std::time::Instant;

fn execute(input: Invocation) -> Result<serde_json::Value, String> {
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(32 * 1024 * 1024);
    runtime.set_max_stack_size(256 * 1024);
    let deadline = Instant::now() + crate::TIME_LIMIT;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    context.with(|ctx| {
        let result = (|| -> rquickjs::Result<String> {
            let rpc = Function::new(ctx.clone(), |op: String, args: String| -> String {
                let reply = (|| {
                    let args = serde_json::from_str(&args).map_err(|e| e.to_string())?;
                    protocol::send(&Frame::Call {
                        request: Request { op, args },
                    })?;
                    protocol::read_line(std::io::stdin().lock())
                })();
                reply.unwrap_or_else(|error| serde_json::json!({"error": error}).to_string())
            })?;
            ctx.globals().set("__rpc", rpc)?;
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
            )?;
            let (module, ready) = Module::declare(ctx.clone(), "plugin", input.source)?.eval()?;
            ready.finish::<()>()?;
            let kind = input.context.get("kind").and_then(|v| v.as_str()).unwrap_or("command");
            let export = match kind { "activate" => "activate", "deactivate" => "deactivate", "event" => "onEvent", _ => "run" };
            let payload: Value = ctx.json_parse(input.context.to_string())?;
            let value: Value = if export == "run" {
                let run: Function = module.get(export)?;
                run.call((input.command, payload))?
            } else {
                match module.get::<_, Function>(export) {
                    Ok(handler) if export == "onEvent" => handler.call((input.context["event"].as_str().unwrap_or(""), payload))?,
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
            Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
            Err(error) => {
                let exception = ctx.catch();
                let message = exception
                    .as_exception()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| error.to_string());
                Err(message)
            }
        }
    })
}

pub fn worker_main() -> i32 {
    let result = protocol::read_line(std::io::stdin().lock())
        .and_then(|line| serde_json::from_str(&line).map_err(|e| e.to_string()))
        .and_then(execute);
    let frame = match result {
        Ok(value) => Frame::Done { value },
        Err(message) => Frame::Failed { message },
    };
    i32::from(protocol::send(&frame).is_err())
}
