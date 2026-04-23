pub mod branches;
pub mod browse;
pub mod commits;
pub mod conflicts;
pub mod diff;
pub mod explorer;
pub mod fetch;
pub mod files;
pub mod git_ops;
pub mod rebase;
pub mod repos;
pub mod staging;

// Re-export all command functions
pub use branches::{get_branches, get_branch_ahead_behind, get_branch_creation, get_branch_status};
pub use browse::browse_projects_root;
pub use commits::{get_commits, get_commits_all_branches, get_commits_between, get_commit_metrics, get_tags};
pub use conflicts::{get_conflicts, get_conflict_file, resolve_conflict};
pub use diff::get_diff;
pub use explorer::open_explorer;
pub use fetch::fetch_repo;
pub use files::{get_files, get_commit_files, get_file, get_file_creation, get_file_creation_batch, get_image};
pub use git_ops::{pull_repo, push_repo, stash_apply, stash_drop, stash_list, stash_pop, stash_push};
pub use rebase::{get_rebase_preview, post_rebase_plan};
pub use repos::{get_config, get_repos};
pub use staging::{get_status, stage, unstage, commit};


