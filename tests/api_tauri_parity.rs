//! Contract test: every Tauri command referenced from the frontend's
//! `static/js/api.js` dispatcher must be registered with
//! `tauri::generate_handler!` in `src-tauri/src/lib.rs`.
//!
//! This catches the class of bug where `mapPathToCommand` knows about a
//! command name that the desktop build doesn't actually expose
//! (symptom: "command not found" at runtime, only inside the Tauri shell).
//! The test is intentionally text-only so it costs nothing to run and does
//! not need the desktop crate to link.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR resolves to the crate directory, which is the
    // workspace root for `gitpow-rust`.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
}

/// Extract command names the frontend hands to `invoke` from
/// `static/js/api.js` (pattern: `command = 'name'`).
fn frontend_commands(api_js: &str) -> BTreeSet<String> {
    let re = Regex::new(r#"command\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'"#).unwrap();
    re.captures_iter(api_js)
        .map(|c| c[1].to_string())
        .collect()
}

/// Extract command names from the `generate_handler![ ... ]` block in
/// `src-tauri/src/lib.rs`. We accept fully-qualified paths like
/// `commands::git_ops::stash_push` and take the trailing identifier.
fn tauri_commands(tauri_lib_rs: &str) -> BTreeSet<String> {
    let start = tauri_lib_rs
        .find("generate_handler!")
        .expect("expected `generate_handler!` in src-tauri/src/lib.rs");
    let after = &tauri_lib_rs[start..];
    let open = after.find('[').expect("expected `[` after generate_handler!");
    let close = after[open..]
        .find(']')
        .expect("expected matching `]` for generate_handler![");
    let block = &after[open + 1..open + close];

    let re = Regex::new(r"(?m)(?:^|[,\s])(?:[a-zA-Z_][a-zA-Z0-9_]*::)+([a-zA-Z_][a-zA-Z0-9_]*)")
        .unwrap();
    re.captures_iter(block)
        .map(|c| c[1].to_string())
        .collect()
}

#[test]
fn frontend_commands_are_registered_in_tauri() {
    let root = workspace_root();
    let api_js = read(&root.join("static/js/api.js"));
    let tauri_lib_rs = read(&root.join("src-tauri/src/lib.rs"));

    let frontend = frontend_commands(&api_js);
    assert!(
        !frontend.is_empty(),
        "frontend command extraction found nothing; check the regex"
    );

    let tauri = tauri_commands(&tauri_lib_rs);
    assert!(
        !tauri.is_empty(),
        "tauri handler extraction found nothing; check the regex"
    );

    let missing: Vec<_> = frontend.difference(&tauri).cloned().collect();
    assert!(
        missing.is_empty(),
        "api.js references Tauri commands that are not registered in \
         src-tauri/src/lib.rs: {:?}\n\
         Either add them to generate_handler! or remove the mapping in api.js.",
        missing
    );
}
