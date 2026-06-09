use gitpow_rust::config::Config;
use gitpow_rust::models::{ConfigResponse, Repo};
use rayon::prelude::*;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub struct GetReposRequest {
    #[serde(default)]
    repos_root: Option<String>,
}

#[tauri::command]
pub fn get_repos(
    request: Option<GetReposRequest>,
    config: State<'_, Mutex<Config>>,
) -> Result<Vec<Repo>, String> {
    let config = config.lock().unwrap();

    tracing::debug!("get_repos: Received request: {:?}", request);

    // Extract repos_root from request, or use config default
    let repos_root = if let Some(req) = request {
        if let Some(custom_root) = req.repos_root {
            tracing::debug!(
                "get_repos: Using custom repos_root from request: {}",
                custom_root
            );
            let path = PathBuf::from(custom_root);
            path.canonicalize().unwrap_or_else(|_| {
                tracing::warn!("get_repos: Failed to canonicalize path: {:?}", path);
                path
            })
        } else {
            tracing::debug!(
                "get_repos: Request provided but repos_root is None, using config default: {:?}",
                config.repos_root
            );
            config.repos_root.clone()
        }
    } else {
        tracing::debug!(
            "get_repos: No request provided, using config default: {:?}",
            config.repos_root
        );
        config.repos_root.clone()
    };

    tracing::debug!("get_repos: Final repos_root path: {:?}", repos_root);
    tracing::debug!("get_repos: repos_root exists: {}", repos_root.exists());
    tracing::debug!("get_repos: repos_root is_dir: {}", repos_root.is_dir());

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

    // Helper to check if a path is hidden (starts with '.').
    fn is_hidden(p: &Path) -> bool {
        p.file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.starts_with('.'))
            .unwrap_or(false)
    }

    let mut repos = Vec::new();

    // Case 1: the selected folder itself is a git repository.
    let self_git_dir = repos_root.join(".git");
    let self_is_repo = self_git_dir.is_dir();
    tracing::debug!(
        "get_repos: Checking if folder itself is a repo. .git path: {:?}, exists: {}, is_dir: {}",
        self_git_dir,
        self_git_dir.exists(),
        self_is_repo
    );
    if self_is_repo {
        tracing::debug!("get_repos: Folder itself is a git repository");
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
    let entries: Vec<_> = match entries_result {
        Ok(entries) => {
            // Collect all entries first (cheap operation)
            match entries.collect::<Result<Vec<_>, _>>() {
                Ok(entries) => entries,
                Err(e) => {
                    if self_is_repo {
                        // Folder itself is a repo; treat missing entries as "no additional repos".
                        tracing::warn!("get_repos: Failed to read some directory entries: {}", e);
                        Vec::new()
                    } else {
                        return Err(format!("Failed to read repos directory: {}", e));
                    }
                }
            }
        }
        Err(e) => {
            if self_is_repo {
                // Folder itself is a repo; treat missing read_dir as "no additional repos".
                return Ok(repos);
            }
            return Err(format!("Failed to read repos directory: {}", e));
        }
    };

    // Filter to directories only and skip hidden directories before expensive .git checks
    let dirs: Vec<PathBuf> = entries
        .into_iter()
        .filter_map(|entry| {
            // Continue on individual entry failures (log warning instead of returning error)
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(e) => {
                    tracing::warn!(
                        "get_repos: Failed to get file type for {:?}: {}",
                        entry.file_name(),
                        e
                    );
                    return None;
                }
            };

            if !file_type.is_dir() {
                return None; // Skip files early
            }

            let full_path = repos_root.join(entry.file_name());

            // Skip hidden directories (starting with '.')
            if is_hidden(&full_path) {
                tracing::debug!("get_repos: Skipping hidden directory: {:?}", full_path);
                return None;
            }

            Some(full_path)
        })
        .collect();

    let entry_count = dirs.len();
    tracing::debug!(
        "get_repos: Found {} directories to check for git repos",
        entry_count
    );

    // Use parallel iteration to check .git existence concurrently
    let found_repos: Vec<Repo> = dirs
        .par_iter()
        .filter_map(|dir| {
            let git_dir = dir.join(".git");
            let git_exists = git_dir.exists();

            if git_exists {
                let name = dir
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| dir.to_string_lossy().to_string());
                tracing::debug!("get_repos: Found git repo: {}", name);
                Some(Repo {
                    id: make_repo_id(dir),
                    name,
                })
            } else {
                None
            }
        })
        .collect();

    repos.extend(found_repos);

    tracing::debug!(
        "get_repos: Scanned {} entries, found {} repos",
        entry_count,
        repos.len()
    );
    Ok(repos)
}

#[tauri::command]
pub fn get_config(config: State<'_, Mutex<Config>>) -> Result<ConfigResponse, String> {
    let config = config.lock().unwrap();
    Ok(ConfigResponse {
        repos_root: config.repos_root.to_string_lossy().to_string(),
    })
}
