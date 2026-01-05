/**
 * Detached HEAD Management for GitPow
 * Functions for managing detached HEAD state and exit modal
 * Extracted from script.js for better maintainability
 */

function updateDetachedHeadStatus() {
  const statusEl = document.getElementById("statusMessage");
  if (!statusEl) return;
  
  const innerDiv = statusEl.querySelector('div');
  if (!innerDiv) return;
  
  if (window.state.detachedHeadCommit) {
    const shortSha = window.state.detachedHeadCommit.sha.slice(0, 10);
    const message = window.state.detachedHeadCommit.message || "";
    // Truncate message if too long (keep first line if multi-line)
    const firstLine = message.split('\n')[0].trim();
    const truncatedMessage = firstLine.length > 60 ? firstLine.substring(0, 57) + "..." : firstLine;
    const statusText = `DETACHED HEAD: ${shortSha}${truncatedMessage ? ` (${truncatedMessage})` : ""}`;
    
    // Set the text and make it red
    innerDiv.textContent = statusText;
    innerDiv.style.color = '#ef4444'; // Red color
    statusEl.style.display = 'block';
    statusEl.style.visibility = 'visible';
    statusEl.style.opacity = '1';
    statusEl.style.zIndex = '1000';
    statusEl.style.transition = 'opacity 0.3s ease-out';
    
    // Make it clickable
    statusEl.style.pointerEvents = 'auto';
    statusEl.style.cursor = 'pointer';
    
    // Set click handler (using onclick to replace any existing handler)
    statusEl.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.state.detachedHeadCommit) {
        showExitDetachedHeadModal();
      }
    };
  } else {
    // Clear detached HEAD message if we're on a branch
    // Only clear if the current status is about detached HEAD
    if (innerDiv.textContent.includes("DETACHED HEAD:")) {
      // Reset color to default and remove click handler
      innerDiv.style.color = '';
      statusEl.style.pointerEvents = 'none';
      statusEl.style.cursor = '';
      statusEl.onclick = null;
      if (window.setStatusMessage) {
        window.setStatusMessage("");
      }
    }
  }
}

// Functions to show/hide exit detached HEAD modal
function showExitDetachedHeadModal() {
  const exitDetachedHeadModal = document.getElementById("exitDetachedHeadModal");
  if (exitDetachedHeadModal) {
    exitDetachedHeadModal.style.display = 'flex';
  }
}

function closeExitDetachedHeadModal() {
  const exitDetachedHeadModal = document.getElementById("exitDetachedHeadModal");
  if (exitDetachedHeadModal) {
    exitDetachedHeadModal.style.display = 'none';
  }
}

