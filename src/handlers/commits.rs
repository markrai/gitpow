use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
};
use serde::Deserialize;

use crate::config::Config;
use crate::models::{Commit, CommitMetric, CommitsBetweenResponse, ErrorResponse, Tag};
use crate::services::commits as commits_service;
use crate::utils::get_repo_path;

#[derive(Deserialize)]
pub struct CommitsQuery {
    branch: Option<String>,
    limit: Option<usize>,
    mode: Option<String>,
}

#[derive(Deserialize)]
pub struct CommitsBetweenQuery {
    from: String,
    to: String,
}

#[derive(Deserialize)]
pub struct CommitMetricsQuery {
    branch: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct AllBranchesCommitsQuery {
    limit: Option<usize>,
}

fn internal_error(error: String) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse { error }),
    )
}

/// Run a blocking service call off the async runtime and map both join and
/// service errors to a 500 JSON response.
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

pub async fn get_commits(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<CommitsQuery>,
) -> Result<Json<Vec<Commit>>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);
    let branch = params.branch.unwrap_or_else(|| "HEAD".to_string());
    let limit = params.limit.unwrap_or(2000);
    let mode = params.mode.unwrap_or_else(|| "full".to_string());

    let commits =
        run_blocking(move || commits_service::list_commits(&repo_path, &branch, limit, &mode))
            .await?;

    Ok(Json(commits))
}

/// Aggregated all-branches commit history for graph "All" mode.
pub async fn get_commits_all_branches(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<AllBranchesCommitsQuery>,
) -> Result<Json<Vec<Commit>>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);
    let max_total = params.limit.unwrap_or(2000);

    let commits =
        run_blocking(move || commits_service::list_all_branches_commits(&repo_path, max_total))
            .await?;

    Ok(Json(commits))
}

pub async fn get_commits_between(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<CommitsBetweenQuery>,
) -> Result<Json<CommitsBetweenResponse>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);

    let response = run_blocking(move || {
        commits_service::count_commits_between(&repo_path, &params.from, &params.to)
    })
    .await?;

    Ok(Json(response))
}

pub async fn get_commit_metrics(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<CommitMetricsQuery>,
) -> Result<Json<Vec<CommitMetric>>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);
    let branch = params.branch.unwrap_or_else(|| "HEAD".to_string());
    let limit = params.limit.unwrap_or(100);

    let metrics =
        run_blocking(move || commits_service::list_commit_metrics(&repo_path, &branch, limit))
            .await?;

    Ok(Json(metrics))
}

pub async fn get_tags(
    State(config): State<Config>,
    Path(repo): Path<String>,
) -> Result<Json<Vec<Tag>>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);

    let tags = run_blocking(move || commits_service::list_tags(&repo_path)).await?;

    Ok(Json(tags))
}
