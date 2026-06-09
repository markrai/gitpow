import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const staticDir = path.join(rootDir, "static");
const allowlistPath = path.join(rootDir, "scripts", "window-globals-allowlist.json");
const assignmentPattern = /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g;

function walkJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function isAssignment(source, matchIndex) {
  const eqIndex = source.indexOf("=", matchIndex);
  const before = source.slice(0, eqIndex).trimEnd().at(-1);
  const after = source[eqIndex + 1];
  return !["!", "<", ">", "="].includes(before) && after !== "=" && after !== ">";
}

function lineColumn(source, index) {
  const prefix = source.slice(0, index);
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function loadAllowlist() {
  const raw = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  const allowed = new Map();
  const duplicateNames = [];
  const malformed = [];

  for (const group of raw.groups || []) {
    if (!group.owner || !group.reason || !Array.isArray(group.names)) {
      malformed.push(JSON.stringify(group));
      continue;
    }
    for (const name of group.names) {
      if (typeof name !== "string" || !name) {
        malformed.push(`${group.owner}: ${String(name)}`);
        continue;
      }
      if (allowed.has(name)) duplicateNames.push(name);
      allowed.set(name, { owner: group.owner, reason: group.reason });
    }
  }

  return { allowed, duplicateNames, malformed };
}

function findWindowAssignments() {
  const found = new Map();
  for (const file of walkJsFiles(staticDir)) {
    const source = fs.readFileSync(file, "utf8");
    let match;
    while ((match = assignmentPattern.exec(source))) {
      if (!isAssignment(source, match.index)) continue;
      const name = match[1];
      const location = lineColumn(source, match.index);
      const relativeFile = path.relative(rootDir, file).replaceAll(path.sep, "/");
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(`${relativeFile}:${location.line}:${location.column}`);
    }
  }
  return found;
}

const { allowed, duplicateNames, malformed } = loadAllowlist();
const found = findWindowAssignments();
const unlisted = [...found.keys()].filter((name) => !allowed.has(name)).sort();

if (malformed.length || duplicateNames.length || unlisted.length) {
  if (malformed.length) {
    console.error("Malformed window global allowlist entries:");
    for (const entry of malformed) console.error(`  - ${entry}`);
  }

  if (duplicateNames.length) {
    console.error("Duplicate window global allowlist names:");
    for (const name of duplicateNames.sort()) console.error(`  - ${name}`);
  }

  if (unlisted.length) {
    console.error("Unreviewed window globals found:");
    for (const name of unlisted) {
      console.error(`  - ${name}`);
      for (const location of found.get(name)) console.error(`      ${location}`);
    }
    console.error(
      "\nAdd intentional compatibility shims to scripts/window-globals-allowlist.json with an owner and reason."
    );
  }

  process.exit(1);
}

console.log(`Window global allowlist OK (${found.size} reviewed exports).`);
