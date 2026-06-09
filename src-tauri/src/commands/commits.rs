use gitpow_rust::config::Config;
use gitpow_rust::models::{Commit, CommitMetric, CommitsBetweenResponse, Tag};
use gitpow_rust::services::commits as commits_service;
use gitpow_rust::utils::get_repo_path;
use serde::Deserialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Deserialize)]
pub struct GetCommitsParams {
    repo: String,
    branch: Option<String>,
    limit: Option<usize>,
    mode: Option<String>,
    #[allow(dead_code)]
    main_branch: Option<String>,
}

#[derive(Deserialize)]
pub struct GetCommitsBetweenParams {
    repo: String,
    from: String,
    to: String,
}

#[derive(Deserialize)]
pub struct GetCommitMetricsParams {
    repo: String,
    branch: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct GetAllBranchesCommitsParams {
    repo: String,
    limit: Option<usize>,
}

/// Resolve a repo-relative name to an absolute path under the configured
/// repos root, without holding the `Config` lock across the blocking work.
fn repo_path_for(name: &str, config: &State<'_, Mutex<Config>>) -> std::path::PathBuf {
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
pub async fn get_commits(
    params: GetCommitsParams,
    config: State<'_, Mutex<Config>>,
) -> Result<Vec<Commit>, String> {
    let repo_path = repo_path_for(&params.repo, &config);
    let branch = params.branch.unwrap_or_else(|| "HEAD".to_string());
    let limit = params.limit.unwrap_or(2000);
    let mode = params.mode.unwrap_or_else(|| "full".to_string());

    run_blocking(move || commits_service::list_commits(&repo_path, &branch, limit, &mode)).await
}

#[tauri::command]
pub async fn get_commits_all_branches(
    params: GetAllBranchesCommitsParams,
    config: State<'_, Mutex<Config>>,
) -> Result<Vec<Commit>, String> {
    let repo_path = repo_path_for(&params.repo, &config);
    let max_total = params.limit.unwrap_or(2000);

    run_blocking(move || commits_service::list_all_branches_commits(&repo_path, max_total)).await
}

#[tauri::command]
pub async fn get_commits_between(
    params: GetCommitsBetweenParams,
    config: State<'_, Mutex<Config>>,
) -> Result<CommitsBetweenResponse, String> {
    let repo_path = repo_path_for(&params.repo, &config);

    run_blocking(move || {
        commits_service::count_commits_between(&repo_path, &params.from, &params.to)
    })
    .await
}

#[tauri::command]
pub async fn get_commit_metrics(
    params: GetCommitMetricsParams,
    config: State<'_, Mutex<Config>>,
) -> Result<Vec<CommitMetric>, String> {
    let repo_path = repo_path_for(&params.repo, &config);
    let branch = params.branch.unwrap_or_else(|| "HEAD".to_string());
    let limit = params.limit.unwrap_or(100);

    run_blocking(move || commits_service::list_commit_metrics(&repo_path, &branch, limit)).await
}

#[tauri::command]
pub async fn get_tags(repo: String, config: State<'_, Mutex<Config>>) -> Result<Vec<Tag>, String> {
    let repo_path = repo_path_for(&repo, &config);

    run_blocking(move || commits_service::list_tags(&repo_path)).await
}
