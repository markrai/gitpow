use gitpow_rust::config::Config;
use gitpow_rust::git::repository::GitRepository;
use gitpow_rust::utils::get_repo_path;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn pull_repo(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<serde_json::Value, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.pull() {
            Ok(output) => Ok(serde_json::json!({
                "success": true,
                "message": "Pull successful",
                "output": output
            })),
            Err(e) => Ok(serde_json::json!({
                "success": false,
                "error": format!("Failed to pull: {}", e),
                "message": format!("Pull failed: {}", e)
            })),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

#[tauri::command]
pub fn push_repo(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<serde_json::Value, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.push() {
            Ok(output) => Ok(serde_json::json!({
                "success": true,
                "message": "Push successful",
                "output": output
            })),
            Err(e) => Ok(serde_json::json!({
                "success": false,
                "error": format!("Failed to push: {}", e),
                "message": format!("Push failed: {}", e)
            })),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

#[tauri::command]
pub fn stash_push(
    repo: String,
    message: Option<String>,
    config: State<'_, Mutex<Config>>,
) -> Result<serde_json::Value, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => {
            let msg = message.as_deref();
            match repo.stash_push(msg) {
                Ok(output) => Ok(serde_json::json!({
                    "success": true,
                    "message": "Changes stashed",
                    "output": output
                })),
                Err(e) => Ok(serde_json::json!({
                    "success": false,
                    "error": format!("Failed to stash: {}", e),
                    "message": format!("Stash failed: {}", e)
                })),
            }
        }
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

#[tauri::command]
pub fn stash_pop(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<serde_json::Value, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.stash_pop() {
            Ok(output) => Ok(serde_json::json!({
                "success": true,
                "message": "Stash popped",
                "output": output
            })),
            Err(e) => Ok(serde_json::json!({
                "success": false,
                "error": format!("Failed to pop stash: {}", e),
                "message": format!("Stash pop failed: {}", e)
            })),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

#[tauri::command]
pub fn checkout_commit(
    repo: String,
    commit_sha: String,
    config: State<'_, Mutex<Config>>,
) -> Result<serde_json::Value, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.checkout_commit(&commit_sha) {
            Ok(output) => Ok(serde_json::json!({
                "success": true,
                "message": "Checkout successful",
                "output": output
            })),
            Err(e) => Ok(serde_json::json!({
                "success": false,
                "error": format!("Failed to checkout commit: {}", e),
                "message": format!("Checkout failed: {}", e)
            })),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

#[tauri::command]
pub fn checkout_branch(
    repo: String,
    branch_name: String,
    config: State<'_, Mutex<Config>>,
) -> Result<serde_json::Value, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.checkout_branch(&branch_name) {
            Ok(output) => Ok(serde_json::json!({
                "success": true,
                "message": "Checkout successful",
                "output": output
            })),
            Err(e) => Ok(serde_json::json!({
                "success": false,
                "error": format!("Failed to checkout branch: {}", e),
                "message": format!("Checkout failed: {}", e)
            })),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

#[tauri::command]
pub fn get_previous_branch(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<Option<String>, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.get_previous_branch_from_reflog() {
            Ok(branch) => Ok(branch),
            Err(e) => Err(format!("Failed to get previous branch: {}", e)),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}

/// Get the best branch to checkout when exiting detached HEAD state
/// Returns the previous branch if found, otherwise the default branch (main/master)
#[tauri::command]
pub fn get_best_branch_to_checkout(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<Option<String>, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(git_repo) => {
            // First, try to get the previous branch from reflog
            if let Ok(Some(previous_branch)) = git_repo.get_previous_branch_from_reflog() {
                // Verify the branch still exists
                if let Ok(branch_info) = git_repo.get_branch_info() {
                    if branch_info.branches.contains(&previous_branch) {
                        return Ok(Some(previous_branch));
                    }
                }
            }
            
            // Fallback to default branch (main, master, or first available)
            match git_repo.get_default_branch() {
                Ok(branch) => Ok(branch),
                Err(e) => Err(format!("Failed to get default branch: {}", e)),
            }
        }
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}
