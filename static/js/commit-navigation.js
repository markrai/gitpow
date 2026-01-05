/**
 * Commit Navigation for GitPow
 * Functions for commit selection, navigation, and view switching
 * Extracted from script.js for better maintainability
 */

// Track the previously active commit element to avoid O(n) DOM traversal
let previousActiveCommitElement = null;

// Debounce timer for rapid commit selection
let commitSelectionDebounceTimer = null;
const COMMIT_SELECTION_DEBOUNCE_MS = 50; // 50ms debounce for rapid clicks

// Helper function to convert hex to RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// Keyboard navigation for commits with Up/Down arrows
function moveCommitSelection(delta) {
  if (!window.state.filteredCommits.length) return;
  let idx = -1;
  if (window.state.currentCommit) {
    idx = window.state.filteredCommits.findIndex(c => c.sha === window.state.currentCommit.sha);
  }
  if (idx === -1) {
    idx = 0;
  } else {
    idx = idx + delta;
    if (idx < 0) idx = 0;
    if (idx >= window.state.filteredCommits.length) idx = window.state.filteredCommits.length - 1;
  }
  const next = window.state.filteredCommits[idx];
  if (!next || (window.state.currentCommit && next.sha === window.state.currentCommit.sha)) return;
  window.state.currentCommit = next;
  updateActiveCommitState();
  loadFilesForCommitDebounced();
  updateCommitDetails(next);
}

// Compute 1-based commit sequence number where #1 is the oldest commit
// in the repository (for the current branch), based on Activity view data.
// The newest commit gets the highest number (= total commits).
function getCommitSequenceNumber(commitSha) {
  const commitsArr = window.state.commits || [];
  if (!commitsArr.length || !commitSha) return null;

  const idx = commitsArr.findIndex((c) => c.sha === commitSha);
  if (idx === -1) return null;

  // totalCommits is the best estimate of total history length for this branch.
  // When we only loaded a window (global cap), commitsArr.length < totalCommits.
  const total =
    typeof window.state.totalCommits === "number" && window.state.totalCommits > 0
      ? window.state.totalCommits
      : commitsArr.length;

  // commitsArr is ordered newest-first (idx 0 = newest, idx N = oldest in window)
  // Newest commit should be #total, oldest in window should be #(total - visibleCount + 1)
  // So: commit at idx gets number (total - idx)
  return total - idx;
}

// Page-wise navigation for commits (Page Up / Page Down)
function pageCommitSelection(direction) {
  const commitList = document.getElementById("commitList");
  if (!commitList || !window.state.filteredCommits.length) return;
  const items = commitList.querySelectorAll(".commit-item");
  if (!items.length) return;

  // Use the active item to estimate row height; fall back to first item.
  const active =
    commitList.querySelector(".commit-item.active") || items[0];
  const itemHeight = active.offsetHeight || 24;
  const viewHeight = commitList.clientHeight || itemHeight * 10;

  // Approximate how many rows fit in the viewport and step by that.
  let step = Math.floor(viewHeight / itemHeight) - 1;
  if (!Number.isFinite(step) || step <= 0) step = 10;

  moveCommitSelection(direction * step);
}

