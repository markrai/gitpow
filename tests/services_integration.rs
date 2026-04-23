//! Integration tests that exercise the `gitpow_rust::services` layer
//! against a real on-disk git fixture repo.
//!
//! These are deliberately small: they prove the handler/command ->
//! service -> libgit2 path works end to end without requiring the full
//! Axum or Tauri stack. As Phase 5 adds more tests, keep fixtures cheap
//! (an empty repo plus one commit is usually enough).

use std::fs;
use std::path::{Path, PathBuf};

use git2::{Repository, Signature};
use tempfile::TempDir;

use gitpow_rust::git::repository::GitRepository;
use gitpow_rust::services::{commits, git_ops};

/// Build a minimal git repo with one commit and return the temp handle +
/// repo path. The `TempDir` is returned so it lives for the whole test.
fn init_fixture_repo() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create tempdir");
    let path = dir.path().to_path_buf();

    {
        let repo = Repository::init(&path).expect("init repo");

        // Write a tracked file.
        let readme = path.join("README.md");
        fs::write(&readme, "hello\n").expect("write README");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add path");
        index.write().expect("write index");
        let tree_oid = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_oid).expect("find tree");

        let sig = Signature::now("GitPow Test", "test@example.com").expect("signature");
        repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
            .expect("commit");
    }

    (dir, path)
}

#[test]
fn list_commits_returns_initial_commit() {
    let (_dir, repo_path) = init_fixture_repo();

    let commits = commits::list_commits(&repo_path, "HEAD", 10, "full")
        .expect("list_commits should succeed");

    assert_eq!(
        commits.len(),
        1,
        "expected exactly one commit, got {:#?}",
        commits
    );
    assert_eq!(commits[0].message.trim(), "initial commit");
}

#[test]
fn list_tags_is_empty_on_fresh_repo() {
    let (_dir, repo_path) = init_fixture_repo();

    let tags = commits::list_tags(&repo_path).expect("list_tags should succeed");
    assert!(tags.is_empty(), "fresh repo should have no tags: {:?}", tags);
}

#[test]
fn stash_list_is_empty_on_clean_repo() {
    let (_dir, repo_path) = init_fixture_repo();

    let entries = git_ops::stash_list(&repo_path).expect("stash_list should succeed");
    assert!(
        entries.is_empty(),
        "clean repo should have no stash entries: {:?}",
        entries
    );
}

#[test]
fn stash_push_reports_no_changes_on_clean_repo() {
    let (_dir, repo_path) = init_fixture_repo();

    let response = git_ops::stash_push(&repo_path, None)
        .expect("stash_push should succeed even with nothing to stash");

    assert!(!response.success, "nothing to stash should not be success");
    assert_eq!(response.message.as_deref(), Some("No local changes to stash"));
    assert!(response.error.is_none(), "no-op should not surface an error");
}

#[test]
fn stash_pop_reports_no_stashes_on_empty_stack() {
    let (_dir, repo_path) = init_fixture_repo();

    let response = git_ops::stash_pop(&repo_path)
        .expect("stash_pop should succeed even with nothing to pop");

    assert!(!response.success);
    assert_eq!(response.message.as_deref(), Some("No stashes to pop"));
    assert!(response.error.is_none());
}

#[test]
fn get_commit_changed_files_returns_initial_readme() {
    let (_dir, repo_path) = init_fixture_repo();

    let head_sha = head_sha(&repo_path);
    let repo = GitRepository::open(&repo_path).expect("open repo");
    let changes = repo
        .get_commit_changed_files(&head_sha)
        .expect("get_commit_changed_files should succeed");

    assert_eq!(changes.len(), 1, "expected exactly one changed file: {:#?}", changes);
    assert_eq!(changes[0].path, "README.md");
    assert_eq!(
        changes[0].status, "added",
        "initial commit's README should be reported as added"
    );
}

#[test]
fn get_file_diff_returns_hunk_for_modified_file() {
    let (_dir, repo_path) = init_fixture_repo();

    // Add a second commit that modifies README.md so we have a real before/after.
    let modified_sha = {
        let repo = Repository::open(&repo_path).expect("reopen repo");

        let readme = repo_path.join("README.md");
        fs::write(&readme, "hello\nworld\n").expect("modify README");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add path");
        index.write().expect("write index");
        let tree_oid = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_oid).expect("find tree");

        let sig = Signature::now("GitPow Test", "test@example.com").expect("signature");
        let parent = repo
            .head()
            .expect("head")
            .peel_to_commit()
            .expect("peel parent");

        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, "add world line", &tree, &[&parent])
            .expect("commit");
        oid.to_string()
    };

    let repo = GitRepository::open(&repo_path).expect("open repo");
    let diff = repo
        .get_file_diff(&modified_sha, "README.md")
        .expect("get_file_diff should succeed");

    assert_eq!(diff.file_path, "README.md");
    assert!(
        !diff.hunks.is_empty(),
        "modified file should yield at least one hunk: {:#?}",
        diff
    );
    assert!(
        !diff.diff.is_empty(),
        "modified file should produce a non-empty patch: {:#?}",
        diff
    );
    assert!(
        diff.diff.contains("+world"),
        "patch should include the added line, got: {}",
        diff.diff
    );
}

#[test]
fn fetch_all_is_a_noop_when_repo_has_no_remotes() {
    let (_dir, repo_path) = init_fixture_repo();

    // Sanity check: a freshly-initialised repo really has zero remotes,
    // so fetch_all should walk an empty list and return Ok(()).
    let repo = GitRepository::open(&repo_path).expect("open repo");
    repo.fetch_all()
        .expect("fetch_all should be a no-op on a remoteless repo");
}

/// Resolve the current HEAD commit to a hex SHA string.
fn head_sha(repo_path: &Path) -> String {
    let repo = Repository::open(repo_path).expect("open repo");
    let head = repo.head().expect("head");
    let commit = head.peel_to_commit().expect("peel head commit");
    commit.id().to_string()
}

#[test]
fn pull_reports_missing_upstream() {
    let (_dir, repo_path) = init_fixture_repo();

    let response = git_ops::pull(&repo_path).expect("pull should return a response, not an error");

    assert!(!response.success);
    let error = response
        .error
        .as_deref()
        .expect("pull without upstream should include an error description");
    assert!(
        error.to_lowercase().contains("upstream"),
        "expected upstream mention, got: {}",
        error
    );
}
