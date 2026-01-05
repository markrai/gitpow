/**
 * Context Menu Management for GitPow
 * Functions for showing/hiding context menu and handling context menu actions
 * Extracted from script.js for better maintainability
 */

function showContextMenu(x, y) {
  const contextMenu = document.getElementById("contextMenu");
  if (!contextMenu) return;
  
  const contextMenuOpenExplorer = document.getElementById("contextMenuOpenExplorer");
  const contextMenuViewGitHub = document.getElementById("contextMenuViewGitHub");
  const contextMenuCopyCommitId = document.getElementById("contextMenuCopyCommitId");
  const contextMenuCheckoutCommit = document.getElementById("contextMenuCheckoutCommit");
  
  // Show/hide menu items based on context
  if (contextMenuOpenExplorer) {
    contextMenuOpenExplorer.style.display = window.state.contextMenuFile ? "block" : "none";
  }
  if (contextMenuViewGitHub) {
    const hasGitHubUsername = window.state.contextMenuCommit && window.getGitHubUsername && window.getGitHubUsername(window.state.contextMenuCommit.email, window.state.contextMenuCommit.author);
    if (hasGitHubUsername) {
      contextMenuViewGitHub.textContent = `View ${window.state.contextMenuCommit.author}'s GitHub Profile`;
      contextMenuViewGitHub.style.display = "block";
    } else {
      contextMenuViewGitHub.style.display = "none";
    }
  }
  if (contextMenuCopyCommitId) {
    contextMenuCopyCommitId.style.display = window.state.contextMenuCommit ? "block" : "none";
  }
  if (contextMenuCheckoutCommit) {
    contextMenuCheckoutCommit.style.display = window.state.contextMenuCommit ? "block" : "none";
  }
  
  contextMenu.style.display = "block";
  contextMenu.style.left = x + "px";
  contextMenu.style.top = y + "px";
}

function hideContextMenu() {
  const contextMenu = document.getElementById("contextMenu");
  if (contextMenu) {
    contextMenu.style.display = "none";
  }
  window.state.contextMenuFile = null;
  window.state.contextMenuCommit = null;
}

// Hide context menu when clicking elsewhere
document.addEventListener("click", (e) => {
  const contextMenu = document.getElementById("contextMenu");
  // Don't hide if clicking on the context menu itself
  if (!contextMenu || !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});
document.addEventListener("contextmenu", (e) => {
  const contextMenu = document.getElementById("contextMenu");
  if (!contextMenu || !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

// Handle context menu actions
(function initContextMenu() {
  const contextMenuOpenExplorer = document.getElementById("contextMenuOpenExplorer");
  const contextMenuViewGitHub = document.getElementById("contextMenuViewGitHub");
  const contextMenuCopyCommitId = document.getElementById("contextMenuCopyCommitId");

  if (contextMenuOpenExplorer) {
    contextMenuOpenExplorer.addEventListener("click", async () => {
      if (!window.state.contextMenuFile || !window.state.currentRepo) {
        hideContextMenu();
        return;
      }
      
      try {
        if (window.api) {
          await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/open-explorer?path=" + encodeURIComponent(window.state.contextMenuFile));
        }
        hideContextMenu();
      } catch (e) {
        if (window.setStatus) {
          window.setStatus("Error opening file explorer: " + e.message, true);
        }
        hideContextMenu();
      }
    });
  }

  if (contextMenuViewGitHub) {
    contextMenuViewGitHub.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (!window.state.contextMenuCommit) {
        hideContextMenu();
        return;
      }
      
      const username = window.getGitHubUsername && window.getGitHubUsername(window.state.contextMenuCommit.email, window.state.contextMenuCommit.author);
      if (!username) {
        console.warn('Could not extract GitHub username from:', window.state.contextMenuCommit);
        hideContextMenu();
        return;
      }
      
      const url = `https://github.com/${username}`;
      console.log('Opening GitHub profile:', url);
      
      // Use Tauri shell API to open URL in external browser (not webview)
      try {
        // Use the same invoke function pattern as the api() function
        const tauri = window.__TAURI__ || window.__TAURI_INTERNALS__;
        if (!tauri) {
          throw new Error('Tauri API not available');
        }

        // Get invoke function using the same logic as api.js
        let invokeFn = null;
        if (tauri.core && tauri.core.invoke) {
          invokeFn = tauri.core.invoke.bind(tauri.core);
        } else if (tauri.invoke) {
          invokeFn = tauri.invoke.bind(tauri);
        } else if (window.__TAURI_INTERNALS__) {
          const internals = window.__TAURI_INTERNALS__;
          if (internals.core && internals.core.invoke) {
            invokeFn = internals.core.invoke.bind(internals.core);
          } else if (internals.invoke) {
            invokeFn = internals.invoke.bind(internals);
          } else if (internals.ipc && internals.ipc.invoke) {
            invokeFn = internals.ipc.invoke.bind(internals.ipc);
          }
        }

        if (invokeFn) {
          // Tauri 2.0 shell plugin open command
          // The shell.open command expects an object with the URL
          await invokeFn('plugin:shell|open', { path: url });
          console.log('Successfully opened GitHub profile in external browser:', url);
          hideContextMenu();
          return;
        } else {
          throw new Error('Tauri invoke function not available');
        }
      } catch (err) {
        console.error('Failed to open URL with Tauri shell API:', err);
        // Don't fallback to window.open in Tauri - it opens in webview, not external browser
        const errorMessage = err?.message || err?.toString() || String(err) || 'Unknown error';
        if (window.setStatus) {
          window.setStatus(`Failed to open GitHub profile: ${errorMessage}`, true);
        }
      }
      hideContextMenu();
    });
  }

  // Handle copy commit ID
  if (contextMenuCopyCommitId) {
    contextMenuCopyCommitId.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (!window.state.contextMenuCommit) {
        hideContextMenu();
        return;
      }
      
      const fullCommitId = window.state.contextMenuCommit.sha;
      
      try {
        // Use the Clipboard API to copy the commit ID
        await navigator.clipboard.writeText(fullCommitId);
        if (window.setStatus) {
          window.setStatus(`Copied commit ID: ${fullCommitId}`, false);
        }
        hideContextMenu();
        // Auto-fade the status message after 2 seconds
        setTimeout(() => {
          if (window.setStatus) {
            window.setStatus("");
          }
        }, 2000);
      } catch (err) {
        console.error('Failed to copy commit ID:', err);
        // Fallback for older browsers or if clipboard API fails
        try {
          const textArea = document.createElement("textarea");
          textArea.value = fullCommitId;
          textArea.style.position = "fixed";
          textArea.style.left = "-999999px";
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand("copy");
          document.body.removeChild(textArea);
          if (window.setStatus) {
            window.setStatus(`Copied commit ID: ${fullCommitId}`, false);
          }
          hideContextMenu();
          // Auto-fade the status message after 2 seconds
          setTimeout(() => {
            if (window.setStatus) {
              window.setStatus("");
            }
          }, 2000);
        } catch (fallbackErr) {
          if (window.setStatus) {
            window.setStatus("Failed to copy commit ID: " + (fallbackErr.message || fallbackErr), true);
          }
          hideContextMenu();
          // Auto-fade error messages after 3 seconds (longer for errors)
          setTimeout(() => {
            if (window.setStatus) {
              window.setStatus("");
            }
          }, 3000);
        }
      }
    });
  }
})();

// Export functions to window
window.showContextMenu = showContextMenu;
window.hideContextMenu = hideContextMenu;
