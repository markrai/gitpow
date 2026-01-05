// All modules are loaded from separate files:
// - dom-elements.js: DOM element references (repoSelect, branchSelect, etc.)
// - searchable-dropdown.js: createSearchableDropdown function
// - state.js: state object, constants, cache helpers
// - utils.js: formatRelativeTime, formatHumanDate, hashColor, getGitHubUsername, getAvatarUrl, fileAccent
// - ui.js: setStatus, setStatusMessage, setFloatingStatusMessage, showGraphLimitNotification,
//          getStoredReposRoot, openReposRootModal, closeReposRootModal
// - api.js: api() function for Tauri/HTTP requests

// Initialize searchable dropdowns
let repoSearchable = null;
let branchSearchable = null;

if (repoSelect) {
  repoSearchable = createSearchableDropdown(repoSelect, {
    placeholder: "Search repos...",
    maxHeight: "400px"
  });
}

if (branchSelect) {
  branchSearchable = createSearchableDropdown(branchSelect, {
    placeholder: "Search branches...",
    maxHeight: "200px"
  });
}

// Initialize color settings from state.js module
applyColorSettings();

// Local normalizePath function that uses the UI module's normalizePathForDisplay
function normalizePath(value) {
  return window.normalizePathForDisplay ? window.normalizePathForDisplay(value) : value;
}

async function loadRepos() {
  // Initialize commit count state for Activity view
  state.commits = [];
  state.filteredCommits = [];
  state.totalCommits = 0;
  // Show initial commit count (0/0) instead of loading message
  updateCommitCountDisplay();

  // Show loading indicator in splash screen and status message
  if (window.loadingProgress && window.loadingProgress.isVisible()) {
    window.loadingProgress.setStage("Loading repositories…");
  } else {
    setStatusMessage("Loading repositories…");
  }

  try {
    // Check if custom repos_root is stored in localStorage
    const storedRootRaw = window.localStorage.getItem("gitzada:reposRoot");
    const customReposRoot = storedRootRaw ? normalizePath(storedRootRaw) : "";
    const apiUrl = customReposRoot
      ? `/api/repos?repos_root=${encodeURIComponent(customReposRoot)}`
      : "/api/repos";
    // Clear existing options up-front so stale data isn't shown on errors
    repoSelect.innerHTML = "";

    let repos;
    try {
      repos = await api(apiUrl);
    } catch (error) {
      console.error('Error calling get_repos:', error);
      state.repos = [];
      const opt = document.createElement("option");
      opt.textContent = "Error loading repos";
      opt.value = "";
      repoSelect.appendChild(opt);
      setStatus(error?.message || String(error) || "Failed to load repositories", true);
      return;
    }
    
    // Ensure repos is always an array
    if (!Array.isArray(repos)) {
      console.error('get_repos returned non-array:', repos, typeof repos);
      state.repos = [];
      const opt = document.createElement("option");
      opt.textContent = "Error loading repos";
      opt.value = "";
      repoSelect.appendChild(opt);
      setStatus(typeof repos === 'string' ? repos : "Failed to load repositories: expected array, got " + typeof repos, true);
      return;
    }
    state.repos = repos;
    if (repos.length === 0) {
      const opt = document.createElement("option");
      if (customReposRoot) {
        opt.textContent = `No repos in: ${customReposRoot}`;
      } else {
        opt.textContent = "No repos found";
      }
      opt.value = "";
      repoSelect.appendChild(opt);
      // If a custom root is set, report that; otherwise fall back to server config
      if (customReposRoot) {
        setStatus(`No repos found under: ${customReposRoot}`, true);
      } else {
        try {
          const config = await api("/api/config");
          setStatus(`No repos found under REPOS_ROOT: ${config.reposRoot}`, true);
        } catch (e) {
          setStatus("No repos under REPOS_ROOT", true);
        }
      }
      return;
    }

    // Try to restore last selected repo from localStorage
    const lastRepoId = window.localStorage.getItem("gitzada:lastRepoId") || null;
    let foundLast = false;

    repos.forEach((r, i) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      if (lastRepoId && r.id === lastRepoId) {
        opt.selected = true;
        state.currentRepo = r.id;
        foundLast = true;
      } else if (!lastRepoId && i === 0) {
        // Fallback to first repo when nothing stored
        opt.selected = true;
        state.currentRepo = r.id;
      }
      repoSelect.appendChild(opt);
    });

    // Update searchable dropdown
    if (repoSearchable) {
      repoSearchable.updateOptions();
      if (state.currentRepo) {
        repoSearchable.setValue(state.currentRepo);
      }
    }

    // If stored repo no longer exists, default to first repo
    if (!state.currentRepo && repos.length > 0) {
      state.currentRepo = repos[0].id;
      repoSelect.value = state.currentRepo;
    }

    // Clear commit cache when repo changes
    loadedCommitsKey = null;
    cachedAllBranchesCommits = null;
    cachedAllBranchesKey = null;
    // Clear cached Activity snapshot for previous repo
    state.lastActivityRepo = null;
    state.lastActivityBranch = null;
    state.lastActivityCommits = null;
    state.lastActivityFilteredCommits = null;
    state.lastActivityTotalCommits = null;
    await loadBranches();
    setStatus("");
    // Initialize git operations toolbar
    if (typeof initGitOps === "function") {
      initGitOps();
    }
    // Load status if in Activity view (commit canvas is shown in Activity view)
    if (!isGraphMode()) {
      await loadStatus();
      // Start polling for real-time updates
      startStatusPolling();
    } else {
      // Stop polling when switching to graph view
      stopStatusPolling();
    }
    await checkConflicts();
  } catch (e) {
    // Ensure dropdown reflects the error state instead of showing stale data
    repoSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.textContent = "Error loading repos";
    opt.value = "";
    repoSelect.appendChild(opt);
    setStatus(e.message, true);
  }
}

// Conflict resolution functions are now loaded from conflicts.js module

// Note: isGraphMode is now in view-mode.js
// Function is exported to window and available globally

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

// Make isBranchActive and state available globally for graph.js
window.isBranchActive = isBranchActive;
window.state = state;

// Apply active branch filter to branches and update dropdown
function applyActiveBranchFilter() {
  const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
  const isActivityView = state.historyMode === "activity";

  // If Active Only is off, show all branches without filtering
  if (!activeOnly) {
    branchSelect.innerHTML = "";
    if (isGraphMode()) {
      const totalBranches = Array.isArray(state.branches) ? state.branches.length : 0;
      const allOpt = document.createElement("option");
      allOpt.value = "__ALL__";
      allOpt.textContent = `All (${totalBranches})`;
      if (state.currentBranch === "__ALL__") allOpt.selected = true;
      branchSelect.appendChild(allOpt);
    }
    state.branches.forEach(b => {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      if (b === state.currentBranch) opt.selected = true;
      branchSelect.appendChild(opt);
    });

    // Update searchable dropdown
    if (branchSearchable) {
      branchSearchable.updateOptions();
      if (state.currentBranch) {
        branchSearchable.setValue(state.currentBranch);
      }
    }
    return;
  }

  // Active Only is enabled - filter branches based on metadata
  const activeBranches = state.branches.filter(branchName => {
    const metadata = state.branchMetadata?.[branchName];
    return isBranchActive(branchName, metadata);
  });
  
  // Update dropdown
  branchSelect.innerHTML = "";
  if (isGraphMode()) {
    const totalActiveBranches = activeBranches.length;
    const allOpt = document.createElement("option");
    allOpt.value = "__ALL__";
    allOpt.textContent = `All (${totalActiveBranches})`;
    if (state.currentBranch === "__ALL__") allOpt.selected = true;
    branchSelect.appendChild(allOpt);
  }
  
  activeBranches.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b;
    opt.textContent = b;
    if (b === state.currentBranch) opt.selected = true;
    branchSelect.appendChild(opt);
  });

  // Update searchable dropdown
  if (branchSearchable) {
    branchSearchable.updateOptions();
    if (state.currentBranch) {
      branchSearchable.setValue(state.currentBranch);
    }
  }
  
  // If current branch is filtered out, switch to first available branch or "All"
  if (state.currentBranch && state.currentBranch !== "__ALL__" && !activeBranches.includes(state.currentBranch)) {
    if (isGraphMode() && activeBranches.length > 0) {
      state.currentBranch = "__ALL__";
      branchSelect.value = "__ALL__";
    } else if (activeBranches.length > 0) {
      state.currentBranch = activeBranches[0];
      branchSelect.value = activeBranches[0];
    } else {
      state.currentBranch = null;
    }
    // Reload commits with new branch
    loadedCommitsKey = null;
    loadCommits();
  }
}

async function loadBranches() {
  if (!state.currentRepo) return;

  const repoName = state.currentRepo.split(/[/\\]/).pop() || state.currentRepo;
  let usedCache = false;

  // Helper to apply branch data to state and UI
  const applyBranchData = (data, fromCache = false) => {
    state.branches = data.branches;
    state.branchMetadata = data.branchMetadata || null;
    state.defaultBranch = data.current || (data.branches && data.branches[0]) || null;

    // Check if we're in detached HEAD state (current branch is "HEAD" or a commit SHA)
    // But skip detection if we're in the middle of checking out a branch
    const isDetachedHead = !state.isCheckingOutBranch && 
                           (data.current === "HEAD" || 
                           (data.current && data.current.length === 40 && /^[0-9a-f]{40}$/i.test(data.current)) ||
                           (data.current && !data.branches.includes(data.current)));
    
    if (isDetachedHead) {
      // We're in detached HEAD state
      if (!state.detachedHeadCommit) {
        // We don't have commit info yet - fetch it
        // Get the HEAD SHA from data.head (preferred) or data.current if it's a SHA
        let headSha = data.head;
        if (!headSha || headSha.length !== 40) {
          // If data.head is not available or not a SHA, try data.current
          if (data.current && data.current.length === 40 && /^[0-9a-f]{40}$/i.test(data.current)) {
            headSha = data.current;
          }
        }
        
        if (headSha && headSha.length === 40) {
          // We have a valid SHA - fetch commit information asynchronously
          (async () => {
            try {
              // Get commits to find the one matching HEAD
              const commits = await api(`/api/repos/${encodeURIComponent(state.currentRepo)}/commits?branch=${encodeURIComponent(headSha)}&limit=1`);
              if (commits && commits.length > 0) {
                const commit = commits[0];
                state.detachedHeadCommit = {
                  sha: commit.sha,
                  message: commit.message || ""
                };
                updateDetachedHeadStatus();
              } else {
                // Fallback: use the SHA we have
                state.detachedHeadCommit = {
                  sha: headSha,
                  message: ""
                };
                updateDetachedHeadStatus();
              }
            } catch (err) {
              console.error("Failed to fetch detached HEAD commit info:", err);
              // Fallback: use the SHA we have
              state.detachedHeadCommit = {
                sha: headSha,
                message: ""
              };
              updateDetachedHeadStatus();
            }
          })();
        } else {
          // We don't have a SHA yet - try to get it by fetching HEAD commits
          // This can happen if data.head is not set
          (async () => {
            try {
              const commits = await api(`/api/repos/${encodeURIComponent(state.currentRepo)}/commits?branch=HEAD&limit=1`);
              if (commits && commits.length > 0) {
                const commit = commits[0];
                state.detachedHeadCommit = {
                  sha: commit.sha,
                  message: commit.message || ""
                };
                updateDetachedHeadStatus();
              }
            } catch (err) {
              console.error("Failed to fetch detached HEAD commit info from HEAD:", err);
            }
          })();
        }
      } else {
        // We already have commit info - just update status
        updateDetachedHeadStatus();
      }
    } else if (!isDetachedHead && state.detachedHeadCommit) {
      // We're on a branch now, clear detached HEAD state and previous branch
      state.detachedHeadCommit = null;
      state.previousBranch = null;
      updateDetachedHeadStatus();
    }

    // In graph mode, default to "All" if not already set
    if (isGraphMode() && state.currentBranch !== "__ALL__") {
      state.currentBranch = "__ALL__";
    } else if (!state.currentBranch) {
      state.currentBranch = data.current || data.branches[0];
    }

    applyActiveBranchFilter();

    if (branchLabelEl) {
      branchLabelEl.textContent = state.currentBranch ? state.currentBranch : "";
    }

    // Update loading indicator with branch count
    const branchCount = data.branches?.length || 0;
    if (window.loadingProgress && window.loadingProgress.isVisible()) {
      const label = fromCache ? "branches (cached)" : "branches";
      window.loadingProgress.setProgress(branchCount, branchCount, label);
    }

    console.log(`[loadBranches] Applied ${data.branches?.length || 0} branches (fromCache: ${fromCache})`);
  };

  // Helper to manage commit cache state
  const updateCommitCacheState = () => {
    if (state.currentBranch === "__ALL__") {
      if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0 && cachedAllBranchesKey) {
        const parsed = parseCacheKey(cachedAllBranchesKey);
        if (parsed.repo === state.currentRepo) {
          loadedCommitsKey = `${state.currentRepo}:__ALL__:full`;
        } else {
          cachedAllBranchesCommits = null;
          cachedAllBranchesKey = null;
          loadedCommitsKey = null;
        }
      } else {
        loadedCommitsKey = null;
      }
    }
  };

  try {
    // Step 1: Try to load from IndexedDB cache first
    if (window.gitCache) {
      const cachedBranches = await window.gitCache.getBranches(state.currentRepo);
      if (cachedBranches && cachedBranches.branches && cachedBranches.branches.length > 0) {
        console.log(`[loadBranches] Using cached data: ${cachedBranches.branches.length} branches`);
        usedCache = true;

        // Show cached data immediately
        if (window.loadingProgress && window.loadingProgress.isVisible()) {
          window.loadingProgress.setStage(`Loading branches for ${repoName}…`);
        }

        applyBranchData(cachedBranches, true);
        updateCommitCacheState();

        // Start loading commits from cache while we verify freshness
        // Don't await - let it run in parallel with the freshness check
        loadCommits();
      }
    }

    // Step 2: Fetch fresh data from API (always, to check for updates)
    if (!usedCache) {
      if (window.loadingProgress && window.loadingProgress.isVisible()) {
        window.loadingProgress.setStage(`Loading branches for ${repoName}…`);
      } else {
        setStatusMessage("Loading branches…");
      }
    }

    const autoFetch = localStorage.getItem("gitzada:automaticFetches") === "true";
    const apiUrl = `/api/repos/${encodeURIComponent(state.currentRepo)}/branches${autoFetch ? "" : "?auto_fetch=false"}`;
    const freshData = await api(apiUrl);

    // Step 3: Check if cache was valid
    if (usedCache && window.gitCache) {
      const cachedMeta = await window.gitCache.getRepoMeta(state.currentRepo);
      const cacheValid = cachedMeta &&
        cachedMeta.head === freshData.head &&
        cachedMeta.refsHash === freshData.refsHash;

      if (cacheValid) {
        console.log("[loadBranches] Cache is still valid, no update needed");
        // Cache is valid - commits are already loading from cache
        // Just update the progress indicator to remove "(cached)" label
        const branchCount = state.branches?.length || 0;
        if (window.loadingProgress && window.loadingProgress.isVisible()) {
          window.loadingProgress.setProgress(branchCount, branchCount, "branches");
          setTimeout(() => {
            if (window.loadingProgress && window.loadingProgress.isVisible()) {
              window.loadingProgress.setStage("Loading commits…");
              window.loadingProgress.setIndeterminate();
            }
          }, 200);
        }
        setStatus("");
        // Restore detached HEAD message if we're in that state
        if (state.detachedHeadCommit) {
          setTimeout(() => updateDetachedHeadStatus(), 100);
        }
        return; // Don't reload commits - they're already loading
      } else {
        console.log("[loadBranches] Cache is stale, updating with fresh data");
        // Cache is stale - invalidate commit cache too
        await window.gitCache.invalidateRepo(state.currentRepo);
        cachedAllBranchesCommits = null;
        cachedAllBranchesKey = null;
        loadedCommitsKey = null;
      }
    }

    // Step 4: Apply fresh data
    applyBranchData(freshData, false);
    updateCommitCacheState();

    // Step 5: Save to cache
    if (window.gitCache) {
      await window.gitCache.saveRepoMeta(state.currentRepo, {
        head: freshData.head,
        refsHash: freshData.refsHash
      });
      await window.gitCache.saveBranches(state.currentRepo, {
        branches: freshData.branches,
        branchMetadata: freshData.branchMetadata,
        current: freshData.current
      });
    }

    // Brief pause to show branch count, then switch to commits loading
    if (window.loadingProgress && window.loadingProgress.isVisible()) {
      setTimeout(() => {
        if (window.loadingProgress && window.loadingProgress.isVisible()) {
          window.loadingProgress.setStage("Loading commits…");
          window.loadingProgress.setIndeterminate();
        }
      }, 200);
    }

    // Step 6: Load commits (fresh data path)
    if (!usedCache) {
      await loadCommits();
    } else {
      // Cache was stale, reload commits with fresh data
      await loadCommits();
    }

    setStatus("");
  } catch (e) {
    console.error("[loadBranches] Error:", e);
    setStatus(e.message, true);
  }
}

