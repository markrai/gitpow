use crate::config::Config;
use crate::git::repository::GitRepository;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use std::path::PathBuf;

pub async fn fetch_repo(
    State(config): State<Config>,
    Path(repo_name): Path<String>,
) -> impl IntoResponse {
    let repo_path = PathBuf::from(&config.repos_root).join(repo_name);

    if !repo_path.exists() || !repo_path.is_dir() {
        return (StatusCode::NOT_FOUND, "Repository not found").into_response();
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.fetch_all() {
            Ok(_) => (StatusCode::OK, "Fetch successful").into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch: {}", e),
            )
                .into_response(),
        },
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to open repository: {}", e),
        )
            .into_response(),
    }
}
