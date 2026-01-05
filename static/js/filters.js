/**
 * Filtering Functions for GitPow
 * Branch and commit filtering logic
 * Extracted from script.js for better maintainability
 */

// Check if a branch is active based on filter settings
function isBranchActive(branchName, metadata) {
  if (!metadata) return true; // If no metadata, consider all branches active
  
  const filterMerged = localStorage.getItem("gitzada:filterMergedBranches") === "true";
  const filterStale = localStorage.getItem("gitzada:filterStaleBranches") === "true";
  const filterUnborn = localStorage.getItem("gitzada:filterUnbornBranches") === "true";
  const staleThresholdMonths = parseInt(localStorage.getItem("gitzada:staleThresholdMonths") || "3", 10);
  
  // Check merged
  if (filterMerged && metadata.isMerged) {
    return false;
  }
  
  // Check unborn
  if (filterUnborn && metadata.isUnborn) {
    return false;
  }
  
  // Check stale (using user's threshold, not backend's default)
  if (filterStale && metadata.lastCommitDate) {
    try {
      const commitDate = new Date(metadata.lastCommitDate);
      const now = new Date();
      const daysSinceLastCommit = Math.floor((now - commitDate) / (1000 * 60 * 60 * 24));
      const thresholdDays = staleThresholdMonths * 30; // Approximate days per month
      if (daysSinceLastCommit > thresholdDays) {
        return false;
      }
    } catch (e) {
      // If date parsing fails, don't filter it out
    }
  }
  
  return true;
}

// Apply active branch filter to branches and update dropdown
function applyActiveBranchFilter() {
  const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
  const isActivityView = window.state.historyMode === "activity";
  const branchSelect = document.getElementById("branchSelect");
  const branchSearchable = window.branchSearchable;

  // If Active Only is off, show all branches without filtering
  if (!activeOnly) {
    if (branchSelect) {
      branchSelect.innerHTML = "";
      if (window.isGraphMode && window.isGraphMode()) {
        const totalBranches = Array.isArray(window.state.branches) ? window.state.branches.length : 0;
        const allOpt = document.createElement("option");
        allOpt.value = "__ALL__";
        allOpt.textContent = `All (${totalBranches})`;
        if (window.state.currentBranch === "__ALL__") allOpt.selected = true;
        branchSelect.appendChild(allOpt);
      }
      window.state.branches.forEach(b => {
        const opt = document.createElement("option");
        opt.value = b;
        opt.textContent = b;
        if (b === window.state.currentBranch) opt.selected = true;
        branchSelect.appendChild(opt);
      });
    }

    // Update searchable dropdown
    if (branchSearchable) {
      branchSearchable.updateOptions();
      if (window.state.currentBranch) {
        branchSearchable.setValue(window.state.currentBranch);
      }
    }
    return;
  }

  // Active Only is enabled - filter branches based on metadata
  const activeBranches = window.state.branches.filter(branchName => {
    const metadata = window.state.branchMetadata?.[branchName];
    return isBranchActive(branchName, metadata);
  });
  
  // Update dropdown
  if (branchSelect) {
    branchSelect.innerHTML = "";
    if (window.isGraphMode && window.isGraphMode()) {
      const totalActiveBranches = activeBranches.length;
      const allOpt = document.createElement("option");
      allOpt.value = "__ALL__";
      allOpt.textContent = `All (${totalActiveBranches})`;
      if (window.state.currentBranch === "__ALL__") allOpt.selected = true;
      branchSelect.appendChild(allOpt);
    }
    
    activeBranches.forEach(b => {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      if (b === window.state.currentBranch) opt.selected = true;
      branchSelect.appendChild(opt);
    });
  }

  // Update searchable dropdown
  if (branchSearchable) {
    branchSearchable.updateOptions();
    if (window.state.currentBranch) {
      branchSearchable.setValue(window.state.currentBranch);
    }
  }
  
  // If current branch is filtered out, switch to first available branch or "All"
  if (window.state.currentBranch && window.state.currentBranch !== "__ALL__" && !activeBranches.includes(window.state.currentBranch)) {
    if (window.isGraphMode && window.isGraphMode() && activeBranches.length > 0) {
      window.state.currentBranch = "__ALL__";
      if (branchSelect) branchSelect.value = "__ALL__";
    } else if (activeBranches.length > 0) {
      window.state.currentBranch = activeBranches[0];
      if (branchSelect) branchSelect.value = activeBranches[0];
    } else {
      window.state.currentBranch = null;
    }
    // Reload commits with new branch
    if (window.loadedCommitsKey !== undefined) {
      window.loadedCommitsKey = null;
    }
    if (window.loadCommits) {
      window.loadCommits();
    }
  }
}

