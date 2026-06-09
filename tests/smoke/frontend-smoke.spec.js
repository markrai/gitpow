import { test, expect } from "@playwright/test";

const SMOKE_BRANCH = process.env.GITPOW_SMOKE_BRANCH || "feature/smoke";
const SMOKE_REPO_NAME = process.env.GITPOW_SMOKE_REPO_NAME || "gitpow-smoke-repo";

/** Patterns for console noise that is expected when running over HTTP, not Tauri. */
const IGNORED_CONSOLE_PATTERNS = [
  /Tauri API not available/i,
  /Make sure you are running in a Tauri application/i,
];

function isIgnoredConsoleMessage(text) {
  return IGNORED_CONSOLE_PATTERNS.some((pattern) => pattern.test(text));
}

async function bootApp(page) {
  const consoleErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (!isIgnoredConsoleMessage(text)) {
        consoleErrors.push(text);
      }
    }
  });

  page.on("pageerror", (err) => {
    consoleErrors.push(err.message);
  });

  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("gitpow:reposRootOnboarded", "true");
  });

  await page.goto("/");

  // Native <select> elements are hidden once searchable-dropdown wraps them.
  await expect(page.locator("#repoSelect")).toBeAttached();
  await expect(page.locator("#branchSelect")).toBeAttached();
  await expect(
    page.getByRole("button", { name: /Select repository/i })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: /Select branch/i })
  ).toBeVisible();
  await expect(page.locator("#searchInput")).toBeVisible();
  await expect(page.locator("#commitList")).toBeAttached();

  await expect
    .poll(() => page.locator("#repoSelect").evaluate((select) => select.value), {
      timeout: 30_000,
    })
    .toContain(SMOKE_REPO_NAME);

  await expect
    .poll(() => page.locator("#commitList .commit-item").count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  return {
    assertNoConsoleErrors() {
      expect(
        consoleErrors,
        `Unexpected console errors: ${consoleErrors.join("; ")}`
      ).toEqual([]);
    },
  };
}

async function selectBranch(page, branch) {
  await page.locator("#branchSelect").evaluate((select, value) => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, branch);

  await expect
    .poll(() => page.locator("#branchSelect").evaluate((select) => select.value))
    .toBe(branch);
}

test.describe("Frontend smoke", () => {
  test("loads app shell and deterministic fixture repo", async ({ page }) => {
    const app = await bootApp(page);

    await expect(page.locator("#commitList")).toContainText("smoke commit");

    app.assertNoConsoleErrors();
  });

  test("switches branches and updates the commit list", async ({ page }) => {
    const app = await bootApp(page);

    await selectBranch(page, SMOKE_BRANCH);

    await expect(page.locator("#commitList")).toContainText("feature smoke commit");
    app.assertNoConsoleErrors();
  });

  test("toggles Activity and graph view modes", async ({ page }) => {
    const app = await bootApp(page);
    const toggle = page.locator("#viewModeToggle");
    const graphContainer = page.locator("#graphContainer");

    await toggle.click();
    await expect(toggle).toHaveText("Vertical Map");
    await expect(graphContainer).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveText("Horizontal Map");
    await expect(graphContainer).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveText("Activity");
    await expect(graphContainer).toBeHidden();

    app.assertNoConsoleErrors();
  });

  test("renders staging shell for dirty fixture files", async ({ page }) => {
    const app = await bootApp(page);

    await selectBranch(page, SMOKE_BRANCH);
    await page.evaluate(() => window.loadStatus());

    await expect(page.locator("#unstagedList")).toContainText("dirty-file.txt");
    await expect(page.locator("#unstagedCount")).toHaveText("1");

    app.assertNoConsoleErrors();
  });

  test("registers singleton listeners through gpEvents", async ({ page }) => {
    const app = await bootApp(page);

    const counts = await page.evaluate(() => ({
      keyboard: window.gpEvents.count("keyboard"),
      script: window.gpEvents.count("script"),
      staging: window.gpEvents.count("staging"),
      viewMode: window.gpEvents.count("view-mode"),
    }));

    expect(counts.keyboard).toBe(2); // window keydown + document mousedown
    expect(counts.script).toBe(4); // repo, branch, search, view-mode toggle
    expect(counts.staging).toBe(4); // commit button + active message fields
    expect(counts.viewMode).toBe(1); // beforeunload cleanup

    app.assertNoConsoleErrors();
  });
});
