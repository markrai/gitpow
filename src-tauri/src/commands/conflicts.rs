use gitpow_rust::config::Config;
use gitpow_rust::models::{
    ConflictFile, ConflictFileResponse, ConflictsResponse, SuccessResponse,
};
use gitpow_rust::utils::get_repo_path;
use serde::Deserialize;
use std::fs;
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn run_git(args: &[&str], repo_path: &std::path::Path) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(repo_path);
    
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    
    let output = cmd.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Deserialize)]
pub struct GetConflictFileParams {
    repo: String,
    path: String,
}

#[tauri::command]
pub fn get_conflicts(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<ConflictsResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    let status_out = run_git(&["status", "--porcelain"], &repo_path)
        .map_err(|e| format!("Failed to get status: {}", e))?;

    let lines: Vec<&str> = status_out.split('\n').collect();
    let mut conflicted_files = Vec::new();

    for line in lines {
        let line = line.trim();
        if line.len() < 3 {
            continue;
        }

        let status1 = line.chars().next().unwrap_or(' ');
        let status2 = line.chars().nth(1).unwrap_or(' ');

        let is_conflict = (status1 == 'A' && status2 == 'A')
            || status1 == 'U'
            || status2 == 'U'
            || (status1 == 'D' && status2 == 'D')
            || (status1 == 'A' && status2 == 'U')
            || (status1 == 'U' && status2 == 'A')
            || (status1 == 'D' && status2 == 'U')
            || (status1 == 'U' && status2 == 'D');

        if is_conflict {
            let file_path = &line[3..];
            if file_path.contains(" -> ") {
                let parts: Vec<&str> = file_path.split(" -> ").collect();
                if parts.len() == 2 {
                    conflicted_files.push(ConflictFile {
                        path: parts[1].to_string(),
                        r#type: "both-modified".to_string(),
                    });
                }
            } else {
                conflicted_files.push(ConflictFile {
                    path: file_path.to_string(),
                    r#type: "both-modified".to_string(),
                });
            }
        }
    }

    Ok(ConflictsResponse {
        files: conflicted_files.clone(),
        has_conflicts: !conflicted_files.is_empty(),
    })
}

#[tauri::command]
pub fn get_conflict_file(
    params: GetConflictFileParams,
    config: State<'_, Mutex<Config>>,
) -> Result<ConflictFileResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);

    // Get Base (common ancestor), Mine (current/ours), and Theirs (incoming)
    // :1: = base, :2: = ours, :3: = theirs
    let base = run_git(&["show", &format!(":1:{}", params.path)], &repo_path).unwrap_or_default();

    let mine = run_git(&["show", &format!(":2:{}", params.path)], &repo_path).unwrap_or_else(|_| {
        // Fallback to working tree
        let full_path = repo_path.join(&params.path);
        fs::read_to_string(&full_path).unwrap_or_default()
    });

    let theirs =
        run_git(&["show", &format!(":3:{}", params.path)], &repo_path).unwrap_or_default();

    // Get current conflicted content (working tree)
    let full_path = repo_path.join(&params.path);
    let result = fs::read_to_string(&full_path).unwrap_or_default();

    Ok(ConflictFileResponse {
        base,
        mine,
        theirs,
        result,
        file_path: params.path,
    })
}

#[derive(Deserialize)]
pub struct ResolveConflictParams {
    repo: String,
    path: String,
    content: String,
}

#[tauri::command]
pub fn resolve_conflict(
    params: ResolveConflictParams,
    config: State<'_, Mutex<Config>>,
) -> Result<SuccessResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);

    if params.path.is_empty() || params.content.is_empty() {
        return Err("path and content required".to_string());
    }

    // Write resolved content to file
    let full_path = repo_path.join(&params.path);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&full_path, params.content).map_err(|e| format!("Failed to write file: {}", e))?;

    // Stage the resolved file
    run_git(&["add", &params.path], &repo_path)
        .map_err(|e| format!("Failed to stage file: {}", e))?;

    Ok(SuccessResponse { success: true })
}

