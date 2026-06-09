use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Json, Response},
};
use base64::{engine::general_purpose, Engine as _};
use mime_guess;
use moka::sync::Cache;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::Path as StdPath;
use std::time::Duration;

use crate::config::Config;
use crate::git::repository::GitRepository;
use crate::models::{ErrorResponse, FileChange, FileCreationInfo, ImageResponse};
use crate::utils::{get_repo_path, normalize_sha};

#[derive(serde::Deserialize)]
pub struct FileQuery {
    #[serde(rename = "ref")]
    ref_: Option<String>,
    path: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct FileCreationQuery {
    path: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct FileCreationBatchQuery {
    // JSON-encoded array of paths in the `paths` query parameter.
    // Example: ?paths=["a.txt","b.txt"]
    pub paths: String,
}

/// Commits beyond this threshold are considered a "large repo", and some
/// expensive operations like finding a file's creation date will be disabled.
const LARGE_REPO_COMMIT_THRESHOLD: usize = 20_000;

/// Cache for file creation info with automatic TTL-based eviction.
/// Key: (repo_path, file_path), Value: FileCreationInfo
/// Entries expire after 60 seconds, max 10,000 entries.
static FILE_CREATION_CACHE: Lazy<Cache<(String, String), FileCreationInfo>> = Lazy::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(60))
        .max_capacity(10_000)
        .build()
});

fn compute_file_creation_info(
    git_repo: &GitRepository,
    repo_key: &str,
    path: &str,
) -> FileCreationInfo {
    let cache_key = (repo_key.to_string(), path.to_string());

    // Try cache first (moka handles TTL automatically)
    if let Some(cached) = FILE_CREATION_CACHE.get(&cache_key) {
        return cached;
    }

    // For large repos, disable this expensive operation
    if let Ok(count) = git_repo.count_all_commits() {
        if count > LARGE_REPO_COMMIT_THRESHOLD {
            let info = FileCreationInfo {
                found: false,
                commit_sha: None,
                commit_date: None,
                date: None,
                message: Some("Disabled for performance on large repositories".to_string()),
                error: Some("disabled".to_string()),
            };
            FILE_CREATION_CACHE.insert(cache_key, info.clone());
            return info;
        }
    }

    let log_out = git_repo
        .run_git(&[
            "log",
            "--diff-filter=A",
            "--format=%H%x1f%aI%x1f%s",
            "--reverse",
            "--",
            path,
        ])
        .unwrap_or_default();

    let info = if let Some(line) = log_out.lines().next() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() >= 2 {
            FileCreationInfo {
                found: true,
                commit_sha: Some(parts[0].to_string()),
                commit_date: Some(parts[1].to_string()),
                date: Some(parts[1].to_string()),
                message: parts.get(2).map(|s| s.to_string()),
                error: None,
            }
        } else {
            FileCreationInfo {
                found: false,
                commit_sha: None,
                commit_date: None,
                date: None,
                message: Some("File creation commit not found".to_string()),
                error: None,
            }
        }
    } else {
        FileCreationInfo {
            found: false,
            commit_sha: None,
            commit_date: None,
            date: None,
            message: Some("File creation commit not found".to_string()),
            error: None,
        }
    };

    // Insert into cache (moka handles eviction automatically)
    FILE_CREATION_CACHE.insert(cache_key, info.clone());

    info
}

pub async fn get_files(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<FileQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);
    let git_repo = GitRepository::open(&repo_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to open repository: {}", e),
            }),
        )
    })?;

    let reference = params.ref_.as_deref().unwrap_or("HEAD");
    let mut args = vec!["ls-tree", "--name-only", reference];
    let path = params.path.unwrap_or_default();
    if !path.is_empty() {
        args.push("--");
        args.push(&path);
    }

    let output = git_repo.run_git(&args).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to list files: {}", e),
            }),
        )
    })?;

    let files: Vec<String> = output.lines().map(|l| l.trim().to_string()).collect();
    Ok(Json(files))
}

pub async fn get_commit_files(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<FileQuery>,
) -> Result<Json<Vec<FileChange>>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);
    let ref_sha = params.ref_.as_deref().unwrap_or("HEAD");
    let ref_sha = normalize_sha(ref_sha);

    // Move blocking git operations to a thread pool to avoid blocking the async runtime
    let changes = tokio::task::spawn_blocking(move || {
        let git_repo = GitRepository::open(&repo_path)
            .map_err(|e| format!("Failed to open repository: {}", e))?;

        git_repo
            .get_commit_changed_files(&ref_sha)
            .map_err(|e| format!("Failed to get commit files: {}", e))
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
    })?
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
    })?;

    Ok(Json(changes))
}

