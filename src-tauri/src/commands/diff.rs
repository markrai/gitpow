use gitpow_rust::config::Config;
use gitpow_rust::models::{DiffHunk, DiffResponse};
use gitpow_rust::utils::{get_repo_path, normalize_sha};
use regex::Regex;
use serde::Deserialize;
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Deserialize)]
pub struct GetDiffParams {
    repo: String,
    path: String,
    #[serde(rename = "ref")]
    ref_: Option<String>,
    staged: Option<String>,
}

fn run_git(args: &[&str], repo_path: &std::path::Path) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(repo_path);
    
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    
    let output = cmd.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_hunks(diff_out: &str) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    let lines: Vec<&str> = diff_out.split('\n').collect();
    let mut current_hunk: Option<DiffHunk> = None;

    let hunk_re = Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap();

    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("@@") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }

            if let Some(caps) = hunk_re.captures(line) {
                let old_start = caps
                    .get(1)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0);
                let old_count = caps
                    .get(2)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(1);
                let new_start = caps
                    .get(3)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0);
                let new_count = caps
                    .get(4)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(1);

                current_hunk = Some(DiffHunk {
                    old_start,
                    old_count,
                    new_start,
                    new_count,
                    lines: vec![line.to_string()],
                    line_start: i as i32,
                });
            }
        } else if let Some(ref mut hunk) = current_hunk {
            hunk.lines.push(line.to_string());
        }
    }

    if let Some(hunk) = current_hunk {
        hunks.push(hunk);
    }

    hunks
}

#[tauri::command]
pub fn get_diff(
    params: GetDiffParams,
    config: State<'_, Mutex<Config>>,
) -> Result<DiffResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);

    if let Some(ref_sha) = params.ref_ {
        let clean_ref = normalize_sha(&ref_sha.trim());

        // Try to get parent commit
        let parent_out = run_git(&["rev-parse", &format!("{}^", clean_ref)], &repo_path);

        if let Ok(parent_ref) = parent_out {
            let parent_ref = normalize_sha(&parent_ref.trim());

            // Check if file exists in parent and current
            let file_exists_in_parent = run_git(
                &["cat-file", "-e", &format!("{}:{}", parent_ref, params.path)],
                &repo_path,
            )
            .is_ok();

            let file_exists_in_current = run_git(
                &["cat-file", "-e", &format!("{}:{}", clean_ref, params.path)],
                &repo_path,
            )
            .is_ok();

            let diff_out = if !file_exists_in_parent && file_exists_in_current {
                // File was added
                let file_content = run_git(
                    &["show", &format!("{}:{}", clean_ref, params.path)],
                    &repo_path,
                )
                .unwrap_or_default();
                let lines: Vec<&str> = file_content.split('\n').collect();
                let mut diff = format!("--- /dev/null\n+++ b/{}\n", params.path);
                diff.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
                for line in lines {
                    diff.push_str(&format!("+{}\n", line));
                }
                diff
            } else if file_exists_in_parent && !file_exists_in_current {
                // File was removed
                let file_content = run_git(
                    &["show", &format!("{}:{}", parent_ref, params.path)],
                    &repo_path,
                )
                .unwrap_or_default();
                let lines: Vec<&str> = file_content.split('\n').collect();
                let mut diff = format!("--- a/{}\n+++ /dev/null\n", params.path);
                diff.push_str(&format!("@@ -1,{} +0,0 @@\n", lines.len()));
                for line in lines {
                    diff.push_str(&format!("-{}\n", line));
                }
                diff
            } else if file_exists_in_parent && file_exists_in_current {
                // File was modified
                run_git(
                    &["diff", &parent_ref, &clean_ref, "--", &params.path],
                    &repo_path,
                )
                .unwrap_or_default()
            } else {
                String::new()
            };

            let hunks = parse_hunks(&diff_out);
            return Ok(DiffResponse {
                diff: diff_out,
                hunks,
                file_path: params.path,
            });
        } else {
            // No parent (initial commit) - return full file as additions
            let file_content = run_git(
                &["show", &format!("{}:{}", clean_ref, params.path)],
                &repo_path,
            )
            .unwrap_or_default();
            let lines: Vec<&str> = file_content.split('\n').collect();
            let mut diff_lines = Vec::new();
            for line in lines {
                diff_lines.push(format!("+ {}", line));
            }
            return Ok(DiffResponse {
                diff: diff_lines.join("\n"),
                hunks: Vec::new(),
                file_path: params.path,
            });
        }
    }

    // Default: working directory diff
    let staged = params.staged.as_deref() == Some("true");
    let diff_args = if staged {
        vec!["diff", "--cached", "--", &params.path]
    } else {
        vec!["diff", "--", &params.path]
    };

    let diff_out = run_git(&diff_args, &repo_path).unwrap_or_default();
    let hunks = parse_hunks(&diff_out);

    Ok(DiffResponse {
        diff: diff_out,
        hunks,
        file_path: params.path,
    })
}


