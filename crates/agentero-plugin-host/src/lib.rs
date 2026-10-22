//! Experimental, command-scoped JS host. No filesystem, network, native-module
//! loader or Node globals are exposed to guest code. This is an API boundary,
//! not an OS sandbox against vulnerabilities in the JS engine.

pub mod manifest;
mod protocol;
mod runtime;
mod supervisor;

pub use protocol::{Invocation, Request};
pub use runtime::worker_main;
pub use supervisor::run;

pub const WORKER_ARG: &str = "--agentero-plugin-worker";
pub const MAX_FRAME: usize = 256 * 1024;
pub const TIME_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);
