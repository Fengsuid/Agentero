//! TypeSafe jEV integration: smart paper highlighting.

pub mod commands;
pub mod runner;
mod service;

pub use service::SuggestedHighlight;

/// Register JobCenter runners defined by this feature.
pub fn register_job_runners(center: &crate::features::jobs::JobCenter) {
    runner::register_job_runners(center);
}
