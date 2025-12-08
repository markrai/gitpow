use gitpow_rust::config::Config;
use gitpow_rust::models::{
    Commit, RebasePlanItem, RebasePlanResponse, RebasePreview,
};
use gitpow_rust::utils::{get_repo_path, normalize_sha};
use serde::Deserialize;
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

#[derive(Deserialize)]
pub struct GetRebasePreviewParams {
    repo: String,
    onto: Option<String>,
    from: Option<String>,
}

#[tauri::command]
pub fn get_rebase_preview(
    params: GetRebasePreviewParams,
    config: State<'_, Mutex<Config>>,
) -> Result<RebasePreview, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);

    let onto = params.onto.as_deref().unwrap_or("main");
    let from = params.from.as_deref().unwrap_or("HEAD");

    // Check for uncommitted changes
    let status_out = run_git(&["status", "--porcelain"], &repo_path).unwrap_or_default();
    if !status_out.trim().is_empty() {
        return Err(
            "Cannot rebase with uncommitted changes. Please commit or stash first.".to_string(),
        );
    }

    // Get merge base
    let merge_base = run_git(&["merge-base", from, onto], &repo_path)
        .map_err(|_| "Cannot find common ancestor".to_string())?;

    let merge_base = normalize_sha(&merge_base.trim());

    // Get commits
    let format = "%H%x1f%an%x1f%ad%x1f%s%x1e";
    let commits_out = run_git(
        &[
            "log",
            &format!("{}..{}", merge_base, from),
            &format!("--format={}", format),
            "--date=iso-strict",
        ],
        &repo_path,
    )
    .map_err(|e| format!("Failed to get commits: {}", e))?;

    let chunks: Vec<&str> = commits_out.split('\x1e').collect();
    let mut commits = Vec::new();

    for chunk in chunks {
        let chunk = chunk.trim();
        if chunk.is_empty() {
            continue;
        }
        let parts: Vec<&str> = chunk.split('\x1f').collect();
        if parts.len() < 4 {
            continue;
        }

        let raw_sha = parts[0].trim();
        let sha = normalize_sha(raw_sha);

        commits.push(Commit {
            sha,
            author: parts[1].trim().to_string(),
            email: String::new(),
            date: parts[2].trim().to_string(),
            message: parts[3].trim().to_string(),
            parents: Vec::new(),
            is_merge: false,
            branches: Vec::new(),
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

    Ok(RebasePreview {
        commits,
        onto: onto.to_string(),
        from: from.to_string(),
        merge_base,
    })
}

#[derive(Deserialize)]
pub struct PostRebasePlanParams {
    repo: String,
    onto: String,
    plan: Vec<RebasePlanItem>,
    dry_run: Option<bool>,
}

#[tauri::command]
pub fn post_rebase_plan(
    params: PostRebasePlanParams,
    config: State<'_, Mutex<Config>>,
) -> Result<RebasePlanResponse, String> {
    let config = config.lock().unwrap();
    let repo_path = get_repo_path(&params.repo, &config.repos_root);

    if params.onto.is_empty() || params.plan.is_empty() {
        return Err("onto and plan (array) required".to_string());
    }

    // Check for uncommitted changes
    let status_out = run_git(&["status", "--porcelain"], &repo_path).unwrap_or_default();
    if !status_out.trim().is_empty() {
        return Err("Cannot rebase with uncommitted changes".to_string());
    }

    if params.dry_run.unwrap_or(false) {
        let mut result = Vec::new();
        for item in params.plan {
            let action = if item.action.is_empty() {
                "pick".to_string()
            } else {
                item.action
            };
            result.push(RebasePlanItem {
                sha: item.sha,
                action,
                message: item.message,
            });
        }
        return Ok(RebasePlanResponse {
            success: true,
            dry_run: Some(true),
            plan: Some(result),
            error: None,
        });
    }

    // For actual rebase, return error suggesting manual rebase
    Ok(RebasePlanResponse {
        success: false,
        dry_run: None,
        plan: None,
        error: Some(
            "Interactive rebase execution requires additional setup. Use preview mode to plan your rebase.".to_string(),
        ),
    })
}

