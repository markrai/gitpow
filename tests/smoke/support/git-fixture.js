import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SMOKE_REPO_NAME = "gitpow-smoke-repo";
export const SMOKE_BRANCH = "feature/smoke";

function git(repoPath, args) {
  execFileSync("git", args, {
    cwd: repoPath,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "GitPow Smoke",
      GIT_AUTHOR_EMAIL: "smoke@gitpow.local",
      GIT_COMMITTER_NAME: "GitPow Smoke",
      GIT_COMMITTER_EMAIL: "smoke@gitpow.local"
    }
  });
}

function writeFile(repoPath, relativePath, content) {
  const fullPath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

export function ensureSmokeReposRoot() {
  const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitpow-smoke-repos-"));
  const repoPath = path.join(reposRoot, SMOKE_REPO_NAME);
  fs.mkdirSync(repoPath, { recursive: true });

  git(repoPath, ["init"]);
  git(repoPath, ["checkout", "-B", "main"]);
  git(repoPath, ["config", "user.name", "GitPow Smoke"]);
  git(repoPath, ["config", "user.email", "smoke@gitpow.local"]);

  writeFile(repoPath, "README.md", "# GitPow smoke fixture\n");
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "-m", "initial smoke commit"]);

  writeFile(repoPath, "src/main.txt", "main branch content\n");
  git(repoPath, ["add", "src/main.txt"]);
  git(repoPath, ["commit", "-m", "main smoke commit"]);

  git(repoPath, ["checkout", "-b", SMOKE_BRANCH]);
  writeFile(repoPath, "feature.txt", "feature branch content\n");
  git(repoPath, ["add", "feature.txt"]);
  git(repoPath, ["commit", "-m", "feature smoke commit"]);

  writeFile(repoPath, "dirty-file.txt", "uncommitted smoke change\n");

  return reposRoot;
}
