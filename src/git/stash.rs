//! Stash operations on `GitRepository`.
//!
//! These live in their own submodule so the giant `repository.rs` can keep
//! shrinking; Rust lets us attach methods to `GitRepository` from any file
//! in the same crate.

use anyhow::Result;

use crate::models::StashEntry;

use super::repository::GitRepository;

impl GitRepository {
    /// Stash uncommitted changes. When `message` is `Some`, use it as the
    /// stash description.
    pub fn stash_push(&self, message: Option<&str>) -> Result<String> {
        match message {
            Some(msg) => self.run_git(&["stash", "push", "-m", msg]),
            None => self.run_git(&["stash", "push"]),
        }
    }

    /// Pop the most recent stash.
    pub fn stash_pop(&self) -> Result<String> {
        self.run_git(&["stash", "pop"])
    }

    /// List all stashes, newest first.
    ///
    /// We ask git for a `US`-delimited record (`%x1f`) so messages
    /// containing commas or other typical separators don't get mangled.
    pub fn stash_list(&self) -> Result<Vec<StashEntry>> {
        let output = self.run_git(&["stash", "list", "--format=%gd%x1f%s%x1f%ai"])?;
        let entries = output
            .lines()
            .filter(|line| !line.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\x1f').collect();
                if parts.len() >= 3 {
                    Some(StashEntry {
                        index: parts[0].to_string(),
                        message: parts[1].to_string(),
                        date: parts[2].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();
        Ok(entries)
    }

    /// Apply a specific stash by ref (e.g. `stash@{0}`).
    pub fn stash_apply(&self, stash_ref: &str) -> Result<String> {
        self.run_git(&["stash", "apply", stash_ref])
    }

    /// Drop a specific stash by ref (e.g. `stash@{0}`).
    pub fn stash_drop(&self, stash_ref: &str) -> Result<String> {
        self.run_git(&["stash", "drop", stash_ref])
    }
}