async function loadCommits() {
  if (!state.currentRepo || !state.currentBranch) return;
  
  // Calculate cache key for current repo/branch/mode combination FIRST
  // This allows us to check for cached data before any async operations
  const isAllBranches = state.currentBranch === "__ALL__";
  const mode = isGraphMode() || isAllBranches 
    ? "full" 
    : state.historyMode || "activity";
  const cacheKey = `${state.currentRepo}:${state.currentBranch}:${mode}`;
  
  console.log("[loadCommits] Called with:", {
    repo: state.currentRepo,
    branch: state.currentBranch,
    mode,
    cacheKey,
    isGraphMode: isGraphMode(),
    isAllBranches,
    hasCachedAll: !!cachedAllBranchesCommits,
    cachedAllLength: cachedAllBranchesCommits ? cachedAllBranchesCommits.length : 0,
    cachedAllKey: cachedAllBranchesKey,
    loadedCommitsKey,
    currentCommitsLength: state.commits ? state.commits.length : 0,
    stackTrace: new Error().stack?.split('\n').slice(1, 4).join('\n')
  });

  // Helper: snapshot Activity view state so we can restore it instantly when
  // toggling back from graph views without refetching or re-filtering.
  const snapshotActivityState = () => {
    if (!state.currentRepo || isGraphMode()) return;
    state.lastActivityRepo = state.currentRepo;
    state.lastActivityBranch = state.currentBranch;
    state.lastActivityCommits = state.commits ? state.commits.slice() : [];
    state.lastActivityFilteredCommits = state.filteredCommits ? state.filteredCommits.slice() : [];
    state.lastActivityTotalCommits = state.totalCommits;
  };
  
  // Helper function to display cached data immediately
  const displayCachedData = () => {
    // Clear loading messages immediately
    setStatusMessage(""); // Clear any "Loading commits..." messages
    // Restore detached HEAD message if we're in that state
    if (state.detachedHeadCommit) {
      setTimeout(() => updateDetachedHeadStatus(), 100);
    }
    if (isGraphMode() && window.graphView && window.graphView.setGraphLegendStatus) {
      window.graphView.setGraphLegendStatus("");
    }
    // Hide splash screen since we have data to show
    if (window.loadingProgress && window.loadingProgress.isVisible()) {
      window.loadingProgress.hide();
    }
    // Update filtered commits and render immediately (applyCommitFilter already
    // calls renderCommitList for us)
    applyCommitFilter();
    snapshotActivityState();
  };
  
  // FIRST: Check and display cached data immediately (before any async operations)
  // This ensures users see data instantly if it's already available locally

  // Show loading indicator early - before cache checks that might take time
  // This ensures users see feedback immediately on large repos
  const repoName = state.currentRepo.split(/[/\\]/).pop() || state.currentRepo;
  if (window.loadingProgress && window.loadingProgress.isVisible()) {
    window.loadingProgress.setStage(`Loading commits for ${repoName}…`);
  } else {
    setStatusMessage("Loading commits…");
  }

  // Check IndexedDB cache first (before in-memory cache)
  if (window.gitCache && !loadedCommitsKey) {
    const cachedCommits = await window.gitCache.getCommits(state.currentRepo, state.currentBranch, mode);
    if (cachedCommits && cachedCommits.commits && cachedCommits.commits.length > 0) {
      console.log(`[loadCommits] Using IndexedDB cached data: ${cachedCommits.commits.length} commits`);
      state.commits = cachedCommits.commits;
      state.filteredCommits = state.commits;
      state.totalCommits = cachedCommits.totalCommits || state.commits.length;
      loadedCommitsKey = cacheKey;

      // Also populate in-memory cache for __ALL__ data
      if (isAllBranches) {
        cachedAllBranchesCommits = state.commits.slice();
        cachedAllBranchesKey = cacheKey;
      }

      // Update splash screen progress
      if (window.loadingProgress && window.loadingProgress.isVisible()) {
        window.loadingProgress.setProgress(state.commits.length, state.commits.length, "commits (cached)");
      }

      markCommitsActiveStatus();
      displayCachedData();
      return; // Use cached data, freshness is validated by loadBranches
    }
  }

  // Check if we already have commits loaded for this exact combination (in-memory)
  if (loadedCommitsKey === cacheKey && state.commits && state.commits.length > 0) {
    console.log("Commits already loaded for", cacheKey, "- displaying cached data immediately");
    displayCachedData();
    // Ensure __ALL__ preload is scheduled for graph views even when reusing cache
    // Start immediately (no delay) so it's ready when user toggles to graph view
    if (!isGraphMode() && !isAllBranches && state.commits && state.commits.length > 0) {
      // Mark preload as scheduled so we can wait for it if user toggles to graph view
      isPreloadScheduled = true;
      // Start preload immediately - it's already async so no need to defer
      // Use Promise.resolve().then() to defer just enough to not block, but start immediately
      Promise.resolve().then(() => {
        isPreloadScheduled = false; // Preload is starting now
        preloadAllBranchesCommits().catch((err) => {
          console.warn("Background preload failed:", err);
        });
      });
    }
    return; // No need to fetch, we have the exact data
  }

  // For single-branch views (not "__ALL__"), we can reuse __ALL__ commits and filter by branch
  // BUT ONLY in graph mode - Activity view needs full branch history from single-branch API
  // The cachedAllBranchesCommits only has ~50 commits per branch for graph performance,
  // which is insufficient for Activity view that shows up to 2000 commits per branch.
  if (!isAllBranches && state.currentBranch && state.currentBranch !== "__ALL__") {
    // Only use cached __ALL__ commits for graph mode single-branch views (not Activity view)
    if (isGraphMode() && cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0) {
      const parsed = parseCacheKey(cachedAllBranchesKey);
      if (parsed.repo === state.currentRepo) {
        console.log("Filtering cached __ALL__ commits for", state.currentBranch, "- displaying immediately (graph mode)");
        // Filter __ALL__ commits to only include those on the current branch
        const filteredCommits = cachedAllBranchesCommits.filter(c => {
          // Include commits that are on the current branch
          if (c.branches && Array.isArray(c.branches) && c.branches.length > 0) {
            return c.branches.includes(state.currentBranch);
          }
          // If commit has no branches listed, include it (it's likely on current branch)
          return true;
        });
        state.commits = filteredCommits;
        state.filteredCommits = state.commits;
        state.totalCommits = state.commits.length; // Set total to avoid limit=100000 request
        loadedCommitsKey = cacheKey;
        displayCachedData();
        // Don't schedule preload - we already have __ALL__ cache (that's where we filtered from)
        return; // Have cached data, no need to fetch
      }
    }

    // Fallback: check if we have commits for the same repo/branch (old behavior)
    if (state.commits && state.commits.length > 0 && loadedCommitsKey) {
      const parsedLoaded = parseCacheKey(loadedCommitsKey);
      if (parsedLoaded.repo === state.currentRepo && parsedLoaded.branch === state.currentBranch) {
        console.log("Reusing commits for", state.currentRepo, state.currentBranch, "- displaying cached data immediately");
        // Update cache key to reflect current mode
        loadedCommitsKey = cacheKey;
        displayCachedData();
        // Ensure __ALL__ preload is scheduled for graph views even when reusing cache
        if (!isGraphMode() && !isAllBranches && state.commits && state.commits.length > 0) {
          setTimeout(() => {
            preloadAllBranchesCommits().catch((err) => {
              console.warn("Background preload failed:", err);
            });
          }, 100);
        }
        return; // Mode change doesn't require refetch - commits are the same
      }
    }
  }
  
  // For "__ALL__" branch, check if we have cached commits for it
  // First check the preserved __ALL__ cache (from preload or previous load)
  // This check happens BEFORE any async operations to ensure instant display
  if (isAllBranches && cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0) {
    const parsed = parseCacheKey(cachedAllBranchesKey);
    if (parsed.repo === state.currentRepo) {
      console.log("[loadCommits] Reusing preserved/preloaded __ALL__ commits for", state.currentRepo, "-", cachedAllBranchesCommits.length, "commits - displaying cached data immediately");
      // Restore the __ALL__ commits
      state.commits = cachedAllBranchesCommits;
      state.filteredCommits = state.commits;
      // Update cache key to reflect current mode
      loadedCommitsKey = cacheKey;
      cachedAllBranchesKey = cacheKey;
      displayCachedData();
      return; // Have cached data, no need to fetch
    } else {
      console.log("[loadCommits] Cached __ALL__ commits exist but for different repo:", parsed.repo, "vs", state.currentRepo);
    }
  } else if (isAllBranches) {
    console.log("[loadCommits] No cached __ALL__ commits found - will fetch from API. cachedAllBranchesCommits:", cachedAllBranchesCommits ? cachedAllBranchesCommits.length : "null");
  }
  
  // Also check if current commits are for __ALL__
  if (isAllBranches && state.commits && state.commits.length > 0 && loadedCommitsKey) {
    const parsedLoaded = parseCacheKey(loadedCommitsKey);
    // Check if we have "__ALL__" commits cached for this repo
    if (parsedLoaded.repo === state.currentRepo && parsedLoaded.branch === "__ALL__") {
      console.log("Reusing __ALL__ commits for", state.currentRepo, "- displaying cached data immediately");
      // Preserve these commits
      cachedAllBranchesCommits = [...state.commits];
      cachedAllBranchesKey = cacheKey;
      // Update cache key to reflect current mode
      loadedCommitsKey = cacheKey;
      displayCachedData();
      return; // Have cached data, no need to fetch
    }
  }
  
  // NOW: Prevent concurrent fetch requests - ONLY ONE fetch should run at a time
  // But we've already displayed cached data above, so this is just for the fetch
  if (isLoadingCommits) {
    console.warn("Commit fetch already in progress, cached data already displayed if available");
    return;
  }
  
  // If we're loading __ALL__ for graph mode and preload is scheduled/in-progress, wait for it
  if (isAllBranches && isGraphMode() && (isPreloadScheduled || isPreloadingAllBranches) && !cachedAllBranchesCommits) {
    console.log("Preload is scheduled/in-progress for __ALL__, waiting for it instead of starting new fetch...");
    // Wait up to 1000ms for preload to complete
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0) {
        const parsed = parseCacheKey(cachedAllBranchesKey);
        if (parsed.repo === state.currentRepo) {
          // Preload completed! Use the cached data
          state.commits = cachedAllBranchesCommits.slice();
          state.filteredCommits = state.commits;
          loadedCommitsKey = cacheKey;
          cachedAllBranchesKey = cacheKey;
          displayCachedData();
          return; // Use cached data, don't fetch
        }
      }
      // If preload is no longer scheduled or in progress, it finished (success or failure)
      if (!isPreloadScheduled && !isPreloadingAllBranches) {
        break; // Preload finished, continue to fetch if needed
      }
    }
  }
  
  // Final defensive check: if we're loading __ALL__ for graph mode, check cache ONE MORE TIME
  // This catches any race conditions where cache was set between earlier checks and now
  if (isAllBranches && isGraphMode() && cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0 && cachedAllBranchesKey) {
    const parsed = parseCacheKey(cachedAllBranchesKey);
    if (parsed.repo === state.currentRepo) {
      console.log("[loadCommits] ✓ Final defensive check: Found cached __ALL__ commits, using them instead of fetching");
      state.commits = cachedAllBranchesCommits.slice();
      state.filteredCommits = state.commits;
      loadedCommitsKey = cacheKey;
      cachedAllBranchesKey = cacheKey;
      displayCachedData();
      return; // Don't fetch, we have the data
    }
  }
  
  // Set loading flag IMMEDIATELY to prevent other calls from starting
  // This must happen before any async operations or early returns
  isLoadingCommits = true;
  
  // Generate a unique request ID for this fetch operation to prevent race conditions
  const requestId = Date.now() + Math.random();
  
  // Immediately invalidate any previous request and set new request ID atomically
  // This ensures only the current operation can update the status message
  // Any updates from previous/abandoned requests will be ignored
  const previousRequestId = currentLoadRequestId;
  currentLoadRequestId = requestId;

  // Unified loading message for all views, shown as soon as a real fetch starts.
  const isAllBranchesGraph = isAllBranches && isGraphMode();
  const loadingMsg = isAllBranchesGraph
    ? `Loading commits from all branches…`
    : "Loading commits…";
  setStatusMessage(loadingMsg, requestId);
  
  try {
    // Update commit count display during loading (will show 0/0 initially, then increment)
    updateCommitCountDisplay();
    
    // Special handling: in graph mode with "All" selected.
    if (isAllBranches && isGraphMode()) {
      const combined = new Map(); // sha -> commit with merged branches
      const allBranches = Array.isArray(state.branches) ? state.branches : [];
      
      // Edge case: empty branches array
      if (allBranches.length === 0) {
        setStatus("No branches found", true);
        state.commits = [];
        applyCommitFilter();
        return;
      }

      const branches = getBranchesForAllGraphMode(
        allBranches,
        state.defaultBranch,
        state.currentBranch
      );

      const totalBranches = branches.length;
      const visibleBranchCap = allBranches.length > totalBranches ? { totalBranches, allBranches: allBranches.length } : null;

      // Calculate per-branch limit (clamped by user seek depth and GRAPH_BRANCH_HISTORY_LIMIT)
    const branchCountForLimit = Math.max(branches.length, 1);
      let perBranchLimit = Math.max(
        GRAPH_VIEW_MIN_PER_BRANCH,
        Math.floor((state.globalCommitCap || getGlobalCommitCap()) / branchCountForLimit)
      );
      // First apply user-configurable seek depth, then enforce global safety cap.
      perBranchLimit = Math.min(perBranchLimit, state.seekDepthPerBranch || getSeekDepthPerBranch());
      perBranchLimit = Math.min(perBranchLimit, GRAPH_BRANCH_HISTORY_LIMIT);

      let loadedBranches = 0;
      let failedBranches = 0;

      // First, try the backend aggregation endpoint for all-branches graph mode.
      // Abort any previous in-flight aggregation request before starting a new one.
      if (currentCommitsAllBranchesController) {
        try {
          currentCommitsAllBranchesController.abort();
        } catch (e) {
          console.warn("Error aborting previous all-branches controller:", e);
        }
      }
      currentCommitsAllBranchesController = new AbortController();

      try {
        const aggregated = await api(
          "/api/repos/" +
            encodeURIComponent(state.currentRepo) +
            "/commits-all-branches?limit=" +
            (state.globalCommitCap || getGlobalCommitCap()),
          { signal: currentCommitsAllBranchesController.signal }
        );

        if (currentLoadRequestId !== requestId) {
          // This request is no longer current; ignore its results.
          isLoadingCommits = false;
          return;
        }

        const commits = Array.isArray(aggregated)
          ? aggregated
          : aggregated && aggregated.commits
          ? aggregated.commits
          : [];

        let allCommits = commits.slice();
        // Backend should already cap/sort, but ensure newest-first ordering here.
        allCommits.sort((a, b) => {
          const da = a.date ? new Date(a.date).getTime() : 0;
          const db = b.date ? new Date(b.date).getTime() : 0;
          return db - da;
        });

        const originalCount = allCommits.length;
        let wasTruncated = false;
        const globalCap = state.globalCommitCap || getGlobalCommitCap();
        if (allCommits.length > globalCap) {
          allCommits = allCommits.slice(0, globalCap);
          wasTruncated = true;
        }

        state.commits = allCommits;
        markCommitsActiveStatus(); // Mark commits for Activity view
        applyCommitFilter(); // Ensure filteredCommits is set correctly
        loadedCommitsKey = cacheKey;
        cachedAllBranchesCommits = allCommits.slice();
        cachedAllBranchesKey = cacheKey;

        // Save to IndexedDB cache
        if (window.gitCache) {
          window.gitCache.saveCommits(state.currentRepo, state.currentBranch, mode, {
            commits: allCommits,
            totalCommits: allCommits.length
          }).catch(err => console.warn("[loadCommits] Failed to save to cache:", err));
        }

        // Update splash screen progress with commit count
        if (window.loadingProgress && window.loadingProgress.isVisible()) {
          window.loadingProgress.setProgress(allCommits.length, allCommits.length, "commits");
        }
        updateCommitCountDisplay();

        if (isGraphMode() && window.graphView && window.graphView.setGraphLegendStatus) {
          if (wasTruncated) {
            const limitMsg = `Showing ${globalCap} most recent commits. Older commits hidden.`;
            window.graphView.setGraphLegendStatus(limitMsg);
          } else if (visibleBranchCap) {
            window.graphView.setGraphLegendStatus(
              `Showing branches ${visibleBranchCap.totalBranches}/${visibleBranchCap.allBranches} in graph (oldest branches omitted).`
            );
          } else {
            window.graphView.setGraphLegendStatus("");
          }
        }

        // Clear request ID, loading flag, and controller
        if (currentLoadRequestId === requestId) {
          currentLoadRequestId = null;
        }
        isLoadingCommits = false;
        currentCommitsAllBranchesController = null;
        
        // Clear loading status message - commits are now loaded
        setStatusMessage("");
        
        // Render the graph immediately after loading commits
        // This ensures the graph is rendered with all branch information
        renderCommitList();
        return;
      } catch (e) {
        // If this was an intentional abort (e.g., repo changed or a new request started),
        // stop here without falling back to per-branch loading.
        if (e.name === "AbortError") {
          console.warn("All-branches aggregation request aborted:", e);
          if (currentLoadRequestId === requestId) {
            currentLoadRequestId = null;
          }
          isLoadingCommits = false;
          currentCommitsAllBranchesController = null;
          return;
        }
        console.warn("All-branches aggregation endpoint failed, falling back to per-branch fetch:", e);
        // Fall through to per-branch path below.
      }

      const totalBranchesForStatus = allBranches.length;

      // Show initial progress message when starting to load branches
      setStatusMessage(`Loading branches: 0/${branches.length}...`, requestId);

      // Bounded-parallel per-branch loading with progress feedback.
      const workerCount = Math.min(
        GRAPH_VIEW_MAX_BRANCHES_PARALLEL,
        Math.max(branches.length, 1)
      );

      const runWorker = async () => {
        while (true) {
          if (currentLoadRequestId !== requestId) {
            // Request was superseded; stop doing work.
            return;
          }

          const nextIndex = loadedBranches + failedBranches;
          if (nextIndex >= branches.length) {
            return;
          }

          const branchName = branches[nextIndex];

          try {
            // Use "local" mode to restrict history to this branch with limit
            const resp = await api(
              "/api/repos/" +
                encodeURIComponent(state.currentRepo) +
                "/commits?branch=" +
                encodeURIComponent(branchName) +
                "&mode=local" +
                "&limit=" + perBranchLimit
            );

            const commitsForBranch = Array.isArray(resp)
              ? resp
              : resp && resp.commits
              ? resp.commits
              : [];

            for (const c of commitsForBranch) {
              const existing = combined.get(c.sha);
              if (existing) {
                const merged = new Set([
                  ...(existing.branches || []),
                  ...(c.branches || []),
                  branchName,
                ]);
                existing.branches = Array.from(merged);
              } else {
                const copy = { ...c };
                const merged = new Set([...(copy.branches || []), branchName]);
                copy.branches = Array.from(merged);
                combined.set(copy.sha, copy);
              }
            }
            loadedBranches++;
          } catch (e) {
            failedBranches++;
            console.warn("Error loading commits for branch", branchName, e);
          }

          // Update commit count display in real-time as commits are loaded
          state.commits = Array.from(combined.values());
          markCommitsActiveStatus(); // Mark commits for Activity view
          state.filteredCommits = state.commits;
          updateCommitCountDisplay();

          // Update progress after loading each branch
          const progressMsgAfter = `Loading branches: ${loadedBranches + failedBranches}/${branches.length}...`;
          setStatusMessage(progressMsgAfter, requestId);

          // Update splash screen progress with branch count and commit count
          if (window.loadingProgress && window.loadingProgress.isVisible()) {
            const commitCount = state.commits.length.toLocaleString();
            window.loadingProgress.setProgress(loadedBranches + failedBranches, branches.length, `branches`);
            if (window.loadingProgress.progressEl) {
              window.loadingProgress.progressEl.textContent = `${loadedBranches + failedBranches} / ${branches.length} branches · ${commitCount} commits`;
            }
          }
        }
      };

      const workers = [];
      for (let i = 0; i < workerCount; i++) {
        workers.push(runWorker());
      }
      await Promise.all(workers);

      // Show final commit count before sorting
      const totalCommitsBeforeSort = combined.size;
      // Clear the "Loading branches" message - final count will be shown via commit count display
      setStatusMessage("", requestId); // Clear branch loading message
      
      // Sort commits by date (newest first)
      let allCommits = Array.from(combined.values()).sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da; // newest first
      });
      
      // Check if we need to truncate
      const originalCount = allCommits.length;
      let wasTruncated = false;
      const globalCap = state.globalCommitCap || getGlobalCommitCap();
      if (allCommits.length > globalCap) {
        allCommits = allCommits.slice(0, globalCap);
        wasTruncated = true;
      }
      
      state.commits = allCommits;
      state.filteredCommits = state.commits;
      
      // Update commit count display
      updateCommitCountDisplay();
      
      // Show appropriate status messages
      if (isGraphMode() && window.graphView && window.graphView.setGraphLegendStatus) {
        // Show in legend for graph view
        if (failedBranches > 0 && loadedBranches === 0) {
          window.graphView.setGraphLegendStatus(`Failed to load commits from all ${totalBranchesForStatus} branches`);
        } else if (failedBranches > 0) {
          window.graphView.setGraphLegendStatus(`Loaded commits from ${loadedBranches} of ${totalBranchesForStatus} branches. Some branches may be unavailable.`);
        } else if (wasTruncated) {
          const limitMsg = `Showing ${globalCap} most recent commits. ${originalCount - globalCap}+ older commits hidden.`;
          window.graphView.setGraphLegendStatus(limitMsg);
        } else if (visibleBranchCap) {
          window.graphView.setGraphLegendStatus(
            `Showing branches ${visibleBranchCap.totalBranches}/${visibleBranchCap.allBranches} in graph (oldest branches omitted).`
          );
        } else {
          window.graphView.setGraphLegendStatus("");
        }
      } else {
        // Show in status bar for non-graph views
        if (failedBranches > 0 && loadedBranches === 0) {
          setStatus(`Failed to load commits from all ${totalBranchesForStatus} branches`, true);
        } else if (failedBranches > 0) {
          setStatus(`Loaded commits from ${loadedBranches} of ${totalBranchesForStatus} branches. Some branches may be unavailable.`, false);
        } else if (wasTruncated) {
          showGraphLimitNotification(originalCount, globalCap, true);
        } else {
          setStatus("");
        }
      }
    } else {
      // Normal path: single-branch or non-graph modes
      // Use "full" mode for graph view, otherwise use historyMode
      const mode =
        isGraphMode() || isAllBranches
          ? "full"
          : state.historyMode || "activity";
      const branchParam = isAllBranches ? "HEAD" : state.currentBranch;
      
      // Add limit for "All" mode in graph view.
      // For Activity view, reuse the global commit cap so the loaded count
      // in the commits pill matches the user's configured limit.
      const defaultLimit = state.globalCommitCap || getGlobalCommitCap();
      const limitParam = (isAllBranches && isGraphMode()) 
        ? `&limit=${state.globalCommitCap || getGlobalCommitCap()}` 
        : `&limit=${defaultLimit}`;
      const loadingMsg = (isAllBranches && isGraphMode())
        ? `Loading commits (limited to ${state.globalCommitCap || getGlobalCommitCap()} for performance)...`
        : "Loading commits...";
      // Show loading message in statusMessage
      setStatusMessage(loadingMsg);

      const response = await api(
        "/api/repos/" +
          encodeURIComponent(state.currentRepo) +
          "/commits?branch=" +
          encodeURIComponent(branchParam) +
          "&mode=" +
          encodeURIComponent(mode) +
          limitParam
      );

      if (Array.isArray(response)) {
        // Update commits incrementally to show real-time count
        state.commits = response;
        markCommitsActiveStatus(); // Mark commits for Activity view
        state.filteredCommits = state.commits;
        // Update splash screen progress with commit count
        if (window.loadingProgress && window.loadingProgress.isVisible()) {
          window.loadingProgress.setProgress(response.length, response.length, "commits");
        }
        updateCommitCountDisplay();
        
        // For Activity view, determine total count
        if (!isGraphMode()) {
          if (response.length < defaultLimit) {
            // We got all commits
            state.totalCommits = response.length;
          } else {
            // We hit the limit, need to get total count
            // Only make the expensive request if we don't already have a cached total
            // If we're filtering from __ALL__ cache, we can use that count instead
            if (state.totalCommits && state.totalCommits > 0) {
              // Already have total from cache, use it
              console.log("[loadCommits] Using cached totalCommits:", state.totalCommits);
            } else {
              // Make a call with a very high limit to get the actual total
              try {
                const totalResponse = await api(
                  "/api/repos/" +
                    encodeURIComponent(state.currentRepo) +
                    "/commits?branch=" +
                    encodeURIComponent(branchParam) +
                    "&mode=" +
                    encodeURIComponent(mode) +
                    "&limit=100000"
                );
                if (Array.isArray(totalResponse)) {
                  state.totalCommits = totalResponse.length;
                } else {
                  // Fallback: if we can't get total, use loaded count
                  state.totalCommits = response.length;
                }
              } catch (e) {
                // If we can't get total, use loaded count
                state.totalCommits = response.length;
              }
            }
            // Update display again with total count
            updateCommitCountDisplay();
          }
        } else {
          // Graph mode: total is just the loaded count
          state.totalCommits = response.length;
        }
        
        // Check if limit was hit (commit count is shown in pill, no need for status message)
        if (isAllBranches && isGraphMode() && response.length >= (state.globalCommitCap || getGlobalCommitCap())) {
          showGraphLimitNotification(response.length, state.globalCommitCap || getGlobalCommitCap(), true);
        }

        // Save to IndexedDB cache
        if (window.gitCache) {
          window.gitCache.saveCommits(state.currentRepo, state.currentBranch, mode, {
            commits: response,
            totalCommits: state.totalCommits
          }).catch(err => console.warn("[loadCommits] Failed to save to cache:", err));
        }
      } else if (response.commits) {
        // Update commits incrementally to show real-time count
        state.commits = response.commits;
        markCommitsActiveStatus(); // Mark commits for Activity view
        state.filteredCommits = state.commits;
        state.branchHierarchy = response.branchHierarchy || [];
        state.branchAngles = response.branchAngles || {};
        // Update splash screen progress with commit count
        if (window.loadingProgress && window.loadingProgress.isVisible()) {
          window.loadingProgress.setProgress(response.commits.length, response.commits.length, "commits");
        }
        updateCommitCountDisplay();
        
        // For Activity view, determine total count (similar logic as above)
        if (!isGraphMode()) {
          if (response.commits.length < defaultLimit) {
            state.totalCommits = response.commits.length;
          } else {
            try {
              const totalResponse = await api(
                "/api/repos/" +
                  encodeURIComponent(state.currentRepo) +
                  "/commits?branch=" +
                  encodeURIComponent(branchParam) +
                  "&mode=" +
                  encodeURIComponent(mode) +
                  "&limit=100000"
              );
              if (totalResponse.commits && Array.isArray(totalResponse.commits)) {
                state.totalCommits = totalResponse.commits.length;
              } else if (Array.isArray(totalResponse)) {
                state.totalCommits = totalResponse.length;
              } else {
                state.totalCommits = response.commits.length;
              }
            } catch (e) {
              state.totalCommits = response.commits.length;
            }
            // Update display again with total count
            updateCommitCountDisplay();
          }
        } else {
          state.totalCommits = response.commits.length;
        }
        
        // Check if limit was hit (commit count is shown in pill, no need for status message)
        if (isAllBranches && isGraphMode() && response.commits.length >= (state.globalCommitCap || getGlobalCommitCap())) {
          showGraphLimitNotification(response.commits.length, state.globalCommitCap || getGlobalCommitCap(), true);
        }

        // Save to IndexedDB cache
        if (window.gitCache) {
          window.gitCache.saveCommits(state.currentRepo, state.currentBranch, mode, {
            commits: response.commits,
            totalCommits: state.totalCommits
          }).catch(err => console.warn("[loadCommits] Failed to save to cache:", err));
        }
      } else {
        state.commits = [];
        setStatus("No commits found. Check repository and branch selection.", false);
      }
    }
    
    // Update cache key after successful fetch
    loadedCommitsKey = cacheKey;
    
    // If we just loaded __ALL__ commits, preserve them separately
    if (isAllBranches && state.commits && state.commits.length > 0) {
      cachedAllBranchesCommits = [...state.commits];
      cachedAllBranchesKey = cacheKey;
      console.log("Preserved __ALL__ commits for", state.currentRepo, "-", state.commits.length, "commits");
    }
    
    applyCommitFilter();
    // Snapshot Activity view so we can restore it instantly when toggling back
    // from graph modes without refetching or re-filtering.
    if (!isGraphMode()) {
      state.lastActivityRepo = state.currentRepo;
      state.lastActivityBranch = state.currentBranch;
      state.lastActivityCommits = state.commits ? state.commits.slice() : [];
      state.lastActivityFilteredCommits = state.filteredCommits ? state.filteredCommits.slice() : [];
      state.lastActivityTotalCommits = state.totalCommits;
    }
    
    // Clear loading status message - commits are now loaded and displayed
    setStatusMessage("");
    
    // Clear request ID on successful completion
    if (currentLoadRequestId === requestId) {
      currentLoadRequestId = null;
    }
  } catch (e) {
    console.error("Error loading commits:", e);
    // Clear request ID on error
    if (currentLoadRequestId === requestId) {
      currentLoadRequestId = null;
    }
    // Enhanced error messages
    if (e.message && e.message.includes("timeout")) {
      setStatus("Request timed out. The repository may be too large. Try selecting a specific branch.", true);
    } else if (e.message && e.message.includes("Failed to fetch")) {
      setStatus("Network error. Please check your connection and try again.", true);
    } else {
      setStatus(e.message || "Error loading commits", true);
    }
    // Don't update cache key on error
  } finally {
    isLoadingCommits = false;

    // Hide splash screen now that commits are loaded
    if (window.loadingProgress && window.loadingProgress.isVisible()) {
      window.loadingProgress.hide();
    }

    // Trigger background preload of __ALL__ commits if we're in Activity view
    // This ensures graph views are ready when user switches to them
    // Do this AFTER isLoadingCommits is set to false so preload can run.
    // IMPORTANT: if we already have cached __ALL__ commits for this repo, do NOT
    // schedule another preload – that would trigger an unnecessary
    // /commits-all-branches request when toggling between views.
    const parsedCacheKey = parseCacheKey(cachedAllBranchesKey);
    const hasCachedAllForCurrentRepo =
      !!cachedAllBranchesCommits &&
      cachedAllBranchesCommits.length > 0 &&
      parsedCacheKey.repo === state.currentRepo;
    const shouldPreload =
      !isGraphMode() &&
      !isAllBranches &&
      state.commits &&
      state.commits.length > 0 &&
      !hasCachedAllForCurrentRepo;
    console.log("Checking if preload should trigger:", {
      isGraphMode: isGraphMode(),
      isAllBranches,
      currentBranch: state.currentBranch,
      hasCommits: state.commits && state.commits.length > 0,
      commitsLength: state.commits ? state.commits.length : 0,
      hasCachedAllForCurrentRepo,
      shouldPreload
    });
    
    if (shouldPreload) {
      // Mark preload as scheduled so we can wait for it if user toggles to graph view
      isPreloadScheduled = true;
      // Start preload immediately - it's already async so no need to defer
      // Use Promise.resolve().then() to defer just enough to not block, but start immediately
      Promise.resolve().then(() => {
        isPreloadScheduled = false; // Preload is starting now
        // Double-check conditions (repo might have changed)
        if (!state.currentRepo || isGraphMode() || state.currentBranch === "__ALL__") {
          console.log("Preload cancelled - conditions changed:", {
            hasRepo: !!state.currentRepo,
            isGraphMode: isGraphMode(),
            currentBranch: state.currentBranch
          });
          return;
        }
        
        // Re-check cache state using the latest key; another path may have
        // populated cachedAllBranchesCommits while this microtask was queued.
        const latestParsed = parseCacheKey(cachedAllBranchesKey);
        const hasCachedAllNow =
          !!cachedAllBranchesCommits &&
          cachedAllBranchesCommits.length > 0 &&
          latestParsed.repo === state.currentRepo;
        console.log("Preload check (post-microtask) - hasCachedAllNow:", hasCachedAllNow, "cachedKey:", cachedAllBranchesKey);
        if (!hasCachedAllNow) {
          // No cached __ALL__ commits for this repo – trigger preload once.
          console.log("No cached __ALL__ commits for current repo, triggering preload");
          preloadAllBranchesCommits().catch(err => {
            console.warn("Background preload failed:", err);
          });
        } else {
          console.log("Already have cached __ALL__ commits for current repo, skipping preload");
        }
      });
    }
  }
}

