//! reqforge: requirements engineering -> delivery plan -> evals -> CI/CD, stored in git/GitHub.

pub mod api;
pub mod changes;
pub mod chat;
pub mod cicd;
pub mod cli;
pub mod console;
pub mod csvio;
pub mod evals;
pub mod lint;
pub mod mcp;
pub mod model;
pub mod query;
pub mod store;
pub mod trace;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
