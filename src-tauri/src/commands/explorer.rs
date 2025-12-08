use gitpow_rust::config::Config;
use gitpow_rust::models::SuccessResponse;
use gitpow_rust::utils::get_repo_path;
use serde::Deserialize;
use std::path::Path as StdPath;
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Deserialize)]
pub struct OpenExplorerParams {
    repo: String,
    path: String,
}

#[tauri::command]
pub fn open_explorer(
    params: OpenExplorerParams,
    config: State<'_, Mutex<Config>>,
) -> Result<SuccessResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);
    let full_path = repo_path.join(&params.path);

    // Check if file exists
    if !full_path.exists() {
        // If file doesn't exist, open the directory containing it
        if let Some(dir_path) = full_path.parent() {
            if dir_path.exists() {
                open_directory(dir_path, &full_path);
            }
        }
    } else {
        // File exists, open it in explorer
        open_file(&full_path);
    }

    Ok(SuccessResponse { success: true })
}

fn open_file(full_path: &StdPath) {
    #[cfg(target_os = "windows")]
    {
        let path_str = full_path.to_string_lossy().replace('/', "\\");
        let _ = Command::new("explorer")
            .args(&["/select,", &path_str])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open")
            .args(&["-R", full_path.to_str().unwrap_or("")])
            .spawn();
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(dir) = full_path.parent() {
            let _ = Command::new("xdg-open")
                .arg(dir.to_str().unwrap_or(""))
                .spawn();
        }
    }
}

fn open_directory(dir_path: &StdPath, full_path: &StdPath) {
    #[cfg(target_os = "windows")]
    {
        let path_str = full_path.to_string_lossy().replace('/', "\\");
        let mut cmd = Command::new("explorer");
        cmd.args(&["/select,", &path_str])
            .creation_flags(0x08000000); // CREATE_NO_WINDOW
        if cmd.spawn().is_err() {
            // If file doesn't exist, just open the directory
            let dir_str = dir_path.to_string_lossy().replace('/', "\\");
            let _ = Command::new("explorer")
                .arg(&dir_str)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .spawn();
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open")
            .args(&["-R", full_path.to_str().unwrap_or("")])
            .spawn();
    }

    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("xdg-open")
            .arg(dir_path.to_str().unwrap_or(""))
            .spawn();
    }
}