// Background preload function for __ALL__ commits
async function preloadAllBranchesCommits() {
  // Don't preload if already in progress
  if (isPreloadingAllBranches) {
    console.log("Preload already in progress, skipping");
    return;
  }
  
  // Don't preload if we don't have repo/branch info
  if (!state.currentRepo) {
    console.log("No repo selected, skipping preload");
    return;
  }
  
  // Check if we already have cached __ALL__ commits for this repo
  if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0) {
    const parsed = parseCacheKey(cachedAllBranchesKey);
    if (parsed.repo === state.currentRepo) {
      // Already have cached commits for this repo
      console.log("Already have cached __ALL__ commits for", state.currentRepo, "- skipping preload");
      return;
    }
  }
  
  // Don't preload if we're in graph mode (normal load will handle it)
  if (isGraphMode()) {
    console.log("In graph mode, skipping preload");
    // Don't hide splash here - loadCommits will handle it when commits-all-branches completes
    return;
  }
  
  // Don't preload if we're already loading commits (but allow a small delay)
  if (isLoadingCommits) {
    console.log("Commits loading in progress, skipping preload");
    // Don't hide splash here - loadCommits will handle it when commits-all-branches completes
    return;
  }
  
  console.log("Starting background preload of __ALL__ commits for", state.currentRepo);
  isPreloadingAllBranches = true;
  
  // Show status message for commits-all-branches fetch (visible in all 3 views)
  setStatusMessage("Loading commits from all branches…");
  
  try {
    const globalCap = state.globalCommitCap || getGlobalCommitCap();

    // First, try the aggregated all-branches endpoint for this repo.
    // This is much faster than walking each branch individually.
    try {
      const aggregated = await api(
        "/api/repos/" +
          encodeURIComponent(state.currentRepo) +
          "/commits-all-branches?limit=" +
          globalCap
      );

      const commits = Array.isArray(aggregated)
        ? aggregated
        : aggregated && aggregated.commits
        ? aggregated.commits
        : [];

      let allCommits = commits.slice();
      // Ensure newest-first ordering.
      allCommits.sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      });

      // Respect global cap.
      if (allCommits.length > globalCap) {
        allCommits = allCommits.slice(0, globalCap);
      }

      cachedAllBranchesCommits = allCommits;
      cachedAllBranchesKey = `${state.currentRepo}:__ALL__:full`;

      console.log(
        "[Preload] ✓ Background preload (aggregated) complete:",
        allCommits.length,
        "commits cached for",
        state.currentRepo,
        "cacheKey:",
        cachedAllBranchesKey
      );
      console.log("[Preload] Cache set - cachedAllBranchesCommits.length:", cachedAllBranchesCommits.length, "cachedAllBranchesKey:", cachedAllBranchesKey);

      // If we're in graph mode and showing single-branch data, upgrade to full __ALL__ data
      if (isGraphMode() && state.currentBranch === "__ALL__" && state.commits && state.commits.length > 0) {
        const parsed = parseCacheKey(cachedAllBranchesKey);
        if (parsed.repo === state.currentRepo) {
          // Upgrade to full __ALL__ data
          state.commits = allCommits.slice();
          state.filteredCommits = state.commits;
          loadedCommitsKey = cachedAllBranchesKey;
          setStatusMessage("");
          renderCommitList();
          console.log("Upgraded graph view to full __ALL__ commits from preload");
        }
      } else {
        // Clear the status message when preload completes (aggregated endpoint path)
        setStatusMessage("");
      }
      // Otherwise, do not touch state.commits; Activity view continues to show its branch view.
      isPreloadingAllBranches = false;
      return;
    } catch (e) {
      console.warn(
        "Preload: aggregated /commits-all-branches endpoint failed, falling back to per-branch preload:",
        e
      );
    }

    // Fallback path: walk branches individually (previous behavior).
    const allBranches = Array.isArray(state.branches) ? state.branches : [];
    
    // Edge case: empty branches array
    if (allBranches.length === 0) {
      console.log("No branches available for preload");
      setStatusMessage("");
      isPreloadingAllBranches = false;
      return;
    }
    
    const branches = getBranchesForAllGraphMode(
      allBranches,
      state.defaultBranch,
      state.currentBranch
    );

    console.log("Preload starting for", branches.length, "branches (of", allBranches.length, "total)");
    
    // Store original repo to verify we're still on the same repo when done
    const originalRepo = state.currentRepo;
    
    // Calculate per-branch limit (clamped by user seek depth and GRAPH_BRANCH_HISTORY_LIMIT)
    const branchCountForLimit = Math.max(branches.length, 1);
    let perBranchLimit = Math.max(
      GRAPH_VIEW_MIN_PER_BRANCH,
      Math.floor((state.globalCommitCap || getGlobalCommitCap()) / branchCountForLimit)
    );
    perBranchLimit = Math.min(perBranchLimit, state.seekDepthPerBranch || getSeekDepthPerBranch());
    perBranchLimit = Math.min(perBranchLimit, GRAPH_BRANCH_HISTORY_LIMIT);
    
    const combined = new Map(); // sha -> commit with merged branches
    let loadedBranches = 0;
    let failedBranches = 0;
    const totalBranches = branches.length;
    
    // Preload is a background operation - don't update status message
    // Only active loadCommits() should manage the status message
    // This prevents conflicts when user toggles views
    
    // Process branches silently (no status updates) with bounded parallelism
    const workerCount = Math.min(
      GRAPH_VIEW_MAX_BRANCHES_PARALLEL,
      Math.max(branches.length, 1)
    );

    let processedBranches = 0;

    const runWorker = async () => {
      while (true) {
        if (state.currentRepo !== originalRepo) {
          // Repo changed, abort preload
          return;
        }

        const idx = processedBranches;
        if (idx >= branches.length) return;
        processedBranches++;

        const branchName = branches[idx];
        
        try {
          // Use "local" mode to restrict history to this branch with limit
          const resp = await api(
            "/api/repos/" +
              encodeURIComponent(state.currentRepo) +
              "/commits?branch=" +
              encodeURIComponent(branchName) +
              "&mode=local" +
              "&limit=" + perBranchLimit
          );
          
          const commitsForBranch = Array.isArray(resp)
            ? resp
            : resp && resp.commits
            ? resp.commits
            : [];
          
          for (const c of commitsForBranch) {
            const existing = combined.get(c.sha);
            if (existing) {
              const merged = new Set([
                ...(existing.branches || []),
                ...(c.branches || []),
                branchName,
              ]);
              existing.branches = Array.from(merged);
            } else {
              const copy = { ...c };
              const merged = new Set([...(copy.branches || []), branchName]);
              copy.branches = Array.from(merged);
              combined.set(copy.sha, copy);
            }
          }
          loadedBranches++;
        } catch (e) {
          failedBranches++;
          console.warn("Background preload: Error loading commits for branch", branchName, e);
          // Continue with other branches
          // Don't update status message - preload is silent
        }
      }
    };

    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(runWorker());
    }
    await Promise.all(workers);
    
    // Verify repo hasn't changed before saving cache
    if (state.currentRepo !== originalRepo) {
      console.log("Repo changed during preload, aborting");
      setStatusMessage("");
      isPreloadingAllBranches = false;
      return;
    }
    
    // Sort commits by date (newest first)
    let allCommits = Array.from(combined.values()).sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da; // newest first
    });
    
    // Check if we need to truncate (respect user global cap, then hard safety cap)
    // Reuse globalCap declared at the top of the function
    if (allCommits.length > globalCap) {
      allCommits = allCommits.slice(0, globalCap);
    }
    
    // Store in cache
    cachedAllBranchesCommits = allCommits;
    cachedAllBranchesKey = `${state.currentRepo}:__ALL__:full`;
    
    // If we're in graph mode and showing single-branch data, upgrade to full __ALL__ data
    if (isGraphMode() && state.currentBranch === "__ALL__" && state.commits && state.commits.length > 0) {
      const parsed = parseCacheKey(cachedAllBranchesKey);
      if (parsed.repo === state.currentRepo) {
        // Upgrade to full __ALL__ data
        state.commits = allCommits.slice();
        state.filteredCommits = state.commits;
        loadedCommitsKey = cachedAllBranchesKey;
        setStatusMessage("");
        renderCommitList();
        console.log("Upgraded graph view to full __ALL__ commits from preload (per-branch path)");
      }
    } else {
      // Clear the floating message when preload completes (only if not upgrading)
      setStatusMessage("");
    }
    
    console.log("Background preload complete:", allCommits.length, "commits cached for", state.currentRepo, "from", loadedBranches, "branches");
  } catch (e) {
    // Silently fail - don't show error messages for background preload
    console.warn("Background preload failed:", e);
    // Clear status message even on error
    setStatusMessage("");
  } finally {
    isPreloadingAllBranches = false;
    isPreloadScheduled = false; // Clear scheduled flag when preload finishes
  }
}

function updateCommitCountDisplay() {
  // Update commit count pill only (not status bar)
  if (commitCountEl) {
    const loaded = state.commits.length;
    const visible = state.filteredCommits.length;
    const total = state.totalCommits !== null ? state.totalCommits : loaded;
    
    if (!isGraphMode()) {
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
  if (!activeOnly || !state.branchMetadata) {
    return true; // If Active Only is off, all commits are considered active
  }
  
  // Get list of active branches
  const activeBranches = new Set(
    state.branches.filter(branchName => {
      const metadata = state.branchMetadata[branchName];
      return isBranchActive(branchName, metadata);
    })
  );
  
  // If commit has branches listed, check if any are active
  if (commit.branches && commit.branches.length > 0) {
    return commit.branches.some(branch => activeBranches.has(branch));
  }
  
  // If commit has no branches listed, check if current branch is active
  // In Activity view, commits without branches are typically on the current branch
  if (state.currentBranch && state.currentBranch !== "__ALL__") {
    return activeBranches.has(state.currentBranch);
  }
  
  // If no current branch or it's __ALL__, consider it active (orphaned or unknown)
  return true;
}

// Helper function to mark all commits with their active status (for Activity view)
function markCommitsActiveStatus() {
  const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
  const isActivityView = state.historyMode === "activity";
  
  if (activeOnly && isActivityView && state.commits) {
    state.commits.forEach(c => {
      c._isActive = isCommitOnActiveBranch(c);
    });
  }
}

function applyCommitFilter() {
  const q = (searchInput.value || "").toLowerCase();
  const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";

  // By default, start from all loaded commits
  let commitsToFilter = state.commits;

  // When Active Only is enabled, filter to only commits on active branches
  if (activeOnly && state.branchMetadata) {
    // Mark all commits with active status first
    markCommitsActiveStatus();
    // Then filter to only active commits
    commitsToFilter = state.commits.filter(c => isCommitOnActiveBranch(c));
  }

  // Then apply search filter if present
  if (!q) {
    state.filteredCommits = commitsToFilter;
  } else {
    state.filteredCommits = commitsToFilter.filter(c =>
      c.message.toLowerCase().includes(q) ||
      c.author.toLowerCase().includes(q)
    );
  }
  updateCommitCountDisplay();
  renderCommitList();
}

function getGraphSymbol(commit, index, allCommits) {
  if (state.historyMode !== "full") return "";
  // Simple graph visualization: | for main line, \ for merge, / for branch
  if (commit.isMerge) return "\\";
  if (commit.isHead || commit.isMain) return "|";
  // Check if this commit is on a different branch path
  const nextCommit = allCommits[index + 1];
  if (nextCommit && nextCommit.parents && nextCommit.parents.length > 0) {
    if (nextCommit.parents[0] === commit.sha) return "|";
  }
  return "|";
}

function getCommitFadeClass(commit) {
  // Apply fading for merged branches in compact mode
  if (commit.isHead || commit.isMain) return "";
  // Fade commits that are on merged branches (not current or main)
  const isOnCurrentBranch = commit.branches && Array.isArray(commit.branches) && commit.branches.some(b => b === state.currentBranch);
  const isOnMainBranch = commit.isMain || (commit.branches && Array.isArray(commit.branches) && (commit.branches.includes("main") || commit.branches.includes("master")));
  if (!isOnCurrentBranch && !isOnMainBranch && commit.branches && Array.isArray(commit.branches) && commit.branches.length > 0) {
    return "faded-more";
  }
  return "";
}

// formatMonthHeader and getMonthKey are now loaded from utils.js module

function renderNeoCommits() {
  // Create or get NEO container - place it in the layout area
  let neoContainer = document.getElementById("neoContainer");
  const layout = document.querySelector(".layout");
  
  if (!neoContainer) {
    neoContainer = document.createElement("div");
    neoContainer.id = "neoContainer";
    neoContainer.style.cssText = "grid-column: 1 / -1; display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; padding: 40px; overflow-y: auto; min-height: 0;";
    if (layout) {
      layout.appendChild(neoContainer);
    } else {
      document.body.appendChild(neoContainer);
    }
  }
  neoContainer.innerHTML = "";
  
  if (!state.filteredCommits || state.filteredCommits.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color: #6b7280; font-size: 18px; text-align: center;";
    empty.textContent = "No commits";
    neoContainer.appendChild(empty);
    return;
  }
  
  // Create commit list with inline files
  const list = document.createElement("div");
  list.style.cssText = "width: 100%; max-width: 1200px; display: flex; flex-direction: column; gap: 16px;";
  
  // Render commits with their files
  for (const c of state.filteredCommits) {
    const isActive = state.currentCommit && state.currentCommit.sha === c.sha;
    const commitDiv = document.createElement("div");
    let activeBg = "rgba(255, 255, 255, 0.02)";
    let activeBorder = "rgba(255, 255, 255, 0.05)";
    if (isActive) {
      const rgb = hexToRgb(colorSettings.activeCommit);
      activeBg = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.1)`;
      activeBorder = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`;
    }
    commitDiv.style.cssText = `
      display: flex;
      gap: 24px;
      padding: 20px 24px;
      background: ${activeBg};
      border: 1px solid ${activeBorder};
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      border-left: 3px solid ${hashColor(c.sha)};
    `;
    commitDiv.onmouseenter = () => {
      if (!isActive) commitDiv.style.background = "rgba(255, 255, 255, 0.05)";
    };
    commitDiv.onmouseleave = () => {
      if (!isActive) commitDiv.style.background = "rgba(255, 255, 255, 0.02)";
    };
    
    // Left side: commit info
    const commitInfo = document.createElement("div");
    commitInfo.style.cssText = "flex: 1; min-width: 0;";
    
    const msg = document.createElement("div");
    msg.style.cssText = `color: ${colorSettings.commitMessage}; font-size: 16px; font-weight: 500; margin-bottom: 8px;`;
    msg.textContent = c.message;
    if (c.isMerge) {
      const mergeBadge = document.createElement("span");
      mergeBadge.style.cssText = "display: inline-block; margin-left: 8px; padding: 2px 8px; background: rgba(167, 139, 250, 0.2); color: #a78bfa; border-radius: 4px; font-size: 11px; font-weight: normal;";
      mergeBadge.textContent = "merge";
      msg.appendChild(mergeBadge);
    }
    
    const meta = document.createElement("div");
    meta.style.cssText = "display: flex; gap: 12px; align-items: center; color: #9ca3af; font-size: 12px;";
    const sha = document.createElement("span");
    sha.style.cssText = "font-family: monospace; color: #6b7280;";
    sha.textContent = c.sha.slice(0, 7);
    // Add context menu handler to SHA element for copying commit ID
    sha.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.contextMenuCommit = c;
      state.contextMenuFile = null;
      showContextMenu(e.clientX, e.clientY);
    });
    const author = document.createElement("span");
    author.textContent = c.author;
    const date = document.createElement("span");
    date.dataset.originalDate = c.date;
    const dateText = state.dateFormatHuman ? formatHumanDate(c.date) : c.date;
    const relativeTime = formatRelativeTime(c.date);
    date.textContent = dateText + " " + relativeTime;
    
    meta.appendChild(sha);
    meta.appendChild(author);
    meta.appendChild(date);
    
    commitInfo.appendChild(msg);
    commitInfo.appendChild(meta);
    
    // Right side: files
    const filesContainer = document.createElement("div");
    filesContainer.style.cssText = "flex: 0 0 300px; display: flex; flex-direction: column; gap: 8px; font-size: 11px;";
    filesContainer.innerHTML = '<div style="color: #6b7280;">Loading files...</div>';
    
    commitDiv.appendChild(commitInfo);
    commitDiv.appendChild(filesContainer);
    
    // Load files for this commit
    (async () => {
      try {
        const files = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/files?ref=" + encodeURIComponent(c.sha));
        let parentFiles = [];
        if (c.parents && c.parents.length > 0) {
          try {
            parentFiles = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/files?ref=" + encodeURIComponent(c.parents[0]));
          } catch (e) {
            // Parent doesn't exist
          }
        }
        
        const parentFileSet = new Set(parentFiles);
        const currentFileSet = new Set(files);
        const added = files.filter(f => !parentFileSet.has(f));
        const removed = parentFiles.filter(f => !currentFileSet.has(f));
        const modified = files.filter(f => parentFileSet.has(f));
        
        let filesHtml = "";
        if (added.length > 0) {
          filesHtml += `<div style="color: #22c55e; margin-bottom: 4px;">+${added.length}</div>`;
        }
        if (modified.length > 0) {
          filesHtml += `<div style="color: #3b82f6; margin-bottom: 4px;">~${modified.length}</div>`;
        }
        if (removed.length > 0) {
          filesHtml += `<div style="color: #ef4444; margin-bottom: 4px;">-${removed.length}</div>`;
        }
        if (filesHtml === "") {
          filesHtml = '<div style="color: #6b7280;">No changes</div>';
        }
        filesContainer.innerHTML = filesHtml;
      } catch (e) {
        filesContainer.innerHTML = '<div style="color: #ef4444;">Error</div>';
      }
    })();
    
    commitDiv.onclick = () => {
      state.currentCommit = c;
      renderNeoCommits();
    };
    list.appendChild(commitDiv);
  }
  
  neoContainer.appendChild(list);
}

