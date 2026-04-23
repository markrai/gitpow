/**
 * Repos Root ("Projects Folder") modal and persistence.
 *
 * Extracted from script.js. Communicates with the rest of the app through
 * globals it does not own:
 *   - window.gpStorage (storage-keys.js)
 *   - window.normalizePathForDisplay (ui.js)
 *   - window.openReposRootModal / window.closeReposRootModal (ui.js)
 *   - window.setStatus (ui.js)
 *   - window.loadRepos (script.js) – resolved lazily at call time
 *   - window.api (api.js)
 *   - window.reposRoot* DOM element handles (dom-elements.js)
 */

(function () {
  function normalizePath(value) {
    return window.normalizePathForDisplay
      ? window.normalizePathForDisplay(value)
      : value;
  }

  async function applyReposRootFromInput() {
    const input = window.reposRootPathInput;
    if (!input) return;

    const raw = input.value.trim();
    const normalized = normalizePath(raw);

    if (normalized) {
      window.gpStorage.set("reposRoot", normalized);
      window.gpStorage.set("reposRootOnboarded", "true");
      await window.loadRepos();
      window.setStatus(`Projects folder set to: ${normalized}`);
    } else {
      // Empty input means "stick with server default" but remember the choice.
      window.gpStorage.remove("reposRoot");
      window.gpStorage.set("reposRootOnboarded", "true");
      await window.loadRepos();
      window.setStatus("Projects folder cleared; using server default");
    }

    window.closeReposRootModal();
  }

  function initReposRoot() {
    const {
      reposRootButton,
      reposRootCloseButton,
      reposRootCancelButton,
      reposRootModal,
      reposRootUseDefaultButton,
      reposRootSaveButton,
      reposRootPathInput,
      reposRootBrowseButton,
    } = window;

    if (reposRootButton) {
      reposRootButton.addEventListener("click", () => window.openReposRootModal());
    }

    if (reposRootCloseButton) {
      reposRootCloseButton.addEventListener("click", () => window.closeReposRootModal());
    }

    if (reposRootCancelButton) {
      reposRootCancelButton.addEventListener("click", () => window.closeReposRootModal());
    }

    if (reposRootModal) {
      // Close when clicking the dimmed backdrop.
      reposRootModal.addEventListener("click", (e) => {
        if (e.target === reposRootModal) {
          window.closeReposRootModal();
        }
      });
    }

    if (reposRootUseDefaultButton) {
      reposRootUseDefaultButton.addEventListener("click", async () => {
        try {
          const config = await window.api("/api/config");
          const serverRoot = normalizePath(
            config && config.reposRoot ? config.reposRoot : ""
          );

          if (serverRoot) {
            window.gpStorage.set("reposRoot", serverRoot);
          } else {
            window.gpStorage.remove("reposRoot");
          }
          window.gpStorage.set("reposRootOnboarded", "true");

          await window.loadRepos();
          window.setStatus(
            serverRoot
              ? `Projects folder set to: ${serverRoot}`
              : "Projects folder set to server default"
          );
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          window.setStatus(
            "Failed to read server default projects folder: " + message,
            true
          );
        }
        window.closeReposRootModal();
      });
    }

    if (reposRootSaveButton && reposRootPathInput) {
      reposRootSaveButton.addEventListener("click", () => {
        applyReposRootFromInput();
      });

      reposRootPathInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applyReposRootFromInput();
        }
      });
    }

    if (reposRootBrowseButton && reposRootPathInput) {
      reposRootBrowseButton.addEventListener("click", async () => {
        try {
          const result = await window.api("/api/browse/projects-root");
          if (result && result.path) {
            const normalized = normalizePath(result.path);
            reposRootPathInput.value = normalized;
            await applyReposRootFromInput();
          } else {
            window.setStatus("No folder selected", true);
          }
        } catch (e) {
          const message = e && e.message ? e.message : String(e);
          const lower = message.toLowerCase();
          if (lower.includes("not found") || lower.includes("404")) {
            window.setStatus(
              "The running server does not expose the folder picker endpoint. Restart it from this codebase (e.g. run.bat/dev.bat), or type the path manually.",
              true
            );
          } else if (lower.includes("cancel")) {
            // User cancelled the dialog; no need to surface an error.
            window.setStatus("", null);
          } else {
            window.setStatus("Unable to open folder picker: " + message, true);
          }
        }
      });
    }
  }

  // Attach handlers once the DOM is parsed. When this script is included at
  // the end of body (as it is today), DOMContentLoaded has already fired or
  // is about to — handle both cases.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initReposRoot);
  } else {
    initReposRoot();
  }

  // Exposed for callers that still live in script.js bootstrap.
  window.applyReposRootFromInput = applyReposRootFromInput;
})();
