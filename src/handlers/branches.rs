use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::git::repository::GitRepository;
use crate::models::{BranchAheadBehind, BranchCreationInfo, BranchInfo, ErrorResponse};
use crate::utils::get_repo_path;

use once_cell::sync::Lazy;
use serde::Deserialize;

/// Tracks the last fetch time per repository to prevent fetch storms.
/// If a fetch was performed within the cooldown period, subsequent requests are skipped.
static FETCH_TRACKER: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Minimum time between fetches for the same repository (60 seconds).
const FETCH_COOLDOWN: Duration = Duration::from_secs(60);

/// Check if enough time has passed since the last fetch for this repo.
/// Returns true if we should fetch, false if we should skip.
fn should_fetch(repo_key: &str) -> bool {
    let mut tracker = FETCH_TRACKER.lock().unwrap();
    let now = Instant::now();

    if let Some(last_fetch) = tracker.get(repo_key) {
        if now.duration_since(*last_fetch) < FETCH_COOLDOWN {
            return false; // Too soon, skip this fetch
        }
    }

    // Record this fetch attempt
    tracker.insert(repo_key.to_string(), now);
    true
}

#[derive(Deserialize)]
pub struct BranchesQuery {
    #[serde(default = "default_auto_fetch")]
    auto_fetch: bool,
}

fn default_auto_fetch() -> bool {
    true // Default to true for backward compatibility
}

pub async fn get_branches(
    State(config): State<Config>,
    Path(repo): Path<String>,
    Query(params): Query<BranchesQuery>,
) -> Result<Json<BranchInfo>, (StatusCode, Json<ErrorResponse>)> {
    let repo_path = get_repo_path(&repo, &config.repos_root);
    let repo_path_clone = repo_path.clone();
    let auto_fetch = params.auto_fetch;

    // --- Get local and cached remote branches in a blocking thread ---
    let branch_info = tokio::task::spawn_blocking(move || {
        let git_repo = GitRepository::open(&repo_path)
            .map_err(|e| format!("Failed to open repository: {}", e))?;

        git_repo
            .get_branch_info()
            .map_err(|e| format!("Failed to get branches: {}", e))
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

    // --- Spawn a background task to fetch remotes only if auto_fetch is enabled ---
    // Uses deduplication to prevent fetch storms when frontend polls frequently.
    let repo_key = repo_path_clone.to_string_lossy().to_string();
    if auto_fetch && should_fetch(&repo_key) {
        // Use spawn_blocking since git fetch is a blocking I/O operation.
        // This avoids blocking the async runtime's worker threads.
        tokio::task::spawn_blocking(move || {
            tracing::debug!("Background fetch started for {}", repo_path_clone.display());
            match GitRepository::open(&repo_path_clone) {
                Ok(git_repo) => {
                    if let Err(e) = git_repo.fetch_all() {
                        tracing::warn!(
                            "Background fetch for repo '{}' failed: {}",
                            repo_path_clone.display(),
                            e
                        );
                    } else {
                        tracing::debug!(
                            "Background fetch for {} completed.",
                            repo_path_clone.display()
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "Background fetch failed to open repo '{}': {}",
                        repo_path_clone.display(),
                        e
                    );
                }
            }
        });
    }

    // --- Return the immediately available branch info ---
    // The UI can now render while the fetch happens in the background.
    Ok(Json(branch_info))
}

#[derive(Deserialize)]
pub struct BranchAheadBehindQuery {
    pub repo: String,
    pub branch: String,
}

pub async fn get_branch_ahead_behind(
    State(config): State<Config>,
    Query(params): Query<BranchAheadBehindQuery>,
) -> Result<Json<BranchAheadBehind>, (StatusCode, Json<ErrorResponse>)> {
    // Repo and branch are provided as query parameters, already percent-decoded by axum.
    // This allows us to support branch names with slashes (e.g. "origin/feature-x")
    // without fighting with path-based routing quirks.
    let repo = params.repo;
    let branch = params.branch;

    let repo_path = get_repo_path(&repo, &config.repos_root);
    let git_repo = GitRepository::open(&repo_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to open repository: {}", e),
            }),
        )
    })?;

    // Try local branch first (single lookup, reuse result for both is_local and branch_sha)
    let local_branch = git_repo.repo.find_branch(&branch, git2::BranchType::Local);
    let is_local = local_branch.is_ok();

    // Resolve the branch tip. Prefer explicit branch refs (local or remote)
    // and fall back to rev-parse. If everything fails, degrade gracefully
    // instead of returning a 404 for UX-critical hover tooltips.
    let branch_sha = if let Ok(local_branch) = local_branch {
        // Reuse the local branch we already found
        local_branch
            .get()
            .peel_to_commit()
            .ok()
            .map(|c| c.id().to_string())
    } else if let Ok(remote_branch) = git_repo.repo.find_branch(&branch, git2::BranchType::Remote) {
        remote_branch
            .get()
            .peel_to_commit()
            .ok()
            .map(|c| c.id().to_string())
    } else {
        git_repo.rev_parse(&branch).ok()
    };

    let branch_sha = match branch_sha {
        Some(sha) => sha,
        None => {
            return Ok(Json(BranchAheadBehind {
                ahead: 0,
                behind: 0,
                upstream: "main".to_string(),
                is_local,
            }))
        }
    };

    let upstream_name = if is_local {
        git_repo
            .get_upstream(&branch)
            .unwrap_or_default()
            .or_else(|| Some("main".to_string()))
            .unwrap()
    } else {
        "main".to_string()
    };

    let upstream_sha = match git_repo.rev_parse(&upstream_name) {
        Ok(sha) => sha,
        Err(_) => {
            return Ok(Json(BranchAheadBehind {
                ahead: 0,
                behind: 0,
                upstream: upstream_name,
                is_local,
            }))
        }
    };

    let (ahead, behind) = git_repo
        .ahead_behind(&branch_sha, &upstream_sha)
        .unwrap_or((0, 0));

    Ok(Json(BranchAheadBehind {
        ahead: ahead as i32,
        behind: behind as i32,
        upstream: upstream_name,
        is_local,
    }))
}

