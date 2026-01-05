/**
 * Keyboard Navigation for GitPow
 * Global keyboard event handlers for commit navigation and modal management
 * Extracted from script.js for better maintainability
 */

// Global key handling: Enhanced keyboard navigation
window.addEventListener("keydown", (e) => {
  // Escape to close modals - handle this first so it works even when typing in inputs
  if (e.key === "Escape") {
    const settingsModal = document.getElementById("settingsModal");
    const reposRootModal = document.getElementById("reposRootModal");
    
    if (settingsModal && settingsModal.style.display !== "none") {
      e.preventDefault();
      settingsModal.style.display = "none";
      return;
    } else if (reposRootModal && reposRootModal.style.display !== "none") {
      e.preventDefault();
      reposRootModal.style.display = "none";
      return;
    }
  }

  // Don't intercept if user is typing in an input/textarea
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
    return;
  }

  // Check if graph view is active - if so, let graph handle arrow keys
  const graphContainer = document.getElementById("graphContainer");
  const isGraphViewActive = graphContainer && graphContainer.style.display !== "none" && window.isGraphMode && window.isGraphMode();
  
  // Commit navigation (only when graph view is not active)
  if (!isGraphViewActive) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const delta = window.state.invertUpDown ? -1 : 1;
      if (window.moveCommitSelection) {
        window.moveCommitSelection(delta);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const delta = window.state.invertUpDown ? 1 : -1;
      if (window.moveCommitSelection) {
        window.moveCommitSelection(delta);
      }
    } else if (e.key === "PageDown") {
      e.preventDefault();
      const dir = window.state.invertUpDown ? -1 : 1;
      if (window.pageCommitSelection) {
        window.pageCommitSelection(dir);
      }
    } else if (e.key === "PageUp") {
      e.preventDefault();
      const dir = window.state.invertUpDown ? 1 : -1;
      if (window.pageCommitSelection) {
        window.pageCommitSelection(dir);
      }
    }
  }
  // Commit Canvas is now integrated into diffPanel - no toggle needed
  // Tab navigation enhancement - ensure focus is visible
  else if (e.key === "Tab") {
    // Ensure focus outline is visible
    document.body.classList.add("keyboard-navigation");
  }
});

// Remove keyboard navigation class on mouse use
document.addEventListener("mousedown", () => {
  document.body.classList.remove("keyboard-navigation");
});
