use anyhow::{bail, Context, Result};
use git2::{self, Repository};
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

    // Branch operations live in src/git/branches.rs.

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

    // Commit-walk operations live in src/git/commits_walk.rs.

    // Diff operations live in src/git/diff.rs.
}
