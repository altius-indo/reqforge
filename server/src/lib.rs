//! reqforge: requirements engineering -> delivery plan -> evals -> CI/CD, stored in git/GitHub.

pub mod agent;
pub mod api;
pub mod changes;
pub mod chat;
pub mod cicd;
pub mod complete;
pub mod codetrace;
pub mod cli;
pub mod console;
pub mod csvio;
pub mod design;
pub mod evidence;
pub mod evals;
pub mod impact;
pub mod lint;
pub mod mcp;
pub mod model;
pub mod query;
pub mod queue;
pub mod store;
pub mod taskflow;
pub mod trace;
pub mod verify;
pub mod workspace;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
