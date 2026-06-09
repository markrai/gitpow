use gitpow_rust::models::BrowseFolderResponse;
use tokio::task;

/// Open a native folder selection dialog on the host OS and
/// return the chosen path as a string. Intended for local use.
#[tauri::command]
pub async fn browse_projects_root() -> Result<BrowseFolderResponse, String> {
    tracing::debug!("browse_projects_root command called");
    let dialog_result = task::spawn_blocking(|| {
        tracing::debug!("Opening folder picker dialog");
        rfd::FileDialog::new().pick_folder()
    })
    .await
    .map_err(|e| {
        tracing::error!("Folder picker task failed: {}", e);
        format!("Folder picker task failed: {}", e)
    })?;

    match dialog_result {
        Some(path) => {
            let path_str = path.to_string_lossy().to_string();
            tracing::debug!("Folder selected: {}", path_str);
            Ok(BrowseFolderResponse { path: path_str })
        }
        None => {
            tracing::debug!("Folder selection was cancelled");
            Err("Folder selection was cancelled".to_string())
        }
    }
}
