// All modules are loaded from separate files:
// - dom-elements.js: DOM element references (repoSelect, branchSelect, etc.)
// - searchable-dropdown.js: createSearchableDropdown function
// - state.js: state object, constants, cache helpers
// - utils.js: formatRelativeTime, formatHumanDate, hashColor, getGitHubUsername, getAvatarUrl, fileAccent
// - ui.js: setStatus, setStatusMessage, setFloatingStatusMessage, showGraphLimitNotification,
//          getStoredReposRoot, openReposRootModal, closeReposRootModal
// - api.js: api() function for Tauri/HTTP requests

// Loading controller (repo/branch dropdowns and loadRepos/loadBranches/loadCommits)
// lives in static/js/controllers/loading.js. It exports compatibility globals
// for modules that still call window.loadRepos/window.loadBranches/window.loadCommits.

// Initialize color settings from state.js module
applyColorSettings();

// Filter helpers (updateCommitCountDisplay, isCommitOnActiveBranch,
// markCommitsActiveStatus, applyCommitFilter) live in static/js/filters.js.

// getGraphSymbol and getCommitFadeClass live in static/js/helpers.js (loaded before script.js).
// Call sites here (e.g. renderCommitList) resolve via window.getGraphSymbol / window.getCommitFadeClass.

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

// Collapsible-section helpers (toggleCollapse, loadCollapseState, initCollapsibleSections)
// and their single DOMContentLoaded bootstrap live in static/js/helpers.js. A previous duplicate
// bootstrap here caused initCollapsibleSections to run twice, which bound every collapse
// toggle/header listener twice; clicks fired toggleCollapse twice per interaction (flip then
// flip back = visible no-op). Keep this file as consumer-only to preserve the fix.

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

// File-creation info helpers (processFileCreationQueue, renderFileCreationInfo,
// loadFileCreationInfo, loadFileCreationInfoBatch) live in static/js/file-navigation.js
// (loaded before script.js). Call sites resolve via window.* exports from that module.
// updateActiveFileState was already deduped in an earlier slice.

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

// Context menu logic (showContextMenu, hideContextMenu, outside-click/contextmenu
// dismissers, and the click handlers for contextMenuOpenExplorer, contextMenuViewGitHub,
// contextMenuCopyCommitId) lives in static/js/context-menu.js (loaded before script.js).
// contextMenuCheckoutCommit's click handler lives in static/js/detached-head.js.

// Detached HEAD logic (updateDetachedHeadStatus, show/closeExitDetachedHeadModal,
// and all of the exit-detached-HEAD and context-menu-checkout-commit listeners)
// lives in static/js/detached-head.js (loaded before script.js in index.html).
// Call sites in this file use the window.* exports set by that module.

// Repos Root (Projects Folder) modal handlers live in static/js/repos-root.js.

// Repo/branch selector loading handlers live in static/js/controllers/loading.js.

// Fetch button functionality moved to js/git-ops.js

// Debounce filter input to avoid re-rendering on every keystroke
let filterDebounceTimer = null;
const FILTER_DEBOUNCE_MS = 150; // 150ms debounce for typing

function handleSearchInput() {
  if (filterDebounceTimer) {
    clearTimeout(filterDebounceTimer);
  }
  filterDebounceTimer = setTimeout(() => {
    filterDebounceTimer = null;
    applyCommitFilter();
  }, FILTER_DEBOUNCE_MS);
}

window.gpEvents.bind({
  owner: "script",
  key: "search-input",
  target: searchInput,
  type: "input",
  handler: handleSearchInput
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
async function handleViewModeToggleClick() {
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
}

if (viewModeToggle) {
  window.gpEvents.bind({
    owner: "script",
    key: "view-mode-toggle-click",
    target: viewModeToggle,
    type: "click",
    handler: handleViewModeToggleClick
  });
}

// Commit canvas is now integrated into diffPanel and shown automatically in Activity view
// No toggle button needed

// Resize handles code moved to js/resize-handles.js

// Staging and commit-form singleton handlers live in static/js/staging.js.
// Global keyboard/mouse singleton handlers live in static/js/keyboard.js.

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
  const onboarded = window.gpStorage.get("reposRootOnboarded") === "true";

  if (existingRoot) {
    // Persist normalized value back into storage
    window.gpStorage.set("reposRoot", existingRoot);
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
