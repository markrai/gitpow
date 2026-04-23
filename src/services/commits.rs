//! Commit-related application services.
//!
//! All functions here are blocking; callers must run them inside a
//! blocking-friendly executor (e.g. `tokio::task::spawn_blocking`).

use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::git::repository::GitRepository;
use crate::models::{Commit, CommitMetric, CommitsBetweenResponse, Tag};
use crate::utils::normalize_sha;

/// Fetch commits for a single branch.
/// `mode == "local"` walks the local-only branch history; any other value
/// uses the fuller branch-head annotations.
pub fn list_commits(
    repo_path: &Path,
    branch: &str,
    limit: usize,
    mode: &str,
) -> Result<Vec<Commit>, String> {
    let git_repo = GitRepository::open(repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let commits = if mode.eq_ignore_ascii_case("local") {
        git_repo.get_commits_local(branch, limit)
    } else {
        git_repo.get_commits(branch, limit)
    }
    .map_err(|e| format!("Failed to get commits: {}", e))?;

    Ok(commits)
}

/// Aggregated all-branches commit history for graph "All" mode. Walks each
/// branch's local history in parallel and merges the results by SHA so the
/// frontend can render per-branch lanes without issuing one request per
/// branch.
pub fn list_all_branches_commits(
    repo_path: &Path,
    max_total: usize,
) -> Result<Vec<Commit>, String> {
    let git_repo = GitRepository::open(repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let branch_info = git_repo
        .get_branch_info()
        .map_err(|e| format!("Failed to get branches: {}", e))?;

    let branches = branch_info.branches;
    if branches.is_empty() {
        return Ok(Vec::new());
    }

    let branch_count = branches.len().max(1);

    // Pick a per-branch limit with a floor so repos with many branches still
    // return meaningful history after SHA deduplication; the global
    // `max_total` still bounds the final result.
    const MIN_PER_BRANCH: usize = 50;
    let mut per_branch_limit = (max_total / branch_count).max(MIN_PER_BRANCH);
    if per_branch_limit > 500 {
        per_branch_limit = 500;
    }

    let combined: Mutex<HashMap<String, (Commit, HashSet<String>)>> =
        Mutex::new(HashMap::new());
    let repo_path_buf: PathBuf = repo_path.to_path_buf();

    branches
        .par_iter()
        .try_for_each(|branch| {
            // Each rayon thread opens its own repo connection (libgit2
            // `Repository` is not `Send`/`Sync`).
            let git_repo = GitRepository::open(&repo_path_buf)
                .map_err(|e| format!("Failed to open repository: {}", e))?;

            let commits_for_branch = git_repo
                .get_commits_local(branch, per_branch_limit)
                .map_err(|e| format!("Failed to get commits for branch {}: {}", branch, e))?;

            let mut map = combined.lock().unwrap();
            for commit in commits_for_branch {
                let sha = commit.sha.clone();
                let entry = map
                    .entry(sha)
                    .or_insert_with(|| (commit, HashSet::new()));
                entry.1.insert(branch.clone());
            }

            Ok::<(), String>(())
        })?;

    let combined = combined.into_inner().unwrap();
    let mut all_commits: Vec<Commit> = combined
        .into_iter()
        .map(|(_sha, (mut commit, branch_set))| {
            commit.branches = branch_set.into_iter().collect();
            commit
        })
        .collect();

    // Sort newest-first by RFC3339 date (compares lexicographically).
    all_commits.sort_by(|a, b| b.date.cmp(&a.date));

    if all_commits.len() > max_total {
        all_commits.truncate(max_total);
    }

    Ok(all_commits)
}

/// Count commits between two SHAs and report the relationship between them.
pub fn count_commits_between(
    repo_path: &Path,
    from: &str,
    to: &str,
) -> Result<CommitsBetweenResponse, String> {
    let git_repo = GitRepository::open(repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let from_sha = normalize_sha(from);
    let to_sha = normalize_sha(to);

    if git_repo.is_ancestor(&to_sha, &from_sha).unwrap_or(false) {
        let count = git_repo
            .count_commits_between(&from_sha, &to_sha)
            .unwrap_or(0);
        return Ok(CommitsBetweenResponse {
            count: count as i32,
            note: None,
            from: Some(from_sha),
            to: Some(to_sha),
            error: None,
        });
    }

    if git_repo.is_ancestor(&from_sha, &to_sha).unwrap_or(false) {
        return Ok(CommitsBetweenResponse {
            count: 0,
            note: Some("Creation commit is after current commit".to_string()),
            from: Some(from_sha),
            to: Some(to_sha),
            error: None,
        });
    }

    Ok(CommitsBetweenResponse {
        count: -1,
        note: Some("Could not find common ancestor".to_string()),
        from: Some(from_sha),
        to: Some(to_sha),
        error: None,
    })
}

/// Compute per-commit metrics (files changed, lines changed, impact score)
/// for the most recent `limit` commits on `branch`.
pub fn list_commit_metrics(
    repo_path: &Path,
    branch: &str,
    limit: usize,
) -> Result<Vec<CommitMetric>, String> {
    let git_repo = GitRepository::open(repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let target = git_repo
        .repo
        .revparse_single(branch)
        .map_err(|e| format!("Failed to resolve branch '{}': {}", branch, e))?;

    let mut revwalk = git_repo
        .repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;

    revwalk
        .push(target.id())
        .map_err(|e| format!("Failed to start revwalk: {}", e))?;

    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| format!("Failed to set revwalk sorting: {}", e))?;

    let oids: Vec<git2::Oid> = revwalk.take(limit).filter_map(|r| r.ok()).collect();

    // Each rayon worker opens its own connection; the path must live as
    // long as the parallel iterator.
    let repo_path_for_threads: PathBuf = git_repo
        .repo
        .path()
        .parent()
        .unwrap_or_else(|| git_repo.repo.path())
        .to_path_buf();

    let metrics: Vec<CommitMetric> = oids
        .par_iter()
        .filter_map(|oid| {
            let git_repo = GitRepository::open(&repo_path_for_threads).ok()?;
            let (files_changed, lines_changed) =
                git_repo.get_commit_stats(*oid).unwrap_or((0, 0));
            Some(CommitMetric {
                sha: oid.to_string(),
                lines_changed,
                files_changed,
                impact_score: impact_score(files_changed, lines_changed),
            })
        })
        .collect();

    Ok(metrics)
}

/// Weighted, squared blend of file count and lines changed. Kept here so the
/// coefficients live in one place instead of being copy-pasted between
/// handlers.
fn impact_score(files_changed: i32, lines_changed: i32) -> f64 {
    let base = lines_changed as f64 * 0.7 + files_changed as f64 * 10.0 * 0.3;
    base * base
}

/// List annotated and lightweight tags with creation metadata.
pub fn list_tags(repo_path: &Path) -> Result<Vec<Tag>, String> {
    let git_repo = GitRepository::open(repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let tags_out = git_repo.run_git(&[
        "for-each-ref",
        "refs/tags",
        "--format=%(refname:short)%00%(objectname)%00%(creatordate:iso-strict)",
    ]);

    let mut tags = Vec::new();
    if let Ok(output) = tags_out {
        for line in output.lines() {
            let parts: Vec<&str> = line.split('\0').collect();
            if parts.len() >= 3 {
                tags.push(Tag {
                    name: parts[0].to_string(),
                    sha: parts[1].to_string(),
                    date: parts[2].to_string(),
                });
            }
        }
    }

    Ok(tags)
}

/// Parse a `git diff --shortstat` line such as
/// ` 2 files changed, 10 insertions(+), 3 deletions(-)` into
/// `(files_changed, total_line_changes)`.
///
/// Kept here for reuse by future services that shell out to
/// `git diff --shortstat`; the test suite already exercises it.
#[allow(dead_code)]
pub fn parse_shortstat(line: &str) -> (i32, i32) {
    let mut files_changed = 0;
    let mut insertions = 0;
    let mut deletions = 0;

    for part in line.split(',') {
        let trimmed = part.trim();
        if let Some(num) = trimmed
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<i32>().ok())
        {
            if trimmed.contains("file") {
                files_changed = num;
            } else if trimmed.contains("insertion") {
                insertions = num;
            } else if trimmed.contains("deletion") {
                deletions = num;
            }
        }
    }

    (files_changed, insertions + deletions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shortstat_standard_line() {
        let line = " 2 files changed, 10 insertions(+), 3 deletions(-)";
        assert_eq!(parse_shortstat(line), (2, 13));
    }

    #[test]
    fn parse_shortstat_insertions_only() {
        let line = " 1 file changed, 5 insertions(+)";
        assert_eq!(parse_shortstat(line), (1, 5));
    }

    #[test]
    fn parse_shortstat_deletions_only() {
        let line = " 1 file changed, 7 deletions(-)";
        assert_eq!(parse_shortstat(line), (1, 7));
    }

    #[test]
    fn parse_shortstat_empty_returns_zero() {
        assert_eq!(parse_shortstat(""), (0, 0));
    }

    #[test]
    fn impact_score_zero_when_nothing_changed() {
        assert_eq!(impact_score(0, 0), 0.0);
    }

    #[test]
    fn impact_score_grows_quadratically() {
        let small = impact_score(1, 10);
        let big = impact_score(2, 20);
        assert!(big > small * 2.0);
    }
}