#[derive(Deserialize)]
pub struct BranchCreationQuery {
    pub repo: String,
    pub branch: String,
}

/// Get the creation info for a branch.
/// For main-like branches, returns the repository's root commit.
/// For feature branches, returns the first commit unique to that branch (merge-base with main).
pub async fn get_branch_creation(
    State(config): State<Config>,
    Query(params): Query<BranchCreationQuery>,
) -> Result<Json<BranchCreationInfo>, (StatusCode, Json<ErrorResponse>)> {
    let repo = params.repo;
    let branch = params.branch;

    let repo_path = get_repo_path(&repo, &config.repos_root);
    let git_repo = GitRepository::open(&repo_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to open repository: {}", e),
            }),
        )
    })?;

    // Check if this is a main-like branch
    let is_main_like = is_main_like_branch(&branch);

    if is_main_like {
        // For main branches, get the root commit (first commit in the repository)
        let root_result = git_repo.run_git(&["rev-list", "--max-parents=0", "HEAD"]);
        match root_result {
            Ok(output) => {
                let root_sha = output.lines().next().unwrap_or("").trim();
                if root_sha.is_empty() {
                    return Ok(Json(BranchCreationInfo {
                        found: false,
                        commit_sha: None,
                        commit_date: None,
                        commit_message: None,
                        is_root_commit: None,
                        error: Some("No root commit found".to_string()),
                    }));
                }

                // Get commit details
                let details_result =
                    git_repo.run_git(&["log", "-1", "--format=%H%x1f%aI%x1f%s", root_sha]);

                match details_result {
                    Ok(details) => {
                        let parts: Vec<&str> = details.trim().split('\x1f').collect();
                        Ok(Json(BranchCreationInfo {
                            found: true,
                            commit_sha: parts.first().map(|s| s.to_string()),
                            commit_date: parts.get(1).map(|s| s.to_string()),
                            commit_message: parts.get(2).map(|s| s.to_string()),
                            is_root_commit: Some(true),
                            error: None,
                        }))
                    }
                    Err(e) => Ok(Json(BranchCreationInfo {
                        found: true,
                        commit_sha: Some(root_sha.to_string()),
                        commit_date: None,
                        commit_message: None,
                        is_root_commit: Some(true),
                        error: Some(format!("Failed to get commit details: {}", e)),
                    })),
                }
            }
            Err(e) => Ok(Json(BranchCreationInfo {
                found: false,
                commit_sha: None,
                commit_date: None,
                commit_message: None,
                is_root_commit: None,
                error: Some(format!("Failed to find root commit: {}", e)),
            })),
        }
    } else {
        // For feature branches, find the merge-base with main/master
        // This is the point where the branch diverged from the main line
        let main_ref = find_main_ref(&git_repo);

        // Get the merge-base between this branch and main
        let merge_base_result = git_repo.run_git(&["merge-base", &branch, &main_ref]);

        match merge_base_result {
            Ok(merge_base) => {
                let merge_base_sha = merge_base.trim();
                if merge_base_sha.is_empty() {
                    return Ok(Json(BranchCreationInfo {
                        found: false,
                        commit_sha: None,
                        commit_date: None,
                        commit_message: None,
                        is_root_commit: None,
                        error: Some("No merge-base found".to_string()),
                    }));
                }

                // Find the first commit on this branch after the merge-base
                // This is the actual "creation" commit of the branch
                let first_commit_result = git_repo.run_git(&[
                    "rev-list",
                    "--ancestry-path",
                    &format!("{}..{}", merge_base_sha, &branch),
                    "--reverse",
                ]);

                let creation_sha = match first_commit_result {
                    Ok(output) => {
                        let first_line = output.lines().next().unwrap_or("").trim();
                        if first_line.is_empty() {
                            // Branch hasn't diverged yet, use merge-base
                            merge_base_sha.to_string()
                        } else {
                            first_line.to_string()
                        }
                    }
                    Err(_) => merge_base_sha.to_string(),
                };

                // Get commit details for the creation commit
                let details_result =
                    git_repo.run_git(&["log", "-1", "--format=%H%x1f%aI%x1f%s", &creation_sha]);

                match details_result {
                    Ok(details) => {
                        let parts: Vec<&str> = details.trim().split('\x1f').collect();
                        Ok(Json(BranchCreationInfo {
                            found: true,
                            commit_sha: parts.first().map(|s| s.to_string()),
                            commit_date: parts.get(1).map(|s| s.to_string()),
                            commit_message: parts.get(2).map(|s| s.to_string()),
                            is_root_commit: Some(false),
                            error: None,
                        }))
                    }
                    Err(e) => Ok(Json(BranchCreationInfo {
                        found: true,
                        commit_sha: Some(creation_sha),
                        commit_date: None,
                        commit_message: None,
                        is_root_commit: Some(false),
                        error: Some(format!("Failed to get commit details: {}", e)),
                    })),
                }
            }
            Err(e) => {
                // No merge-base found - this might be an orphan branch or unrelated history
                // Fall back to finding the oldest commit on this branch
                let oldest_result = git_repo.run_git(&["rev-list", "--max-parents=0", &branch]);

                match oldest_result {
                    Ok(output) => {
                        let oldest_sha = output.lines().next().unwrap_or("").trim();
                        if oldest_sha.is_empty() {
                            return Ok(Json(BranchCreationInfo {
                                found: false,
                                commit_sha: None,
                                commit_date: None,
                                commit_message: None,
                                is_root_commit: None,
                                error: Some(format!("No merge-base with {}: {}", main_ref, e)),
                            }));
                        }

                        let details_result = git_repo.run_git(&[
                            "log",
                            "-1",
                            "--format=%H%x1f%aI%x1f%s",
                            oldest_sha,
                        ]);

                        match details_result {
                            Ok(details) => {
                                let parts: Vec<&str> = details.trim().split('\x1f').collect();
                                Ok(Json(BranchCreationInfo {
                                    found: true,
                                    commit_sha: parts.first().map(|s| s.to_string()),
                                    commit_date: parts.get(1).map(|s| s.to_string()),
                                    commit_message: parts.get(2).map(|s| s.to_string()),
                                    is_root_commit: Some(true),
                                    error: None,
                                }))
                            }
                            Err(_) => Ok(Json(BranchCreationInfo {
                                found: true,
                                commit_sha: Some(oldest_sha.to_string()),
                                commit_date: None,
                                commit_message: None,
                                is_root_commit: Some(true),
                                error: None,
                            })),
                        }
                    }
                    Err(_) => Ok(Json(BranchCreationInfo {
                        found: false,
                        commit_sha: None,
                        commit_date: None,
                        commit_message: None,
                        is_root_commit: None,
                        error: Some(format!("No merge-base with {}: {}", main_ref, e)),
                    })),
                }
            }
        }
    }
}

/// Check if a branch name is a main-like branch (main, master, develop, etc.)
fn is_main_like_branch(name: &str) -> bool {
    let lower = name.to_lowercase();
    let base_name = lower.split('/').last().unwrap_or(&lower);
    matches!(
        base_name,
        "main" | "master" | "develop" | "development" | "trunk"
    )
}

/// Find the main reference in the repository (main, master, origin/main, etc.)
fn find_main_ref(git_repo: &GitRepository) -> String {
    // Try common main branch names in order of preference
    let candidates = [
        "main",
        "master",
        "origin/main",
        "origin/master",
        "develop",
        "origin/develop",
    ];

    for candidate in candidates {
        if git_repo.rev_parse(candidate).is_ok() {
            return candidate.to_string();
        }
    }

    // Default to main if nothing found
    "main".to_string()
}
