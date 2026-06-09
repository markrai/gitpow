//! Commit-walk operations on `GitRepository`.
//!
//! All revwalk-based queries live here so the rest of the file stays
//! focused on repo-open and branch metadata. Both `get_commits` and
//! `get_commits_local` use the same TOPOLOGICAL | TIME sort; the
//! difference is that `get_commits` annotates each commit with every
//! branch tip pointing at it, while `get_commits_local` tags the whole
//! list with the single branch spec it walked from.

use std::collections::HashMap;

use anyhow::Result;
use chrono::DateTime;
use git2::{Oid, Sort};

use crate::models::Commit;

use super::repository::GitRepository;

impl GitRepository {
    pub fn get_commits(&self, branch_name: &str, limit: usize) -> Result<Vec<Commit>> {
        // Resolve the starting point for this history. This can be any revspec
        // ("HEAD", "main", "origin/main", etc.).
        let spec = if branch_name.is_empty() {
            "HEAD"
        } else {
            branch_name
        };
        let target = match self.repo.revparse_single(spec) {
            Ok(t) => t,
            Err(e)
                if e.code() == git2::ErrorCode::UnbornBranch
                    || e.code() == git2::ErrorCode::NotFound =>
            {
                // Repository has no commits yet - return empty list
                return Ok(Vec::new());
            }
            Err(e) => return Err(e.into()),
        };

        let mut revwalk = self.repo.revwalk()?;
        revwalk.push(target.id())?;
        revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;

        let mut commits = Vec::new();

        // Map branch tips -> commit IDs so we can tag head commits with the
        // branches that currently point at them. This is inexpensive and keeps
        // payloads small for non-graph views.
        let mut sha_branches: HashMap<String, Vec<String>> = HashMap::new();
        for branch in self.repo.branches(None)? {
            let (branch, _) = branch?;
            if let Some(name) = branch.name()? {
                if let Ok(commit) = branch.get().peel_to_commit() {
                    sha_branches
                        .entry(commit.id().to_string())
                        .or_default()
                        .push(name.to_string());
                }
            }
        }

        for oid in revwalk.take(limit) {
            let oid = oid?;
            let commit = self.repo.find_commit(oid)?;

            let branches = sha_branches
                .get(&oid.to_string())
                .cloned()
                .unwrap_or_default();

            // Convert git2::Time to an RFC3339 string for the frontend.
            let time = commit.time();
            let seconds = time.seconds();
            let date_time = DateTime::from_timestamp(seconds, 0)
                .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
            let date_str = date_time.to_rfc3339();

            commits.push(Commit {
                sha: commit.id().to_string(),
                author: commit.author().name().unwrap_or_default().to_string(),
                email: commit.author().email().unwrap_or_default().to_string(),
                date: date_str,
                message: commit.message().unwrap_or_default().to_string(),
                parents: commit.parent_ids().map(|id| id.to_string()).collect(),
                is_merge: commit.parent_count() > 1,
                branches,
                primary_branch: None,
                is_head: None,
                is_main: None,
                branch_angle: None,
                branch_info: None,
                branch_divergence_point: None,
                branch_base: None,
                branch_divergence_age_days: None,
            });
        }

        Ok(commits)
    }

    /// Get commits limited to a single branch's local history. Used by the
    /// "All branches" graph mode so each branch fetch only annotates commits
    /// with that branch name, avoiding every commit looking like it's on
    /// every branch.
    pub fn get_commits_local(&self, branch_name: &str, limit: usize) -> Result<Vec<Commit>> {
        let spec = if branch_name.is_empty() {
            "HEAD"
        } else {
            branch_name
        };
        let target = match self.repo.revparse_single(spec) {
            Ok(t) => t,
            Err(e)
                if e.code() == git2::ErrorCode::UnbornBranch
                    || e.code() == git2::ErrorCode::NotFound =>
            {
                // Repository has no commits yet - return empty list
                return Ok(Vec::new());
            }
            Err(e) => return Err(e.into()),
        };

        let mut revwalk = self.repo.revwalk()?;
        revwalk.push(target.id())?;
        revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;

        let mut commits = Vec::new();

        for oid in revwalk.take(limit) {
            let oid = oid?;
            let commit = self.repo.find_commit(oid)?;

            let time = commit.time();
            let seconds = time.seconds();
            let date_time = DateTime::from_timestamp(seconds, 0)
                .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
            let date_str = date_time.to_rfc3339();

            commits.push(Commit {
                sha: commit.id().to_string(),
                author: commit.author().name().unwrap_or_default().to_string(),
                email: commit.author().email().unwrap_or_default().to_string(),
                date: date_str,
                message: commit.message().unwrap_or_default().to_string(),
                parents: commit.parent_ids().map(|id| id.to_string()).collect(),
                is_merge: commit.parent_count() > 1,
                // In local mode, tag all returned commits with the branch spec
                // we walked from. The frontend merges these per-branch lists.
                branches: vec![spec.to_string()],
                primary_branch: None,
                is_head: None,
                is_main: None,
                branch_angle: None,
                branch_info: None,
                branch_divergence_point: None,
                branch_base: None,
                branch_divergence_age_days: None,
            });
        }

        Ok(commits)
    }

    pub fn is_ancestor(&self, commit: &str, ancestor: &str) -> Result<bool> {
        let commit_oid = Oid::from_str(commit)?;
        let ancestor_oid = Oid::from_str(ancestor)?;
        Ok(self.repo.graph_descendant_of(commit_oid, ancestor_oid)?)
    }

    pub fn count_commits_between(&self, from: &str, to: &str) -> Result<usize> {
        let from_oid = Oid::from_str(from)?;
        let to_oid = Oid::from_str(to)?;
        let mut revwalk = self.repo.revwalk()?;
        revwalk.push(to_oid)?;
        revwalk.hide(from_oid)?;
        Ok(revwalk.count())
    }

    /// Count the total number of commits in a repository.
    /// This is used as a heuristic to disable expensive operations on very large repos.
    pub fn count_all_commits(&self) -> Result<usize> {
        let output = self.run_git(&["rev-list", "--all", "--count"])?;
        let count = output.trim().parse::<usize>().unwrap_or(0);
        Ok(count)
    }

    pub fn get_commit_stats(&self, oid: Oid) -> Result<(i32, i32)> {
        let commit = self.repo.find_commit(oid)?;
        let parent_commit = if commit.parent_count() > 0 {
            Some(commit.parent(0)?)
        } else {
            None
        };

        let tree = commit.tree()?;
        let parent_tree = parent_commit.as_ref().map(|p| p.tree()).transpose()?;

        let diff = self
            .repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;

        let stats = diff.stats()?;
        let files_changed = stats.files_changed() as i32;
        let lines_changed = (stats.insertions() + stats.deletions()) as i32;

        Ok((files_changed, lines_changed))
    }
}
