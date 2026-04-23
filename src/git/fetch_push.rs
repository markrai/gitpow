//! Remote interactions: fetch, pull, push.
//!
//! The fetch path wires up SSH auth via `git2::RemoteCallbacks` (agent first,
//! `~/.ssh/id_rsa` fallback) and tolerates per-remote auth failures so the
//! rest of the UI can still render local branch state. Pull and push
//! currently shell out through `self.run_git(...)` so that the user's
//! configured credential helper / askpass UX matches what they see in a
//! normal terminal.

use anyhow::Result;
use git2::{Cred, RemoteCallbacks};

use super::repository::GitRepository;

impl GitRepository {
    pub fn fetch_all(&self) -> Result<()> {
        let remotes = self.repo.remotes()?;
        for remote_name in remotes.iter().flatten() {
            let mut remote = self.repo.find_remote(remote_name)?;

            // Set up callbacks for SSH authentication
            let mut callbacks = RemoteCallbacks::new();
            callbacks.credentials(|_url, username_from_url, _allowed_types| {
                let username = username_from_url.unwrap_or("git");

                // Try to use SSH credentials from the system (SSH agent, keys, etc.)
                Cred::ssh_key_from_agent(username).or_else(|_| {
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

            // Try to fetch, but don't fail if authentication is not available.
            // This allows the app to work with local repos or repos that don't
            // need auth — the branch list can still be populated from local
            // branches.
            if let Err(e) = remote.fetch(&[] as &[&str], Some(&mut fetch_options), None) {
                if e.code() == git2::ErrorCode::Auth {
                    eprintln!(
                        "Warning: Failed to fetch remote '{}' due to authentication. Using local branches only.",
                        remote_name
                    );
                    continue;
                }
                return Err(e.into());
            }
        }
        Ok(())
    }

    /// Pull changes from the remote for the current branch.
    pub fn pull(&self) -> Result<String> {
        self.run_git(&["pull"])
    }

    /// Push changes to the remote for the current branch.
    pub fn push(&self) -> Result<String> {
        self.run_git(&["push"])
    }

    /// Push with upstream tracking for a new branch.
    pub fn push_set_upstream(&self, branch: &str) -> Result<String> {
        self.run_git(&["push", "-u", "origin", branch])
    }
}
