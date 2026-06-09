import { test, expect } from "@playwright/test";

/** Patterns for console noise that is expected when running over HTTP, not Tauri. */
const IGNORED_CONSOLE_PATTERNS = [
  /Tauri API not available/i,
  /Make sure you are running in a Tauri application/i,
];

function isIgnoredConsoleMessage(text) {
  return IGNORED_CONSOLE_PATTERNS.some((pattern) => pattern.test(text));
}

test.describe("Frontend boot smoke", () => {
  test("loads app shell with core controls", async ({ page }) => {
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

    expect(
      consoleErrors,
      `Unexpected console errors: ${consoleErrors.join("; ")}`
    ).toEqual([]);
  });
});
