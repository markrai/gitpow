use crate::config::Config;
use crate::git::repository::GitRepository;
use crate::models::{
    BranchStatusResponse, ErrorResponse, GitOperationResponse, StashListResponse,
};
use crate::services::git_ops as git_ops_service;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
pub struct StashPushQuery {
    message: Option<String>,
}

#[derive(Deserialize)]
pub struct StashRefQuery {
    #[serde(rename = "ref")]
    stash_ref: Option<String>,
}

fn internal_error(error: String) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse { error }),
    )
}

fn not_found() -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: "Repository not found".to_string(),
        }),
    )
}

/// Run a blocking service call off the async runtime. Errors become 500s.
async fn run_blocking<F, T>(f: F) -> Result<T, (StatusCode, Json<ErrorResponse>)>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| internal_error(format!("Task join error: {}", e)))?
        .map_err(internal_error)
}

/// Get the current branch status including ahead/behind counts and stash info.
/// Still handler-local because it's a small read that isn't shared with the
/// Tauri shell's `get_branch_status` (which uses its own typed model).
pub async fn get_branch_status(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
) -> Result<Json<BranchStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = PathBuf::from(&config.repos_root).join(&repo_name);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(not_found());
    }

    let git_repo = GitRepository::open(&repo_path)
        .map_err(|e| internal_error(format!("Failed to open repository: {}", e)))?;

    let branch = git_repo
        .get_current_branch()
        .unwrap_or_else(|_| "HEAD".to_string());
    let has_upstream = git_repo.has_upstream().unwrap_or(false);
    let (ahead, behind) = if has_upstream {
        git_repo.get_ahead_behind_upstream().unwrap_or((0, 0))
    } else {
        (0, 0)
    };
    let has_uncommitted = git_repo.has_uncommitted_changes().unwrap_or(false);
    let stash_count = git_repo.stash_list().map(|l| l.len()).unwrap_or(0);

    Ok(Json(BranchStatusResponse {
        branch,
        has_upstream,
        ahead,
        behind,
        has_uncommitted,
        stash_count,
    }))
}

pub async fn pull_repo(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = PathBuf::from(&config.repos_root).join(&repo_name);
    let response = run_blocking(move || git_ops_service::pull(&repo_path)).await?;
    Ok(Json(response))
}

pub async fn push_repo(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = PathBuf::from(&config.repos_root).join(&repo_name);
    let response = run_blocking(move || git_ops_service::push(&repo_path)).await?;
    Ok(Json(response))
}

pub async fn stash_list(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
) -> Result<Json<StashListResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = PathBuf::from(&config.repos_root).join(&repo_name);
    let entries = run_blocking(move || git_ops_service::stash_list(&repo_path)).await?;
    Ok(Json(StashListResponse { entries }))
}

pub async fn stash_push(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
    Query(params): Query<StashPushQuery>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = PathBuf::from(&config.repos_root).join(&repo_name);
    let response = run_blocking(move || {
        git_ops_service::stash_push(&repo_path, params.message.as_deref())
    })
    .await?;
    Ok(Json(response))
}

pub async fn stash_pop(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = PathBuf::from(&config.repos_root).join(&repo_name);
    let response = run_blocking(move || git_ops_service::stash_pop(&repo_path)).await?;
    Ok(Json(response))
}

pub async fn stash_apply(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
    Query(params): Query<StashRefQuery>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = PathBuf::from(&config.repos_root).join(&repo_name);
    let response = run_blocking(move || {
        git_ops_service::stash_apply(&repo_path, params.stash_ref.as_deref())
    })
    .await?;
    Ok(Json(response))
}

pub async fn stash_drop(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
    Query(params): Query<StashRefQuery>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = PathBuf::from(&config.repos_root).join(&repo_name);
    let response = run_blocking(move || {
        git_ops_service::stash_drop(&repo_path, params.stash_ref.as_deref())
    })
    .await?;
    Ok(Json(response))
}