pub async fn get_file(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<FileQuery>,
) -> Result<Response, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);
    let git_repo = GitRepository::open(&repo_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to open repository: {}", e),
            }),
        )
    })?;

    let path = params.path.unwrap_or_default();
    if path.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "path query parameter is required".to_string(),
            }),
        ));
    }

    let ref_sha = params.ref_.as_deref().unwrap_or("HEAD");
    let ref_sha = normalize_sha(ref_sha);

    let content = git_repo
        .run_git_bytes(&["show", &format!("{}:{}", ref_sha, path)])
        .map_err(|e| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("File not found: {}", e),
                }),
            )
        })?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/plain")
        .body(axum::body::Body::from(content))
        .unwrap())
}

pub async fn get_file_creation(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<FileCreationQuery>,
) -> Result<Json<FileCreationInfo>, (StatusCode, Json<ErrorResponse>)> {
    let path = params.path.unwrap_or_default();
    if path.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "path query parameter is required".to_string(),
            }),
        ));
    }

    let repo_path = get_repo_path(&repo, &config.repos_root);
    let repo_key = repo_path.to_string_lossy().to_string();

    // Move blocking git operations to a thread pool to avoid blocking the async runtime
    let info_result = tokio::task::spawn_blocking(move || {
        let git_repo = GitRepository::open(&repo_path)
            .map_err(|e| format!("Failed to open repository: {}", e))?;
        let info = compute_file_creation_info(&git_repo, &repo_key, &path);
        Ok::<_, String>(info)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
    })?;

    match info_result {
        Ok(info) => Ok(Json(info)),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )),
    }
}

pub async fn get_file_creation_batch(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<FileCreationBatchQuery>,
) -> Result<Json<HashMap<String, FileCreationInfo>>, (StatusCode, Json<ErrorResponse>)> {
    let paths: Vec<String> = match serde_json::from_str(&params.paths) {
        Ok(v) => v,
        Err(e) => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!(
                        "invalid paths parameter (expected JSON array of strings): {}",
                        e
                    ),
                }),
            ))
        }
    };

    if paths.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "paths query parameter must be a non-empty JSON array".to_string(),
            }),
        ));
    }

    let repo_path = get_repo_path(&repo, &config.repos_root);
    let repo_key = repo_path.to_string_lossy().to_string();

    // Move blocking git operations to a thread pool to avoid blocking the async runtime
    let result = tokio::task::spawn_blocking(move || {
        let git_repo = GitRepository::open(&repo_path)
            .map_err(|e| format!("Failed to open repository: {}", e))?;

        let mut result: HashMap<String, FileCreationInfo> = HashMap::new();

        // The compute function contains the conditional logic and caching,
        // so we can just call it in a loop.
        for path in paths.iter() {
            if path.is_empty() {
                continue;
            }

            let info = compute_file_creation_info(&git_repo, &repo_key, path);
            result.insert(path.clone(), info);
        }

        Ok(result)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
    })?
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
    })?;

    Ok(Json(result))
}

pub async fn get_image(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<FileQuery>,
) -> Result<Json<ImageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let path = params.path.unwrap_or_default();
    if path.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "path query parameter is required".to_string(),
            }),
        ));
    }

    let repo_path = get_repo_path(&repo, &config.repos_root);
    let git_repo = GitRepository::open(&repo_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to open repository: {}", e),
            }),
        )
    })?;

    let ref_sha = params.ref_.as_deref().unwrap_or("HEAD");
    let ref_sha = normalize_sha(ref_sha);

    let data = git_repo
        .run_git_bytes(&["show", &format!("{}:{}", ref_sha, path)])
        .map_err(|e| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("File not found: {}", e),
                }),
            )
        })?;

    let base64_data = general_purpose::STANDARD.encode(&data);

    let ext = StdPath::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime_type = mime_guess::from_ext(&ext)
        .first_or_octet_stream()
        .to_string();

    Ok(Json(ImageResponse {
        data: format!("data:{};base64,{}", mime_type, base64_data),
        mime_type,
    }))
}
