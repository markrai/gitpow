use gitpow_rust::config::Config;
use gitpow_rust::git::repository::GitRepository;
use gitpow_rust::models::{BranchAheadBehind, BranchCreationInfo, BranchInfo};
use gitpow_rust::utils::get_repo_path;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

#[derive(Deserialize)]
pub struct GetBranchesParams {
    repo: String,
    #[serde(default = "default_auto_fetch")]
    auto_fetch: bool,
}

fn default_auto_fetch() -> bool {
    true // Default to true for backward compatibility
}

#[tauri::command]
pub async fn get_branches(
    params: GetBranchesParams,
    config: State<'_, Mutex<Config>>,
) -> Result<BranchInfo, String> {
    let repos_root = {
        let config = config.lock().unwrap();
        config.repos_root.clone()
    };
    let repo_path = get_repo_path(&params.repo, &repos_root);
    let repo_path_clone = repo_path.clone();

    // --- Get local and cached remote branches immediately ---
    let branch_info = {
        let git_repo = GitRepository::open(&repo_path)
            .map_err(|e| format!("Failed to open repository: {}", e))?;

        git_repo
            .get_branch_info()
            .map_err(|e| format!("Failed to get branches: {}", e))?
    };

    // --- Spawn a background task to fetch remotes only if auto_fetch is enabled ---
    if params.auto_fetch {
        tokio::spawn(async move {
            println!(
                "Spawning background fetch for {}",
                repo_path_clone.display()
            );
            // Open a new repository instance for this thread.
            match GitRepository::open(&repo_path_clone) {
                Ok(git_repo) => {
                    if let Err(e) = git_repo.fetch_all() {
                        eprintln!(
                            "Background fetch for repo '{}' failed: {}",
                            repo_path_clone.display(),
                            e
                        );
                    } else {
                        println!(
                            "Background fetch for {} completed successfully.",
                            repo_path_clone.display()
                        );
                    }
                }
                Err(e) => {
                    eprintln!(
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
    Ok(branch_info)
}

#[derive(Deserialize)]
pub struct GetBranchAheadBehindParams {
    pub repo: String,
    pub branch: String,
}

#[tauri::command]
pub async fn get_branch_ahead_behind(
    params: GetBranchAheadBehindParams,
    config: State<'_, Mutex<Config>>,
) -> Result<BranchAheadBehind, String> {
    let repos_root = {
        let config = config.lock().unwrap();
        config.repos_root.clone()
    };
    let repo = params.repo;
    let branch = params.branch;

    tokio::task::spawn_blocking(move || {
        let repo_path = get_repo_path(&repo, &repos_root);
        let git_repo = GitRepository::open(&repo_path)
            .map_err(|e| format!("Failed to open repository: {}", e))?;

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
        } else if let Ok(remote_branch) =
            git_repo.repo.find_branch(&branch, git2::BranchType::Remote)
        {
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
                return Ok(BranchAheadBehind {
                    ahead: 0,
                    behind: 0,
                    upstream: "main".to_string(),
                    is_local,
                })
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
                return Ok(BranchAheadBehind {
                    ahead: 0,
                    behind: 0,
                    upstream: upstream_name,
                    is_local,
                })
            }
        };

        let (ahead, behind) = git_repo
            .ahead_behind(&branch_sha, &upstream_sha)
            .unwrap_or((0, 0));

        Ok(BranchAheadBehind {
            ahead: ahead as i32,
            behind: behind as i32,
            upstream: upstream_name,
            is_local,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[derive(Deserialize)]
pub struct GetBranchStatusParams {
    pub repo: String,
}

#[derive(Serialize)]
pub struct BranchStatus {
    pub branch: String,
    pub ahead: i32,
    pub behind: i32,
    pub has_upstream: bool,
    pub stash_count: i32,
}

#[tauri::command]
pub async fn get_branch_status(
    params: GetBranchStatusParams,
    config: State<'_, Mutex<Config>>,
) -> Result<BranchStatus, String> {
    let repos_root = {
        let config = config.lock().unwrap();
        config.repos_root.clone()
    };
    let repo_name = params.repo;

    tokio::task::spawn_blocking(move || {
        let repo_path = get_repo_path(&repo_name, &repos_root);
        let git_repo = GitRepository::open(&repo_path)
            .map_err(|e| format!("Failed to open repository: {}", e))?;

        // Get current branch name
        let current_branch = git_repo
            .repo
            .head()
            .ok()
            .and_then(|head| head.shorthand().map(|s| s.to_string()))
            .unwrap_or_else(|| "unknown".to_string());

        // Try local branch first (single lookup, reuse result)
        let local_branch = git_repo
            .repo
            .find_branch(&current_branch, git2::BranchType::Local);
        let is_local = local_branch.is_ok();

        let branch_sha = if let Ok(local_branch) = local_branch {
            // Reuse the local branch we already found
            local_branch
                .get()
                .peel_to_commit()
                .ok()
                .map(|c| c.id().to_string())
        } else if let Ok(remote_branch) = git_repo
            .repo
            .find_branch(&current_branch, git2::BranchType::Remote)
        {
            remote_branch
                .get()
                .peel_to_commit()
                .ok()
                .map(|c| c.id().to_string())
        } else {
            git_repo.rev_parse(&current_branch).ok()
        };

        let (ahead, behind, has_upstream) = if let Some(branch_sha) = branch_sha {
            let upstream_name = if is_local {
                git_repo
                    .get_upstream(&current_branch)
                    .unwrap_or_default()
                    .or_else(|| Some("main".to_string()))
                    .unwrap()
            } else {
                "main".to_string()
            };

            let has_upstream = git_repo
                .get_upstream(&current_branch)
                .ok()
                .flatten()
                .is_some();

            if let Ok(upstream_sha) = git_repo.rev_parse(&upstream_name) {
                let (a, b) = git_repo
                    .ahead_behind(&branch_sha, &upstream_sha)
                    .unwrap_or((0, 0));
                (a as i32, b as i32, has_upstream)
            } else {
                (0, 0, has_upstream)
            }
        } else {
            (0, 0, false)
        };

        // Count stashes using git command (simpler than stash_foreach which requires mutable access)
        let stash_count = git_repo
            .run_git(&["stash", "list"])
            .map(|output| output.lines().count() as i32)
            .unwrap_or(0);

        Ok(BranchStatus {
            branch: current_branch,
            ahead,
            behind,
            has_upstream,
            stash_count,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[derive(Deserialize)]
pub struct GetBranchCreationParams {
    pub repo: String,
    pub branch: String,
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

    "main".to_string()
}

#[tauri::command]
pub async fn get_branch_creation(
    params: GetBranchCreationParams,
    config: State<'_, Mutex<Config>>,
) -> Result<BranchCreationInfo, String> {
    let repos_root = {
        let config = config.lock().unwrap();
        config.repos_root.clone()
    };
    let repo = params.repo;
    let branch = params.branch;

    tokio::task::spawn_blocking(move || {
        let repo_path = get_repo_path(&repo, &repos_root);
        let git_repo = GitRepository::open(&repo_path)
            .map_err(|e| format!("Failed to open repository: {}", e))?;

        let is_main_like = is_main_like_branch(&branch);

        if is_main_like {
            // For main branches, get the root commit (first commit in the repository)
            let root_result = git_repo.run_git(&["rev-list", "--max-parents=0", "HEAD"]);
            match root_result {
                Ok(output) => {
                    let root_sha = output.lines().next().unwrap_or("").trim();
                    if root_sha.is_empty() {
                        return Ok(BranchCreationInfo {
                            found: false,
                            commit_sha: None,
                            commit_date: None,
                            commit_message: None,
                            is_root_commit: None,
                            error: Some("No root commit found".to_string()),
                        });
                    }

                    let details_result =
                        git_repo.run_git(&["log", "-1", "--format=%H%x1f%aI%x1f%s", root_sha]);

                    match details_result {
                        Ok(details) => {
                            let parts: Vec<&str> = details.trim().split('\x1f').collect();
                            Ok(BranchCreationInfo {
                                found: true,
                                commit_sha: parts.first().map(|s| s.to_string()),
                                commit_date: parts.get(1).map(|s| s.to_string()),
                                commit_message: parts.get(2).map(|s| s.to_string()),
                                is_root_commit: Some(true),
                                error: None,
                            })
                        }
                        Err(e) => Ok(BranchCreationInfo {
                            found: true,
                            commit_sha: Some(root_sha.to_string()),
                            commit_date: None,
                            commit_message: None,
                            is_root_commit: Some(true),
                            error: Some(format!("Failed to get commit details: {}", e)),
                        }),
                    }
                }
                Err(e) => Ok(BranchCreationInfo {
                    found: false,
                    commit_sha: None,
                    commit_date: None,
                    commit_message: None,
                    is_root_commit: None,
                    error: Some(format!("Failed to find root commit: {}", e)),
                }),
            }
        } else {
            // For feature branches, find the merge-base with main/master
            let main_ref = find_main_ref(&git_repo);
            let merge_base_result = git_repo.run_git(&["merge-base", &branch, &main_ref]);

            match merge_base_result {
                Ok(merge_base) => {
                    let merge_base_sha = merge_base.trim();
                    if merge_base_sha.is_empty() {
                        return Ok(BranchCreationInfo {
                            found: false,
                            commit_sha: None,
                            commit_date: None,
                            commit_message: None,
                            is_root_commit: None,
                            error: Some("No merge-base found".to_string()),
                        });
                    }

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
                                merge_base_sha.to_string()
                            } else {
                                first_line.to_string()
                            }
                        }
                        Err(_) => merge_base_sha.to_string(),
                    };

                    let details_result =
                        git_repo.run_git(&["log", "-1", "--format=%H%x1f%aI%x1f%s", &creation_sha]);

                    match details_result {
                        Ok(details) => {
                            let parts: Vec<&str> = details.trim().split('\x1f').collect();
                            Ok(BranchCreationInfo {
                                found: true,
                                commit_sha: parts.first().map(|s| s.to_string()),
                                commit_date: parts.get(1).map(|s| s.to_string()),
                                commit_message: parts.get(2).map(|s| s.to_string()),
                                is_root_commit: Some(false),
                                error: None,
                            })
                        }
                        Err(e) => Ok(BranchCreationInfo {
                            found: true,
                            commit_sha: Some(creation_sha),
                            commit_date: None,
                            commit_message: None,
                            is_root_commit: Some(false),
                            error: Some(format!("Failed to get commit details: {}", e)),
                        }),
                    }
                }
                Err(e) => {
                    // Fall back to finding the oldest commit on this branch
                    let oldest_result = git_repo.run_git(&["rev-list", "--max-parents=0", &branch]);

                    match oldest_result {
                        Ok(output) => {
                            let oldest_sha = output.lines().next().unwrap_or("").trim();
                            if oldest_sha.is_empty() {
                                return Ok(BranchCreationInfo {
                                    found: false,
                                    commit_sha: None,
                                    commit_date: None,
                                    commit_message: None,
                                    is_root_commit: None,
                                    error: Some(format!("No merge-base with {}: {}", main_ref, e)),
                                });
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
                                    Ok(BranchCreationInfo {
                                        found: true,
                                        commit_sha: parts.first().map(|s| s.to_string()),
                                        commit_date: parts.get(1).map(|s| s.to_string()),
                                        commit_message: parts.get(2).map(|s| s.to_string()),
                                        is_root_commit: Some(true),
                                        error: None,
                                    })
                                }
                                Err(_) => Ok(BranchCreationInfo {
                                    found: true,
                                    commit_sha: Some(oldest_sha.to_string()),
                                    commit_date: None,
                                    commit_message: None,
                                    is_root_commit: Some(true),
                                    error: None,
                                }),
                            }
                        }
                        Err(_) => Ok(BranchCreationInfo {
                            found: false,
                            commit_sha: None,
                            commit_date: None,
                            commit_message: None,
                            is_root_commit: None,
                            error: Some(format!("No merge-base with {}: {}", main_ref, e)),
                        }),
                    }
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
