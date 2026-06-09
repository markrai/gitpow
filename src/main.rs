mod config;
mod git;
mod handlers;
mod models;
mod services;
mod utils;

use axum::http::{header::CACHE_CONTROL, HeaderValue};
use axum::{
    routing::{get, post},
    Router,
};
use std::net::SocketAddr;
use std::time::Duration;
use tower::ServiceBuilder;
use tower_http::timeout::TimeoutLayer;
use tower_http::{cors::CorsLayer, services::ServeDir, set_header::SetResponseHeaderLayer};

use config::Config;
use handlers::branches::{get_branch_ahead_behind, get_branch_creation, get_branches};
use handlers::browse::browse_projects_root;
use handlers::commits::{
    get_commit_metrics, get_commits, get_commits_all_branches, get_commits_between, get_tags,
};
use handlers::conflicts::{get_conflict_file, get_conflicts, resolve_conflict};
use handlers::diff::get_diff;
use handlers::explorer::open_explorer;
use handlers::fetch::fetch_repo;
use handlers::files::{
    get_commit_files, get_file, get_file_creation, get_file_creation_batch, get_files, get_image,
};
use handlers::git_ops::{
    get_branch_status, pull_repo, push_repo, stash_apply, stash_drop, stash_list, stash_pop,
    stash_push,
};
use handlers::rebase::{get_rebase_preview, post_rebase_plan};
use handlers::repos::{get_config, get_repos};
use handlers::staging::{commit, get_status, stage, unstage};

#[tokio::main]
async fn main() {
    // Initialize tracing subscriber with explicit default level
    // RUST_LOG env var can override this (e.g., RUST_LOG=debug for verbose logs)
    // Default to 'info' level so important logs are always visible
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let config = Config::init();
    let app_state = config.clone();

    let static_dir = ServeDir::new("./static");
    let static_service = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::if_not_present(
            CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-cache, must-revalidate"),
        ))
        .service(static_dir);

    let app = Router::new()
        .route("/api/config", get(get_config))
        .route("/api/browse/projects-root", get(browse_projects_root))
        .route("/api/repos", get(get_repos))
        .route("/api/repos/:repo/branches", get(get_branches))
        // Ahead/behind endpoint uses query parameters for both repo and branch
        // to avoid any routing edge cases with slashes in branch names.
        .route("/api/branch-ahead-behind", get(get_branch_ahead_behind))
        // Branch creation endpoint - returns when a branch was created
        .route("/api/branch-creation", get(get_branch_creation))
        .route("/api/repos/:repo/commits", get(get_commits))
        .route(
            "/api/repos/:repo/commits-all-branches",
            get(get_commits_all_branches),
        )
        .route("/api/repos/:repo/commits-between", get(get_commits_between))
        .route("/api/repos/:repo/commits/metrics", get(get_commit_metrics))
        .route("/api/repos/:repo/tags", get(get_tags))
        .route("/api/repos/:repo/files", get(get_files))
        .route("/api/repos/:repo/commit/files", get(get_commit_files))
        .route("/api/repos/:repo/file", get(get_file))
        .route("/api/repos/:repo/file-creation", get(get_file_creation))
        .route(
            "/api/repos/:repo/file-creation-batch",
            get(get_file_creation_batch),
        )
        .route("/api/repos/:repo/image", get(get_image))
        .route("/api/repos/:repo/diff", get(get_diff))
        .route("/api/repos/:repo/status", get(get_status))
        .route("/api/repos/:repo/stage", post(stage))
        .route("/api/repos/:repo/unstage", post(unstage))
        .route("/api/repos/:repo/commit", post(commit))
        .route("/api/repos/:repo/fetch", post(fetch_repo))
        .route("/api/repos/:repo/pull", post(pull_repo))
        .route("/api/repos/:repo/push", post(push_repo))
        .route("/api/repos/:repo/branch-status", get(get_branch_status))
        .route("/api/repos/:repo/stash", get(stash_list))
        .route("/api/repos/:repo/stash/push", post(stash_push))
        .route("/api/repos/:repo/stash/pop", post(stash_pop))
        .route("/api/repos/:repo/stash/apply", post(stash_apply))
        .route("/api/repos/:repo/stash/drop", post(stash_drop))
        .route("/api/repos/:repo/rebase/preview", get(get_rebase_preview))
        .route("/api/repos/:repo/rebase/plan", post(post_rebase_plan))
        .route("/api/repos/:repo/conflicts", get(get_conflicts))
        .route("/api/repos/:repo/conflicts/file", get(get_conflict_file))
        .route("/api/repos/:repo/conflicts/resolve", post(resolve_conflict))
        .route("/api/repos/:repo/open-explorer", get(open_explorer))
        .layer(
            ServiceBuilder::new()
                .layer(TimeoutLayer::new(Duration::from_secs(60))) // 60 second timeout for all requests
                .layer(CorsLayer::permissive()),
        )
        .with_state(app_state)
        .fallback_service(static_service);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port.parse().unwrap_or(3000)));
    tracing::info!("Git Explorer server on http://localhost:{}", addr.port());
    tracing::info!("Repos root: {:?}", config.repos_root);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
