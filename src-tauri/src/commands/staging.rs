use gitpow_rust::config::Config;
use gitpow_rust::models::{StatusFile, StatusResponse, SuccessResponse};
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
pub struct StageRequest {
    repo: String,
    path: String,
    hunks: Option<Vec<usize>>,
}

#[derive(Deserialize)]
pub struct UnstageRequest {
    repo: String,
    path: String,
    hunks: Option<Vec<usize>>,
}

#[derive(Deserialize)]
pub struct CommitRequest {
    repo: String,
    message: String,
}

#[tauri::command]
pub fn get_status(
    repo: String,
    config: State<'_, Mutex<Config>>,
) -> Result<StatusResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&repo, &config.repos_root);

    let status_out = run_git(&["status", "--porcelain"], &repo_path)
        .map_err(|e| format!("Failed to get status: {}", e))?;

    let lines: Vec<&str> = status_out.split('\n').collect();
    let mut files = Vec::new();

    for line in lines {
        // Don't trim leading spaces - they're significant in git status --porcelain format
        // Format: "XY filename" where X=staged status, Y=unstaged status, then space, then filename
        let line = line.trim_end(); // Only trim trailing whitespace
        if line.is_empty() || line.len() < 4 {
            continue;
        }

        let staged = line.chars().next().unwrap() != ' ' && line.chars().next().unwrap() != '?';
        let unstaged = line.chars().nth(1).unwrap() != ' ' && line.chars().nth(1).unwrap() != '?';
        let status = &line[..2];
        // Git status format is always: 2 status chars, then space, then filename
        // Find the space after the 2-char status and get everything after it
        let file_path = if line.len() >= 3 && line.chars().nth(2) == Some(' ') {
            // Standard format: "XY filename" - filename starts at index 3
            &line[3..]
        } else if line.len() > 2 {
            // Fallback: skip first 3 chars (should be "XY " but handle edge cases)
            &line[3..]
        } else {
            continue;
        };

        if file_path.contains(" -> ") {
            // Renamed file
            let parts: Vec<&str> = file_path.split(" -> ").collect();
            if parts.len() == 2 {
                files.push(StatusFile {
                    path: parts[1].to_string(),
                    old_path: Some(parts[0].to_string()),
                    status: status.to_string(),
                    staged,
                    unstaged,
                    r#type: "renamed".to_string(),
                });
            }
        } else {
            let file_type = if status.contains('A') {
                "added"
            } else if status.contains('D') {
                "deleted"
            } else if status.contains('?') {
                "untracked"
            } else {
                "modified"
            };

            files.push(StatusFile {
                path: file_path.to_string(),
                old_path: None,
                status: status.to_string(),
                staged,
                unstaged,
                r#type: file_type.to_string(),
            });
        }
    }

    Ok(StatusResponse { files })
}

#[tauri::command]
pub fn stage(
    req: StageRequest,
    config: State<'_, Mutex<Config>>,
) -> Result<SuccessResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&req.repo, &config.repos_root);

    if let Some(hunks) = req.hunks {
        if !hunks.is_empty() {
            // Stage specific hunks
            let diff_out = run_git(&["diff", "--", &req.path], &repo_path).unwrap_or_default();
            let lines: Vec<&str> = diff_out.split('\n').collect();
            let mut patch_lines = Vec::new();
            let mut in_hunk = false;
            let mut hunk_index = 0;

            for line in lines {
                if line.starts_with("@@") {
                    in_hunk = hunks.contains(&hunk_index);
                    hunk_index += 1;
                    if in_hunk {
                        patch_lines.push(line);
                    }
                } else if in_hunk {
                    patch_lines.push(line);
                }
            }

            if !patch_lines.is_empty() {
                let patch_content = patch_lines.join("\n") + "\n";
                let tmp_file = repo_path.join(".git").join("tmp-patch-temp");
                if let Some(parent) = tmp_file.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                fs::write(&tmp_file, patch_content)
                    .map_err(|e| format!("Failed to write patch: {}", e))?;

                run_git(
                    &["apply", "--cached", tmp_file.to_str().unwrap()],
                    &repo_path,
                )
                .map_err(|e| format!("Failed to apply patch: {}", e))?;

                let _ = fs::remove_file(&tmp_file);
            }
        }
    } else {
        // Stage entire file
        run_git(&["add", &req.path], &repo_path)
            .map_err(|e| format!("Failed to stage file: {}", e))?;
    }

    Ok(SuccessResponse { success: true })
}

#[tauri::command]
pub fn unstage(
    req: UnstageRequest,
    config: State<'_, Mutex<Config>>,
) -> Result<SuccessResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&req.repo, &config.repos_root);

    run_git(&["reset", "HEAD", "--", &req.path], &repo_path)
        .map_err(|e| format!("Failed to unstage file: {}", e))?;

    Ok(SuccessResponse { success: true })
}

#[tauri::command]
pub fn commit(
    req: CommitRequest,
    config: State<'_, Mutex<Config>>,
) -> Result<SuccessResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&req.repo, &config.repos_root);

    let message = req.message.trim();
    if message.is_empty() {
        return Err("commit message required".to_string());
    }

    run_git(&["commit", "-m", message], &repo_path)
        .map_err(|e| format!("Failed to create commit: {}", e))?;

    Ok(SuccessResponse { success: true })
}


