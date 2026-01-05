/**
 * UI Helper Functions for GitPow
 * Status messages, notifications, and UI utilities
 * Extracted from script.js for better maintainability
 */

// ============================================================================
// Status Message Functions
// ============================================================================

/**
 * Set status message (backward compatibility wrapper)
 * @param {string} text - Status text to display
 * @param {boolean} isError - Whether this is an error message (unused, kept for compatibility)
 */
function setStatus(text, isError) {
  // Status messages now use the unified statusMessage element instead of toolbar
  // This function is kept for backward compatibility but redirects to setStatusMessage
  if (text && text.trim()) {
    setStatusMessage(text);
  } else {
    setStatusMessage("");
  }
}

/**
 * Unified status message function for both Activity and Graph modes
 * @param {string} text - Status text to display (empty to clear)
 * @param {string|null} requestId - Optional request ID to prevent race conditions
 */
function setStatusMessage(text, requestId = null) {
  // If a requestId is provided, only update if it matches the current request
  // This prevents updates from abandoned/stale requests
  if (requestId !== null && requestId !== window.currentLoadRequestId) {
    return; // This update is from a stale/abandoned request - ignore it
  }

  const statusEl = document.getElementById("statusMessage");
  if (!statusEl) {
    console.warn("statusMessage element not found");
    return;
  }

  const innerDiv = statusEl.querySelector('div');
  if (!innerDiv) {
    console.warn("statusMessage inner div not found");
    return;
  }

  // For progress updates, throttle to prevent visual "fighting" when updates happen rapidly
  // Allow clearing immediately, but throttle progress updates to max once per 100ms
  const now = Date.now();
  if (text && text.trim() && text.includes("Loading branches:")) {
    if (now - window.lastStatusUpdateTime < 100) {
      // Throttle rapid progress updates - only update every 100ms
      return;
    }
    window.lastStatusUpdateTime = now;
  }

  // Check if we're in detached HEAD state - preserve that message
  const isDetachedHeadMessage = innerDiv.textContent && innerDiv.textContent.includes("DETACHED HEAD:");
  const shouldPreserveDetachedHead = window.state && window.state.detachedHeadCommit && !text;

  // Atomic update - do all DOM manipulation together
  if (text && text.trim()) {
    innerDiv.textContent = text;
    // Set color to red if it's a detached HEAD message, otherwise use default
    if (text.includes("DETACHED HEAD:")) {
      innerDiv.style.color = '#ef4444'; // Red color
      // Make it clickable for detached HEAD messages
      statusEl.style.pointerEvents = 'auto';
      statusEl.style.cursor = 'pointer';
    } else {
      innerDiv.style.color = ''; // Reset to default
      // Reset pointer events for non-detached-HEAD messages
      statusEl.style.pointerEvents = 'none';
      statusEl.style.cursor = '';
    }
    statusEl.style.display = 'block';
    statusEl.style.visibility = 'visible';
    statusEl.style.opacity = '1';
    statusEl.style.zIndex = '1000';
    // Ensure transition is set for fade-out
    statusEl.style.transition = 'opacity 0.3s ease-out';
  } else {
    // Only clear if no requestId or if it matches current request
    if (requestId === null || requestId === window.currentLoadRequestId) {
      // If we're in detached HEAD state, restore the detached HEAD message instead of clearing
      if (shouldPreserveDetachedHead && window.updateDetachedHeadStatus) {
        // Restore detached HEAD message after a brief delay to allow other operations to complete
        setTimeout(() => {
          if (window.state && window.state.detachedHeadCommit) {
            window.updateDetachedHeadStatus();
          }
        }, 50);
        return; // Don't clear - we'll restore the detached HEAD message
      }
      
      // Fade out before hiding
      statusEl.style.opacity = '0';
      statusEl.style.transition = 'opacity 0.3s ease-out';
      // Hide after fade completes
      setTimeout(() => {
        // Double-check we should still hide (in case a new message was set)
        // But don't hide if we're in detached HEAD state
        if (window.state && window.state.detachedHeadCommit) {
          // Restore detached HEAD message
          if (window.updateDetachedHeadStatus) {
            window.updateDetachedHeadStatus();
          }
        } else if (statusEl.style.opacity === '0' || !innerDiv.textContent.trim()) {
          statusEl.style.display = 'none';
          statusEl.style.visibility = 'hidden';
        }
      }, 300);
      window.lastStatusUpdateTime = 0; // Reset throttle on clear
    }
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use setStatusMessage instead
 * @param {string} text - Status text to display
 */
function setFloatingStatusMessage(text) {
  setStatusMessage(text);
}

/**
 * Show notification when graph view is limited
 * @param {number} actualCount - Actual number of commits
 * @param {number} limit - Applied limit
 * @param {boolean} wasTruncated - Whether commits were truncated
 */
function showGraphLimitNotification(actualCount, limit, wasTruncated) {
  if (wasTruncated && actualCount >= limit) {
    const msg = `Showing ${limit} most recent commits. ${actualCount - limit}+ older commits hidden. Select a specific branch to see more.`;
    // Use unified status message for both graph and activity modes
    setStatusMessage(msg);
  }
}

// ============================================================================
// Repos Root (Projects Folder) Helpers
// ============================================================================

/**
 * Get stored repos root from localStorage
 * @returns {string} Normalized repos root path or empty string
 */
function getStoredReposRoot() {
  const raw = window.localStorage.getItem("gitzada:reposRoot");
  if (!raw) return "";
  return normalizePathForDisplay(String(raw));
}

/**
 * Normalize path for display (Windows-style on Windows)
 * Note: This is different from the simpler normalizePath in utils.js
 * @param {string} value - Path to normalize
 * @returns {string} Normalized path
 */
function normalizePathForDisplay(value) {
  if (!value) return "";
  let v = String(value).trim();
  // Normalize to Windows-style paths when running on Windows
  try {
    const nav = window.navigator || {};
    const platform = (nav.platform || "").toLowerCase();
    const ua = (nav.userAgent || "").toLowerCase();
    const isWindows = platform.startsWith("win") || ua.includes("windows");
    if (isWindows) {
      // Strip extended-length path prefix (\\?\C:\...) for readability
      if (v.startsWith("\\\\?\\")) {
        v = v.slice(4);
      }
      v = v.replace(/\//g, "\\");
    }
  } catch {
    // If navigator is not available for some reason, leave the value as-is
  }
  return v;
}

/**
 * Open the repos root modal dialog
 */
function openReposRootModal() {
  const reposRootModal = document.getElementById("reposRootModal");
  const reposRootCurrent = document.getElementById("reposRootCurrent");
  const reposRootPathInput = document.getElementById("reposRootPathInput");

  if (!reposRootModal) return;

  const currentOverride = getStoredReposRoot();
  if (reposRootCurrent) {
    if (currentOverride) {
      reposRootCurrent.textContent = currentOverride;
    } else {
      reposRootCurrent.textContent = "Using server default REPOS_ROOT";
    }
  }

  if (reposRootPathInput) {
    reposRootPathInput.value = currentOverride;
    reposRootPathInput.placeholder = "";
    // Focus shortly after open so layout has settled
    setTimeout(() => {
      reposRootPathInput.focus();
      reposRootPathInput.select();
    }, 0);
  }

  reposRootModal.style.display = "flex";
}

/**
 * Close the repos root modal dialog
 */
function closeReposRootModal() {
  const reposRootModal = document.getElementById("reposRootModal");
  if (!reposRootModal) return;
  reposRootModal.style.display = "none";
  // Mark that the user has seen/handled the Projects Folder dialog at least once
  try {
    window.localStorage.setItem("gitzada:reposRootOnboarded", "true");
  } catch {
    // Ignore storage errors (e.g., private mode)
  }
}

// ============================================================================
// Export to window for global access
// ============================================================================

window.setStatus = setStatus;
window.setStatusMessage = setStatusMessage;
window.setFloatingStatusMessage = setFloatingStatusMessage;
window.showGraphLimitNotification = showGraphLimitNotification;
window.getStoredReposRoot = getStoredReposRoot;
window.normalizePathForDisplay = normalizePathForDisplay;
window.openReposRootModal = openReposRootModal;
window.closeReposRootModal = closeReposRootModal;
