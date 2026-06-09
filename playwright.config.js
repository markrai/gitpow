import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || "3000";
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
      REPOS_ROOT: process.env.REPOS_ROOT || rootDir,
      RUST_LOG: "error",
    },
  },
});
