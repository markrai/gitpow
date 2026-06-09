use gitpow_rust::config::Config;
use gitpow_rust::git::repository::GitRepository;
use gitpow_rust::utils::get_repo_path;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn fetch_repo(repo: String, config: State<'_, Mutex<Config>>) -> Result<String, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err("Repository not found".to_string());
    }

    match GitRepository::open(&repo_path) {
        Ok(repo) => match repo.fetch_all() {
            Ok(_) => Ok("Fetch successful".to_string()),
            Err(e) => Err(format!("Failed to fetch: {}", e)),
        },
        Err(e) => Err(format!("Failed to open repository: {}", e)),
    }
}
