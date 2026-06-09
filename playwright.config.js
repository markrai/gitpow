import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  ensureSmokeReposRoot,
  SMOKE_BRANCH,
  SMOKE_REPO_NAME
} from "./tests/smoke/support/git-fixture.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || "3000";
const reposRoot = process.env.REPOS_ROOT || ensureSmokeReposRoot();
process.env.REPOS_ROOT = reposRoot;
process.env.GITPOW_SMOKE_BRANCH = process.env.GITPOW_SMOKE_BRANCH || SMOKE_BRANCH;
process.env.GITPOW_SMOKE_REPO_NAME = process.env.GITPOW_SMOKE_REPO_NAME || SMOKE_REPO_NAME;
const serverBin =
  process.platform === "win32"
    ? path.join(rootDir, "target", "debug", "gitpow-rust.exe")
    : path.join(rootDir, "target", "debug", "gitpow-rust");

export default defineConfig({
  testDir: "./tests/smoke",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: `"${serverBin}"`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: port,
      REPOS_ROOT: reposRoot,
      RUST_LOG: "error",
    },
  },
});