// Handle exit detached HEAD modal
(function initDetachedHeadModal() {
  const exitDetachedHeadModal = document.getElementById("exitDetachedHeadModal");
  const exitDetachedHeadClose = document.getElementById("exitDetachedHeadClose");
  const exitDetachedHeadNo = document.getElementById("exitDetachedHeadNo");
  const exitDetachedHeadYes = document.getElementById("exitDetachedHeadYes");
  const contextMenuCheckoutCommit = document.getElementById("contextMenuCheckoutCommit");

  if (exitDetachedHeadModal) {
    // Close when clicking on backdrop
    exitDetachedHeadModal.addEventListener("click", (e) => {
      if (e.target === exitDetachedHeadModal) {
        closeExitDetachedHeadModal();
      }
    });
  }

  if (exitDetachedHeadClose) {
    exitDetachedHeadClose.addEventListener("click", () => {
      closeExitDetachedHeadModal();
    });
  }

  if (exitDetachedHeadNo) {
    exitDetachedHeadNo.addEventListener("click", () => {
      closeExitDetachedHeadModal();
    });
  }

  if (exitDetachedHeadYes) {
    exitDetachedHeadYes.addEventListener("click", async () => {
      if (!window.state.currentRepo || !window.state.detachedHeadCommit) {
        closeExitDetachedHeadModal();
        return;
      }
      
      // Disable the button to prevent double-clicks
      if (exitDetachedHeadYes) {
        exitDetachedHeadYes.disabled = true;
        exitDetachedHeadYes.textContent = "Switching...";
      }
      
      let targetBranch = null;
      
      try {
        // Use Tauri invoke to get the best branch to checkout
        const tauri = window.__TAURI__ || window.__TAURI_INTERNALS__;
        if (!tauri) {
          throw new Error('Tauri API not available');
        }

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

        if (!invokeFn) {
          throw new Error('Tauri invoke function not available');
        }

        // Use the new robust command that handles all fallback logic
        try {
          targetBranch = await invokeFn('get_best_branch_to_checkout', {
            repo: window.state.currentRepo
          });
        } catch (err) {
          console.warn("Failed to get best branch to checkout:", err);
        }
        
        // Fallback: try stored previousBranch if available and still exists
        if (!targetBranch && window.state.previousBranch && window.state.branches && window.state.branches.includes(window.state.previousBranch)) {
          targetBranch = window.state.previousBranch;
        }
        
        // Final fallback: use local branch list
        if (!targetBranch && window.state.branches && window.state.branches.length > 0) {
          // Try to find main or master first
          targetBranch = window.state.branches.find(b => b === "main" || b === "master") || window.state.branches[0];
        }
        
        if (!targetBranch) {
          if (window.setStatus) {
            window.setStatus("No branch available to checkout", true);
          }
          closeExitDetachedHeadModal();
          if (exitDetachedHeadYes) {
            exitDetachedHeadYes.disabled = false;
            exitDetachedHeadYes.textContent = "Yes";
          }
          return;
        }

        // Set flag to prevent re-detection of detached HEAD during checkout
        window.state.isCheckingOutBranch = true;
        
        // Perform the checkout
        const result = await invokeFn('checkout_branch', {
          repo: window.state.currentRepo,
          branchName: targetBranch
        });

        if (result.success) {
          // Clear detached HEAD state immediately
          window.state.detachedHeadCommit = null;
          window.state.previousBranch = null;
          
          // Update branch dropdown immediately
          const branchSelect = document.getElementById("branchSelect");
          if (branchSelect) {
            branchSelect.value = targetBranch;
          }
          if (window.branchSearchable) {
            window.branchSearchable.setValue(targetBranch);
          }
          
          // Update status message
          updateDetachedHeadStatus();
          
          // Small delay to ensure git state has updated after checkout
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Reload branches to get fresh state from git
          // This will update state.currentBranch and state.branches
          if (window.loadBranches) {
            await window.loadBranches();
          }
          
          // Clear the flag after reload
          window.state.isCheckingOutBranch = false;
          
          // Verify we're actually on a branch (not detached HEAD)
          const isOnBranch = window.state.currentBranch && 
                            window.state.currentBranch !== "HEAD" && 
                            window.state.currentBranch.length !== 40 && // Not a SHA
                            window.state.branches && 
                            window.state.branches.includes(window.state.currentBranch);
          
          if (isOnBranch) {
            // Successfully on a branch - ensure detached HEAD state is cleared
            window.state.detachedHeadCommit = null;
            window.state.previousBranch = null;
            updateDetachedHeadStatus();
            
            // Reload commits to show the branch's commits
            if (window.loadCommits) {
              await window.loadCommits();
            }
            
            closeExitDetachedHeadModal();
            if (window.setStatus) {
              window.setStatus(`Switched to branch: ${window.state.currentBranch}`, false);
              setTimeout(() => window.setStatus(""), 2000);
            }
          } else {
            // Still in detached HEAD - this shouldn't happen but handle gracefully
            console.warn("Still in detached HEAD after checkout. Current branch:", window.state.currentBranch);
            
            // Try one more time to reload branches
            if (window.loadBranches) {
              await window.loadBranches();
            }
            
            // Check again
            const stillDetached = !window.state.currentBranch || 
                                 window.state.currentBranch === "HEAD" || 
                                 (window.state.currentBranch.length === 40 && /^[0-9a-f]{40}$/i.test(window.state.currentBranch)) ||
                                 !window.state.branches || 
                                 !window.state.branches.includes(window.state.currentBranch);
            
            if (stillDetached) {
              if (window.setStatus) {
                window.setStatus("Checkout completed but still in detached HEAD state. Please try again.", true);
              }
            } else {
              // Actually succeeded on second check
              window.state.detachedHeadCommit = null;
              window.state.previousBranch = null;
              updateDetachedHeadStatus();
              if (window.loadCommits) {
                await window.loadCommits();
              }
              closeExitDetachedHeadModal();
              if (window.setStatus) {
                window.setStatus(`Switched to branch: ${window.state.currentBranch}`, false);
                setTimeout(() => window.setStatus(""), 2000);
              }
            }
          }
        } else {
          // Checkout failed
          window.state.isCheckingOutBranch = false;
          if (window.setStatus) {
            window.setStatus(result.error || result.message || "Failed to checkout branch", true);
          }
          closeExitDetachedHeadModal();
        }
      } catch (err) {
        console.error('Failed to checkout branch:', err);
        window.state.isCheckingOutBranch = false;
        if (window.setStatus) {
          window.setStatus("Failed to checkout branch: " + (err.message || err), true);
        }
        closeExitDetachedHeadModal();
      } finally {
        // Re-enable the button
        if (exitDetachedHeadYes) {
          exitDetachedHeadYes.disabled = false;
          exitDetachedHeadYes.textContent = "Yes";
        }
      }
    });
  }

  // Handle checkout commit (detached HEAD)
  if (contextMenuCheckoutCommit) {
    contextMenuCheckoutCommit.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (!window.state.contextMenuCommit || !window.state.currentRepo) {
        if (window.hideContextMenu) {
          window.hideContextMenu();
        }
        return;
      }
      
      const commitSha = window.state.contextMenuCommit.sha;
      
      try {
        // Use Tauri invoke to call the checkout_commit command
        const tauri = window.__TAURI__ || window.__TAURI_INTERNALS__;
        if (!tauri) {
          throw new Error('Tauri API not available');
        }

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

        if (!invokeFn) {
          throw new Error('Tauri invoke function not available');
        }

        const result = await invokeFn('checkout_commit', {
          repo: window.state.currentRepo,
          commitSha: commitSha
        });

        if (result.success) {
          // Store the previous branch before entering detached HEAD
          if (window.state.currentBranch && window.state.currentBranch !== "HEAD" && !window.state.previousBranch) {
            window.state.previousBranch = window.state.currentBranch;
          }
          
          // Store detached HEAD state
          window.state.detachedHeadCommit = {
            sha: commitSha,
            message: window.state.contextMenuCommit.message || ""
          };
          
          // Update status message
          updateDetachedHeadStatus();
          
          // Reload branches to reflect the detached HEAD state
          if (window.loadBranches) {
            await window.loadBranches();
          }
          
          // Reload commits
          if (window.loadCommits) {
            await window.loadCommits();
          }
          
          if (window.hideContextMenu) {
            window.hideContextMenu();
          }
        } else {
          if (window.setStatus) {
            window.setStatus(result.error || result.message || "Failed to checkout commit", true);
          }
          if (window.hideContextMenu) {
            window.hideContextMenu();
          }
        }
      } catch (err) {
        console.error('Failed to checkout commit:', err);
        if (window.setStatus) {
          window.setStatus("Failed to checkout commit: " + (err.message || err), true);
        }
        if (window.hideContextMenu) {
          window.hideContextMenu();
        }
      }
    });
  }
})();

// Export functions to window
window.updateDetachedHeadStatus = updateDetachedHeadStatus;
window.showExitDetachedHeadModal = showExitDetachedHeadModal;
window.closeExitDetachedHeadModal = closeExitDetachedHeadModal;
