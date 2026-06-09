use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Json,
};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::models::{ConfigResponse, ErrorResponse, Repo};

#[derive(Deserialize)]
pub struct ReposQuery {
    repos_root: Option<String>,
}

pub async fn get_repos(
    State(config): State<Config>,
    Query(query): Query<ReposQuery>,
) -> Result<Json<Vec<Repo>>, (StatusCode, Json<ErrorResponse>)> {
    // Use custom repos_root from query if provided, otherwise use config default
    let repos_root = if let Some(custom_root) = &query.repos_root {
        let path = PathBuf::from(custom_root);
        path.canonicalize().unwrap_or_else(|_| path)
    } else {
        config.repos_root.clone()
    };

    // Helper to create a user-facing ID string from a path.
    // On Windows, strip any extended-length prefix (\\?\C:\...) for readability.
    fn make_repo_id(path: &Path) -> String {
        let raw = path.to_string_lossy().to_string();
        if cfg!(windows) && raw.starts_with(r"\\?\") {
            raw[4..].to_string()
        } else {
            raw
        }
    }

    let mut repos = Vec::new();

    // Case 1: the selected folder itself is a git repository.
    let self_git_dir = repos_root.join(".git");
    let self_is_repo = self_git_dir.is_dir();
    if self_is_repo {
        let name = repos_root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| repos_root.to_string_lossy().to_string());
        repos.push(Repo {
            id: make_repo_id(&repos_root),
            name,
        });
    }

    // Case 2: the folder may contain multiple git repositories as children.
    // If we can't read the directory at all and it's not itself a repo, surface an error.
    let entries_result = fs::read_dir(&repos_root);
    let entries = match entries_result {
        Ok(entries) => entries,
        Err(e) => {
            if self_is_repo {
                // Folder itself is a repo; treat missing read_dir as "no additional repos".
                return Ok(Json(repos));
            }
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to read repos directory: {}", e),
                }),
            ));
        }
    };

    for entry in entries {
        let entry = entry.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to read directory entry: {}", e),
                }),
            )
        })?;

        if entry
            .file_type()
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Failed to get file type: {}", e),
                    }),
                )
            })?
            .is_dir()
        {
            let full_path = repos_root.join(entry.file_name());
            let git_dir = full_path.join(".git");
            if git_dir.exists() {
                let name = entry.file_name().to_string_lossy().to_string();
                repos.push(Repo {
                    id: make_repo_id(&full_path),
                    name,
                });
            }
        }
    }

    Ok(Json(repos))
}

pub async fn get_config(State(config): State<Config>) -> Json<ConfigResponse> {
    Json(ConfigResponse {
        repos_root: config.repos_root.to_string_lossy().to_string(),
    })
}