async function renderNeoFileList() {
  // Create or get file list container
  let fileListContainer = document.getElementById("neoFileList");
  const layout = document.querySelector(".layout");
  
  if (!fileListContainer) {
    fileListContainer = document.createElement("div");
    fileListContainer.id = "neoFileList";
    fileListContainer.style.cssText = "grid-column: 2; display: flex; flex-direction: column; padding: 40px; overflow-y: auto; min-height: 0; border-left: 1px solid #1f2937;";
    if (layout) {
      layout.appendChild(fileListContainer);
    } else {
      document.body.appendChild(fileListContainer);
    }
  }
  
  if (!state.currentCommit) {
    fileListContainer.innerHTML = '<div style="color: #6b7280; text-align: center; padding: 40px; font-size: 14px;">Select a commit to view files</div>';
    return;
  }
  
  try {
    // Get files for the selected commit
    const files = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/files?ref=" + encodeURIComponent(state.currentCommit.sha));
    
    // Get parent commit files to compare
    let parentFiles = [];
    if (state.currentCommit.parents && state.currentCommit.parents.length > 0) {
      try {
        parentFiles = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/files?ref=" + encodeURIComponent(state.currentCommit.parents[0]));
      } catch (e) {
        // If parent doesn't exist, treat all as new
      }
    }
    
    const parentFileSet = new Set(parentFiles);
    const currentFileSet = new Set(files);
    
    // Categorize files
    const added = files.filter(f => !parentFileSet.has(f));
    const removed = parentFiles.filter(f => !currentFileSet.has(f));
    const modified = files.filter(f => parentFileSet.has(f));
    
    // Build file list HTML
    let html = '<div style="display: flex; flex-direction: column; gap: 24px;">';
    
    // Added files
    if (added.length > 0) {
      html += '<div>';
      html += '<div style="color: #22c55e; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">';
      html += '<span style="display: inline-block; width: 8px; height: 8px; background: #22c55e; border-radius: 50%;"></span>';
      html += `Added (${added.length})</div>`;
      html += '<div style="display: flex; flex-direction: column; gap: 6px;">';
      added.forEach(file => {
        html += `<div style="padding: 10px 14px; background: rgba(34, 197, 94, 0.05); border-left: 3px solid #22c55e; border-radius: 4px; font-size: 13px; color: #d1fae5; font-family: monospace; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='rgba(34, 197, 94, 0.1)'" onmouseout="this.style.background='rgba(34, 197, 94, 0.05)'">+ ${file}</div>`;
      });
      html += '</div></div>';
    }
    
    // Modified files
    if (modified.length > 0) {
      html += '<div>';
      html += '<div style="color: #3b82f6; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">';
      html += '<span style="display: inline-block; width: 8px; height: 8px; background: #3b82f6; border-radius: 50%;"></span>';
      html += `Modified (${modified.length})</div>`;
      html += '<div style="display: flex; flex-direction: column; gap: 6px;">';
      modified.forEach(file => {
        html += `<div style="padding: 10px 14px; background: rgba(59, 130, 246, 0.05); border-left: 3px solid #3b82f6; border-radius: 4px; font-size: 13px; color: #dbeafe; font-family: monospace; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='rgba(59, 130, 246, 0.1)'" onmouseout="this.style.background='rgba(59, 130, 246, 0.05)'">~ ${file}</div>`;
      });
      html += '</div></div>';
    }
    
    // Removed files
    if (removed.length > 0) {
      html += '<div>';
      html += '<div style="color: #ef4444; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">';
      html += '<span style="display: inline-block; width: 8px; height: 8px; background: #ef4444; border-radius: 50%;"></span>';
      html += `Removed (${removed.length})</div>`;
      html += '<div style="display: flex; flex-direction: column; gap: 6px;">';
      removed.forEach(file => {
        html += `<div style="padding: 10px 14px; background: rgba(239, 68, 68, 0.05); border-left: 3px solid #ef4444; border-radius: 4px; font-size: 13px; color: #fee2e2; font-family: monospace; cursor: pointer; transition: all 0.2s; opacity: 0.8;" onmouseover="this.style.background='rgba(239, 68, 68, 0.1)'; this.style.opacity='1'" onmouseout="this.style.background='rgba(239, 68, 68, 0.05)'; this.style.opacity='0.8'">- ${file}</div>`;
      });
      html += '</div></div>';
    }
    
    if (added.length === 0 && modified.length === 0 && removed.length === 0) {
      html = '<div style="color: #6b7280; text-align: center; padding: 40px; font-size: 14px;">No file changes in this commit</div>';
    } else {
      html += '</div>';
    }
    
    fileListContainer.innerHTML = html;
  } catch (e) {
    fileListContainer.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 40px; font-size: 14px;">Error loading files: ' + e.message + '</div>';
  }
}

// Note: switchViewMode, startStatusPolling, and stopStatusPolling are now in view-mode.js
// Functions are exported to window and available globally

// Clean up polling on page unload
window.addEventListener("beforeunload", () => {
  stopStatusPolling();
});

// Collapsible section functionality
function toggleCollapse(sectionId, toggleButton) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  
  const isCollapsed = section.classList.contains("collapsed");
  if (isCollapsed) {
    section.classList.remove("collapsed");
    localStorage.setItem(`gitzada:${sectionId}-collapsed`, "false");
  } else {
    section.classList.add("collapsed");
    localStorage.setItem(`gitzada:${sectionId}-collapsed`, "true");
  }
}

function loadCollapseState(sectionId) {
  const saved = localStorage.getItem(`gitzada:${sectionId}-collapsed`);
  const section = document.getElementById(sectionId);
  if (section && saved === "true") {
    section.classList.add("collapsed");
  }
}

// Initialize collapse functionality
function initCollapsibleSections() {
  if (diffSectionToggle && diffSection) {
    diffSectionToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollapse("diffSection", diffSectionToggle);
    });
    
    // Also allow clicking the header to toggle
    const diffSectionHeader = diffSection.querySelector(".collapsible-header");
    if (diffSectionHeader) {
      diffSectionHeader.addEventListener("click", (e) => {
        if (e.target !== diffSectionToggle && !diffSectionToggle.contains(e.target)) {
          toggleCollapse("diffSection", diffSectionToggle);
        }
      });
    }
    
    // Load saved state
    loadCollapseState("diffSection");
  }

  if (stagedCommitSectionToggle && stagedCommitSection) {
    stagedCommitSectionToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollapse("stagedCommitSection", stagedCommitSectionToggle);
    });
    
    // Also allow clicking the header to toggle
    const stagedCommitSectionHeader = stagedCommitSection.querySelector(".collapsible-header");
    if (stagedCommitSectionHeader) {
      stagedCommitSectionHeader.addEventListener("click", (e) => {
        if (e.target !== stagedCommitSectionToggle && !stagedCommitSectionToggle.contains(e.target)) {
          toggleCollapse("stagedCommitSection", stagedCommitSectionToggle);
        }
      });
    }
    
    // Load saved state
    loadCollapseState("stagedCommitSection");
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCollapsibleSections);
} else {
  initCollapsibleSections();
}

async function renderCommitList() {
  try {
    // Show/hide graph view based on mode
    switchViewMode(isGraphMode());
    
    if (isGraphMode()) {
      const graphContainer = document.getElementById("graphContainer");
      if (graphContainer) {
      // Ensure commits are loaded before rendering
      let commitsToRender = state.filteredCommits || state.commits || [];
      const isAllBranches = state.currentBranch === "__ALL__";
      const focusBranch = isAllBranches
        ? (state.defaultBranch || null)
        : (state.currentBranch || null);
      
      // ALWAYS check for __ALL__ cache when in graph mode with __ALL__ branch
      // This prevents using stale single-branch commits from Activity view
      if (isAllBranches && state.currentBranch === "__ALL__") {
        if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0 && cachedAllBranchesKey) {
          const parsed = parseCacheKey(cachedAllBranchesKey);
          if (parsed.repo === state.currentRepo) {
            // Check if we're already using the cached data
            const expectedCacheKey = `${state.currentRepo}:__ALL__:full`;
            if (loadedCommitsKey !== expectedCacheKey || commitsToRender.length === 0) {
              // Cache exists and we're not using it yet, or we have no commits - use cache!
              console.log("[renderCommitList] Using cached __ALL__ commits:", cachedAllBranchesCommits.length, "commits (current loadedCommitsKey:", loadedCommitsKey, ")");
              state.commits = cachedAllBranchesCommits.slice();
              state.filteredCommits = state.commits;
              loadedCommitsKey = expectedCacheKey;
              cachedAllBranchesKey = expectedCacheKey;
              commitsToRender = state.commits;
            } else {
              console.log("[renderCommitList] Already using cached __ALL__ commits, loadedCommitsKey matches:", loadedCommitsKey);
            }
          } else {
            console.log("[renderCommitList] Cache exists but repo mismatch:", parsed.repo, "vs", state.currentRepo);
          }
        } else {
          console.log("[renderCommitList] No __ALL__ cache found. cachedAllBranchesCommits:", cachedAllBranchesCommits ? cachedAllBranchesCommits.length : "null", "cachedAllBranchesKey:", cachedAllBranchesKey);
        }
      }
      
      if (commitsToRender.length === 0) {
        // Only call loadCommits if we still don't have commits after checking cache
        if (state.currentRepo && state.currentBranch) {
          // Only trigger load if not already loading; loadCommits() will set
          // a unified "Loading commits…" status message that is shared across views.
          if (!isLoadingCommits) {
            console.log("[renderCommitList] No commits available, calling loadCommits()");
            loadCommits().catch(err => {
              console.error("Background commit load failed:", err);
            });
          } else {
            console.log("[renderCommitList] loadCommits() already in progress, skipping");
          }
          return; // Exit early, will re-render when commits arrive
        } else {
          setStatus("Please select a repository and branch", true);
          return;
        }
      }
      
      // Render with available commits
      // Wait for graph module to load if not available yet
      if (!window.graphView || typeof window.graphView.renderGraph !== "function") {
        // Wait up to 2 seconds for graph module to load
        let attempts = 0;
        while ((!window.graphView || typeof window.graphView.renderGraph !== "function") && attempts < 20) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
      }
      
      if (window.graphView && typeof window.graphView.renderGraph === "function") {
        await window.graphView.renderGraph(commitsToRender, {
          repo: state.currentRepo,
          allBranches: isAllBranches,
          focusBranch,
        });
      } else {
        console.error("window.graphView.renderGraph is not available after waiting");
      }
    }
    
    return;
  } else {
    // Show all panels in other modes
    const commitsPanel = document.querySelector(".panel:first-child");
    const layout = document.querySelector(".layout");
    const diffPanel = document.getElementById("diffPanel");
    const filesPanel = document.querySelector(".panel:nth-child(2)");
    if (commitsPanel) commitsPanel.style.display = "flex";
    commitList.style.display = "block";
    if (timeline3d) {
      timeline3d.style.display = "none";
    }
    if (helixControls) {
      helixControls.style.display = "none";
    }
    // Hide legacy NEO container if it exists
    const neoContainerEl = document.getElementById("neoContainer");
    if (neoContainerEl) {
      neoContainerEl.style.display = "none";
    }
    const graphContainer = document.getElementById("graphContainer");
    if (graphContainer) graphContainer.style.display = "none";
    // Show files and diff panels
    const filesPanelHeader = document.getElementById("filesPanelHeader");
    if (diffPanel) diffPanel.style.display = "flex";
    if (filesPanel) filesPanel.style.display = "flex";
    if (filesPanelHeader) filesPanelHeader.style.display = "";
    if (layout) layout.style.gridTemplateColumns = "320px 1fr 1fr";
  }

  commitList.innerHTML = "";
  previousActiveCommitElement = null; // Reset tracking when list is rebuilt

  if (!state.filteredCommits.length) {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = "No commits";
    commitList.appendChild(div);
    state.currentCommit = null;
    // Don't set placeholder text on initial load - leave diff panel empty
    // Only clear it if there was previous content
    if (state.currentFile) {
      const diffContent = document.getElementById("diffContent");
      const diffHeader = document.getElementById("diffHeader");
      if (diffContent) diffContent.textContent = "";
      if (diffHeader) diffHeader.textContent = "";
    }
    fileList.innerHTML = "";
    state.currentFile = null;
    return;
  }

  // Group commits by month if enabled
  if (state.separateByMonths) {
    // Ensure expandedMonths is a Set
    if (!(state.expandedMonths instanceof Set)) {
      state.expandedMonths = new Set();
    }
    
    const commitsByMonth = {};
    state.filteredCommits.forEach(c => {
      const monthKey = getMonthKey(c.date);
      if (!commitsByMonth[monthKey]) {
        commitsByMonth[monthKey] = [];
      }
      commitsByMonth[monthKey].push(c);
    });

    // Sort month keys in descending order (newest first)
    const sortedMonthKeys = Object.keys(commitsByMonth).sort((a, b) => b.localeCompare(a));

    // Expand the latest month by default when separateByMonths is enabled
    if (sortedMonthKeys.length > 0) {
      const latestMonthKey = sortedMonthKeys[0];
      if (!state.expandedMonths.has(latestMonthKey)) {
        state.expandedMonths.add(latestMonthKey);
      }
    }

    sortedMonthKeys.forEach(monthKey => {
      const commits = commitsByMonth[monthKey];
      if (commits.length === 0) return; // Skip empty months

      // Create month container
      const monthContainer = document.createElement("div");
      monthContainer.className = "month-container";
      monthContainer.dataset.monthKey = monthKey;

      // Create month header with chevron
      const monthHeader = document.createElement("div");
      monthHeader.className = "month-header";
      monthHeader.style.cssText = "padding: 16px 12px 8px 12px; font-size: 14px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid rgba(55, 65, 81, 0.3); margin-bottom: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none;";
      
      // Chevron icon (collapsed by default)
      const chevron = document.createElement("span");
      chevron.className = "month-chevron";
      chevron.textContent = "▶"; // Right arrow when collapsed
      chevron.style.cssText = "font-size: 10px; color: #6b7280; transition: transform 0.2s ease;";
      
      const monthLabel = document.createElement("span");
      monthLabel.textContent = formatMonthHeader(commits[0].date);
      
      monthHeader.appendChild(chevron);
      monthHeader.appendChild(monthLabel);
      
      // Create commits container
      const commitsContainer = document.createElement("div");
      commitsContainer.className = "month-commits";
      commitsContainer.style.cssText = "display: none;"; // Start collapsed
      
      // Check if this month should be expanded
      const isExpanded = state.expandedMonths.has(monthKey);
      if (isExpanded) {
        chevron.textContent = "▼"; // Down arrow when expanded
        chevron.style.transform = "rotate(0deg)";
        commitsContainer.style.display = "block";
      } else {
        chevron.textContent = "▶";
        chevron.style.transform = "rotate(0deg)";
        commitsContainer.style.display = "none";
      }

      // Store commits data on the container for lazy rendering
      commitsContainer.dataset.monthKey = monthKey;
      commitsContainer._commits = commits;
      commitsContainer._rendered = false;

      // Helper function to render commits for a month (lazy rendering)
      const renderMonthCommits = (container, monthCommits) => {
        if (container._rendered) return;
        container._rendered = true;
        container.innerHTML = ""; // Clear any placeholder

        const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
        const isActivityView = state.historyMode === "activity";
        const activityFont = localStorage.getItem("gitzada:fontActivity") || "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

        monthCommits.forEach((c) => {
          const div = document.createElement("div");
          const isActive = state.currentCommit && state.currentCommit.sha === c.sha;
          const fadeClass = getCommitFadeClass(c);
          div.className = "item commit-item" + (isActive ? " active" : "") + (fadeClass ? " " + fadeClass : "");
          div.setAttribute("data-sha", c.sha);
          div.style.borderLeftColor = hashColor(c.sha);

          if (activeOnly && isActivityView) {
            const isActiveCommit = isCommitOnActiveBranch(c);
            if (!isActiveCommit) {
              div.style.filter = "grayscale(100%)";
              div.style.opacity = "0.6";
            }
          }

          if (isActive) {
            const rgb = hexToRgb(colorSettings.activeCommit);
            div.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
            previousActiveCommitElement = div; // Track for lightweight updates
          }

          const commitNumber = document.createElement("div");
          commitNumber.className = "commit-number";
          const seq = getCommitSequenceNumber(c.sha);
          if (seq != null) {
            commitNumber.textContent = "#" + seq;
            div.appendChild(commitNumber);
          }

          const msg = document.createElement("div");
          msg.className = "commit-message";
          msg.style.color = colorSettings.commitMessage;
          msg.style.fontFamily = activityFont;
          msg.textContent = c.message;
          if (c.isMerge) {
            const mergeBadge = document.createElement("span");
            mergeBadge.className = "merge-badge";
            mergeBadge.textContent = "merge";
            msg.appendChild(mergeBadge);
          }

          const meta = document.createElement("div");
          meta.className = "commit-meta";
          meta.style.fontFamily = activityFont;
          const sha = document.createElement("span");
          sha.className = "commit-sha";
          sha.textContent = c.sha.slice(0, 7);
          // Add context menu handler to SHA element for copying commit ID
          sha.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.contextMenuCommit = c;
            state.contextMenuFile = null;
            showContextMenu(e.clientX, e.clientY);
          });

          const authorContainer = document.createElement("span");
          authorContainer.className = "commit-author";
          authorContainer.style.cssText = "display: inline-flex; align-items: center; gap: 6px;";

          const avatarUrl = getAvatarUrl(c.email, c.author, 18);
          if (avatarUrl) {
            const avatar = document.createElement("img");
            avatar.src = avatarUrl;
            avatar.alt = c.author;
            avatar.style.cssText = "width: 18px; height: 18px; border-radius: 50%; object-fit: cover; flex-shrink: 0;";
            avatar.onerror = function() { this.style.display = 'none'; };
            authorContainer.appendChild(avatar);
          }

          const author = document.createElement("span");
          author.textContent = c.author;
          // Add context menu handler to author element for direct right-click
          author.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.contextMenuCommit = c;
            state.contextMenuFile = null;
            showContextMenu(e.clientX, e.clientY);
          });
          authorContainer.appendChild(author);

          const date = document.createElement("span");
          date.className = "commit-date";
          date.dataset.originalDate = c.date;
          const dateText = state.dateFormatHuman ? formatHumanDate(c.date) : c.date;
          const relativeTime = formatRelativeTime(c.date);
          date.textContent = dateText + " " + relativeTime;

          meta.appendChild(sha);
          meta.appendChild(authorContainer);
          meta.appendChild(date);
          div.appendChild(msg);
          div.appendChild(meta);

          const selectCommit = () => {
            state.currentCommit = c;
            updateActiveCommitState();
            loadFilesForCommitDebounced();
            updateCommitDetails(c);
          };
          div.addEventListener("click", selectCommit);
          div.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectCommit();
            }
          });

          div.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.contextMenuCommit = c;
            state.contextMenuFile = null;
            showContextMenu(e.clientX, e.clientY);
          });

          container.appendChild(div);
        });
      };

      // Toggle expand/collapse on header click
      monthHeader.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasExpanded = state.expandedMonths.has(monthKey);
        if (wasExpanded) {
          state.expandedMonths.delete(monthKey);
          chevron.textContent = "▶";
          commitsContainer.style.display = "none";
        } else {
          state.expandedMonths.add(monthKey);
          chevron.textContent = "▼";
          commitsContainer.style.display = "block";
          // Lazy render commits when expanding
          renderMonthCommits(commitsContainer, commitsContainer._commits);
        }
      });

      monthContainer.appendChild(monthHeader);
      monthContainer.appendChild(commitsContainer);
      commitList.appendChild(monthContainer);

      // Only render commits if month is expanded (lazy rendering)
      if (isExpanded) {
        renderMonthCommits(commitsContainer, commits);
      }
    });
  } else {
    // Render commits normally without grouping - with progressive loading for large lists
    const INITIAL_RENDER_LIMIT = 200;
    const LOAD_MORE_BATCH = 200;
    let renderedCount = 0;

    const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
    const isActivityView = state.historyMode === "activity";

    // Helper to create a commit DOM element
    const createCommitElement = (c) => {
      const div = document.createElement("div");
      const isActive = state.currentCommit && state.currentCommit.sha === c.sha;
      const fadeClass = getCommitFadeClass(c);
      div.className = "item commit-item" + (isActive ? " active" : "") + (fadeClass ? " " + fadeClass : "");
      div.setAttribute("data-sha", c.sha);
      div.style.borderLeftColor = hashColor(c.sha);

      if (activeOnly && isActivityView) {
        const isActiveCommit = isCommitOnActiveBranch(c);
        if (!isActiveCommit) {
          div.style.filter = "grayscale(100%)";
          div.style.opacity = "0.6";
        }
      }

      if (isActive) {
        const rgb = hexToRgb(colorSettings.activeCommit);
        div.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
        previousActiveCommitElement = div; // Track for lightweight updates
      }

      const commitNumber = document.createElement("div");
      commitNumber.className = "commit-number";
      const seq = getCommitSequenceNumber(c.sha);
      if (seq != null) {
        commitNumber.textContent = "#" + seq;
        div.appendChild(commitNumber);
      }

      const msg = document.createElement("div");
      msg.className = "commit-message";
      msg.style.color = colorSettings.commitMessage;
      msg.textContent = c.message;
      if (c.isMerge) {
        const mergeBadge = document.createElement("span");
        mergeBadge.className = "merge-badge";
        mergeBadge.textContent = "merge";
        msg.appendChild(mergeBadge);
      }

      const meta = document.createElement("div");
      meta.className = "commit-meta";
      const sha = document.createElement("span");
      sha.className = "commit-sha";
      sha.textContent = c.sha.slice(0, 7);
      // Add context menu handler to SHA element for copying commit ID
      sha.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.contextMenuCommit = c;
        state.contextMenuFile = null;
        showContextMenu(e.clientX, e.clientY);
      });

      const authorContainer = document.createElement("span");
      authorContainer.className = "commit-author";
      authorContainer.style.cssText = "display: inline-flex; align-items: center; gap: 6px;";

      const avatarUrl = getAvatarUrl(c.email, c.author, 18);
      if (avatarUrl) {
        const avatar = document.createElement("img");
        avatar.src = avatarUrl;
        avatar.alt = c.author;
        avatar.style.cssText = "width: 18px; height: 18px; border-radius: 50%; object-fit: cover; flex-shrink: 0;";
        avatar.onerror = function() { this.style.display = 'none'; };
        authorContainer.appendChild(avatar);
      }

      const author = document.createElement("span");
      author.textContent = c.author;
      // Add context menu handler to author element for direct right-click
      author.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.contextMenuCommit = c;
        state.contextMenuFile = null;
        showContextMenu(e.clientX, e.clientY);
      });
      authorContainer.appendChild(author);

      const date = document.createElement("span");
      date.className = "commit-date";
      date.dataset.originalDate = c.date;
      const dateText = state.dateFormatHuman ? formatHumanDate(c.date) : c.date;
      const relativeTime = formatRelativeTime(c.date);
      date.textContent = dateText + " " + relativeTime;

      meta.appendChild(sha);
      meta.appendChild(authorContainer);
      meta.appendChild(date);
      div.appendChild(msg);
      div.appendChild(meta);

      const selectCommit = () => {
        state.currentCommit = c;
        updateActiveCommitState();
        loadFilesForCommitDebounced();
        updateCommitDetails(c);
      };
      div.addEventListener("click", selectCommit);
      div.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectCommit();
        }
      });

      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.contextMenuCommit = c;
        state.contextMenuFile = null;
        showContextMenu(e.clientX, e.clientY);
      });

      return div;
    };

    // Render initial batch
    const initialBatch = state.filteredCommits.slice(0, INITIAL_RENDER_LIMIT);
    initialBatch.forEach((c) => {
      commitList.appendChild(createCommitElement(c));
    });
    renderedCount = initialBatch.length;

    // Add "Load more" sentinel if there are more commits
    if (state.filteredCommits.length > INITIAL_RENDER_LIMIT) {
      const loadMoreSentinel = document.createElement("div");
      loadMoreSentinel.id = "loadMoreSentinel";
      loadMoreSentinel.className = "item";
      loadMoreSentinel.style.cssText = "text-align: center; color: #6b7280; padding: 12px; cursor: pointer;";
      loadMoreSentinel.textContent = `Load more (${state.filteredCommits.length - renderedCount} remaining)`;

      // Load more on click
      loadMoreSentinel.addEventListener("click", () => {
        const nextBatch = state.filteredCommits.slice(renderedCount, renderedCount + LOAD_MORE_BATCH);
        nextBatch.forEach((c) => {
          commitList.insertBefore(createCommitElement(c), loadMoreSentinel);
        });
        renderedCount += nextBatch.length;

        if (renderedCount >= state.filteredCommits.length) {
          loadMoreSentinel.remove();
        } else {
          loadMoreSentinel.textContent = `Load more (${state.filteredCommits.length - renderedCount} remaining)`;
        }
      });

      commitList.appendChild(loadMoreSentinel);

      // Use IntersectionObserver for infinite scroll
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && renderedCount < state.filteredCommits.length) {
            const nextBatch = state.filteredCommits.slice(renderedCount, renderedCount + LOAD_MORE_BATCH);
            nextBatch.forEach((c) => {
              commitList.insertBefore(createCommitElement(c), loadMoreSentinel);
            });
            renderedCount += nextBatch.length;

            if (renderedCount >= state.filteredCommits.length) {
              loadMoreSentinel.remove();
              observer.disconnect();
            } else {
              loadMoreSentinel.textContent = `Load more (${state.filteredCommits.length - renderedCount} remaining)`;
            }
          }
        });
      }, { root: commitList, threshold: 0.1 });

      observer.observe(loadMoreSentinel);
    }
  }

  if (!state.currentCommit && state.filteredCommits.length > 0) {
    state.currentCommit = state.filteredCommits[0];
    renderCommitList();
    loadFilesForCommit();
  }
  } catch (e) {
    console.error("Error rendering commit list:", e);
    setStatus("Error rendering commits: " + e.message, true);
  }
}

