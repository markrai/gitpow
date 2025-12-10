use anyhow::{bail, Context, Result};
use chrono::DateTime;
use git2::{self, BranchType, Cred, Oid, RemoteCallbacks, Repository, Sort};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::models::{BranchInfo, BranchMetadata, Commit, StashEntry};

/// Run a git command in the specified directory and return stdout as a String.
/// This is a standalone utility for handlers that don't need a full GitRepository.
pub fn run_git(args: &[&str], repo_path: &Path) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(repo_path);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub struct GitRepository {
    path: PathBuf,
    pub repo: Repository,
}

impl GitRepository {
    pub fn open(repo_path: &Path) -> Result<Self> {
        let repo = Repository::open(repo_path)
            .with_context(|| format!("Failed to open git repository at {}", repo_path.display()))?;

        Ok(Self {
            path: repo_path.to_path_buf(),
            repo,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn fetch_all(&self) -> Result<()> {
        let remotes = self.repo.remotes()?;
        for remote_name in remotes.iter().flatten() {
            let mut remote = self.repo.find_remote(remote_name)?;
            
            // Set up callbacks for SSH authentication
            let mut callbacks = RemoteCallbacks::new();
            callbacks.credentials(|_url, username_from_url, _allowed_types| {
                let username = username_from_url.unwrap_or("git");
                
                // Try to use SSH credentials from the system (SSH agent, keys, etc.)
                Cred::ssh_key_from_agent(username)
                    .or_else(|_| {
                        // Fallback: try default SSH key locations
                        let home = std::env::var("HOME")
                            .or_else(|_| std::env::var("USERPROFILE"))
                            .map_err(|_| git2::Error::from_str("Could not find home directory"))?;
                        let ssh_key_path = std::path::Path::new(&home).join(".ssh").join("id_rsa");
                        if ssh_key_path.exists() {
                            Cred::ssh_key(username, None, &ssh_key_path, None)
                        } else {
                            Err(git2::Error::from_str("No SSH credentials available"))
                        }
                    })
            });
            
            let mut fetch_options = git2::FetchOptions::new();
            fetch_options.remote_callbacks(callbacks);
            
            // Try to fetch, but don't fail if authentication is not available
            // This allows the app to work with local repos or repos that don't need auth
            if let Err(e) = remote.fetch(&[] as &[&str], Some(&mut fetch_options), None) {
                // If it's an authentication error, log it but don't fail completely
                // The branch list can still be populated from local branches
                if e.code() == git2::ErrorCode::Auth {
                    eprintln!("Warning: Failed to fetch remote '{}' due to authentication. Using local branches only.", remote_name);
                    continue;
                }
                return Err(e.into());
            }
        }
        Ok(())
    }

    /// Pull changes from the remote for the current branch
    pub fn pull(&self) -> Result<String> {
        self.run_git(&["pull"])
    }

    /// Push changes to the remote for the current branch
    pub fn push(&self) -> Result<String> {
        self.run_git(&["push"])
    }

    /// Push with upstream tracking for a new branch
    pub fn push_set_upstream(&self, branch: &str) -> Result<String> {
        self.run_git(&["push", "-u", "origin", branch])
    }

    /// Stash current changes
    pub fn stash_push(&self, message: Option<&str>) -> Result<String> {
        match message {
            Some(msg) => self.run_git(&["stash", "push", "-m", msg]),
            None => self.run_git(&["stash", "push"]),
        }
    }

    /// Pop the most recent stash
    pub fn stash_pop(&self) -> Result<String> {
        self.run_git(&["stash", "pop"])
    }

    /// List all stashes
    pub fn stash_list(&self) -> Result<Vec<StashEntry>> {
        let output = self.run_git(&["stash", "list", "--format=%gd%x1f%s%x1f%ai"])?;
        let entries = output
            .lines()
            .filter(|line| !line.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\x1f').collect();
                if parts.len() >= 3 {
                    Some(StashEntry {
                        index: parts[0].to_string(),
                        message: parts[1].to_string(),
                        date: parts[2].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();
        Ok(entries)
    }

    /// Apply a specific stash by index (e.g., "stash@{0}")
    pub fn stash_apply(&self, stash_ref: &str) -> Result<String> {
        self.run_git(&["stash", "apply", stash_ref])
    }

    /// Drop a specific stash by index
    pub fn stash_drop(&self, stash_ref: &str) -> Result<String> {
        self.run_git(&["stash", "drop", stash_ref])
    }

    /// Get the current branch name
    pub fn get_current_branch(&self) -> Result<String> {
        let output = self.run_git(&["rev-parse", "--abbrev-ref", "HEAD"])?;
        Ok(output.trim().to_string())
    }

    /// Check if current branch has an upstream configured
    pub fn has_upstream(&self) -> Result<bool> {
        let result = self.run_git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        Ok(result.is_ok())
    }

    /// Get ahead/behind count relative to upstream
    pub fn get_ahead_behind_upstream(&self) -> Result<(usize, usize)> {
        let output = self.run_git(&["rev-list", "--left-right", "--count", "HEAD...@{u}"])?;
        let parts: Vec<&str> = output.trim().split_whitespace().collect();
        if parts.len() == 2 {
            let ahead = parts[0].parse().unwrap_or(0);
            let behind = parts[1].parse().unwrap_or(0);
            Ok((ahead, behind))
        } else {
            Ok((0, 0))
        }
    }

    /// Check if there are uncommitted changes (staged or unstaged)
    pub fn has_uncommitted_changes(&self) -> Result<bool> {
        let output = self.run_git(&["status", "--porcelain"])?;
        Ok(!output.trim().is_empty())
    }

    /// Run a git command in this repository and return stdout as a String.
    pub fn run_git(&self, args: &[&str]) -> Result<String> {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(&self.path);

        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let output = cmd.output()
            .with_context(|| format!("Failed to run git with args {:?}", args))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            bail!(stderr);
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Run a git command in this repository and return stdout bytes.
    pub fn run_git_bytes(&self, args: &[&str]) -> Result<Vec<u8>> {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(&self.path);

        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let output = cmd.output()
            .with_context(|| format!("Failed to run git with args {:?}", args))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            bail!(stderr);
        }

        Ok(output.stdout)
    }

    pub fn get_branch_info(&self) -> Result<BranchInfo> {
        // Single-pass collection of all branches (local + remote)
        let mut branches: Vec<String> = Vec::new();
        for branch in self.repo.branches(None)? {
            let (branch, _) = branch?;
            if let Some(name) = branch.name()? {
                branches.push(name.to_string());
            }
        }

        // Sort with priority: main > master > develop > others (alphabetical)
        branches.sort_by(|a, b| {
            fn rank(name: &str) -> i32 {
                match name {
                    "main" => 0,
                    "master" => 1,
                    "develop" => 2,
                    _ => 10,
                }
            }
            let ra = rank(a);
            let rb = rank(b);
            if ra == rb {
                a.cmp(b)
            } else {
                ra.cmp(&rb)
            }
        });
        branches.dedup();

        // Handle unborn branches (repositories with no commits yet)
        let current_branch = match self.repo.head() {
            Ok(head) => head.shorthand().unwrap_or("HEAD").to_string(),
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
                // Repository has no commits yet - try to get the branch name from HEAD reference
                if let Ok(head_ref) = self.repo.find_reference("HEAD") {
                    if let Some(head_name) = head_ref.symbolic_target() {
                        head_name
                            .strip_prefix("refs/heads/")
                            .unwrap_or(head_name)
                            .to_string()
                    } else {
                        "main".to_string()
                    }
                } else {
                    "main".to_string()
                }
            }
            Err(e) => return Err(e.into()),
        };

        // Find main/master branch for merged detection
        let main_branch = branches
            .iter()
            .find(|b| *b == "main" || *b == "master")
            .map(|s| s.as_str())
            .unwrap_or("main");

        // Pre-resolve main branch OID once for merged checks
        let main_oid = self.repo.revparse_single(main_branch).ok().map(|o| o.id());

        // Calculate metadata for each branch in a single pass
        // Also collect OIDs for refs_hash to avoid double revparse_single calls
        let now = chrono::Utc::now();
        let mut branch_metadata: HashMap<String, BranchMetadata> = HashMap::with_capacity(branches.len());
        let mut branch_oids: Vec<(&str, Option<Oid>)> = Vec::with_capacity(branches.len());

        for branch_name in &branches {
            // Try to resolve branch - if it fails, it's unborn
            let branch_obj = self.repo.revparse_single(branch_name).ok();
            let is_unborn = branch_obj.is_none();

            // Store OID for refs_hash calculation (avoiding second revparse_single)
            let branch_oid = branch_obj.as_ref().map(|o| o.id());
            branch_oids.push((branch_name.as_str(), branch_oid));

            let (is_merged, last_commit_date, is_stale) = if let Some(obj) = branch_obj {
                let oid = obj.id();

                // Check merged status using pre-resolved main OID
                let is_merged = main_oid
                    .map(|main| self.repo.graph_descendant_of(main, oid).unwrap_or(false))
                    .unwrap_or(false);

                // Get commit date and stale status in one operation
                let (date_str, is_stale) = if let Ok(commit) = obj.peel_to_commit() {
                    let time = commit.time();
                    let date_time = DateTime::from_timestamp(time.seconds(), 0)
                        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
                    let date_str = date_time.to_rfc3339();

                    // Calculate stale status (> 90 days old)
                    let duration = now.signed_duration_since(date_time);
                    let is_stale = duration.num_days() > 90;

                    (Some(date_str), is_stale)
                } else {
                    (None, false)
                };

                (is_merged, date_str, is_stale)
            } else {
                (false, None, false)
            };

            branch_metadata.insert(
                branch_name.clone(),
                BranchMetadata {
                    is_merged,
                    is_stale,
                    is_unborn,
                    last_commit_date,
                },
            );
        }

        // Get HEAD SHA for cache invalidation
        let head_sha = self.repo.head().ok().and_then(|h| h.target()).map(|oid| oid.to_string());

        // Calculate refs hash using cached OIDs (no second revparse_single calls!)
        // This changes when any branch is created, deleted, or moved
        let refs_hash = {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut hasher = DefaultHasher::new();
            for (name, oid) in &branch_oids {
                name.hash(&mut hasher);
                if let Some(oid) = oid {
                    oid.to_string().hash(&mut hasher);
                }
            }
            format!("{:x}", hasher.finish())
        };

        Ok(BranchInfo {
            current: current_branch,
            branches,
            branch_metadata: Some(branch_metadata),
            head: head_sha,
            refs_hash: Some(refs_hash),
        })
    }

    pub fn get_branches(&self) -> Result<Vec<String>> {
        let mut branches = Vec::new();
        for branch in self.repo.branches(Some(BranchType::Local))? {
            let (branch, _) = branch?;
            if let Some(name) = branch.name()? {
                branches.push(name.to_string());
            }
        }
        Ok(branches)
    }

    pub fn rev_parse(&self, spec: &str) -> Result<String> {
        let obj = self.repo.revparse_single(spec)?;
        Ok(obj.id().to_string())
    }

    pub fn get_upstream(&self, branch_name: &str) -> Result<Option<String>> {
        let branch = self.repo.find_branch(branch_name, BranchType::Local)?;
        if let Ok(upstream) = branch.upstream() {
            if let Some(upstream_name) = upstream.name()? {
                return Ok(Some(upstream_name.to_string()));
            }
        }
        Ok(None)
    }

    pub fn ahead_behind(&self, local: &str, upstream: &str) -> Result<(usize, usize)> {
        let local_oid = self.repo.revparse_single(local)?.id();
        let upstream_oid = self.repo.revparse_single(upstream)?.id();
        let ahead_behind = self.repo.graph_ahead_behind(local_oid, upstream_oid)?;
        Ok(ahead_behind)
    }

    pub fn get_commits(&self, branch_name: &str, limit: usize) -> Result<Vec<Commit>> {
        // Resolve the starting point for this history. This can be any revspec
        // ("HEAD", "main", "origin/main", etc.).
        let spec = if branch_name.is_empty() { "HEAD" } else { branch_name };
        let target = match self.repo.revparse_single(spec) {
            Ok(t) => t,
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch || e.code() == git2::ErrorCode::NotFound => {
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
        let spec = if branch_name.is_empty() { "HEAD" } else { branch_name };
        let target = match self.repo.revparse_single(spec) {
            Ok(t) => t,
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch || e.code() == git2::ErrorCode::NotFound => {
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

        let diff =
            self.repo
                .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;

        let stats = diff.stats()?;
        let files_changed = stats.files_changed() as i32;
        let lines_changed = (stats.insertions() + stats.deletions()) as i32;

        Ok((files_changed, lines_changed))
    }

    /// Get the list of changed files in a commit using libgit2
    /// Returns a Vec of FileChange with path and status (added, modified, removed)
    pub fn get_commit_changed_files(&self, commit_sha: &str) -> Result<Vec<crate::models::FileChange>> {
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
        let diff = self.repo.diff_tree_to_tree(
            parent_tree.as_ref(),
            Some(&tree),
            None,
        )?;

        let mut changes = Vec::new();

        // Iterate through all deltas in the diff
        for delta_idx in 0..diff.deltas().len() {
            let delta = diff.get_delta(delta_idx).unwrap();

            // Get the file path (prefer new_file path, fall back to old_file for deletions)
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            if path.is_empty() {
                continue;
            }

            // Map git2 Delta to our status strings
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

    /// Check if a branch is merged into main/master branch
    pub fn is_branch_merged(&self, branch_name: &str, main_branch: &str) -> Result<bool> {
        // Try to resolve both branches
        let branch_oid = match self.repo.revparse_single(branch_name) {
            Ok(obj) => obj.id(),
            Err(_) => return Ok(false), // Branch doesn't exist or has no commits
        };

        let main_oid = match self.repo.revparse_single(main_branch) {
            Ok(obj) => obj.id(),
            Err(_) => return Ok(false), // Main branch doesn't exist
        };

        // Check if branch tip is an ancestor of main (i.e., merged)
        Ok(self.repo.graph_descendant_of(main_oid, branch_oid)?)
    }

    /// Get the last commit date on a branch
    pub fn get_branch_last_commit_date(&self, branch_name: &str) -> Result<Option<String>> {
        let spec = if branch_name.is_empty() { "HEAD" } else { branch_name };
        let target = match self.repo.revparse_single(spec) {
            Ok(t) => t,
            Err(_) => return Ok(None), // Branch doesn't exist or has no commits
        };

        let commit = match target.peel_to_commit() {
            Ok(c) => c,
            Err(_) => return Ok(None),
        };

        let time = commit.time();
        let seconds = time.seconds();
        let date_time = DateTime::from_timestamp(seconds, 0)
            .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
        let date_str = date_time.to_rfc3339();

        Ok(Some(date_str))
    }

    /// Check if a branch is unborn (has no commits)
    pub fn is_branch_unborn(&self, branch_name: &str) -> Result<bool> {
        // Try to resolve the branch
        match self.repo.revparse_single(branch_name) {
            Ok(_) => Ok(false), // Branch exists and has commits
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(true),
            Err(_) => Ok(false), // Other error, assume not unborn
        }
    }

    /// Get the diff for a specific file in a commit compared to its parent
    /// Returns a tuple of (diff_text, hunks) where hunks contain parsed hunk information
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

        // Check if file exists in current and parent trees
        let file_in_current = tree.get_path(std::path::Path::new(file_path)).ok();
        let file_in_parent = parent_tree
            .as_ref()
            .and_then(|t| t.get_path(std::path::Path::new(file_path)).ok());

        // Handle different scenarios
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

    /// Generate diff between two trees for a specific file using libgit2
    fn generate_file_diff(
        &self,
        old_tree: Option<&git2::Tree>,
        new_tree: &git2::Tree,
        file_path: &str,
    ) -> Result<FileDiff> {
        let mut diff_opts = git2::DiffOptions::new();
        diff_opts.pathspec(file_path);
        diff_opts.context_lines(3);

        let diff = self
            .repo
            .diff_tree_to_tree(old_tree, Some(new_tree), Some(&mut diff_opts))?;

        let mut diff_text = String::new();
        let mut hunks: Vec<DiffHunkData> = Vec::new();
        let mut current_hunk_lines: Vec<String> = Vec::new();
        let mut current_hunk: Option<DiffHunkData> = None;

        // Use diff.print to get formatted output
        diff.print(git2::DiffFormat::Patch, |delta, hunk, line| {
            // Build the diff text
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
                    // Hunk header
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
                    // File header
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

        // Don't forget the last hunk
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

    /// Get diff for working directory changes (staged or unstaged)
    pub fn get_working_diff(&self, file_path: &str, staged: bool) -> Result<FileDiff> {
        let mut diff_opts = git2::DiffOptions::new();
        diff_opts.pathspec(file_path);
        diff_opts.context_lines(3);

        let diff = if staged {
            // Staged changes: HEAD to index
            let head_tree = self.repo.head()?.peel_to_tree().ok();
            self.repo.diff_tree_to_index(
                head_tree.as_ref(),
                None, // Use default index
                Some(&mut diff_opts),
            )?
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

/// Diff result for a single file
#[derive(Debug)]
pub struct FileDiff {
    pub diff: String,
    pub hunks: Vec<DiffHunkData>,
    pub file_path: String,
}

/// Hunk data from libgit2 diff
#[derive(Debug)]
pub struct DiffHunkData {
    pub old_start: i32,
    pub old_count: i32,
    pub new_start: i32,
    pub new_count: i32,
    pub lines: Vec<String>,
}
