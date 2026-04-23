//! Diff operations on `GitRepository`.
//!
//! Pulled out of the giant `repository.rs`; rust lets us keep adding methods
//! to `GitRepository` from any file in the same crate. The two owned diff
//! types live next to the methods that produce them so consumers (handlers,
//! commands) keep using `repo.get_file_diff(...)?` field access without
//! caring where the struct is defined.

use anyhow::Result;
use git2::Oid;

use super::repository::GitRepository;

/// Diff result for a single file.
#[derive(Debug)]
pub struct FileDiff {
    pub diff: String,
    pub hunks: Vec<DiffHunkData>,
    pub file_path: String,
}

/// Hunk data from a libgit2 diff.
#[derive(Debug)]
pub struct DiffHunkData {
    pub old_start: i32,
    pub old_count: i32,
    pub new_start: i32,
    pub new_count: i32,
    pub lines: Vec<String>,
}

impl GitRepository {
    /// Get the list of changed files in a commit using libgit2.
    /// Returns a `Vec<FileChange>` with path and status (added, modified, removed).
    pub fn get_commit_changed_files(
        &self,
        commit_sha: &str,
    ) -> Result<Vec<crate::models::FileChange>> {
        use git2::Delta;

        let oid = Oid::from_str(commit_sha)?;
        let commit = self.repo.find_commit(oid)?;
        let tree = commit.tree()?;

        // Get parent tree (None for initial commit)
        let parent_tree = if commit.parent_count() > 0 {
            Some(commit.parent(0)?.tree()?)
        } else {
            None
        };

        // Create diff between parent and current commit
        let diff = self
            .repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;

        let mut changes = Vec::new();

        for delta_idx in 0..diff.deltas().len() {
            let delta = diff.get_delta(delta_idx).unwrap();

            // Prefer the new path; fall back to old for deletions.
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            if path.is_empty() {
                continue;
            }

            let status = match delta.status() {
                Delta::Added | Delta::Untracked => "added",
                Delta::Deleted => "removed",
                Delta::Modified | Delta::Typechange => "modified",
                Delta::Renamed | Delta::Copied => "modified",
                _ => "modified",
            };

            changes.push(crate::models::FileChange {
                path,
                status: status.to_string(),
            });
        }

        Ok(changes)
    }

    /// Get the diff for a specific file in a commit compared to its parent.
    /// Handles add/delete/modify and the (rare) "neither side has the file"
    /// case explicitly so callers always get a well-formed `FileDiff`.
    pub fn get_file_diff(&self, commit_sha: &str, file_path: &str) -> Result<FileDiff> {
        let oid = Oid::from_str(commit_sha)?;
        let commit = self.repo.find_commit(oid)?;
        let tree = commit.tree()?;

        // Get parent tree (None for initial commit)
        let parent_tree = if commit.parent_count() > 0 {
            Some(commit.parent(0)?.tree()?)
        } else {
            None
        };

        let file_in_current = tree.get_path(std::path::Path::new(file_path)).ok();
        let file_in_parent = parent_tree
            .as_ref()
            .and_then(|t| t.get_path(std::path::Path::new(file_path)).ok());

        match (file_in_parent, file_in_current) {
            (None, Some(entry)) => {
                // File was added - show all lines as additions
                let blob = self.repo.find_blob(entry.id())?;
                let content = String::from_utf8_lossy(blob.content());
                let lines: Vec<&str> = content.lines().collect();
                let line_count = lines.len();

                let mut diff = format!("--- /dev/null\n+++ b/{}\n", file_path);
                diff.push_str(&format!("@@ -0,0 +1,{} @@\n", line_count));
                for line in &lines {
                    diff.push_str(&format!("+{}\n", line));
                }

                let hunk = DiffHunkData {
                    old_start: 0,
                    old_count: 0,
                    new_start: 1,
                    new_count: line_count as i32,
                    lines: std::iter::once(format!("@@ -0,0 +1,{} @@", line_count))
                        .chain(lines.iter().map(|l| format!("+{}", l)))
                        .collect(),
                };

                Ok(FileDiff {
                    diff,
                    hunks: vec![hunk],
                    file_path: file_path.to_string(),
                })
            }
            (Some(entry), None) => {
                // File was deleted - show all lines as deletions
                let blob = self.repo.find_blob(entry.id())?;
                let content = String::from_utf8_lossy(blob.content());
                let lines: Vec<&str> = content.lines().collect();
                let line_count = lines.len();

                let mut diff = format!("--- a/{}\n+++ /dev/null\n", file_path);
                diff.push_str(&format!("@@ -1,{} +0,0 @@\n", line_count));
                for line in &lines {
                    diff.push_str(&format!("-{}\n", line));
                }

                let hunk = DiffHunkData {
                    old_start: 1,
                    old_count: line_count as i32,
                    new_start: 0,
                    new_count: 0,
                    lines: std::iter::once(format!("@@ -1,{} +0,0 @@", line_count))
                        .chain(lines.iter().map(|l| format!("-{}", l)))
                        .collect(),
                };

                Ok(FileDiff {
                    diff,
                    hunks: vec![hunk],
                    file_path: file_path.to_string(),
                })
            }
            (Some(_), Some(_)) => {
                // File was modified - generate actual diff
                self.generate_file_diff(parent_tree.as_ref(), &tree, file_path)
            }
            (None, None) => {
                // File doesn't exist in either - empty diff
                Ok(FileDiff {
                    diff: String::new(),
                    hunks: vec![],
                    file_path: file_path.to_string(),
                })
            }
        }
    }