// Update only the active commit state without re-rendering the entire list
function updateActiveCommitState() {
  const commitList = document.getElementById("commitList");
  if (!commitList || !window.state.currentCommit) return;

  // Remove active state from previous element only (O(1) instead of O(n))
  if (previousActiveCommitElement) {
    previousActiveCommitElement.classList.remove('active');
    previousActiveCommitElement.style.background = '';
  }

  // Find the new active commit by data-sha attribute
  const activeItem = commitList.querySelector(`[data-sha="${window.state.currentCommit.sha}"]`);

  if (activeItem) {
    // Check if commit is inside a collapsed month container
    const monthContainer = activeItem.closest('.month-container');
    if (monthContainer) {
      const commitsContainer = monthContainer.querySelector('.month-commits');
      const chevron = monthContainer.querySelector('.month-chevron');
      const monthKey = monthContainer.dataset.monthKey;

      // If the commits container is hidden (collapsed), expand it and render its commits
      if (commitsContainer && commitsContainer.style.display === 'none') {
        window.state.expandedMonths.add(monthKey);
        if (chevron) {
          chevron.textContent = "▼";
        }
        commitsContainer.style.display = 'block';
        // Trigger lazy render if needed
        if (commitsContainer._commits && !commitsContainer._rendered) {
          // The month header click handler has the renderMonthCommits function
          // For now, just set _rendered to trigger re-query
        }
      }
    }

    // Add active class
    activeItem.classList.add('active');

    // Apply active commit background color
    if (window.colorSettings && window.colorSettings.activeCommit) {
      const rgb = hexToRgb(window.colorSettings.activeCommit);
      if (rgb) {
        activeItem.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
      }
    }

    // Store reference for next update
    previousActiveCommitElement = activeItem;

    // Scroll to ensure active commit is visible
    if (typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } else {
    previousActiveCommitElement = null;
  }
}

// Update commit details panel with commit information
function updateCommitDetails(commit) {
  // This function is kept for API compatibility but the UI elements no longer exist
  // Commit details are now displayed inline in the commit list items
  if (!commit) return;
}

// Debounced wrapper for loadFilesForCommit - prevents overwhelming the backend
// when user rapidly clicks through commits
function loadFilesForCommitDebounced() {
  if (commitSelectionDebounceTimer) {
    clearTimeout(commitSelectionDebounceTimer);
  }
  commitSelectionDebounceTimer = setTimeout(() => {
    commitSelectionDebounceTimer = null;
    if (window.loadFilesForCommit) {
      window.loadFilesForCommit();
    }
  }, COMMIT_SELECTION_DEBOUNCE_MS);
}

// Switch to Activity View and select a commit by SHA
async function switchToActivityView(commitSha) {
  const currentMode = window.state.historyMode || "activity";
  const isNeo = currentMode === "neo-vertical" || currentMode === "neo-horizontal";
  
  if (isNeo) {
    // Switch to Activity View
    window.state.historyMode = "activity";
    
    // Update button appearance
    const viewModeToggle = document.getElementById("viewModeToggle");
    if (viewModeToggle) {
      viewModeToggle.textContent = "Activity";
      viewModeToggle.dataset.mode = "activity";
      viewModeToggle.title = "Activity: Active branch + main + merges";
      viewModeToggle.setAttribute("aria-label", "Activity view mode");
    }
    
    // If switching away from graph view and "__ALL__" is selected, reset to a real branch
    if (window.state.currentBranch === "__ALL__") {
      window.state.currentBranch = window.state.branches[0] || null;
    }
    
    // Switch UI immediately
    if (window.switchViewMode) {
      window.switchViewMode(false);
    }
    
    // Render immediately (non-blocking)
    if (window.renderCommitList) {
      window.renderCommitList();
    }

    // Use requestAnimationFrame to ensure UI update is visible before starting async operations
    await new Promise(resolve => requestAnimationFrame(resolve));

    // Refresh branch dropdown for Activity view without refetching from the server
    if (window.applyActiveBranchFilter) {
      window.applyActiveBranchFilter();
    }
    const branchLabelEl = document.getElementById("branchLabel");
    if (branchLabelEl) {
      branchLabelEl.textContent = window.state.currentBranch
        ? (window.state.currentBranch === "__ALL__" ? "All" : window.state.currentBranch)
        : "";
    }

    // Reload commits using the cache-aware path (will filter __ALL__ if available)
    if (window.loadCommits) {
      await window.loadCommits();
    }
  }
  
  // Select the commit (this will work even if we're already in Activity View)
  highlightCommitBySha(commitSha);
}

// Highlight a commit by SHA in the commits pane
function highlightCommitBySha(commitSha, filePathToSelect = null) {
  // Find the commit in the current commits list
  const commit = window.state.commits.find(c => c.sha === commitSha);
  if (!commit) {
    // If not in current list, we might need to load more commits or switch view
    if (window.setStatus) {
      window.setStatus("Commit not found in current view", true);
    }
    return;
  }
  
  // Set as current commit
  window.state.currentCommit = commit;
  
  // Update active state without full re-render
  updateActiveCommitState();
  updateCommitDetails(commit);
  
  // Scroll to the commit with center alignment (different from updateActiveCommitState's 'nearest')
  const commitListEl = document.getElementById("commitList");
  if (commitListEl) {
    const commitElement = commitListEl.querySelector(`[data-sha="${commitSha}"]`);
    if (commitElement) {
      commitElement.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      // If not found, try to find by class
      const activeItem = commitListEl.querySelector(".item.active");
      if (activeItem) {
        activeItem.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }
  
  // Load files for this commit
  if (window.loadFilesForCommit) {
    window.loadFilesForCommit().then(() => {
      // After files are loaded, select the specified file if provided
      if (filePathToSelect) {
        // Wait a bit for the file list to render
        setTimeout(() => {
          window.state.currentFile = filePathToSelect;
          if (window.renderFileList) {
            window.renderFileList();
          }
          if (window.loadCommitFileDiff) {
            window.loadCommitFileDiff();
          }
          
          // Scroll to the file in the file list
          const fileList = document.getElementById("fileList");
          if (fileList) {
            const fileElement = fileList.querySelector(`[data-file-path="${filePathToSelect}"]`);
            if (fileElement) {
              fileElement.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }
        }, 200);
      }
    });
  }
}

// Export functions to window
window.moveCommitSelection = moveCommitSelection;
window.pageCommitSelection = pageCommitSelection;
window.updateActiveCommitState = updateActiveCommitState;
window.updateCommitDetails = updateCommitDetails;
window.loadFilesForCommitDebounced = loadFilesForCommitDebounced;
window.getCommitSequenceNumber = getCommitSequenceNumber;
window.switchToActivityView = switchToActivityView;
window.highlightCommitBySha = highlightCommitBySha;