// Note: moveCommitSelection, getCommitSequenceNumber, and pageCommitSelection are now in commit-navigation.js
// Functions are exported to window and available globally

// Note: updateActiveCommitState is now in commit-navigation.js
// Function is exported to window and available globally

// Note: updateCommitDetails is now in commit-navigation.js
// Function is exported to window and available globally

// AbortController for cancelling pending file list requests
let currentFilesAbortController = null;

// Note: commitSelectionDebounceTimer and loadFilesForCommitDebounced are now in commit-navigation.js
// Functions are exported to window and available globally

async function loadFilesForCommit() {
  // Cancel any pending file list request
  if (currentFilesAbortController) {
    currentFilesAbortController.abort();
    currentFilesAbortController = null;
  }
  // Also cancel any pending diff request
  if (currentDiffAbortController) {
    currentDiffAbortController.abort();
    currentDiffAbortController = null;
  }

  if (!state.currentRepo || !state.currentCommit) {
    if (fileList) {
      fileList.innerHTML = '<div class="item">Select a commit to view files</div>';
    }
    return;
  }

  // Capture current state to detect stale responses
  const requestSha = state.currentCommit.sha;
  const requestRepo = state.currentRepo;

  // Clear diff when loading new commit - don't show placeholder text during loading
  const diffContent = document.getElementById("diffContent");
  const diffHeader = document.getElementById("diffHeader");
  if (diffContent) diffContent.textContent = "";
  if (diffHeader) diffHeader.textContent = "";
  state.currentFile = null;

  try {
    let changedFiles = null;

    // Check IndexedDB cache first (file lists are immutable - same SHA = same files)
    if (window.gitCache) {
      changedFiles = await window.gitCache.getFiles(requestRepo, requestSha);
    }

    // If not in cache, fetch from API
    if (!changedFiles) {
      if (fileList) {
        fileList.innerHTML = '<div class="item">Loading changed files...</div>';
      }

      // Create abort controller for this request
      currentFilesAbortController = new AbortController();
      const signal = currentFilesAbortController.signal;

      const url = "/api/repos/" + encodeURIComponent(requestRepo) + "/commit/files?ref=" + encodeURIComponent(requestSha);
      console.log(`[loadFilesForCommit] Loading files for commit ${requestSha}`);
      changedFiles = await api(url, { signal });

      // Clear controller after successful fetch
      currentFilesAbortController = null;

      // Save to cache (fire and forget)
      if (window.gitCache && changedFiles) {
        window.gitCache.saveFiles(requestRepo, requestSha, changedFiles)
          .catch(err => console.warn("[loadFilesForCommit] Failed to cache files:", err));
      }
    }

    // Check if state changed while we were fetching (stale response)
    if (state.currentCommit?.sha !== requestSha || state.currentRepo !== requestRepo) {
      console.log("[loadFilesForCommit] Discarding stale response");
      return;
    }

    console.log(`[loadFilesForCommit] Got ${changedFiles?.length || 0} files for commit ${requestSha}`);

    state.changedFiles = changedFiles || [];
    state.files = changedFiles.map(f => f.path);

    // Auto-select the first file if files are available
    if (state.changedFiles && state.changedFiles.length > 0) {
      state.currentFile = state.changedFiles[0].path;
    }

    // Single render with the correct active file already set
    renderFileList();

    // Load the diff for the selected file
    if (state.currentFile) {
      loadCommitFileDiff();
    }
  } catch (e) {
    // Ignore abort errors - they're expected when user clicks quickly
    if (e.name === 'AbortError') {
      console.log("[loadFilesForCommit] Request aborted");
      return;
    }
    // Don't show error in toolbar - it's shown in the file list panel
    if (fileList) {
      fileList.innerHTML = '<div class="item" style="color: #ef4444;">Error loading files: ' + e.message + '</div>';
    }
  }
}

// Note: updateActiveFileState is now in file-navigation.js
// Function is exported to window and available globally

function renderFileList() {
  if (!fileList) return;
  fileList.innerHTML = "";
  previousActiveFileElement = null; // Reset tracking when list is rebuilt

  if (!state.changedFiles || !state.changedFiles.length) {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = "No file changes in this commit";
    fileList.appendChild(div);
    return;
  }
  // Clear previous queue when rendering new file list
  fileCreationQueue = [];
  activeFileRequests = 0;
  
  state.changedFiles.forEach(fileInfo => {
    const f = fileInfo.path;
    const status = fileInfo.status;
    const div = document.createElement("div");
    const isActive = state.currentFile === f;
    div.className = "item" + (isActive ? " active" : "");
    div.setAttribute("data-file-path", f);
    
    // Color code based on change status
    let statusColor = fileAccent(f);
    if (status === 'added') {
      statusColor = colorSettings.addedFile;
    } else if (status === 'removed') {
      statusColor = colorSettings.removedFile;
    } else if (status === 'modified') {
      statusColor = colorSettings.modifiedFile;
    }
    div.style.borderRightWidth = '5px';
    div.style.borderRightColor = statusColor;
    
    // Apply status-based background color when active
    if (isActive) {
      if (status === 'added') {
        const rgb = hexToRgb(colorSettings.addedFile);
        div.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
      } else if (status === 'removed') {
        const rgb = hexToRgb(colorSettings.removedFile);
        div.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
      } else if (status === 'modified') {
        const rgb = hexToRgb(colorSettings.modifiedFile);
        div.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
      }
      // Track for lightweight updates
      previousActiveFileElement = div;
    }
    
    const name = document.createElement("div");
    name.style.display = "flex";
    name.style.alignItems = "center";
    name.style.gap = "8px";
    
    // Status indicator
    const statusIndicator = document.createElement("span");
    statusIndicator.textContent = status === 'added' ? '+' : status === 'removed' ? '-' : '~';
    statusIndicator.style.color = statusColor;
    statusIndicator.style.fontWeight = "bold";
    statusIndicator.style.fontSize = "14px";
    statusIndicator.style.width = "16px";
    
    const fileName = document.createElement("span");
    fileName.textContent = f;
    
    name.appendChild(statusIndicator);
    name.appendChild(fileName);
    
    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.style.display = "flex";
    meta.style.justifyContent = "space-between";
    meta.style.alignItems = "center";
    meta.style.width = "100%";
    
    const statusText = document.createElement("span");
    statusText.textContent = status;
    meta.appendChild(statusText);
    
    div.appendChild(name);
    div.appendChild(meta);
    
    // Queue creation info loading for modified or deleted files (rate limited)
    if (status === 'modified' || status === 'removed') {
      fileCreationQueue.push({ filePath: f, metaElement: meta });
    }
    
    const selectFile = () => {
      state.currentFile = f;
      updateActiveFileState(f); // Lightweight update instead of full re-render
      loadCommitFileDiff();
    };
    div.addEventListener("click", selectFile);
    div.setAttribute("role", "option");
    div.setAttribute("tabindex", "0");
    div.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectFile();
      }
    });
    
    // Right-click context menu
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.contextMenuFile = f;
      showContextMenu(e.clientX, e.clientY);
    });
    
    fileList.appendChild(div);
  });
  
  // Start processing the file creation info queue with rate limiting
  if (fileCreationQueue.length > 0) {
    processFileCreationQueue();
  }
}

// Process file creation info queue with rate limiting
async function processFileCreationQueue() {
  if (fileCreationInProgress || fileCreationQueue.length === 0) {
    return;
  }
  
  fileCreationInProgress = true;
  
  while (fileCreationQueue.length > 0 && activeFileRequests < MAX_CONCURRENT_FILE_REQUESTS) {
    const batchItems = fileCreationQueue.splice(0, FILE_CREATION_BATCH_SIZE);
    activeFileRequests++;
    
    // Process this batch
    loadFileCreationInfoBatch(batchItems).finally(() => {
      activeFileRequests--;
      // Process next batch after a small delay
      setTimeout(() => {
        processFileCreationQueue();
      }, 100);
    });
  }
  
  fileCreationInProgress = false;
}

// Render file creation info into the UI for a single file
async function renderFileCreationInfo(filePath, metaElement, creationInfo) {
  if (!state.currentRepo || !state.currentCommit) {
    return;
  }
  
  if (!metaElement || !creationInfo || !creationInfo.found) {
    return;
  }
  
  try {
      // Check cache first
      const cacheKey = `${state.currentRepo}:${state.currentCommit.sha}:${creationInfo.commitSha}`;
      let commitsAgo = null;
      
      if (commitsAgoCache.has(cacheKey)) {
        commitsAgo = commitsAgoCache.get(cacheKey);
        console.log("[renderFileCreationInfo] Using cached commitsAgo:", commitsAgo, "for", cacheKey);
      } else {
        // Find the index of this commit in the commits list
        let commitIndex = state.commits.findIndex(c => c && c.sha === creationInfo.commitSha);
        let currentCommitIndex = state.commits.findIndex(c => c && c.sha === state.currentCommit.sha);
        
        // If commit found in current list, use it
        // Note: commits are typically ordered newest first (index 0 = newest)
        // So if creation commit is at higher index, it's older (more commits ago)
        if (commitIndex >= 0 && currentCommitIndex >= 0) {
          // If creation commit index is higher, it's older (more commits ago)
          // If creation commit index is lower, it's newer (shouldn't happen, but handle it)
          if (commitIndex > currentCommitIndex) {
            commitsAgo = commitIndex - currentCommitIndex;
          } else if (commitIndex < currentCommitIndex) {
            // Creation commit is newer than current - this shouldn't happen normally
            commitsAgo = 0;
          } else {
            commitsAgo = 0; // Same commit
          }
        } else {
          // If commit not found in current list, check __ALL__ cache before making API call
          // This prevents unnecessary API calls when we have the data cached
          let foundInCache = false;
          if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0) {
            const parsed = parseCacheKey(cachedAllBranchesKey);
            if (parsed && parsed.repo === state.currentRepo) {
              // Check if both commits are in the __ALL__ cache
              const creationCommitIndex = cachedAllBranchesCommits.findIndex(c => c && c.sha === creationInfo.commitSha);
              const currentCommitIndexInCache = cachedAllBranchesCommits.findIndex(c => c && c.sha === state.currentCommit.sha);
              
              if (creationCommitIndex >= 0 && currentCommitIndexInCache >= 0) {
                // Both commits found in cache, calculate from cache
                if (creationCommitIndex > currentCommitIndexInCache) {
                  commitsAgo = creationCommitIndex - currentCommitIndexInCache;
                } else if (creationCommitIndex < currentCommitIndexInCache) {
                  commitsAgo = 0;
                } else {
                  commitsAgo = 0; // Same commit
                }
                foundInCache = true;
              }
            }
          }
          
          // Only make API call if commit not found in cache
          if (!foundInCache) {
            try {
              // Re-check currentCommit before making API call
              if (!state.currentCommit) {
                return;
              }
              const commitsBetweenResponse = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/commits-between?from=" + encodeURIComponent(creationInfo.commitSha) + "&to=" + encodeURIComponent(state.currentCommit.sha));
              if (commitsBetweenResponse && commitsBetweenResponse.count !== undefined) {
                commitsAgo = commitsBetweenResponse.count;
              }
            } catch (e) {
              console.error("Could not calculate commits between", e);
            }
          }
          
          // Cache the result
          if (commitsAgo !== null) {
            commitsAgoCache.set(cacheKey, commitsAgo);
          }
        }
      }
      
      const creationInfoDiv = document.createElement("div");
      creationInfoDiv.setAttribute("data-file-creation-info", "true"); // Mark as rendered to prevent duplicate requests
      creationInfoDiv.style.cssText = "display: flex; align-items: center; gap: 4px; font-size: 9px; color: #9ca3af; margin-left: auto;";
      
      // Format date with ordinal suffix (1st, 2nd, 3rd, 4th, etc.)
      function getOrdinalSuffix(day) {
        if (day > 3 && day < 21) return 'th';
        switch (day % 10) {
          case 1: return 'st';
          case 2: return 'nd';
          case 3: return 'rd';
          default: return 'th';
        }
      }
      
      const dateText = document.createElement("span");
      if (creationInfo.date) {
        const date = new Date(creationInfo.date);
        const day = date.getDate();
        const month = date.toLocaleDateString('en-US', { month: 'short' }).toLowerCase();
        const year = date.getFullYear();
        dateText.textContent = `created: ${month} ${day}${getOrdinalSuffix(day)} ${year}`;
      } else {
        dateText.textContent = "created: unknown date";
      }
      
      const separator = document.createElement("span");
      separator.textContent = "|";
      separator.style.margin = "0 4px";
      
      const commitsAgoLink = document.createElement("span");
      if (commitsAgo !== null && commitsAgo >= 0) {
        commitsAgoLink.textContent = `${commitsAgo} commit${commitsAgo !== 1 ? 's' : ''} ago`;
        commitsAgoLink.style.cssText = "color: #60a5fa; cursor: pointer; text-decoration: underline; text-decoration-color: rgba(96, 165, 250, 0.5);";
        commitsAgoLink.addEventListener("click", (e) => {
          e.stopPropagation();
          highlightCommitBySha(creationInfo.commitSha, filePath);
        });
      } else if (commitsAgo === -1) {
        // Commits on different branches
        commitsAgoLink.textContent = "different branch";
        commitsAgoLink.style.color = "#6b7280";
      } else {
        // Try one more time with a simpler approach - just count all commits up to current
        // This is a fallback - we'll show "unknown"
        commitsAgoLink.textContent = "unknown commits ago";
        commitsAgoLink.style.color = "#6b7280";
      }
      
      creationInfoDiv.appendChild(dateText);
      creationInfoDiv.appendChild(separator);
      creationInfoDiv.appendChild(commitsAgoLink);
      metaElement.appendChild(creationInfoDiv);
  } catch (e) {
    // Log error for debugging
    console.error("Error rendering file creation info:", e, { filePath, repo: state.currentRepo });
    // Show error info in the UI for debugging
    const errorDiv = document.createElement("div");
    errorDiv.style.cssText = "display: flex; align-items: center; gap: 4px; font-size: 11px; color: #ef4444; margin-left: auto;";
    errorDiv.textContent = "Error loading creation info";
    metaElement.appendChild(errorDiv);
  }
}

// Load file creation info for a single file (wrapper using batch logic)
async function loadFileCreationInfo(filePath, metaElement) {
  return loadFileCreationInfoBatch([{ filePath, metaElement }]);
}

// Load file creation info for a batch of files and display it
async function loadFileCreationInfoBatch(batchItems) {
  if (!state.currentRepo || !state.currentCommit) {
    return;
  }
  
  // Filter out items that already have file creation info rendered
  const validItems = (batchItems || []).filter(item => {
    if (!item || !item.metaElement || !item.filePath) return false;
    // Check if file creation info is already rendered (look for creationInfoDiv)
    const existingInfo = item.metaElement.querySelector('div[data-file-creation-info]');
    return !existingInfo; // Only include if not already rendered
  });
  
  if (validItems.length === 0) {
    return; // All items already have creation info, skip the request
  }
  
  try {
    const uniquePaths = Array.from(new Set(validItems.map(item => item.filePath)));
    const params = new URLSearchParams();
    params.set("paths", JSON.stringify(uniquePaths));
    
    const url = "/api/repos/" + encodeURIComponent(state.currentRepo) + "/file-creation-batch?" + params.toString();
    const creationMap = await api(url);
    
    // Re-check currentCommit in case it changed during async operation
    if (!state.currentCommit) {
      return;
    }
    
    for (const item of validItems) {
      const { filePath, metaElement } = item;
      const creationInfo = creationMap && creationMap[filePath];
      if (creationInfo && creationInfo.found) {
        await renderFileCreationInfo(filePath, metaElement, creationInfo);
      }
    }
  } catch (e) {
    // Log error for debugging
    console.error("Error loading file creation info batch:", e, { repo: state.currentRepo });
    // Show error info in the UI for debugging
    for (const item of validItems) {
      const { metaElement } = item;
      const errorDiv = document.createElement("div");
      errorDiv.style.cssText = "display: flex; align-items: center; gap: 4px; font-size: 11px; color: #ef4444; margin-left: auto;";
      errorDiv.textContent = "Error loading creation info";
      metaElement.appendChild(errorDiv);
    }
  }
}

// Note: switchToActivityView and highlightCommitBySha are now in commit-navigation.js
// Functions are exported to window and available globally

// isImageFile is now loaded from utils.js module

// AbortController for cancelling pending diff requests
let currentDiffAbortController = null;

async function loadCommitFileDiff() {
  const diffContent = document.getElementById("diffContent");
  const diffHeader = document.getElementById("diffHeader");

  // Cancel any pending diff request
  if (currentDiffAbortController) {
    currentDiffAbortController.abort();
    currentDiffAbortController = null;
  }

  if (!state.currentRepo || !state.currentCommit || !state.currentFile) {
    // Only show placeholder if a commit is selected but no file is selected
    // Don't show it if there's no commit (initial load state)
    if (state.currentCommit) {
      if (diffContent) diffContent.textContent = "Select a file to view diff";
      if (diffHeader) diffHeader.textContent = "DIFF: Select a file to view diff";
    } else {
      // No commit selected - keep diff panel empty
      if (diffContent) diffContent.textContent = "";
      if (diffHeader) diffHeader.textContent = "";
    }
    return;
  }

  // Capture current state to detect stale responses
  const requestSha = state.currentCommit.sha;
  const requestFile = state.currentFile;
  const requestRepo = state.currentRepo;

  if (diffHeader) {
    diffHeader.textContent = state.currentFile ? `DIFF: ${state.currentFile}` : "";
  }

  if (diffContent) {
    diffContent.textContent = "Loading diff...";
  }

  try {
    // Check if this is an image file
    if (isImageFile(state.currentFile)) {
      await loadImageDiff();
      return;
    }

    let diffResponse;
    const sha = requestSha;
    const filePath = requestFile;

    // Check IndexedDB cache first (diffs are immutable - same SHA + file = same diff forever)
    if (window.gitCache) {
      const cachedDiff = await window.gitCache.getDiff(requestRepo, sha, filePath);
      if (cachedDiff) {
        diffResponse = cachedDiff;
      }
    }

    // If not cached, fetch from API with abort support
    if (!diffResponse) {
      // Create new abort controller for this request
      currentDiffAbortController = new AbortController();
      const signal = currentDiffAbortController.signal;

      diffResponse = await api(
        "/api/repos/" + encodeURIComponent(requestRepo) + "/diff?path=" + encodeURIComponent(filePath) + "&ref=" + encodeURIComponent(sha),
        { signal }
      );

      // Clear controller after successful fetch
      currentDiffAbortController = null;

      // Save to cache (fire and forget - don't block rendering)
      if (window.gitCache && diffResponse) {
        window.gitCache.saveDiff(requestRepo, sha, filePath, {
          diff: diffResponse.diff,
          hunks: diffResponse.hunks
        }).catch(err => console.warn("[loadCommitFileDiff] Failed to cache diff:", err));
      }
    }

    // Check if state changed while we were fetching (stale response)
    if (state.currentCommit?.sha !== requestSha ||
        state.currentFile !== requestFile ||
        state.currentRepo !== requestRepo) {
      console.log("[loadCommitFileDiff] Discarding stale response");
      return;
    }

    const diffText = diffResponse.diff;
    
    // Render diff with styling
    if (diffContent) {
      diffContent.innerHTML = "";
      
      // If diff is empty or undefined, show a message
      if (!diffText || diffText.trim() === "") {
        const emptyDiv = document.createElement("div");
        emptyDiv.style.color = "#9ca3af";
        emptyDiv.style.padding = "16px";
        emptyDiv.style.textAlign = "center";
        emptyDiv.textContent = "No changes in this file";
        diffContent.appendChild(emptyDiv);
        return;
      }
      
      const lines = diffText.split("\n");
      // Filter out Git metadata lines
      const filteredLines = lines.filter(line => {
        return !line.startsWith("diff --git") && 
               !line.startsWith("index ") && 
               !line.startsWith("new file mode") && 
               !line.startsWith("deleted file mode") && 
               !line.startsWith("old mode") && 
               !line.startsWith("new mode") &&
               !line.startsWith("rename from") && 
               !line.startsWith("rename to") &&
               !line.startsWith("similarity index");
      });
      
      filteredLines.forEach(line => {
        const lineDiv = document.createElement("div");
        lineDiv.style.padding = "2px 8px";
        lineDiv.style.fontFamily = "ui-monospace, monospace";
        lineDiv.style.fontSize = "12px";
        lineDiv.style.lineHeight = "1.6";
        
        if (line.startsWith("+++") || line.startsWith("---")) {
          lineDiv.style.color = "#9ca3af";
          lineDiv.style.backgroundColor = "rgba(107, 114, 128, 0.1)";
          lineDiv.textContent = line;
        } else if (line.startsWith("@@")) {
          const hunkRgb = hexToRgb(colorSettings.diffHunk);
          lineDiv.style.color = colorSettings.diffHunk;
          lineDiv.style.backgroundColor = `rgba(${hunkRgb.r}, ${hunkRgb.g}, ${hunkRgb.b}, 0.1)`;
          lineDiv.textContent = line;
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
          const addedRgb = hexToRgb(colorSettings.diffAdded);
          lineDiv.style.color = colorSettings.diffAdded;
          lineDiv.style.backgroundColor = `rgba(${addedRgb.r}, ${addedRgb.g}, ${addedRgb.b}, 0.1)`;
          lineDiv.textContent = line;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          const removedRgb = hexToRgb(colorSettings.diffRemoved);
          lineDiv.style.color = colorSettings.diffRemoved;
          lineDiv.style.backgroundColor = `rgba(${removedRgb.r}, ${removedRgb.g}, ${removedRgb.b}, 0.1)`;
          lineDiv.textContent = line;
        } else {
          lineDiv.style.color = "#9ca3af";
          lineDiv.textContent = line || " ";
        }
        diffContent.appendChild(lineDiv);
      });
    }
  } catch (e) {
    // Ignore abort errors - they're expected when user clicks quickly
    if (e.name === 'AbortError') {
      console.log("[loadCommitFileDiff] Request aborted");
      return;
    }
    if (diffContent) {
      diffContent.textContent = "Error loading diff: " + e.message;
      diffContent.style.color = "#ef4444";
    }
  }
}

