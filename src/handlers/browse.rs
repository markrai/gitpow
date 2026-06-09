use axum::{http::StatusCode, response::Json};
use tokio::task;

use crate::models::{BrowseFolderResponse, ErrorResponse};

/// Open a native folder selection dialog on the host OS and
/// return the chosen path as a string. Intended for local use.
pub async fn browse_projects_root(
) -> Result<Json<BrowseFolderResponse>, (StatusCode, Json<ErrorResponse>)> {
    let dialog_result = task::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Folder picker task failed: {}", e),
                }),
            )
        })?;

    match dialog_result {
        Some(path) => Ok(Json(BrowseFolderResponse {
            path: path.to_string_lossy().to_string(),
        })),
        None => Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Folder selection was cancelled".to_string(),
            }),
        )),
    }
}
