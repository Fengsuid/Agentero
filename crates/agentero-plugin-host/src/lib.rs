//! Experimental, command-scoped JS host. No filesystem, network, native-module
//! loader or Node globals are exposed to guest code. This is an API boundary,
//! not an OS sandbox against vulnerabilities in the JS engine.

pub mod manifest;
mod protocol;
mod runtime;
mod supervisor;

pub use protocol::{read_line, Invocation, Request};
pub use runtime::worker_main;
pub use supervisor::{resolve_plugin_worker, run, RunOutput};

pub const WORKER_ARG: &str = "--agentero-plugin-worker";
/// Call replies, Done, and Failed. The invocation frame has its own budget.
pub const MAX_FRAME: usize = 256 * 1024;
pub const MAX_INVOCATION: usize = 2 * 1024 * 1024;
pub const MAX_CALLS: usize = 64;
pub const MAX_RESULT_BYTES: usize = 4096;
/// Guest script budget, measured from the `ready` frame (start of user JS).
pub const TIME_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);
/// Process spawn through the `ready` frame. Not part of [`TIME_LIMIT`].
pub const START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// True when `arg` is the worker flag. A GUI early-exit uses this so a mistaken
/// re-exec cannot open a window. Tests pass the argument; they do not spawn the GUI.
pub fn is_plugin_worker_arg(arg: Option<&str>) -> bool {
    arg == Some(WORKER_ARG)
}
