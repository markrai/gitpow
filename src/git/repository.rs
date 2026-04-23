use anyhow::{bail, Context, Result};
use chrono::DateTime;
use git2::{self, BranchType, Oid, Repository, Sort};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::models::{BranchInfo, BranchMetadata, Commit};

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

    // Fetch / pull / push live in src/git/fetch_push.rs.
    // Stash operations live in src/git/stash.rs.

    /// Checkout a specific commit (detached HEAD mode)
    pub fn checkout_commit(&self, commit_sha: &str) -> Result<String> {
        self.run_git(&["checkout", commit_sha])
    }

    /// Checkout a branch
    pub fn checkout_branch(&self, branch_name: &str) -> Result<String> {
        self.run_git(&["checkout", branch_name])
    }

    /// Get the current branch name
    pub fn get_current_branch(&self) -> Result<String> {
        let output = self.run_git(&["rev-parse", "--abbrev-ref", "HEAD"])?;
        Ok(output.trim().to_string())
    }

    /// Get the branch name from reflog before entering detached HEAD
    /// Returns the branch name if found, None otherwise
    /// This searches through reflog entries to find the most recent checkout from a branch
    pub fn get_previous_branch_from_reflog(&self) -> Result<Option<String>> {
        // Search through the last 50 reflog entries to find the most recent branch checkout
        // This handles cases where user has switched to multiple commits
        let output = match self.run_git(&["reflog", "-50", "--format=%gs"]) {
            Ok(output) => output,
            Err(_) => return Ok(None), // No reflog or error - return None
        };
        
        // Parse each reflog entry line
        for line in output.lines() {
            let reflog_msg = line.trim();
            if reflog_msg.is_empty() {
                continue;
            }
            
            // Look for "moving from" pattern in checkout messages
            // Format: "checkout: moving from <branch> to <commit>"
            // or "checkout: moving from <branch> to <branch>"
            if let Some(from_pos) = reflog_msg.find("moving from ") {
                let after_from = &reflog_msg[from_pos + 12..]; // Skip "moving from "
                if let Some(to_pos) = after_from.find(" to ") {
                    let branch_name = after_from[..to_pos].trim();
                    
                    // Validate it's a valid branch name (not a commit SHA, not "HEAD")
                    // Reject if it's HEAD, a full SHA (40 hex chars), or a ref path
                    if branch_name != "HEAD" 
                        && !branch_name.starts_with("refs/")
                        && (branch_name.len() != 40 || !branch_name.chars().all(|c| c.is_ascii_hexdigit())) // Not a full SHA
                    {
                        // Additional validation: check if it looks like a branch name
                        // Branch names typically don't start with numbers and contain alphanumeric, -, _, /
                        if !branch_name.is_empty() && !branch_name.chars().next().unwrap_or(' ').is_ascii_digit() {
                            return Ok(Some(branch_name.to_string()));
                        }
                    }
                }
            }
        }
        
        Ok(None)
    }

    /// Get the default branch (main, master, or first available branch)
    /// Returns the branch name if found, None otherwise
    pub fn get_default_branch(&self) -> Result<Option<String>> {
        // Get all local branches
        let branches = self.get_branch_info()?;
        
        if branches.branches.is_empty() {
            return Ok(None);
        }
        
        // Prefer main, then master, then first branch
        if let Some(main) = branches.branches.iter().find(|b| b.as_str() == "main") {
            return Ok(Some(main.clone()));
        }
        
        if let Some(master) = branches.branches.iter().find(|b| b.as_str() == "master") {
            return Ok(Some(master.clone()));
        }
        
        // Return first branch as fallback
        Ok(Some(branches.branches[0].clone()))
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

    // Diff operations live in src/git/diff.rs.

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

    // get_file_diff / generate_file_diff / get_working_diff and the
    // FileDiff / DiffHunkData types live in src/git/diff.rs.
}