function updateCommitCountDisplay() {
  // Update commit count pill only (not status bar)
  const commitCountEl = document.getElementById("commitCount");
  if (commitCountEl) {
    const loaded = window.state.commits.length;
    const visible = window.state.filteredCommits.length;
    const total = window.state.totalCommits !== null ? window.state.totalCommits : loaded;
    
    if (!window.isGraphMode || !window.isGraphMode()) {
      // Activity view: show visible/total format (filtered count if filtering is active)
      const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
      if (activeOnly && visible !== loaded) {
        // Show filtered count when active only is enabled and filtering has effect
        commitCountEl.textContent = `${visible}/${total}`;
      } else {
        // Show loaded/total when no filtering or all commits are visible
        commitCountEl.textContent = `${loaded}/${total}`;
      }
    } else {
      // Graph mode: show filtered/total format (original behavior)
      if (!loaded) {
        commitCountEl.textContent = "0";
      } else if (visible === loaded) {
        commitCountEl.textContent = `${total}`;
      } else {
        commitCountEl.textContent = `${visible}/${total}`;
      }
    }
  }
}

// Helper function to check if a commit is on an active branch
function isCommitOnActiveBranch(commit) {
  const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
  if (!activeOnly || !window.state.branchMetadata) {
    return true; // If Active Only is off, all commits are considered active
  }
  
  // Get list of active branches
  const activeBranches = new Set(
    window.state.branches.filter(branchName => {
      const metadata = window.state.branchMetadata[branchName];
      return isBranchActive(branchName, metadata);
    })
  );
  
  // If commit has branches listed, check if any are active
  if (commit.branches && commit.branches.length > 0) {
    return commit.branches.some(branch => activeBranches.has(branch));
  }
  
  // If commit has no branches listed, check if current branch is active
  // In Activity view, commits without branches are typically on the current branch
  if (window.state.currentBranch && window.state.currentBranch !== "__ALL__") {
    return activeBranches.has(window.state.currentBranch);
  }
  
  // If no current branch or it's __ALL__, consider it active (orphaned or unknown)
  return true;
}

// Helper function to mark all commits with their active status (for Activity view)
function markCommitsActiveStatus() {
  const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
  const isActivityView = window.state.historyMode === "activity";
  
  if (activeOnly && isActivityView && window.state.commits) {
    window.state.commits.forEach(c => {
      c._isActive = isCommitOnActiveBranch(c);
    });
  }
}

function applyCommitFilter() {
  const searchInput = document.getElementById("searchInput");
  if (!searchInput) return;
  
  const q = (searchInput.value || "").toLowerCase();
  const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";

  // By default, start from all loaded commits
  let commitsToFilter = window.state.commits;

  // When Active Only is enabled, filter to only commits on active branches
  if (activeOnly && window.state.branchMetadata) {
    // Mark all commits with active status first
    markCommitsActiveStatus();
    // Then filter to only active commits
    commitsToFilter = window.state.commits.filter(c => isCommitOnActiveBranch(c));
  }

  // Then apply search filter if present
  if (!q) {
    window.state.filteredCommits = commitsToFilter;
  } else {
    window.state.filteredCommits = commitsToFilter.filter(c =>
      c.message.toLowerCase().includes(q) ||
      c.author.toLowerCase().includes(q)
    );
  }
  updateCommitCountDisplay();
  if (window.renderCommitList) {
    window.renderCommitList();
  }
}

// Export functions to window
window.isBranchActive = isBranchActive;
window.applyActiveBranchFilter = applyActiveBranchFilter;
window.updateCommitCountDisplay = updateCommitCountDisplay;
window.isCommitOnActiveBranch = isCommitOnActiveBranch;
window.markCommitsActiveStatus = markCommitsActiveStatus;
window.applyCommitFilter = applyCommitFilter;
