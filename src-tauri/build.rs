use std::collections::BTreeMap;
use std::path::Path;

fn main() {
    // Generate libraries list before building
    generate_libraries();

    tauri_build::build()
}

fn generate_libraries() {
    generate_libraries_inline();
}

fn generate_libraries_inline() {
    use std::fs;

    let mut all_deps: BTreeMap<String, String> = BTreeMap::new();

    // Parse root Cargo.toml
    if let Ok(content) = fs::read_to_string("../Cargo.toml") {
        parse_cargo_deps(&content, &mut all_deps);
    }

    // Parse src-tauri/Cargo.toml (current)
    if let Ok(content) = fs::read_to_string("Cargo.toml") {
        parse_cargo_deps(&content, &mut all_deps);
    }

    // Parse package.json
    if let Ok(content) = fs::read_to_string("../package.json") {
        parse_package_json_deps(&content, &mut all_deps);
    }

    // Check for Three.js in index.html
    if let Ok(content) = fs::read_to_string("../static/index.html") {
        if let Some(start) = content.find("three@") {
            let after_at = &content[start + 6..];
            if let Some(end) = after_at.find("/") {
                let version = &after_at[..end];
                all_deps.insert("three".to_string(), version.to_string());
            }
        }
    }

    // Generate JavaScript file
    let output_dir = Path::new("../static");
    if !output_dir.exists() {
        return;
    }

    let mut js_content = String::from("// Auto-generated file - do not edit manually\n");
    js_content
        .push_str("// This file is generated during build from Cargo.toml and package.json\n\n");
    js_content.push_str("window.EXTERNAL_LIBRARIES = [\n");

    // Sort and format libraries
    let mut sorted_deps: Vec<_> = all_deps.iter().collect();
    sorted_deps.sort_by_key(|(name, _)| name.to_lowercase());

    for (i, (name, version)) in sorted_deps.iter().enumerate() {
        let version_clean = version.trim_start_matches("^").trim_start_matches("~");
        js_content.push_str(&format!(
            "  {{ name: \"{}\", version: \"{}\" }}{}\n",
            name,
            version_clean,
            if i < sorted_deps.len() - 1 { "," } else { "" }
        ));
    }

    js_content.push_str("];\n");

    if let Err(e) = fs::write(output_dir.join("libraries.js"), js_content) {
        println!("cargo:warning=Failed to write libraries.js: {}", e);
    } else {
        println!("cargo:warning=Generated libraries.js successfully");
    }
}

fn parse_cargo_deps(content: &str, deps: &mut BTreeMap<String, String>) {
    let lines: Vec<&str> = content.lines().collect();
    let mut in_deps = false;
    let mut in_build_deps = false;

    for line in lines {
        let trimmed = line.trim();

        if trimmed.starts_with("[dependencies]") {
            in_deps = true;
            in_build_deps = false;
            continue;
        }

        if trimmed.starts_with("[build-dependencies]") {
            in_deps = false;
            in_build_deps = true;
            continue;
        }

        if trimmed.starts_with('[') {
            in_deps = false;
            in_build_deps = false;
            continue;
        }

        if (in_deps || in_build_deps) && !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some(equal_pos) = trimmed.find('=') {
                let name = trimmed[..equal_pos].trim();
                let rest = trimmed[equal_pos + 1..].trim();

                // Extract version
                let version = if rest.starts_with('"') {
                    // Simple string version: version = "1.0"
                    rest.trim_matches('"').to_string()
                } else if rest.starts_with('{') {
                    // Table version: version = { version = "1.0", ... }
                    if let Some(version_start) = rest.find("version") {
                        let after_version = &rest[version_start + 7..];
                        if let Some(quote_start) = after_version.find('"') {
                            let version_str = &after_version[quote_start + 1..];
                            if let Some(quote_end) = version_str.find('"') {
                                version_str[..quote_end].to_string()
                            } else {
                                continue;
                            }
                        } else {
                            continue;
                        }
                    } else {
                        continue;
                    }
                } else {
                    continue;
                };

                deps.insert(name.to_string(), version);
            }
        }
    }
}

fn parse_package_json_deps(content: &str, deps: &mut BTreeMap<String, String>) {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(deps_obj) = json.get("dependencies").and_then(|d| d.as_object()) {
            for (name, version) in deps_obj {
                if let Some(version_str) = version.as_str() {
                    deps.insert(name.clone(), version_str.to_string());
                }
            }
        }
    }
}