// isImageFile is now loaded from utils.js module

async function loadImageDiff() {
  const diffContent = document.getElementById("diffContent");
  if (!diffContent) return;
  
  try {
    // Get file status
    const fileInfo = state.changedFiles.find(f => f.path === state.currentFile);
    const status = fileInfo ? fileInfo.status : 'modified';
    
    diffContent.innerHTML = "";
    diffContent.style.padding = "20px";
    diffContent.style.display = "flex";
    diffContent.style.flexDirection = "column";
    diffContent.style.gap = "20px";
    diffContent.style.alignItems = "center";
    
    if (status === 'added') {
      // Show the new image
      const imageResponse = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/image?path=" + encodeURIComponent(state.currentFile) + "&ref=" + encodeURIComponent(state.currentCommit.sha));
      const imgContainer = document.createElement("div");
      imgContainer.style.cssText = "position: relative; max-width: 100%; text-align: center;";
      
      const label = document.createElement("div");
      label.style.cssText = "color: #22c55e; font-size: 12px; margin-bottom: 8px; font-weight: 600;";
      label.textContent = "Added";
      imgContainer.appendChild(label);
      
      const img = document.createElement("img");
      img.src = imageResponse.data;
      img.style.cssText = "max-width: 100%; max-height: 600px; border: 2px solid #22c55e; border-radius: 4px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);";
      imgContainer.appendChild(img);
      diffContent.appendChild(imgContainer);
    } else if (status === 'removed') {
      // Show the removed image with red overlay and X
      const parentRef = state.currentCommit.parents && state.currentCommit.parents.length > 0 ? state.currentCommit.parents[0] : null;
      if (parentRef) {
        const imageResponse = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/image?path=" + encodeURIComponent(state.currentFile) + "&ref=" + encodeURIComponent(parentRef));
        const imgContainer = document.createElement("div");
        imgContainer.style.cssText = "position: relative; max-width: 100%; text-align: center;";
        
        const label = document.createElement("div");
        label.style.cssText = "color: #ef4444; font-size: 12px; margin-bottom: 8px; font-weight: 600;";
        label.textContent = "Removed";
        imgContainer.appendChild(label);
        
        const wrapper = document.createElement("div");
        wrapper.style.cssText = "position: relative; display: inline-block;";
        
        const img = document.createElement("img");
        img.src = imageResponse.data;
        img.style.cssText = "max-width: 100%; max-height: 600px; border: 2px solid #ef4444; border-radius: 4px; opacity: 0.5; filter: grayscale(100%);";
        
        // Red overlay
        const overlay = document.createElement("div");
        overlay.style.cssText = "position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(239, 68, 68, 0.3); border-radius: 4px; pointer-events: none;";
        
        // X mark
        const xMark = document.createElement("div");
        xMark.style.cssText = "position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 80px; color: #ef4444; font-weight: bold; text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8); pointer-events: none; z-index: 10;";
        xMark.textContent = "✕";
        
        wrapper.appendChild(img);
        wrapper.appendChild(overlay);
        wrapper.appendChild(xMark);
        imgContainer.appendChild(wrapper);
        diffContent.appendChild(imgContainer);
      }
    } else if (status === 'modified') {
      // Show before and after side by side
      const parentRef = state.currentCommit.parents && state.currentCommit.parents.length > 0 ? state.currentCommit.parents[0] : null;
      
      const container = document.createElement("div");
      container.style.cssText = "display: grid; grid-template-columns: 1fr 1fr; gap: 20px; width: 100%; max-width: 1200px;";
      
      if (parentRef) {
        try {
          const beforeResponse = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/image?path=" + encodeURIComponent(state.currentFile) + "&ref=" + encodeURIComponent(parentRef));
          
          const beforeContainer = document.createElement("div");
          beforeContainer.style.cssText = "text-align: center;";
          
          const beforeLabel = document.createElement("div");
          beforeLabel.style.cssText = "color: #ef4444; font-size: 12px; margin-bottom: 8px; font-weight: 600;";
          beforeLabel.textContent = "Before";
          beforeContainer.appendChild(beforeLabel);
          
          const beforeImg = document.createElement("img");
          beforeImg.src = beforeResponse.data;
          beforeImg.style.cssText = "max-width: 100%; max-height: 600px; border: 2px solid #ef4444; border-radius: 4px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);";
          beforeContainer.appendChild(beforeImg);
          container.appendChild(beforeContainer);
        } catch (e) {
          // Parent image might not exist
        }
      }
      
      try {
        const afterResponse = await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/image?path=" + encodeURIComponent(state.currentFile) + "&ref=" + encodeURIComponent(state.currentCommit.sha));
        
        const afterContainer = document.createElement("div");
        afterContainer.style.cssText = "text-align: center;";
        
        const afterLabel = document.createElement("div");
        afterLabel.style.cssText = "color: #22c55e; font-size: 12px; margin-bottom: 8px; font-weight: 600;";
        afterLabel.textContent = "After";
        afterContainer.appendChild(afterLabel);
        
        const afterImg = document.createElement("img");
        afterImg.src = afterResponse.data;
        afterImg.style.cssText = "max-width: 100%; max-height: 600px; border: 2px solid #22c55e; border-radius: 4px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);";
        afterContainer.appendChild(afterImg);
        container.appendChild(afterContainer);
      } catch (e) {
        // Current image might not exist
      }
      
      diffContent.appendChild(container);
    }
  } catch (e) {
    if (diffContent) {
      diffContent.textContent = "Error loading image: " + e.message;
      diffContent.style.color = "#ef4444";
    }
  }
}

function showContextMenu(x, y) {
  if (!contextMenu) return;
  
  // Show/hide menu items based on context
  if (contextMenuOpenExplorer) {
    contextMenuOpenExplorer.style.display = state.contextMenuFile ? "block" : "none";
  }
  if (contextMenuViewGitHub) {
    const hasGitHubUsername = state.contextMenuCommit && getGitHubUsername(state.contextMenuCommit.email, state.contextMenuCommit.author);
    if (hasGitHubUsername) {
      contextMenuViewGitHub.textContent = `View ${state.contextMenuCommit.author}'s GitHub Profile`;
      contextMenuViewGitHub.style.display = "block";
    } else {
      contextMenuViewGitHub.style.display = "none";
    }
  }
  if (contextMenuCopyCommitId) {
    contextMenuCopyCommitId.style.display = state.contextMenuCommit ? "block" : "none";
  }
  if (contextMenuCheckoutCommit) {
    contextMenuCheckoutCommit.style.display = state.contextMenuCommit ? "block" : "none";
  }
  
  contextMenu.style.display = "block";
  contextMenu.style.left = x + "px";
  contextMenu.style.top = y + "px";
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.style.display = "none";
  }
  state.contextMenuFile = null;
  state.contextMenuCommit = null;
}

// Hide context menu when clicking elsewhere
document.addEventListener("click", (e) => {
  // Don't hide if clicking on the context menu itself
  if (!contextMenu || !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});
document.addEventListener("contextmenu", (e) => {
  if (!contextMenu || !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

// Handle context menu actions
if (contextMenuOpenExplorer) {
  contextMenuOpenExplorer.addEventListener("click", async () => {
    if (!state.contextMenuFile || !state.currentRepo) {
      hideContextMenu();
      return;
    }
    
    try {
      await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/open-explorer?path=" + encodeURIComponent(state.contextMenuFile));
      hideContextMenu();
    } catch (e) {
      setStatus("Error opening file explorer: " + e.message, true);
      hideContextMenu();
    }
  });
}

if (contextMenuViewGitHub) {
  contextMenuViewGitHub.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!state.contextMenuCommit) {
      hideContextMenu();
      return;
    }
    
    const username = getGitHubUsername(state.contextMenuCommit.email, state.contextMenuCommit.author);
    if (!username) {
      console.warn('Could not extract GitHub username from:', state.contextMenuCommit);
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
      setStatus(`Failed to open GitHub profile: ${errorMessage}`, true);
    }
    hideContextMenu();
  });
}

// Handle copy commit ID
if (contextMenuCopyCommitId) {
  contextMenuCopyCommitId.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!state.contextMenuCommit) {
      hideContextMenu();
      return;
    }
    
    const fullCommitId = state.contextMenuCommit.sha;
    
    try {
      // Use the Clipboard API to copy the commit ID
      await navigator.clipboard.writeText(fullCommitId);
      setStatus(`Copied commit ID: ${fullCommitId}`, false);
      hideContextMenu();
      // Auto-fade the status message after 2 seconds
      setTimeout(() => {
        setStatus("");
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
        setStatus(`Copied commit ID: ${fullCommitId}`, false);
        hideContextMenu();
        // Auto-fade the status message after 2 seconds
        setTimeout(() => {
          setStatus("");
        }, 2000);
      } catch (fallbackErr) {
        setStatus("Failed to copy commit ID: " + (fallbackErr.message || fallbackErr), true);
        hideContextMenu();
        // Auto-fade error messages after 3 seconds (longer for errors)
        setTimeout(() => {
          setStatus("");
        }, 3000);
      }
    }
  });
}

// Function to update detached HEAD status message
function updateDetachedHeadStatus() {
  const statusEl = document.getElementById("statusMessage");
  if (!statusEl) return;
  
  const innerDiv = statusEl.querySelector('div');
  if (!innerDiv) return;
  
  if (state.detachedHeadCommit) {
    const shortSha = state.detachedHeadCommit.sha.slice(0, 10);
    const message = state.detachedHeadCommit.message || "";
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
      if (state.detachedHeadCommit) {
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
      setStatusMessage("");
    }
  }
}

// Export to window for access from ui.js
window.updateDetachedHeadStatus = updateDetachedHeadStatus;

// Handle checkout commit (detached HEAD)
if (contextMenuCheckoutCommit) {
  contextMenuCheckoutCommit.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!state.contextMenuCommit || !state.currentRepo) {
      hideContextMenu();
      return;
    }
    
    const commitSha = state.contextMenuCommit.sha;
    
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
        repo: state.currentRepo,
        commitSha: commitSha
      });

      if (result.success) {
        // Store the previous branch before entering detached HEAD
        if (state.currentBranch && state.currentBranch !== "HEAD" && !state.previousBranch) {
          state.previousBranch = state.currentBranch;
        }
        
        // Store detached HEAD state
        state.detachedHeadCommit = {
          sha: commitSha,
          message: state.contextMenuCommit.message || ""
        };
        
        // Update status message
        updateDetachedHeadStatus();
        
        // Reload branches to reflect the detached HEAD state
        await loadBranches();
        
        // Reload commits
        await loadCommits();
        
        hideContextMenu();
      } else {
        setStatus(result.error || result.message || "Failed to checkout commit", true);
        hideContextMenu();
      }
    } catch (err) {
      console.error('Failed to checkout commit:', err);
      setStatus("Failed to checkout commit: " + (err.message || err), true);
      hideContextMenu();
    }
  });
}

// Functions to show/hide exit detached HEAD modal
function showExitDetachedHeadModal() {
  if (exitDetachedHeadModal) {
    exitDetachedHeadModal.style.display = 'flex';
  }
}

function closeExitDetachedHeadModal() {
  if (exitDetachedHeadModal) {
    exitDetachedHeadModal.style.display = 'none';
  }
}

// Handle exit detached HEAD modal
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
    if (!state.currentRepo || !state.detachedHeadCommit) {
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
          repo: state.currentRepo
        });
      } catch (err) {
        console.warn("Failed to get best branch to checkout:", err);
      }
      
      // Fallback: try stored previousBranch if available and still exists
      if (!targetBranch && state.previousBranch && state.branches && state.branches.includes(state.previousBranch)) {
        targetBranch = state.previousBranch;
      }
      
      // Final fallback: use local branch list
      if (!targetBranch && state.branches && state.branches.length > 0) {
        // Try to find main or master first
        targetBranch = state.branches.find(b => b === "main" || b === "master") || state.branches[0];
      }
      
      if (!targetBranch) {
        setStatus("No branch available to checkout", true);
        closeExitDetachedHeadModal();
        if (exitDetachedHeadYes) {
          exitDetachedHeadYes.disabled = false;
          exitDetachedHeadYes.textContent = "Yes";
        }
        return;
      }

      // Set flag to prevent re-detection of detached HEAD during checkout
      state.isCheckingOutBranch = true;
      
      // Perform the checkout
      const result = await invokeFn('checkout_branch', {
        repo: state.currentRepo,
        branchName: targetBranch
      });

      if (result.success) {
        // Clear detached HEAD state immediately
        state.detachedHeadCommit = null;
        state.previousBranch = null;
        
        // Update branch dropdown immediately
        if (branchSelect) {
          branchSelect.value = targetBranch;
        }
        if (branchSearchable) {
          branchSearchable.setValue(targetBranch);
        }
        
        // Update status message
        updateDetachedHeadStatus();
        
        // Small delay to ensure git state has updated after checkout
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Reload branches to get fresh state from git
        // This will update state.currentBranch and state.branches
        await loadBranches();
        
        // Clear the flag after reload
        state.isCheckingOutBranch = false;
        
        // Verify we're actually on a branch (not detached HEAD)
        const isOnBranch = state.currentBranch && 
                          state.currentBranch !== "HEAD" && 
                          state.currentBranch.length !== 40 && // Not a SHA
                          state.branches && 
                          state.branches.includes(state.currentBranch);
        
        if (isOnBranch) {
          // Successfully on a branch - ensure detached HEAD state is cleared
          state.detachedHeadCommit = null;
          state.previousBranch = null;
          updateDetachedHeadStatus();
          
          // Reload commits to show the branch's commits
          await loadCommits();
          
          closeExitDetachedHeadModal();
          setStatus(`Switched to branch: ${state.currentBranch}`, false);
          setTimeout(() => setStatus(""), 2000);
        } else {
          // Still in detached HEAD - this shouldn't happen but handle gracefully
          console.warn("Still in detached HEAD after checkout. Current branch:", state.currentBranch);
          
          // Try one more time to reload branches
          await loadBranches();
          
          // Check again
          const stillDetached = !state.currentBranch || 
                               state.currentBranch === "HEAD" || 
                               (state.currentBranch.length === 40 && /^[0-9a-f]{40}$/i.test(state.currentBranch)) ||
                               !state.branches || 
                               !state.branches.includes(state.currentBranch);
          
          if (stillDetached) {
            setStatus("Checkout completed but still in detached HEAD state. Please try again.", true);
          } else {
            // Actually succeeded on second check
            state.detachedHeadCommit = null;
            state.previousBranch = null;
            updateDetachedHeadStatus();
            await loadCommits();
            closeExitDetachedHeadModal();
            setStatus(`Switched to branch: ${state.currentBranch}`, false);
            setTimeout(() => setStatus(""), 2000);
          }
        }
      } else {
        // Checkout failed
        state.isCheckingOutBranch = false;
        setStatus(result.error || result.message || "Failed to checkout branch", true);
        closeExitDetachedHeadModal();
      }
    } catch (err) {
      console.error('Failed to checkout branch:', err);
      state.isCheckingOutBranch = false;
      setStatus("Failed to checkout branch: " + (err.message || err), true);
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

// Handle repos root folder selection
if (reposRootButton) {
  reposRootButton.addEventListener("click", () => {
    openReposRootModal();
  });
}

if (reposRootCloseButton) {
  reposRootCloseButton.addEventListener("click", () => {
    closeReposRootModal();
  });
}

if (reposRootCancelButton) {
  reposRootCancelButton.addEventListener("click", () => {
    closeReposRootModal();
  });
}

if (reposRootModal) {
  // Close when clicking on dimmed backdrop
  reposRootModal.addEventListener("click", (e) => {
    if (e.target === reposRootModal) {
      closeReposRootModal();
    }
  });
}

async function applyReposRootFromInput() {
  if (!reposRootPathInput) return;

  const raw = reposRootPathInput.value.trim();
  const normalized = normalizePath(raw);

  if (normalized) {
    window.localStorage.setItem("gitzada:reposRoot", normalized);
    window.localStorage.setItem("gitzada:reposRootOnboarded", "true");
    await loadRepos();
    setStatus(`Projects folder set to: ${normalized}`);
  } else {
    // Treat empty input as "stick with server default", but remember that user made a choice
    window.localStorage.removeItem("gitzada:reposRoot");
    window.localStorage.setItem("gitzada:reposRootOnboarded", "true");
    await loadRepos();
    setStatus("Projects folder cleared; using server default");
  }

  closeReposRootModal();
}

if (reposRootUseDefaultButton) {
  reposRootUseDefaultButton.addEventListener("click", async () => {
    try {
      const config = await api("/api/config");
      const serverRoot = normalizePath(config && config.reposRoot ? config.reposRoot : "");

      if (serverRoot) {
        window.localStorage.setItem("gitzada:reposRoot", serverRoot);
      } else {
        window.localStorage.removeItem("gitzada:reposRoot");
      }
      window.localStorage.setItem("gitzada:reposRootOnboarded", "true");

      await loadRepos();
      setStatus(
        serverRoot
          ? `Projects folder set to: ${serverRoot}`
          : "Projects folder set to server default"
      );
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      setStatus("Failed to read server default projects folder: " + message, true);
    }
    closeReposRootModal();
  });
}

if (reposRootSaveButton && reposRootPathInput) {
  reposRootSaveButton.addEventListener("click", () => {
    applyReposRootFromInput();
  });

  // Support pressing Enter inside the input to save
  reposRootPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyReposRootFromInput();
    }
  });
}

if (reposRootBrowseButton && reposRootPathInput) {
  reposRootBrowseButton.addEventListener("click", async () => {
    console.log('Browse button clicked');
    try {
      console.log('Calling browse_projects_root...');
      const result = await api("/api/browse/projects-root");
      console.log('Browse result:', result);
      if (result && result.path) {
        const normalized = normalizePath(result.path);
        reposRootPathInput.value = normalized;
        await applyReposRootFromInput();
      } else {
        console.warn('Browse returned no path:', result);
        setStatus("No folder selected", true);
      }
    } catch (e) {
      console.error('Browse error:', e);
      const message = e && e.message ? e.message : String(e);
      const lower = message.toLowerCase();
      if (lower.includes("not found") || lower.includes("404")) {
        setStatus(
          "The running server does not expose the folder picker endpoint. Restart it from this codebase (e.g. run.bat/dev.bat), or type the path manually.",
          true
        );
      } else if (lower.includes("cancel")) {
        // User cancelled the dialog; no need to surface an error
        setStatus("", null);
      } else {
        setStatus("Unable to open folder picker: " + message, true);
      }
    }
  });
}

repoSelect.addEventListener("change", async e => {
  const newRepo = e.target.value || null;

  // --- Hard reset commit/cache state on repo change --------------------
  // Abort any in-flight all-branches aggregation tied to the previous repo.
  if (currentCommitsAllBranchesController) {
    try {
      currentCommitsAllBranchesController.abort();
    } catch (err) {
      console.warn("Error aborting all-branches controller on repo change:", err);
    }
    currentCommitsAllBranchesController = null;
  }

  state.currentRepo = newRepo;
  state.currentBranch = null; // force loadBranches to pick a fresh default
  state.currentCommit = null;
  state.currentFile = null;

  // Clear commit data so we don't render stale lists/graphs
  state.commits = [];
  state.filteredCommits = [];
  state.totalCommits = 0;

  // Reset loading/caching flags so the new repo can load freely
  isLoadingCommits = false;
  currentLoadRequestId = null;
  loadedCommitsKey = null;
  cachedAllBranchesCommits = null;
  cachedAllBranchesKey = null;
  isPreloadingAllBranches = false;
  isPreloadScheduled = false;
  commitsAgoCache.clear(); // Clear commits ago cache when repo changes
  state.lastActivityRepo = null;
  state.lastActivityBranch = null;
  state.lastActivityCommits = null;
  state.lastActivityFilteredCommits = null;
  state.lastActivityTotalCommits = null;
  // ---------------------------------------------------------------------

  // Persist last chosen repo
  if (state.currentRepo) {
    window.localStorage.setItem("gitzada:lastRepoId", state.currentRepo);
  } else {
    window.localStorage.removeItem("gitzada:lastRepoId");
  }

  // Clear UI panels
  commitList.innerHTML = "";
  fileList.innerHTML = "";
  const diffContent = document.getElementById("diffContent");
  const diffHeader = document.getElementById("diffHeader");
  if (diffContent) diffContent.textContent = "";
  if (diffHeader) diffHeader.textContent = "";

  // For graph mode, show a consistent loading hint while new repo initializes
  if (isGraphMode() && state.currentRepo) {
    setStatusMessage("Loading commits for new repository…");
  }

  // Load branches (which will also call loadCommits())
  if (state.currentRepo) await loadBranches();
});