    /// Generate a diff between two trees for a specific file using libgit2.
    /// Walks `diff.print` and reconstructs both the textual patch and the
    /// per-hunk metadata that the frontend renderer needs.
    fn generate_file_diff(
        &self,
        old_tree: Option<&git2::Tree>,
        new_tree: &git2::Tree,
        file_path: &str,
    ) -> Result<FileDiff> {
        let mut diff_opts = git2::DiffOptions::new();
        diff_opts.pathspec(file_path);
        diff_opts.context_lines(3);

        let diff =
            self.repo
                .diff_tree_to_tree(old_tree, Some(new_tree), Some(&mut diff_opts))?;

        let mut diff_text = String::new();
        let mut hunks: Vec<DiffHunkData> = Vec::new();
        let mut current_hunk_lines: Vec<String> = Vec::new();
        let mut current_hunk: Option<DiffHunkData> = None;

        diff.print(git2::DiffFormat::Patch, |delta, hunk, line| {
            let origin = line.origin();
            let content = std::str::from_utf8(line.content()).unwrap_or("");

            match origin {
                '+' | '-' | ' ' => {
                    diff_text.push(origin);
                    diff_text.push_str(content);
                    if !content.ends_with('\n') {
                        diff_text.push('\n');
                    }
                    current_hunk_lines.push(format!("{}{}", origin, content.trim_end()));
                }
                'H' => {
                    if let Some(h) = current_hunk.take() {
                        let mut h = h;
                        h.lines = current_hunk_lines.clone();
                        hunks.push(h);
                        current_hunk_lines.clear();
                    }

                    if let Some(hunk_info) = hunk {
                        let header = format!(
                            "@@ -{},{} +{},{} @@",
                            hunk_info.old_start(),
                            hunk_info.old_lines(),
                            hunk_info.new_start(),
                            hunk_info.new_lines()
                        );
                        diff_text.push_str(&header);
                        diff_text.push('\n');
                        current_hunk_lines.push(header.clone());

                        current_hunk = Some(DiffHunkData {
                            old_start: hunk_info.old_start() as i32,
                            old_count: hunk_info.old_lines() as i32,
                            new_start: hunk_info.new_start() as i32,
                            new_count: hunk_info.new_lines() as i32,
                            lines: vec![],
                        });
                    }
                }
                'F' => {
                    let old_path = delta
                        .old_file()
                        .path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "/dev/null".to_string());
                    let new_path = delta
                        .new_file()
                        .path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "/dev/null".to_string());

                    let old_prefix = if delta.status() == git2::Delta::Added {
                        "/dev/null".to_string()
                    } else {
                        format!("a/{}", old_path)
                    };
                    let new_prefix = if delta.status() == git2::Delta::Deleted {
                        "/dev/null".to_string()
                    } else {
                        format!("b/{}", new_path)
                    };

                    diff_text.push_str(&format!("--- {}\n", old_prefix));
                    diff_text.push_str(&format!("+++ {}\n", new_prefix));
                }
                _ => {
                    // Other line types (context info, etc.)
                    diff_text.push_str(content);
                }
            }
            true
        })?;

        // Don't forget the last hunk.
        if let Some(h) = current_hunk.take() {
            let mut h = h;
            h.lines = current_hunk_lines;
            hunks.push(h);
        }

        Ok(FileDiff {
            diff: diff_text,
            hunks,
            file_path: file_path.to_string(),
        })
    }

    /// Diff for working-directory changes. When `staged` is true, compares
    /// HEAD to the index; otherwise compares the index to the working tree.
    pub fn get_working_diff(&self, file_path: &str, staged: bool) -> Result<FileDiff> {
        let mut diff_opts = git2::DiffOptions::new();
        diff_opts.pathspec(file_path);
        diff_opts.context_lines(3);

        let diff = if staged {
            // Staged changes: HEAD to index
            let head_tree = self.repo.head()?.peel_to_tree().ok();
            self.repo
                .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))?
        } else {
            // Unstaged changes: index to workdir
            self.repo
                .diff_index_to_workdir(None, Some(&mut diff_opts))?
        };

        let mut diff_text = String::new();
        let mut hunks: Vec<DiffHunkData> = Vec::new();
        let mut current_hunk_lines: Vec<String> = Vec::new();
        let mut current_hunk: Option<DiffHunkData> = None;

        diff.print(git2::DiffFormat::Patch, |delta, hunk, line| {
            let origin = line.origin();
            let content = std::str::from_utf8(line.content()).unwrap_or("");

            match origin {
                '+' | '-' | ' ' => {
                    diff_text.push(origin);
                    diff_text.push_str(content);
                    if !content.ends_with('\n') {
                        diff_text.push('\n');
                    }
                    current_hunk_lines.push(format!("{}{}", origin, content.trim_end()));
                }
                'H' => {
                    if let Some(h) = current_hunk.take() {
                        let mut h = h;
                        h.lines = current_hunk_lines.clone();
                        hunks.push(h);
                        current_hunk_lines.clear();
                    }

                    if let Some(hunk_info) = hunk {
                        let header = format!(
                            "@@ -{},{} +{},{} @@",
                            hunk_info.old_start(),
                            hunk_info.old_lines(),
                            hunk_info.new_start(),
                            hunk_info.new_lines()
                        );
                        diff_text.push_str(&header);
                        diff_text.push('\n');
                        current_hunk_lines.push(header.clone());

                        current_hunk = Some(DiffHunkData {
                            old_start: hunk_info.old_start() as i32,
                            old_count: hunk_info.old_lines() as i32,
                            new_start: hunk_info.new_start() as i32,
                            new_count: hunk_info.new_lines() as i32,
                            lines: vec![],
                        });
                    }
                }
                'F' => {
                    let old_path = delta
                        .old_file()
                        .path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "/dev/null".to_string());
                    let new_path = delta
                        .new_file()
                        .path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "/dev/null".to_string());

                    diff_text.push_str(&format!("--- a/{}\n", old_path));
                    diff_text.push_str(&format!("+++ b/{}\n", new_path));
                }
                _ => {}
            }
            true
        })?;

        if let Some(h) = current_hunk.take() {
            let mut h = h;
            h.lines = current_hunk_lines;
            hunks.push(h);
        }

        Ok(FileDiff {
            diff: diff_text,
            hunks,
            file_path: file_path.to_string(),
        })
    }
}
