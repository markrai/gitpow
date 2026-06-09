/**
 * Loading Controller for GitPow
 *
 * Owns repository, branch, commit loading, and repo/branch selector wiring.
 * Extracted from static/script.js as part of the Phase 2 maintainability pass.
 */

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

// normalizePath (display wrapper over window.normalizePathForDisplay) lives in
// static/js/helpers.js (loaded before script.js). Call sites here resolve via window.normalizePath.

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
    const storedRootRaw = window.gpStorage.get("reposRoot");
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
    const lastRepoId = window.gpStorage.get("lastRepoId") || null;
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

// Branch/commit filtering (isBranchActive, applyActiveBranchFilter,
// updateCommitCountDisplay, isCommitOnActiveBranch, markCommitsActiveStatus,
// applyCommitFilter) lives in static/js/filters.js (loaded before script.js).
// state is already published to window.state by static/js/state.js.

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

async function handleRepoSelectChange(e) {
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
  state.status = { files: [] };
  state.currentDiffFile = null;
  state.unstagedDiffData = null;
  state.stagedDiffData = null;
  if (state.stagedHunks) {
    state.stagedHunks.clear();
  }

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
    window.gpStorage.set("lastRepoId", state.currentRepo);
  } else {
    window.gpStorage.remove("lastRepoId");
  }

  // Clear UI panels
  commitList.innerHTML = "";
  fileList.innerHTML = "";
  const diffContent = document.getElementById("diffContent");
  const diffHeader = document.getElementById("diffHeader");
  if (diffContent) diffContent.textContent = "";
  if (diffHeader) diffHeader.textContent = "";
  if (typeof renderStatusLists === "function") {
    renderStatusLists();
  }

  // For graph mode, show a consistent loading hint while new repo initializes
  if (isGraphMode() && state.currentRepo) {
    setStatusMessage("Loading commits for new repository…");
  }

  // Load branches (which will also call loadCommits())
  if (state.currentRepo) {
    await loadBranches();
    if (!isGraphMode() && typeof loadStatus === "function") {
      await loadStatus();
    }
    if (typeof checkConflicts === "function") {
      await checkConflicts();
    }
  }
}

window.gpEvents.bind({
  owner: "loading",
  key: "repo-select-change",
  target: repoSelect,
  type: "change",
  handler: handleRepoSelectChange
});

async function handleBranchSelectChange(e) {
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
}

window.gpEvents.bind({
  owner: "loading",
  key: "branch-select-change",
  target: branchSelect,
  type: "change",
  handler: handleBranchSelectChange
});
// Compatibility exports for modules that still resolve loading functions via window.
window.loadRepos = loadRepos;
window.loadBranches = loadBranches;
window.loadCommits = loadCommits;
