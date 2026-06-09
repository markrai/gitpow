use gitpow_rust::config::Config;
use gitpow_rust::git::repository::GitRepository;
use gitpow_rust::models::{GitOperationResponse, StashListResponse};
use gitpow_rust::services::git_ops as git_ops_service;
use gitpow_rust::utils::get_repo_path;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

fn repo_path_for(name: &str, config: &State<'_, Mutex<Config>>) -> PathBuf {
    let repos_root = config.lock().unwrap().repos_root.clone();
    get_repo_path(name, &repos_root)
}

async fn run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn pull_repo(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<GitOperationResponse, String> {
    let repo_path = repo_path_for(&repo, &config);
    run_blocking(move || git_ops_service::pull(&repo_path)).await
}

#[tauri::command]
pub async fn push_repo(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<GitOperationResponse, String> {
    let repo_path = repo_path_for(&repo, &config);
    run_blocking(move || git_ops_service::push(&repo_path)).await
}

#[tauri::command]
pub async fn stash_list(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<StashListResponse, String> {
    let repo_path = repo_path_for(&repo, &config);
    let entries = run_blocking(move || git_ops_service::stash_list(&repo_path)).await?;
    Ok(StashListResponse { entries })
}

#[tauri::command]
pub async fn stash_push(
    repo: String,
    message: Option<String>,
    config: State<'_, Mutex<Config>>,
) -> Result<GitOperationResponse, String> {
    let repo_path = repo_path_for(&repo, &config);
    run_blocking(move || git_ops_service::stash_push(&repo_path, message.as_deref())).await
}

#[tauri::command]
pub async fn stash_pop(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<GitOperationResponse, String> {
    let repo_path = repo_path_for(&repo, &config);
    run_blocking(move || git_ops_service::stash_pop(&repo_path)).await
}

#[tauri::command]
pub async fn stash_apply(
    repo: String,
    stash_ref: Option<String>,
    config: State<'_, Mutex<Config>>,
) -> Result<GitOperationResponse, String> {
    let repo_path = repo_path_for(&repo, &config);
    run_blocking(move || git_ops_service::stash_apply(&repo_path, stash_ref.as_deref())).await
}

#[tauri::command]
pub async fn stash_drop(
    repo: String,
    stash_ref: Option<String>,
    config: State<'_, Mutex<Config>>,
) -> Result<GitOperationResponse, String> {
    let repo_path = repo_path_for(&repo, &config);
    run_blocking(move || git_ops_service::stash_drop(&repo_path, stash_ref.as_deref())).await
}

/// Checkout a specific commit, putting the repo into detached-HEAD state.
/// Not shared with the HTTP handler (Tauri-only surface today).
#[tauri::command]
pub fn checkout_commit(
    repo: String,
    commit_sha: String,
    config: State<'_, Mutex<Config>>,
) -> Result<serde_json::Value, String> {
    let repo_path = repo_path_for(&repo, &config);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.checkout_commit(&commit_sha) {
            Ok(output) => Ok(serde_json::json!({
                "success": true,
                "message": "Checkout successful",
                "output": output
            })),
            Err(e) => Ok(serde_json::json!({
                "success": false,
                "error": format!("Failed to checkout commit: {}", e),
                "message": format!("Checkout failed: {}", e)
            })),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

#[tauri::command]
pub fn checkout_branch(
    repo: String,
    branch_name: String,
    config: State<'_, Mutex<Config>>,
) -> Result<serde_json::Value, String> {
    let repo_path = repo_path_for(&repo, &config);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.checkout_branch(&branch_name) {
            Ok(output) => Ok(serde_json::json!({
                "success": true,
                "message": "Checkout successful",
                "output": output
            })),
            Err(e) => Ok(serde_json::json!({
                "success": false,
                "error": format!("Failed to checkout branch: {}", e),
                "message": format!("Checkout failed: {}", e)
            })),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

#[tauri::command]
pub fn get_previous_branch(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<Option<String>, String> {
    let repo_path = repo_path_for(&repo, &config);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => repo
            .get_previous_branch_from_reflog()
            .map_err(|e| format!("Failed to get previous branch: {}", e)),
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

/// Best branch to check out when exiting detached HEAD. Uses the reflog
/// first, falling back to the repo's default branch.
#[tauri::command]
pub fn get_best_branch_to_checkout(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<Option<String>, String> {
    let repo_path = repo_path_for(&repo, &config);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    let git_repo =
        GitRepository::open(&repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    if let Ok(Some(previous_branch)) = git_repo.get_previous_branch_from_reflog() {
        if let Ok(branch_info) = git_repo.get_branch_info() {
            if branch_info.branches.contains(&previous_branch) {
                return Ok(Some(previous_branch));
            }
        }
    }

    git_repo
        .get_default_branch()
        .map_err(|e| format!("Failed to get default branch: {}", e))
}
