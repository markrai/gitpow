use gitpow_rust::config::Config;
use std::sync::Mutex;
use tauri::State;

mod commands;

// Initialize tracing subscriber
fn init_tracing() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("debug"));
    // Get the filter string before moving env_filter
    let filter_str = format!("{:?}", env_filter);
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(false)
        .init();
    tracing::info!("Tracing initialized with level: {}", filter_str);
}

pub fn run() {
    init_tracing();

    // Initialize config
    let config = Config::init();
    tracing::info!("Repos root: {:?}", config.repos_root);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(config))
        .invoke_handler(tauri::generate_handler![
            // Config
            commands::repos::get_config,
            // Repos
            commands::repos::get_repos,
            commands::browse::browse_projects_root,
            // Branches
            commands::branches::get_branches,
            commands::branches::get_branch_ahead_behind,
            commands::branches::get_branch_creation,
            commands::branches::get_branch_status,
            // Commits
            commands::commits::get_commits,
            commands::commits::get_commits_all_branches,
            commands::commits::get_commits_between,
            commands::commits::get_commit_metrics,
            commands::commits::get_tags,
            // Files
            commands::files::get_files,
            commands::files::get_commit_files,
            commands::files::get_file,
            commands::files::get_file_creation,
            commands::files::get_file_creation_batch,
            commands::files::get_image,
            // Diff
            commands::diff::get_diff,
            // Staging
            commands::staging::get_status,
            commands::staging::stage,
            commands::staging::unstage,
            commands::staging::commit,
            // Fetch
            commands::fetch::fetch_repo,
            // Git Operations
            commands::git_ops::pull_repo,
            commands::git_ops::push_repo,
            commands::git_ops::stash_push,
            commands::git_ops::stash_pop,
            commands::git_ops::checkout_commit,
            commands::git_ops::checkout_branch,
            commands::git_ops::get_previous_branch,
            commands::git_ops::get_best_branch_to_checkout,
            // Rebase
            commands::rebase::get_rebase_preview,
            commands::rebase::post_rebase_plan,
            // Conflicts
            commands::conflicts::get_conflicts,
            commands::conflicts::get_conflict_file,
            commands::conflicts::resolve_conflict,
            // Explorer
            commands::explorer::open_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