branchSelect.addEventListener("change", async e => {
  // Clear detached HEAD state when selecting a branch
  if (state.detachedHeadCommit) {
    state.detachedHeadCommit = null;
    state.previousBranch = null;
    updateDetachedHeadStatus();
  }
  
  const selectedBranch = e.target.value;
  state.currentBranch = selectedBranch || null;
  state.currentCommit = null;
  state.currentFile = null;
  commitList.innerHTML = "";
  fileList.innerHTML = "";
  const diffContent = document.getElementById("diffContent");
  const diffHeader = document.getElementById("diffHeader");
  if (diffContent) diffContent.textContent = "";
  if (diffHeader) diffHeader.textContent = "";
  
  // Update branch label
  if (branchLabelEl) {
    branchLabelEl.textContent = (selectedBranch === "__ALL__") ? "All" : (selectedBranch || "");
  }
  
  // Handle cache when branch changes - let loadCommits() check for cached data first
  if (state.currentBranch) {
    // Only clear __ALL__ cache if switching to a different repo
    if (state.currentBranch !== "__ALL__" && cachedAllBranchesKey) {
      const parsed = parseCacheKey(cachedAllBranchesKey);
      if (parsed.repo && parsed.repo !== state.currentRepo) {
        // Different repo, clear everything
        cachedAllBranchesCommits = null;
        cachedAllBranchesKey = null;
      }
      // Otherwise keep __ALL__ cache when switching to single branch
    }
    // Don't clear loadedCommitsKey here - let loadCommits() check if we have cached data
    // for the new branch first. It will handle cache invalidation if needed.
    await loadCommits();
  }
});

// Fetch button functionality moved to js/git-ops.js

// Debounce filter input to avoid re-rendering on every keystroke
let filterDebounceTimer = null;
const FILTER_DEBOUNCE_MS = 150; // 150ms debounce for typing

searchInput.addEventListener("input", () => {
  if (filterDebounceTimer) {
    clearTimeout(filterDebounceTimer);
  }
  filterDebounceTimer = setTimeout(() => {
    filterDebounceTimer = null;
    applyCommitFilter();
  }, FILTER_DEBOUNCE_MS);
});

// Settings modal handlers
if (settingsButton) {
  settingsButton.addEventListener("click", () => {
    if (settingsModal) {
      settingsModal.style.display = "flex";
      // Update About tab info when settings modal opens (if About tab is active)
      const aboutTab = document.getElementById("aboutTab");
      if (aboutTab && aboutTab.classList.contains("active")) {
        updateAboutTabInfo();
      }
      // Load current colors into inputs
      const colorInputs = {
        colorCommitMessage: colorSettings.commitMessage,
        colorActiveCommit: colorSettings.activeCommit,
        colorAddedFile: colorSettings.addedFile,
        colorModifiedFile: colorSettings.modifiedFile,
        colorRemovedFile: colorSettings.removedFile,
        colorDiffAdded: colorSettings.diffAdded,
        colorDiffRemoved: colorSettings.diffRemoved,
        colorDiffHunk: colorSettings.diffHunk
      };
      Object.keys(colorInputs).forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = colorInputs[id];
      });
      // Load separateByMonths toggle
      const separateByMonthsInputEl = document.getElementById("separateByMonths");
      if (separateByMonthsInputEl) {
        separateByMonthsInputEl.checked = state.separateByMonths;
      }
      // Load dateFormatTimestamp toggle (inverted: true means show timestamps, false means show human-readable)
      const dateFormatTimestampInputEl = document.getElementById("dateFormatTimestamp");
      if (dateFormatTimestampInputEl) {
        dateFormatTimestampInputEl.checked = !state.dateFormatHuman;
      }
      // Load seek depth input
      const seekDepthInputEl = document.getElementById("seekDepthInput");
      if (seekDepthInputEl) {
        seekDepthInputEl.value = state.seekDepthPerBranch || getSeekDepthPerBranch();
      }
      // Load global commit cap input
      const globalCommitCapInputEl = document.getElementById("globalCommitCapInput");
      if (globalCommitCapInputEl) {
        globalCommitCapInputEl.value = state.globalCommitCap || getGlobalCommitCap();
      }
      // Load max branches for all input
      const maxBranchesForAllInputEl = document.getElementById("maxBranchesForAllInput");
      if (maxBranchesForAllInputEl) {
        maxBranchesForAllInputEl.value = state.maxBranchesForAll || getMaxBranchesForAll();
      }
      // Load collapse branches toggle
      const collapseBranchesToggleEl = document.getElementById("collapseBranchesToggle");
      if (collapseBranchesToggleEl) {
        collapseBranchesToggleEl.checked = localStorage.getItem("gitzada:collapseBranches") === "true";
      }
      // Load automatic fetches toggle (defaults to false/off)
      const automaticFetchesToggleEl = document.getElementById("automaticFetchesToggle");
      if (automaticFetchesToggleEl) {
        automaticFetchesToggleEl.checked = localStorage.getItem("gitzada:automaticFetches") === "true";
      }
      // Load Non-Active Branch filter settings
      const filterMergedBranchesEl = document.getElementById("filterMergedBranches");
      if (filterMergedBranchesEl) {
        filterMergedBranchesEl.checked = localStorage.getItem("gitzada:filterMergedBranches") === "true";
      }
      const filterStaleBranchesEl = document.getElementById("filterStaleBranches");
      if (filterStaleBranchesEl) {
        filterStaleBranchesEl.checked = localStorage.getItem("gitzada:filterStaleBranches") === "true";
      }
      const staleThresholdMonthsEl = document.getElementById("staleThresholdMonths");
      if (staleThresholdMonthsEl) {
        staleThresholdMonthsEl.value = localStorage.getItem("gitzada:staleThresholdMonths") || "3";
      }
      const filterUnbornBranchesEl = document.getElementById("filterUnbornBranches");
      if (filterUnbornBranchesEl) {
        filterUnbornBranchesEl.checked = localStorage.getItem("gitzada:filterUnbornBranches") === "true";
      }
      // Load font settings
      const fontActivityEl = document.getElementById("fontActivity");
      if (fontActivityEl) {
        const savedFont = localStorage.getItem("gitzada:fontActivity") || "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        fontActivityEl.value = savedFont;
        // If saved font is not in dropdown, add it as a custom option
        if (!Array.from(fontActivityEl.options).some(opt => opt.value === savedFont)) {
          const option = document.createElement("option");
          option.value = savedFont;
          option.textContent = "Custom: " + savedFont.substring(0, 30) + (savedFont.length > 30 ? "..." : "");
          fontActivityEl.appendChild(option);
          fontActivityEl.value = savedFont;
        }
      }
      const fontVerticalMapEl = document.getElementById("fontVerticalMap");
      if (fontVerticalMapEl) {
        const savedFont = localStorage.getItem("gitzada:fontVerticalMap") || "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        fontVerticalMapEl.value = savedFont;
        // If saved font is not in dropdown, add it as a custom option
        if (!Array.from(fontVerticalMapEl.options).some(opt => opt.value === savedFont)) {
          const option = document.createElement("option");
          option.value = savedFont;
          option.textContent = "Custom: " + savedFont.substring(0, 30) + (savedFont.length > 30 ? "..." : "");
          fontVerticalMapEl.appendChild(option);
          fontVerticalMapEl.value = savedFont;
        }
      }
      const fontHorizontalMapEl = document.getElementById("fontHorizontalMap");
      if (fontHorizontalMapEl) {
        const savedFont = localStorage.getItem("gitzada:fontHorizontalMap") || "Arial, sans-serif";
        fontHorizontalMapEl.value = savedFont;
        // If saved font is not in dropdown, add it as a custom option
        if (!Array.from(fontHorizontalMapEl.options).some(opt => opt.value === savedFont)) {
          const option = document.createElement("option");
          option.value = savedFont;
          option.textContent = "Custom: " + savedFont.substring(0, 30) + (savedFont.length > 30 ? "..." : "");
          fontHorizontalMapEl.appendChild(option);
          fontHorizontalMapEl.value = savedFont;
        }
      }
      // Note: Horizontal map transparency and size sliders are now in the Controls element
      // They are loaded and handled in graph.js setupOverlay()
    }
  });
}

if (settingsClose) {
  settingsClose.addEventListener("click", () => {
    if (settingsModal) settingsModal.style.display = "none";
  });
}

// Close modal on background click
if (settingsModal) {
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) {
      settingsModal.style.display = "none";
    }
  });
}

// formatBytes, getMemoryUsage, and getCacheUsage are now loaded from utils.js module

// Update memory and cache info in About tab
function updateAboutTabInfo() {
  const memoryEl = document.getElementById("memoryUsage");
  const cacheEl = document.getElementById("cacheUsage");
  
  if (memoryEl) {
    memoryEl.textContent = `Memory: ${getMemoryUsage()}`;
  }
  if (cacheEl) {
    cacheEl.textContent = `Cache: ${getCacheUsage()}`;
  }
  
  // Update external libraries list
  updateLibrariesList();
}

// Update external libraries list from generated file
function updateLibrariesList() {
  const librariesListEl = document.getElementById("librariesList");
  if (!librariesListEl) return;
  
  // Check if libraries.js has loaded
  if (typeof window.EXTERNAL_LIBRARIES !== 'undefined' && Array.isArray(window.EXTERNAL_LIBRARIES)) {
    const libraries = window.EXTERNAL_LIBRARIES;
    if (libraries.length > 0) {
      librariesListEl.innerHTML = libraries.map(lib => 
        `• ${lib.name} ${lib.version}`
      ).join('<br>');
    } else {
      librariesListEl.textContent = "No libraries found";
    }
  } else {
    // Fallback: libraries.js not loaded yet or doesn't exist
    // Try again after a short delay
    setTimeout(() => {
      if (typeof window.EXTERNAL_LIBRARIES !== 'undefined' && Array.isArray(window.EXTERNAL_LIBRARIES)) {
        updateLibrariesList();
      } else {
        librariesListEl.textContent = "Libraries list unavailable";
      }
    }, 100);
  }
}

// Initialize libraries list on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Wait a bit for libraries.js to load
    setTimeout(updateLibrariesList, 200);
  });
} else {
  // DOM already loaded
  setTimeout(updateLibrariesList, 200);
}

// Settings tab switching
document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const tabName = tab.dataset.tab;
    // Update tab buttons
    document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    // Update tab panes
    document.querySelectorAll(".settings-tab-pane").forEach(pane => pane.classList.remove("active"));
    const targetPane = document.getElementById(tabName + "Tab");
    if (targetPane) targetPane.classList.add("active");
    
    // Update memory and cache info when About tab is opened
    if (tabName === "about") {
      updateAboutTabInfo();
      // Update periodically while About tab is visible
      const updateInterval = setInterval(() => {
        const aboutTab = document.getElementById("aboutTab");
        if (aboutTab && aboutTab.classList.contains("active")) {
          updateAboutTabInfo();
        } else {
          clearInterval(updateInterval);
        }
      }, 2000); // Update every 2 seconds
    }
  });
});

// Separate by months toggle handler
const separateByMonthsInput = document.getElementById("separateByMonths");
if (separateByMonthsInput) {
  separateByMonthsInput.addEventListener("change", (e) => {
    state.separateByMonths = e.target.checked;
    localStorage.setItem("gitzada:separateByMonths", state.separateByMonths ? "true" : "false");
    renderCommitList();
  });
}

// Date format toggle handler (timestamp vs human-readable)
const dateFormatTimestampInput = document.getElementById("dateFormatTimestamp");
if (dateFormatTimestampInput) {
  dateFormatTimestampInput.addEventListener("change", (e) => {
    // Inverted: checkbox checked = show timestamps (dateFormatHuman = false)
    state.dateFormatHuman = !e.target.checked;
    localStorage.setItem("gitzada:dateFormatHuman", state.dateFormatHuman ? "true" : "false");
    // Re-render commits in both Activity view and NEO views
    if (state.historyMode === "activity") {
      renderCommitList();
    } else {
      renderNeoCommits();
    }
  });
}

// Seek depth input handler (per-branch seek depth for All-branches map views)
const seekDepthInput = document.getElementById("seekDepthInput");
if (seekDepthInput) {
  seekDepthInput.addEventListener("change", (e) => {
    let value = parseInt(e.target.value, 10);
    if (!Number.isFinite(value)) {
      value = DEFAULT_SEEK_DEPTH_PER_BRANCH;
    }
    if (value < 10) value = 10;
    if (value > GRAPH_BRANCH_HISTORY_LIMIT) value = GRAPH_BRANCH_HISTORY_LIMIT;
    state.seekDepthPerBranch = value;
    localStorage.setItem("gitzada:seekDepthPerBranch", String(value));
    // Normalize input display
    e.target.value = String(value);
  });
}

// Max branches for all input handler
const maxBranchesForAllInput = document.getElementById("maxBranchesForAllInput");
if (maxBranchesForAllInput) {
  maxBranchesForAllInput.addEventListener("change", (e) => {
    let value = parseInt(e.target.value, 10);
    if (!Number.isFinite(value)) {
      value = DEFAULT_MAX_BRANCHES_FOR_ALL;
    }
    if (value < 10) value = 10;
    if (value > 500) value = 500;
    state.maxBranchesForAll = value;
    localStorage.setItem("gitzada:maxBranchesForAll", String(value));
    // Normalize input display
    e.target.value = String(value);
    // Reload commits if in graph mode with __ALL__ selected
    if (isGraphMode() && state.currentBranch === "__ALL__") {
      loadedCommitsKey = null;
      loadCommits();
    }
  });
}

// Global commit cap input handler (All-branches map views)
const globalCommitCapInput = document.getElementById("globalCommitCapInput");
if (globalCommitCapInput) {
  globalCommitCapInput.addEventListener("change", (e) => {
    let value = parseInt(e.target.value, 10);
    if (!Number.isFinite(value)) {
      value = DEFAULT_GLOBAL_COMMIT_CAP;
    }
    if (value < 200) value = 200;
    if (value > GRAPH_VIEW_MAX_COMMITS) value = GRAPH_VIEW_MAX_COMMITS;
    state.globalCommitCap = value;
    localStorage.setItem("gitzada:globalCommitCap", String(value));
    // Normalize input display
    e.target.value = String(value);
  });
}

// Collapse branches toggle handler
const collapseBranchesToggle = document.getElementById("collapseBranchesToggle");
if (collapseBranchesToggle) {
  collapseBranchesToggle.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    localStorage.setItem("gitzada:collapseBranches", enabled ? "true" : "false");
    // Re-render graph if in graph mode to apply the change
    if (isGraphMode() && state.currentBranch === "__ALL__" && window.graphView && window.graphView.renderGraph) {
      const commitsToRender = state.filteredCommits || state.commits || [];
      if (commitsToRender.length > 0) {
        window.graphView.renderGraph(commitsToRender, {
          repo: state.currentRepo,
          allBranches: true,
          focusBranch: state.defaultBranch || null,
        });
      }
    }
  });
}

// Automatic fetches toggle handler
const automaticFetchesToggle = document.getElementById("automaticFetchesToggle");
if (automaticFetchesToggle) {
  // Load saved preference (defaults to false/off)
  const saved = localStorage.getItem("gitzada:automaticFetches");
  automaticFetchesToggle.checked = saved === "true";
  
  automaticFetchesToggle.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    localStorage.setItem("gitzada:automaticFetches", enabled ? "true" : "false");
  });
}

// Active Only toggle handler
const activeOnlyToggle = document.getElementById("activeOnlyToggle");
if (activeOnlyToggle) {
  const saved = localStorage.getItem("gitzada:activeOnly");
  activeOnlyToggle.checked = saved === "true";
  activeOnlyToggle.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    localStorage.setItem("gitzada:activeOnly", enabled ? "true" : "false");
    applyActiveBranchFilter();
    // Immediately apply filter to existing commits and re-render
    applyCommitFilter();
    // Also reload commits in background to ensure we have fresh data
    loadedCommitsKey = null;
    loadCommits();
  });
}

// Non-Active Branch filter settings handlers
const filterMergedBranches = document.getElementById("filterMergedBranches");
if (filterMergedBranches) {
  const saved = localStorage.getItem("gitzada:filterMergedBranches");
  filterMergedBranches.checked = saved === "true";
  filterMergedBranches.addEventListener("change", (e) => {
    localStorage.setItem("gitzada:filterMergedBranches", e.target.checked ? "true" : "false");
    // Re-apply filters if Active Only is enabled
    if (localStorage.getItem("gitzada:activeOnly") === "true") {
      applyActiveBranchFilter();
      loadedCommitsKey = null;
      loadCommits();
    }
  });
}

const filterStaleBranches = document.getElementById("filterStaleBranches");
if (filterStaleBranches) {
  const saved = localStorage.getItem("gitzada:filterStaleBranches");
  filterStaleBranches.checked = saved === "true";
  filterStaleBranches.addEventListener("change", (e) => {
    localStorage.setItem("gitzada:filterStaleBranches", e.target.checked ? "true" : "false");
    // Re-apply filters if Active Only is enabled
    if (localStorage.getItem("gitzada:activeOnly") === "true") {
      applyActiveBranchFilter();
      loadedCommitsKey = null;
      loadCommits();
    }
  });
}

const staleThresholdMonths = document.getElementById("staleThresholdMonths");
if (staleThresholdMonths) {
  const saved = localStorage.getItem("gitzada:staleThresholdMonths") || "3";
  staleThresholdMonths.value = saved;
  staleThresholdMonths.addEventListener("change", (e) => {
    localStorage.setItem("gitzada:staleThresholdMonths", e.target.value);
    // Re-apply filters if Active Only is enabled
    if (localStorage.getItem("gitzada:activeOnly") === "true") {
      applyActiveBranchFilter();
      loadedCommitsKey = null;
      loadCommits();
    }
  });
}

const filterUnbornBranches = document.getElementById("filterUnbornBranches");
if (filterUnbornBranches) {
  const saved = localStorage.getItem("gitzada:filterUnbornBranches");
  filterUnbornBranches.checked = saved === "true";
  filterUnbornBranches.addEventListener("change", (e) => {
    localStorage.setItem("gitzada:filterUnbornBranches", e.target.checked ? "true" : "false");
    // Re-apply filters if Active Only is enabled
    if (localStorage.getItem("gitzada:activeOnly") === "true") {
      applyActiveBranchFilter();
      loadedCommitsKey = null;
      loadCommits();
    }
  });
}

// Control settings toggle handlers
const invertUpDownInput = document.getElementById("invertUpDown");
if (invertUpDownInput) {
  invertUpDownInput.addEventListener("change", (e) => {
    state.invertUpDown = e.target.checked;
    localStorage.setItem("gitzada:invertUpDown", state.invertUpDown ? "true" : "false");
  });
}

const invertLeftRightInput = document.getElementById("invertLeftRight");
if (invertLeftRightInput) {
  invertLeftRightInput.addEventListener("change", (e) => {
    state.invertLeftRight = e.target.checked;
    localStorage.setItem("gitzada:invertLeftRight", state.invertLeftRight ? "true" : "false");
  });
}

// Font input change handlers
const fontActivityInput = document.getElementById("fontActivity");
if (fontActivityInput) {
  fontActivityInput.addEventListener("change", (e) => {
    const font = e.target.value.trim() || "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    localStorage.setItem("gitzada:fontActivity", font);
    // Re-render commit list to apply font
    renderCommitList();
  });
}

const fontVerticalMapInput = document.getElementById("fontVerticalMap");
if (fontVerticalMapInput) {
  fontVerticalMapInput.addEventListener("change", (e) => {
    const font = e.target.value.trim() || "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    localStorage.setItem("gitzada:fontVerticalMap", font);
    // Re-render graph if in vertical map mode
    if (isGraphMode() && window.graphView && window.graphView.renderGraph && graphState.orientation === "vertical") {
      const commitsToRender = state.filteredCommits || state.commits || [];
      if (commitsToRender.length > 0) {
        window.graphView.renderGraph(commitsToRender, {
          repo: state.currentRepo,
          allBranches: state.currentBranch === "__ALL__",
          focusBranch: state.defaultBranch || null,
        });
      }
    }
  });
}

const fontHorizontalMapInput = document.getElementById("fontHorizontalMap");
if (fontHorizontalMapInput) {
  fontHorizontalMapInput.addEventListener("change", (e) => {
    const font = e.target.value.trim() || "Arial, sans-serif";
    localStorage.setItem("gitzada:fontHorizontalMap", font);
    // Re-render graph if in horizontal map mode
    if (isGraphMode() && window.graphView && window.graphView.renderGraph && graphState.orientation === "horizontal") {
      const commitsToRender = state.filteredCommits || state.commits || [];
      if (commitsToRender.length > 0) {
        window.graphView.renderGraph(commitsToRender, {
          repo: state.currentRepo,
          allBranches: state.currentBranch === "__ALL__",
          focusBranch: state.defaultBranch || null,
        });
      }
    }
  });
}

// Note: Horizontal map transparency and size sliders are now handled in graph.js
// They are part of the Controls element in the graph view

// Color input change handlers
const colorInputIds = ["colorCommitMessage", "colorActiveCommit", "colorAddedFile", "colorModifiedFile", "colorRemovedFile", "colorDiffAdded", "colorDiffRemoved", "colorDiffHunk"];
const keyMap = {
  "colorCommitMessage": "commitMessage",
  "colorActiveCommit": "activeCommit",
  "colorAddedFile": "addedFile",
  "colorModifiedFile": "modifiedFile",
  "colorRemovedFile": "removedFile",
  "colorDiffAdded": "diffAdded",
  "colorDiffRemoved": "diffRemoved",
  "colorDiffHunk": "diffHunk"
};

colorInputIds.forEach(id => {
  const input = document.getElementById(id);
  if (input) {
    input.addEventListener("input", (e) => {
      const color = e.target.value;
      const settingKey = keyMap[id];
      if (settingKey) {
        colorSettings[settingKey] = color;
        localStorage.setItem(`gitzada:color:${settingKey}`, color);
        applyColorSettings();
        // Re-render affected UI elements
        if (id === "colorCommitMessage") {
          renderCommitList();
          renderNeoCommits();
        } else if (id === "colorActiveCommit") {
          renderCommitList();
        } else if (id === "colorAddedFile" || id === "colorModifiedFile" || id === "colorRemovedFile") {
          renderFileList();
        } else if (id === "colorDiffAdded" || id === "colorDiffRemoved" || id === "colorDiffHunk") {
          if (state.currentFile) loadCommitFileDiff();
        }
      }
    });
  }
});

