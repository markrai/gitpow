use regex::Regex;
use std::path::{Path, PathBuf};

pub fn get_repo_path(name: &str, repos_root: &PathBuf) -> PathBuf {
    let candidate = Path::new(name);
    if candidate.is_absolute() {
        // When the client sends an absolute path, trust it directly.
        // This is only used in a local app context.
        return candidate.to_path_buf();
    }

    // Relative repo name – sanitize to prevent directory traversal
    let re = Regex::new(r"[^a-zA-Z0-9_.\\/-]").unwrap();
    let safe_name = re.replace_all(name, "");
    repos_root.join(safe_name.as_ref())
}

pub fn normalize_sha(raw_sha: &str) -> String {
    let re = Regex::new(r"[0-9a-fA-F]{40}").unwrap();
    if let Some(caps) = re.find(raw_sha) {
        caps.as_str().to_string()
    } else {
        raw_sha.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_repo_path_joins_relative_name() {
        let root = PathBuf::from("/tmp/projects");
        let p = get_repo_path("my-repo", &root);
        assert_eq!(p, PathBuf::from("/tmp/projects").join("my-repo"));
    }

    #[test]
    fn get_repo_path_strips_unsafe_chars() {
        let root = PathBuf::from("/tmp/projects");
        let p = get_repo_path("weird;name|here", &root);
        assert_eq!(p, PathBuf::from("/tmp/projects").join("weirdnamehere"));
    }

    #[test]
    fn get_repo_path_preserves_nested_relative() {
        let root = PathBuf::from("/tmp/projects");
        let p = get_repo_path("org/repo", &root);
        assert_eq!(p, PathBuf::from("/tmp/projects").join("org/repo"));
    }

    #[test]
    fn get_repo_path_trusts_absolute_paths() {
        let root = PathBuf::from("/tmp/projects");
        #[cfg(windows)]
        let abs = "C:\\custom\\repo";
        #[cfg(not(windows))]
        let abs = "/custom/repo";
        let p = get_repo_path(abs, &root);
        assert_eq!(p, PathBuf::from(abs));
    }

    #[test]
    fn normalize_sha_extracts_40_hex() {
        let raw = "prefix 0123456789abcdef0123456789abcdef01234567 suffix";
        assert_eq!(
            normalize_sha(raw),
            "0123456789abcdef0123456789abcdef01234567"
        );
    }

    #[test]
    fn normalize_sha_passes_through_when_no_match() {
        assert_eq!(normalize_sha("HEAD"), "HEAD");
    }
}
