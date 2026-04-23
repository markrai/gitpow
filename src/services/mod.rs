//! Application services shared by the Axum binary and the Tauri shell.
//!
//! These functions own the orchestration that was previously duplicated
//! between `handlers/` (HTTP) and `src-tauri/src/commands/` (IPC). Each
//! service is synchronous and performs blocking libgit2 work, so callers
//! must invoke it inside `tokio::task::spawn_blocking` (or a rayon worker)
//! to stay off the async runtime.
//!
//! Errors are returned as `String` so both transports can propagate them
//! uniformly without leaking `anyhow`/`git2` types across layers.

pub mod commits;
pub mod git_ops;