// View mode toggle - cycles through: Activity → Vertical Map → Horizontal Map → Activity
const viewModeToggle = document.getElementById("viewModeToggle");
if (viewModeToggle) {
  viewModeToggle.addEventListener("click", async () => {
    // Remove focus immediately after click/tap
    viewModeToggle.blur();
    
    const currentMode = state.historyMode || "activity";
    let nextMode;
    let nextLabel;
    let nextTitle;
    
    // Cycle: activity → neo-vertical → neo-horizontal → activity
    if (currentMode === "activity") {
      nextMode = "neo-vertical";
      nextLabel = "Vertical Map";
      nextTitle = "Vertical Map: WebGL lane visualization (vertical)";
    } else if (currentMode === "neo-vertical") {
      nextMode = "neo-horizontal";
      nextLabel = "Horizontal Map";
      nextTitle = "Horizontal Map: WebGL lane visualization (horizontal)";
    } else {
      // neo-horizontal or any other state
      nextMode = "activity";
      nextLabel = "Activity";
      nextTitle = "Activity: Active branch + main + merges";
    }
    
    const wasNeo = currentMode === "neo-vertical" || currentMode === "neo-horizontal";
    const isNeo = nextMode === "neo-vertical" || nextMode === "neo-horizontal";
    const hadActivitySnapshot =
      state.lastActivityRepo === state.currentRepo &&
      !!state.lastActivityBranch &&
      Array.isArray(state.lastActivityCommits) &&
      state.lastActivityCommits.length > 0;
    
    // Determine orientation for graph views
    let orientation = "vertical";
    if (nextMode === "neo-horizontal") {
      orientation = "horizontal";
    } else if (nextMode === "neo-vertical") {
      orientation = "vertical";
    }
    
    // Set graph orientation if switching to graph view
    if (isNeo && window.graphView && window.graphView.setGraphOrientation) {
      window.graphView.setGraphOrientation(orientation);
    }
    
    // Update state
    state.historyMode = nextMode;
    
    // Update button appearance
    viewModeToggle.textContent = nextLabel;
    viewModeToggle.dataset.mode = nextMode;
    viewModeToggle.title = nextTitle;
    viewModeToggle.setAttribute("aria-label", `${nextLabel} view mode`);

    const switchingIntoGraph = !wasNeo && isNeo;
    const switchingOutOfGraph = wasNeo && !isNeo;

    // IMPORTANT: Save Activity view snapshot BEFORE switching into graph mode
    // This preserves the commit count and branch selection for when we switch back
    if (switchingIntoGraph && !wasNeo) {
      // Save current Activity state before overwriting with __ALL__ data
      state.lastActivityRepo = state.currentRepo;
      state.lastActivityBranch = state.currentBranch;
      state.lastActivityCommits = state.commits ? state.commits.slice() : [];
      state.lastActivityFilteredCommits = state.filteredCommits ? state.filteredCommits.slice() : [];
      state.lastActivityTotalCommits = state.totalCommits;
      console.log("[View Toggle] Saved Activity snapshot:", {
        repo: state.lastActivityRepo,
        branch: state.lastActivityBranch,
        commits: state.lastActivityCommits.length,
        total: state.lastActivityTotalCommits
      });
    }

    // If switching away from graph view, prefer the last Activity branch if we have one.
    // Otherwise, if "__ALL__" is selected, fall back to the first real branch.
    if (switchingOutOfGraph) {
      if (hadActivitySnapshot && state.lastActivityRepo === state.currentRepo) {
        state.currentBranch = state.lastActivityBranch;
      } else if (state.currentBranch === "__ALL__") {
        state.currentBranch = state.branches[0] || null;
      }
    }

    // Strong invariant when entering graph views:
    // - Always use "__ALL__" branch for graphs.
    // - Either render from cachedAllBranchesCommits for this repo, or show available data while loading.
    if (switchingIntoGraph) {
      const repo = state.currentRepo;
      state.currentBranch = "__ALL__";

      let hasAllBranchesCached = false;
      console.log("[View Toggle] Initial cache check:", {
        hasCachedCommits: !!cachedAllBranchesCommits,
        cachedCommitsLength: cachedAllBranchesCommits ? cachedAllBranchesCommits.length : 0,
        cachedKey: cachedAllBranchesKey,
        currentRepo: repo,
        isPreloadScheduled,
        isPreloadingAllBranches
      });
      
      if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0 && cachedAllBranchesKey) {
        const parsed = parseCacheKey(cachedAllBranchesKey);
        console.log("[View Toggle] Cache key parsed:", parsed, "repo:", repo);
        if (parsed.repo === repo) {
          hasAllBranchesCached = true;
          console.log(
            "[View Toggle] ✓ Found preloaded __ALL__ commits:",
            cachedAllBranchesCommits.length,
            "commits for",
            repo
          );
        } else {
          console.log(
            "[View Toggle] ✗ Cached __ALL__ commits exist but for different repo:",
            parsed.repo,
            "vs",
            repo
          );
        }
      } else {
        console.log(
          "[View Toggle] ✗ No cached __ALL__ commits found. cachedAllBranchesCommits:",
          cachedAllBranchesCommits ? cachedAllBranchesCommits.length : "null",
          "cachedAllBranchesKey:",
          cachedAllBranchesKey,
          "isPreloadScheduled:",
          isPreloadScheduled,
          "isPreloadingAllBranches:",
          isPreloadingAllBranches
        );
      }

      if (hasAllBranchesCached) {
        // Bind graph data directly to the __ALL__ cache
        const cacheKey = `${repo}:__ALL__:full`;
        state.commits = cachedAllBranchesCommits.slice();
        state.filteredCommits = state.commits;
        state.totalCommits = state.commits.length;
        loadedCommitsKey = cacheKey;
        cachedAllBranchesKey = cacheKey;
        setStatusMessage("");
        // Return early - we have the data, no need to call loadCommits()
        // Skip the rest of the toggle handler and just render
        switchViewMode(isNeo);
        await new Promise(resolve => requestAnimationFrame(resolve));
        applyActiveBranchFilter();
        if (branchLabelEl) {
          branchLabelEl.textContent = state.currentBranch === "__ALL__" ? "All" : (state.currentBranch || "");
        }
        updateCommitCountDisplay(); // Update count before rendering
        renderCommitList();
        return; // Exit early, don't call loadCommits()
      } else if (isPreloadScheduled || isPreloadingAllBranches) {
        // Preload is scheduled or in progress - wait briefly for it to complete
        // Show available single-branch commits immediately while waiting
        const availableCommits = state.commits && state.commits.length > 0 ? state.commits.slice() : [];
        if (availableCommits.length > 0) {
          // Show what we have immediately - graph will upgrade when preload completes
          state.commits = availableCommits;
          state.filteredCommits = availableCommits;
          setStatusMessage("Loading all branches for graph…");
          console.log("[View Toggle] Preload scheduled/in-progress, showing available commits while waiting");
        } else {
          state.commits = [];
          state.filteredCommits = [];
          setStatusMessage("Loading all branches for graph…");
        }
        loadedCommitsKey = null; // Will be set when preload completes or loadCommits() runs
      } else {
        // No __ALL__ cache and no preload in progress
        // Show available single-branch commits immediately if we have them, then load __ALL__
        const availableCommits = state.commits && state.commits.length > 0 ? state.commits.slice() : [];
        if (availableCommits.length > 0) {
          // Show what we have immediately - graph will upgrade when __ALL__ loads
          state.commits = availableCommits;
          state.filteredCommits = availableCommits;
          setStatusMessage("Loading all branches for graph…");
          console.log("No __ALL__ cache yet, showing available commits while loading");
        } else {
          state.commits = [];
          state.filteredCommits = [];
          setStatusMessage("Loading all branches for graph…");
        }
        loadedCommitsKey = null;
      }
    }

    // Switch UI immediately before fetching data
    switchViewMode(isNeo);

    // Ensure UI update is painted before starting async work
    await new Promise(resolve => requestAnimationFrame(resolve));

    // When switching to/from graph view, refresh the branch dropdown and commits
    // without refetching branches from the server on every toggle.
    if (wasNeo !== isNeo) {
      // If switching to graph view and preload is scheduled or in progress, wait briefly for it
      if (switchingIntoGraph && (isPreloadScheduled || isPreloadingAllBranches) && !cachedAllBranchesCommits) {
        console.log("Preload scheduled or in progress, waiting briefly for it to complete...");
        // Wait up to 1000ms for preload to complete (longer since it might not have started yet)
        for (let i = 0; i < 20; i++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          // Check if cache is now available
          if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0) {
            const parsed = parseCacheKey(cachedAllBranchesKey);
            if (parsed.repo === state.currentRepo) {
              // Preload completed! Use the cached data
              const cacheKey = `${state.currentRepo}:__ALL__:full`;
              state.commits = cachedAllBranchesCommits.slice();
              state.filteredCommits = state.commits;
              state.totalCommits = state.commits.length;
              loadedCommitsKey = cacheKey;
              cachedAllBranchesKey = cacheKey;
              setStatusMessage("");
              console.log("Preload completed, using cached __ALL__ commits");
              // Skip calling loadCommits() since we have the data
              applyActiveBranchFilter();
              if (branchLabelEl) {
                branchLabelEl.textContent = state.currentBranch === "__ALL__" ? "All" : (state.currentBranch || "");
              }
              updateCommitCountDisplay(); // Update count before rendering
              renderCommitList();
              return; // Exit early, don't call loadCommits()
            }
          }
          // If preload is no longer scheduled or in progress, it finished (success or failure)
          if (!isPreloadScheduled && !isPreloadingAllBranches) {
            break;
          }
        }
      }
      // Don't clear cachedAllBranchesCommits - we want to reuse it across all views!
      // Only clear if switching repos
      if (cachedAllBranchesKey) {
        const parsed = parseCacheKey(cachedAllBranchesKey);
        if (parsed.repo && parsed.repo !== state.currentRepo) {
          // Different repo, clear everything
          cachedAllBranchesCommits = null;
          cachedAllBranchesKey = null;
          loadedCommitsKey = null;
        }
      }

      // Rebuild branch dropdown for the new mode using existing branch data
      applyActiveBranchFilter();
      if (branchLabelEl) {
        branchLabelEl.textContent = state.currentBranch
          ? (state.currentBranch === "__ALL__" ? "All" : state.currentBranch)
          : "";
      }

      // If switching back to Activity view and we have a snapshot of the last
      // Activity commits for this repo/branch, restore it instantly and skip
      // calling loadCommits(). This avoids re-filtering or refetching when
      // toggling between map views and Activity.
      if (!isNeo && hadActivitySnapshot && state.lastActivityRepo === state.currentRepo) {
        state.currentBranch = state.lastActivityBranch;
        state.commits = state.lastActivityCommits ? state.lastActivityCommits.slice() : [];
        state.filteredCommits = state.lastActivityFilteredCommits
          ? state.lastActivityFilteredCommits.slice()
          : state.commits;
        state.totalCommits =
          state.lastActivityTotalCommits != null
            ? state.lastActivityTotalCommits
            : state.commits.length;
        if (state.currentRepo && state.currentBranch) {
          loadedCommitsKey = `${state.currentRepo}:${state.currentBranch}:${state.historyMode || "activity"}`;
        }
        updateCommitCountDisplay(); // Update count before rendering
        renderCommitList();
        return;
      }

      // If switching back to Activity view without a snapshot, check if we can filter from __ALL__ cache
      // This prevents unnecessary fetches when we already have all-branches data cached
      if (switchingOutOfGraph && !isNeo && state.currentBranch && state.currentBranch !== "__ALL__") {
        if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0 && cachedAllBranchesKey) {
          const parsed = parseCacheKey(cachedAllBranchesKey);
          if (parsed.repo === state.currentRepo) {
            // Filter __ALL__ commits for the current branch
            console.log("[View Toggle] Filtering cached __ALL__ commits for Activity view:", state.currentBranch);
            const filteredCommits = cachedAllBranchesCommits.filter(c => {
              if (c.branches && Array.isArray(c.branches) && c.branches.length > 0) {
                return c.branches.includes(state.currentBranch);
              }
              return true; // Include commits with no branches listed
            });
            state.commits = filteredCommits;
            state.filteredCommits = state.commits;
            state.totalCommits = state.commits.length; // Set total to avoid limit=100000 request
            const cacheKey = `${state.currentRepo}:${state.currentBranch}:activity`;
            loadedCommitsKey = cacheKey;
            setStatusMessage("");
            // Don't schedule preload - we already have __ALL__ cache
            updateCommitCountDisplay(); // Update count before rendering
            renderCommitList();
            return; // Don't call loadCommits(), we filtered from cache
          }
        }
      }

      // If switching to graph view and we have cached __ALL__ commits, use them
      // (either from initial check or after waiting for preload)
      if (isNeo && state.currentBranch === "__ALL__") {
        if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0) {
          const parsed = parseCacheKey(cachedAllBranchesKey);
          if (parsed.repo === state.currentRepo) {
            // We have __ALL__ cache - use it
            const cacheKey = `${state.currentRepo}:__ALL__:full`;
            state.commits = cachedAllBranchesCommits.slice();
            state.filteredCommits = state.commits;
            state.totalCommits = state.commits.length;
            loadedCommitsKey = cacheKey;
            cachedAllBranchesKey = cacheKey;
            setStatusMessage("");
            console.log(
              "Graph view: rendering from __ALL__ cache:",
              cachedAllBranchesCommits.length,
              "commits"
            );
            updateCommitCountDisplay(); // Update count before rendering
            renderCommitList();
            return;
          }
        }
      }

      // For both Activity and Graph views (when no Activity snapshot is
      // available), let loadCommits() reuse cached data or fetch as needed.
      // It will handle rendering via displayCachedData().
      
      // Final safety check: if we're switching to graph view with __ALL__, check cache one more time
      // This catches cases where preload completed during the wait loop or between checks
      if (switchingIntoGraph && state.currentBranch === "__ALL__") {
        console.log("[View Toggle] Final safety check before loadCommits():", {
          hasCachedCommits: !!cachedAllBranchesCommits,
          cachedCommitsLength: cachedAllBranchesCommits ? cachedAllBranchesCommits.length : 0,
          cachedKey: cachedAllBranchesKey,
          currentRepo: state.currentRepo,
          currentBranch: state.currentBranch
        });
        
        if (cachedAllBranchesCommits && cachedAllBranchesCommits.length > 0 && cachedAllBranchesKey) {
          const parsed = parseCacheKey(cachedAllBranchesKey);
          if (parsed.repo === state.currentRepo) {
            // Cache exists! Use it instead of calling loadCommits()
            const cacheKey = `${state.currentRepo}:__ALL__:full`;
            state.commits = cachedAllBranchesCommits.slice();
            state.filteredCommits = state.commits;
            loadedCommitsKey = cacheKey;
            cachedAllBranchesKey = cacheKey;
            setStatusMessage("");
            console.log("[View Toggle] ✓ Final check: Found cached __ALL__ commits, using them instead of calling loadCommits()");
            renderCommitList();
            return; // Don't call loadCommits()
          } else {
            console.log("[View Toggle] ✗ Final check: Cache exists but repo mismatch:", parsed.repo, "vs", state.currentRepo);
          }
        } else {
          console.log("[View Toggle] ✗ Final check: No cache found, will call loadCommits()");
        }
      }
      
      console.log("[View Toggle] Calling loadCommits() for", state.currentRepo, state.currentBranch);
      loadCommits().catch(err => {
        console.error("Background commit load failed:", err);
      });
    } else {
      // If switching between graph orientations (vertical/horizontal), the setGraphOrientation call above
      // will handle updating the graph layout. We only need to reload commits if data isn't already cached.
      const cacheKey = `${state.currentRepo}:${state.currentBranch}:full`; // Graph modes use "full"

      // Prefer __ALL__ cache if we're in all-branches mode.
      if (state.currentBranch === "__ALL__") {
        const parsed = parseCacheKey(cachedAllBranchesKey);
        const hasAllBranchesCached =
          cachedAllBranchesCommits &&
          cachedAllBranchesCommits.length > 0 &&
          cachedAllBranchesKey &&
          parsed.repo === state.currentRepo;

        if (hasAllBranchesCached) {
          state.commits = cachedAllBranchesCommits.slice();
          state.filteredCommits = state.commits;
          loadedCommitsKey = cacheKey;
          // Re-render immediately from cache; no need to clear status, as any
          // "Loading commits…" message will be cleared by displayCachedData()
          // when the Activity view uses this data.
          renderCommitList();
          return;
        }
      }

      if (!(loadedCommitsKey === cacheKey && state.commits && state.commits.length > 0)) {
        loadCommits().catch(err => {
          console.error("Background commit load failed:", err);
        });
      } else {
        console.log("Skipping loadCommits - data already cached for", cacheKey);
        renderCommitList();
      }
    }
  });
}

// Commit canvas is now integrated into diffPanel and shown automatically in Activity view
// No toggle button needed

// Resize handles code moved to js/resize-handles.js

// Note: All staging functions (loadStatus, renderStatusLists, loadFileDiff, renderDiff, 
// stageHunk, unstageHunk, updateCommitButton) are now in staging.js
// Functions are exported to window and available globally

// Add event listeners for both subject and description fields
if (commitMessageSubject) {
  commitMessageSubject.addEventListener("input", updateCommitButton);
  commitMessageSubject.addEventListener("keydown", (e) => {
    // Allow Enter to move to description, but prevent form submission
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (commitMessageDescription) {
        commitMessageDescription.focus();
      }
    }
  });
}

if (commitMessageDescription) {
  commitMessageDescription.addEventListener("input", updateCommitButton);
}

// Legacy support for old commitMessage field
if (commitMessage) {
  commitMessage.addEventListener("input", updateCommitButton);
}

// Note: isRefreshingCommits and refreshCommitsAfterCommit are now in staging.js
// Functions are exported to window and available globally

commitButton.addEventListener("click", async () => {
  // Get commit message from subject and description fields
  let commitMsg = "";
  if (commitMessageSubject && commitMessageDescription) {
    // New two-part format: subject + description
    const subject = commitMessageSubject.value.trim();
    const description = commitMessageDescription.value.trim();
    
    if (!subject) return; // Subject is required
    
    if (description) {
      // Combine subject and description with blank line separator (Git convention)
      commitMsg = subject + "\n\n" + description;
    } else {
      commitMsg = subject;
    }
  } else if (commitMessage) {
    // Legacy single field support
    commitMsg = commitMessage.value.trim();
    if (!commitMsg) return;
  } else {
    return; // No commit message fields available
  }
  
  setStatus("Committing...");
  try {
    await api("/api/repos/" + encodeURIComponent(state.currentRepo) + "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: commitMsg })
    });
    
    // Clear both fields after successful commit
    if (commitMessageSubject) commitMessageSubject.value = "";
    if (commitMessageDescription) commitMessageDescription.value = "";
    if (commitMessage) commitMessage.value = ""; // Legacy support
    
    state.stagedHunks.clear();
    await loadStatus();
    await refreshCommitsAfterCommit();
    await checkConflicts();
    setStatus("Commit successful");
  } catch (e) {
    setStatus(e.message, true);
  }
});


// Global key handling: Enhanced keyboard navigation
window.addEventListener("keydown", (e) => {
  // Escape to close modals - handle this first so it works even when typing in inputs
  if (e.key === "Escape") {
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
  const isGraphViewActive = graphContainer && graphContainer.style.display !== "none" && isGraphMode();
  
  // Commit navigation (only when graph view is not active)
  if (!isGraphViewActive) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const delta = state.invertUpDown ? -1 : 1;
      moveCommitSelection(delta);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const delta = state.invertUpDown ? 1 : -1;
      moveCommitSelection(delta);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      const dir = state.invertUpDown ? -1 : 1;
      pageCommitSelection(dir);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      const dir = state.invertUpDown ? 1 : -1;
      pageCommitSelection(dir);
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

// 3D Timeline Visualization - moved to js/timeline3d.js

// Initial bootstrap:
// - If the user has already selected a Projects Folder (stored in localStorage),
//   load repos immediately.
// - Otherwise, show the Projects Folder modal so they can choose a folder explicitly.
// Diagnostic: Check Tauri availability at startup
(function checkTauriAvailability() {
  console.log('[Tauri Check] window.__TAURI__:', typeof window.__TAURI__ !== 'undefined' ? 'available' : 'not available');
  console.log('[Tauri Check] window.__TAURI_INTERNALS__:', typeof window.__TAURI_INTERNALS__ !== 'undefined' ? 'available' : 'not available');
  console.log('[Tauri Check] window.location.protocol:', window.location?.protocol);
  console.log('[Tauri Check] window object keys containing TAURI:', Object.keys(window).filter(k => k.includes('TAURI')));
  
  if (window.__TAURI_INTERNALS__) {
    console.log('[Tauri Check] __TAURI_INTERNALS__ keys:', Object.keys(window.__TAURI_INTERNALS__));
    const internals = window.__TAURI_INTERNALS__;
    // Try to find invoke in the structure
    if (internals.invoke) console.log('[Tauri Check] Found invoke directly on __TAURI_INTERNALS__');
    if (internals.core && internals.core.invoke) console.log('[Tauri Check] Found invoke at __TAURI_INTERNALS__.core.invoke');
    if (internals.ipc && internals.ipc.invoke) console.log('[Tauri Check] Found invoke at __TAURI_INTERNALS__.ipc.invoke');
    // Log all nested keys
    Object.keys(internals).forEach(key => {
      if (typeof internals[key] === 'object' && internals[key] !== null) {
        console.log(`[Tauri Check] __TAURI_INTERNALS__.${key} keys:`, Object.keys(internals[key]));
      }
    });
  }
  
  // Wait a bit and check again (Tauri might inject later)
  setTimeout(() => {
    console.log('[Tauri Check] After 500ms - window.__TAURI__:', typeof window.__TAURI__ !== 'undefined' ? 'available' : 'not available');
    if (typeof window.__TAURI__ === 'undefined' && typeof window.__TAURI_INTERNALS__ === 'undefined') {
      console.warn('[Tauri Check] WARNING: Tauri API not detected. The app may not be running in Tauri.');
    }
  }, 500);
})();

(function bootstrapApp() {
  // Note: Splash screen is now hidden by loadingProgress.hide() when data is ready
  // Don't hide it prematurely here

  const existingRoot = getStoredReposRoot();
  const onboarded =
    window.localStorage.getItem("gitzada:reposRootOnboarded") === "true";

  if (existingRoot) {
    // Persist normalized value back into storage
    window.localStorage.setItem("gitzada:reposRoot", existingRoot);
    loadRepos();
  } else if (onboarded) {
    // User explicitly chose to rely on server default earlier
    loadRepos();
  } else {
    // First run: prompt for a Projects Folder instead of silently assuming one
    // Hide splash before showing modal
    if (window.loadingProgress) {
      window.loadingProgress.hide();
    }
    openReposRootModal();
  }
})();
