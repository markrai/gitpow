//! Git-operation services: pull, push, and the full stash surface.
//!
//! The HTTP handler and the Tauri command each used to own a nearly
//! identical copy of this orchestration. Both now call these functions so
//! behavior can only drift in one place.
//!
//! All functions are blocking and must be invoked from a blocking-friendly
//! executor (e.g. `tokio::task::spawn_blocking`).

use std::path::Path;

use crate::git::repository::GitRepository;
use crate::models::{GitOperationResponse, StashEntry};

fn open_repo(repo_path: &Path) -> Result<GitRepository, String> {
    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }
    GitRepository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))
}

fn success(message: impl Into<String>, output: String) -> GitOperationResponse {
    GitOperationResponse {
        success: true,
        message: Some(message.into()),
        output: Some(output),
        error: None,
    }
}

fn failure(error: String) -> GitOperationResponse {
    GitOperationResponse {
        success: false,
        message: None,
        output: None,
        error: Some(error),
    }
}

fn skipped(message: impl Into<String>) -> GitOperationResponse {
    GitOperationResponse {
        success: false,
        message: Some(message.into()),
        output: None,
        error: None,
    }
}

/// Pull from the upstream branch if one is configured. No-ops (non-error
/// `success: false`) when there's no upstream so the UI can prompt for one.
pub fn pull(repo_path: &Path) -> Result<GitOperationResponse, String> {
    let git_repo = open_repo(repo_path)?;

    if !git_repo.has_upstream().unwrap_or(false) {
        return Ok(GitOperationResponse {
            success: false,
            message: Some("No upstream branch configured".to_string()),
            output: None,
            error: Some(
                "No upstream branch configured. Push first or set upstream manually.".to_string(),
            ),
        });
    }

    Ok(match git_repo.pull() {
        Ok(output) => success("Pull successful", output),
        Err(e) => failure(e.to_string()),
    })
}

/// Push to the upstream branch, or set the upstream to the current branch on
/// the default remote if none is configured.
pub fn push(repo_path: &Path) -> Result<GitOperationResponse, String> {
    let git_repo = open_repo(repo_path)?;

    if git_repo.has_upstream().unwrap_or(false) {
        return Ok(match git_repo.push() {
            Ok(output) => success("Push successful", output),
            Err(e) => failure(e.to_string()),
        });
    }

    let branch = git_repo
        .get_current_branch()
        .unwrap_or_else(|_| "HEAD".to_string());
    Ok(match git_repo.push_set_upstream(&branch) {
        Ok(output) => success(
            format!("Pushed and set upstream for branch '{}'", branch),
            output,
        ),
        Err(e) => failure(e.to_string()),
    })
}

/// List all stash entries, newest first.
pub fn stash_list(repo_path: &Path) -> Result<Vec<StashEntry>, String> {
    let git_repo = open_repo(repo_path)?;
    Ok(git_repo.stash_list().unwrap_or_default())
}

/// Stash local changes. Returns a non-error skip if there's nothing to stash.
pub fn stash_push(repo_path: &Path, message: Option<&str>) -> Result<GitOperationResponse, String> {
    let git_repo = open_repo(repo_path)?;

    if !git_repo.has_uncommitted_changes().unwrap_or(false) {
        return Ok(skipped("No local changes to stash"));
    }

    Ok(match git_repo.stash_push(message) {
        Ok(output) => success("Changes stashed", output),
        Err(e) => failure(e.to_string()),
    })
}

/// Pop the most recent stash. Returns a non-error skip if the stash stack is
/// empty.
pub fn stash_pop(repo_path: &Path) -> Result<GitOperationResponse, String> {
    let git_repo = open_repo(repo_path)?;

    let stashes = git_repo.stash_list().unwrap_or_default();
    if stashes.is_empty() {
        return Ok(skipped("No stashes to pop"));
    }

    Ok(match git_repo.stash_pop() {
        Ok(output) => success("Stash popped", output),
        Err(e) => failure(e.to_string()),
    })
}

/// Apply a specific stash ref (default `stash@{0}`).
pub fn stash_apply(
    repo_path: &Path,
    stash_ref: Option<&str>,
) -> Result<GitOperationResponse, String> {
    let git_repo = open_repo(repo_path)?;
    let stash_ref = stash_ref.unwrap_or("stash@{0}");

    Ok(match git_repo.stash_apply(stash_ref) {
        Ok(output) => success(format!("Stash {} applied", stash_ref), output),
        Err(e) => failure(e.to_string()),
    })
}

/// Drop a specific stash ref (default `stash@{0}`).
pub fn stash_drop(
    repo_path: &Path,
    stash_ref: Option<&str>,
) -> Result<GitOperationResponse, String> {
    let git_repo = open_repo(repo_path)?;
    let stash_ref = stash_ref.unwrap_or("stash@{0}");

    Ok(match git_repo.stash_drop(stash_ref) {
        Ok(output) => success(format!("Stash {} dropped", stash_ref), output),
        Err(e) => failure(e.to_string()),
    })
}
