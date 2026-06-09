use base64::{engine::general_purpose, Engine as _};
use gitpow_rust::config::Config;
use gitpow_rust::git::repository::GitRepository;
use gitpow_rust::models::{FileChange, FileCreationInfo, ImageResponse};
use gitpow_rust::utils::{get_repo_path, normalize_sha};
use mime_guess;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path as StdPath;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;

#[derive(Deserialize, Debug)]
pub struct GetFilesParams {
    repo: String,
    #[serde(rename = "ref")]
    ref_: Option<String>,
    path: Option<String>,
}

#[derive(Deserialize)]
pub struct GetFileCreationParams {
    repo: String,
    path: Option<String>,
}

#[derive(Deserialize)]
pub struct GetFileCreationBatchParams {
    repo: String,
    paths: String, // JSON-encoded array of paths
}

#[derive(Deserialize)]
pub struct GetImageParams {
    repo: String,
    #[serde(rename = "ref")]
    ref_: Option<String>,
    path: Option<String>,
}

#[derive(Clone)]
struct CachedValue<T> {
    value: T,
    stored: Instant,
}

fn file_creation_cache() -> &'static Mutex<HashMap<(String, String), CachedValue<FileCreationInfo>>>
{
    static CACHE: OnceLock<Mutex<HashMap<(String, String), CachedValue<FileCreationInfo>>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn compute_file_creation_info(
    git_repo: &GitRepository,
    repo_key: &str,
    path: &str,
) -> FileCreationInfo {
    // Try cache first
    {
        let cache = file_creation_cache().lock().unwrap();
        if let Some(entry) = cache.get(&(repo_key.to_string(), path.to_string())) {
            if entry.stored.elapsed() < Duration::from_secs(60) {
                return entry.value.clone();
            }
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

    let mut cache = file_creation_cache().lock().unwrap();
    cache.insert(
        (repo_key.to_string(), path.to_string()),
        CachedValue {
            value: info.clone(),
            stored: Instant::now(),
        },
    );

    info
}

#[tauri::command]
pub fn get_files(
    params: GetFilesParams,
    config: State<'_, Mutex<Config>>,
) -> Result<Vec<String>, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);
    let git_repo =
        GitRepository::open(&repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    let reference = params.ref_.as_deref().unwrap_or("HEAD");
    let mut args = vec!["ls-tree", "--name-only", reference];
    let path = params.path.unwrap_or_default();
    if !path.is_empty() {
        args.push("--");
        args.push(&path);
    }

    let output = git_repo
        .run_git(&args)
        .map_err(|e| format!("Failed to list files: {}", e))?;

    let files: Vec<String> = output.lines().map(|l| l.trim().to_string()).collect();
    Ok(files)
}

#[tauri::command]
pub fn get_commit_files(
    params: GetFilesParams,
    config: State<'_, Mutex<Config>>,
) -> Result<Vec<FileChange>, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);
    let git_repo =
        GitRepository::open(&repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    tracing::debug!("get_commit_files: params.ref_ = {:?}", params.ref_);
    let ref_sha = params.ref_.as_deref().unwrap_or_else(|| {
        tracing::warn!("get_commit_files: ref_ is None, defaulting to HEAD");
        "HEAD"
    });
    let ref_sha = normalize_sha(ref_sha);
    tracing::debug!("get_commit_files: Using ref_sha: {}", ref_sha);

    let parents_out = git_repo
        .run_git(&["show", "-s", "--format=%P", &ref_sha])
        .unwrap_or_default();
    let parents: Vec<&str> = parents_out.split_whitespace().collect();

    let mut changes = Vec::new();

    if parents.is_empty() {
        // Initial commit
        let ls_out = git_repo
            .run_git(&["ls-tree", "-r", "--name-only", &ref_sha])
            .unwrap_or_default();
        for line in ls_out.lines() {
            let path = line.trim();
            if !path.is_empty() {
                changes.push(FileChange {
                    path: path.to_string(),
                    status: "added".to_string(),
                });
            }
        }
    } else {
        let diff_out = git_repo
            .run_git(&["diff", "--name-status", parents[0], &ref_sha])
            .unwrap_or_default();
        for line in diff_out.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }

            let status_code = parts[0];
            match status_code.chars().next().unwrap_or('M') {
                'A' => {
                    if parts.len() >= 2 {
                        changes.push(FileChange {
                            path: parts[1].to_string(),
                            status: "added".to_string(),
                        });
                    }
                }
                'D' => {
                    if parts.len() >= 2 {
                        changes.push(FileChange {
                            path: parts[1].to_string(),
                            status: "removed".to_string(),
                        });
                    }
                }
                'R' => {
                    if parts.len() >= 3 {
                        changes.push(FileChange {
                            path: parts[2].to_string(),
                            status: "modified".to_string(),
                        });
                    }
                }
                _ => {
                    if parts.len() >= 2 {
                        changes.push(FileChange {
                            path: parts[1].to_string(),
                            status: "modified".to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(changes)
}

#[tauri::command]
pub fn get_file(
    params: GetFilesParams,
    config: State<'_, Mutex<Config>>,
) -> Result<String, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);
    let git_repo =
        GitRepository::open(&repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    let path = params.path.unwrap_or_default();
    if path.is_empty() {
        return Err("path parameter is required".to_string());
    }

    let ref_sha = params.ref_.as_deref().unwrap_or("HEAD");
    let ref_sha = normalize_sha(ref_sha);

    let content = git_repo
        .run_git_bytes(&["show", &format!("{}:{}", ref_sha, path)])
        .map_err(|e| format!("File not found: {}", e))?;

    // Return as base64-encoded string for binary safety
    Ok(general_purpose::STANDARD.encode(&content))
}

#[tauri::command]
pub fn get_file_creation(
    params: GetFileCreationParams,
    config: State<'_, Mutex<Config>>,
) -> Result<FileCreationInfo, String> {
    let path = params.path.unwrap_or_default();
    if path.is_empty() {
        return Err("path parameter is required".to_string());
    }

    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);
    let repo_key = repo_path.to_string_lossy().to_string();
    let git_repo =
        GitRepository::open(&repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    let info = compute_file_creation_info(&git_repo, &repo_key, &path);

    Ok(info)
}

#[tauri::command]
pub fn get_file_creation_batch(
    params: GetFileCreationBatchParams,
    config: State<'_, Mutex<Config>>,
) -> Result<HashMap<String, FileCreationInfo>, String> {
    let paths: Vec<String> = serde_json::from_str(&params.paths).map_err(|e| {
        format!(
            "invalid paths parameter (expected JSON array of strings): {}",
            e
        )
    })?;

    if paths.is_empty() {
        return Err("paths parameter must be a non-empty JSON array".to_string());
    }

    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);
    let repo_key = repo_path.to_string_lossy().to_string();
    let git_repo =
        GitRepository::open(&repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    let mut result: HashMap<String, FileCreationInfo> = HashMap::new();

    for path in paths.iter() {
        if path.is_empty() {
            continue;
        }

        let info = compute_file_creation_info(&git_repo, &repo_key, path);
        result.insert(path.clone(), info);
    }

    Ok(result)
}

#[tauri::command]
pub fn get_image(
    params: GetImageParams,
    config: State<'_, Mutex<Config>>,
) -> Result<ImageResponse, String> {
    let path = params.path.unwrap_or_default();
    if path.is_empty() {
        return Err("path parameter is required".to_string());
    }

    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);
    let git_repo =
        GitRepository::open(&repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    let ref_sha = params.ref_.as_deref().unwrap_or("HEAD");
    let ref_sha = normalize_sha(ref_sha);

    let data = git_repo
        .run_git_bytes(&["show", &format!("{}:{}", ref_sha, path)])
        .map_err(|e| format!("File not found: {}", e))?;

    let base64_data = general_purpose::STANDARD.encode(&data);

    let ext = StdPath::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime_type = mime_guess::from_ext(&ext)
        .first_or_octet_stream()
        .to_string();

    Ok(ImageResponse {
        data: format!("data:{};base64,{}", mime_type, base64_data),
        mime_type,
    })
}
