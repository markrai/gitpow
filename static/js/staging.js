/**
 * Staging and Commit Operations for GitPow
 * Functions for staging/unstaging files and hunks, committing changes
 * Extracted from script.js for better maintainability
 */

// Guard to prevent concurrent refresh operations
let isRefreshingCommits = false;

async function loadStatus() {
  if (!window.state.currentRepo) return;
  try {
    if (window.api) {
      const statusData = await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/status");
      window.state.status = statusData;
      
      // Show the inner sections when status is loaded (only in Activity view)
      if (window.isGraphMode && !window.isGraphMode()) {
        const unstagedSection = document.getElementById("unstagedSection");
        const stagedSection = document.getElementById("stagedSection");
        const commitForm = document.getElementById("commitForm");
        if (unstagedSection) unstagedSection.style.display = "";
        if (stagedSection) stagedSection.style.display = "";
        if (commitForm) commitForm.style.display = "";
      }
      
      renderStatusLists();
    }
  } catch (e) {
    if (window.setStatus) {
      window.setStatus(e.message, true);
    }
  }
}

function renderStatusLists() {
  const unstagedList = document.getElementById("unstagedList");
  const stagedList = document.getElementById("stagedList");
  const unstagedCount = document.getElementById("unstagedCount");
  const stagedCount = document.getElementById("stagedCount");
  
  if (!unstagedList || !stagedList) return;
  
  unstagedList.innerHTML = "";
  stagedList.innerHTML = "";
  const unstaged = [];
  const staged = [];
  
  if (window.state.status && window.state.status.files) {
    window.state.status.files.forEach(file => {
      // Files can be both staged and unstaged (e.g., modified, staged, then modified again)
      // Prioritize unstaged - if a file has unstaged changes, it goes to unstaged section
      if (file.unstaged || file.type === "untracked") {
        unstaged.push(file);
      } else if (file.staged) {
        // Only add to staged if it's not also unstaged
        staged.push(file);
      }
    });
  }

  if (unstagedCount) unstagedCount.textContent = unstaged.length;
  if (stagedCount) stagedCount.textContent = staged.length;

  unstaged.forEach(file => {
    const div = document.createElement("div");
    div.className = "canvas-file-item";
    div.innerHTML = `<span style="color: #ef4444;">${file.path}</span><span class="canvas-file-status">${file.type}</span>`;
    div.addEventListener("click", () => {
      if (window.loadFileDiff) {
        window.loadFileDiff(file.path, false);
      }
    });
    // Right-click to stage entire file
    div.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (window.api) {
          await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/stage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: file.path })
          });
          await loadStatus();
          if (window.state.currentDiffFile === file.path && window.loadFileDiff) {
            await window.loadFileDiff(file.path, true);
          }
        }
      } catch (err) {
        if (window.setStatus) {
          window.setStatus(err.message, true);
        }
      }
    });
    unstagedList.appendChild(div);
  });

  staged.forEach(file => {
    const div = document.createElement("div");
    div.className = "canvas-file-item";
    div.innerHTML = `<span style="color: #22c55e;">${file.path}</span><span class="canvas-file-status">${file.type}</span>`;
    div.addEventListener("click", () => {
      if (window.loadFileDiff) {
        window.loadFileDiff(file.path, true);
      }
    });
    // Right-click to unstage entire file
    div.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (window.api) {
          await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/unstage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: file.path })
          });
          await loadStatus();
          if (window.state.currentDiffFile === file.path && window.loadFileDiff) {
            await window.loadFileDiff(file.path, false);
          }
        }
      } catch (err) {
        if (window.setStatus) {
          window.setStatus(err.message, true);
        }
      }
    });
    stagedList.appendChild(div);
  });

  updateCommitButton();
}

async function loadFileDiff(filePath, isStaged) {
  window.state.currentDiffFile = filePath;
  const diffView = document.getElementById("diffView");
  if (diffView) {
    diffView.style.display = "grid";
  }
  if (window.setStatus) {
    window.setStatus("Loading diff...");
  }
  try {
    if (window.api) {
      const unstagedData = await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/diff?path=" + encodeURIComponent(filePath) + "&staged=false").catch(() => ({ diff: "", hunks: [] }));
      const stagedData = await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/diff?path=" + encodeURIComponent(filePath) + "&staged=true").catch(() => ({ diff: "", hunks: [] }));
      
      window.state.unstagedDiffData = unstagedData;
      window.state.stagedDiffData = stagedData;
      
      const unstagedDiff = document.getElementById("unstagedDiff");
      const stagedDiff = document.getElementById("stagedDiff");
      if (window.renderDiff) {
        if (unstagedDiff) window.renderDiff(unstagedDiff, unstagedData, false, filePath);
        if (stagedDiff) window.renderDiff(stagedDiff, stagedData, true, filePath);
      }
      if (window.setStatus) {
        window.setStatus("");
      }
    }
  } catch (e) {
    if (window.setStatus) {
      window.setStatus(e.message, true);
    }
  }
}

function renderDiff(container, diffData, isStaged, filePath) {
  if (!container) return;
  container.innerHTML = "";
  if (!diffData || !diffData.hunks || diffData.hunks.length === 0) {
    container.textContent = "No changes";
    return;
  }

  diffData.hunks.forEach((hunk, idx) => {
    const hunkDiv = document.createElement("div");
    hunkDiv.className = "diff-hunk" + (isStaged ? " staged" : "");
    hunkDiv.dataset.hunkIndex = idx;
    
    const header = document.createElement("div");
    header.style.fontSize = "10px";
    header.style.color = "#6b7280";
    header.style.marginBottom = "4px";
    header.textContent = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    hunkDiv.appendChild(header);

    const linesDiv = document.createElement("div");
    hunk.lines.forEach(line => {
      const lineDiv = document.createElement("div");
      lineDiv.className = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) {
        lineDiv.classList.add("added");
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        lineDiv.classList.add("removed");
      } else {
        lineDiv.classList.add("context");
      }
      lineDiv.textContent = line;
      linesDiv.appendChild(lineDiv);
    });
    hunkDiv.appendChild(linesDiv);

    if (!isStaged) {
      hunkDiv.addEventListener("click", () => {
        if (window.stageHunk) {
          window.stageHunk(filePath, idx);
        }
      });
    } else {
      hunkDiv.addEventListener("click", () => {
        if (window.unstageHunk) {
          window.unstageHunk(filePath, idx);
        }
      });
    }

    container.appendChild(hunkDiv);
  });
}

async function stageHunk(filePath, hunkIndex) {
  try {
    if (window.api) {
      await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, hunks: [hunkIndex] })
      });
      if (window.state.stagedHunks) {
        window.state.stagedHunks.add(`${filePath}:${hunkIndex}`);
      }
      await loadStatus();
      if (window.state.currentDiffFile === filePath && window.loadFileDiff) {
        await window.loadFileDiff(filePath, false);
      }
    }
  } catch (e) {
    if (window.setStatus) {
      window.setStatus(e.message, true);
    }
  }
}

async function unstageHunk(filePath, hunkIndex) {
  try {
    if (window.api) {
      await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/unstage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, hunks: [hunkIndex] })
      });
      if (window.state.stagedHunks) {
        window.state.stagedHunks.delete(`${filePath}:${hunkIndex}`);
      }
      await loadStatus();
      if (window.state.currentDiffFile === filePath && window.loadFileDiff) {
        await window.loadFileDiff(filePath, true);
      }
    }
  } catch (e) {
    if (window.setStatus) {
      window.setStatus(e.message, true);
    }
  }
}

function updateCommitButton() {
  const commitButton = document.getElementById("commitButton");
  if (!commitButton) return;
  
  const hasStaged = window.state.status && window.state.status.files && window.state.status.files.some(f => f.staged);
  // Check subject field (required) - use new fields if available, fallback to old field
  const commitMessageSubject = document.getElementById("commitMessageSubject");
  const commitMessage = document.getElementById("commitMessage");
  const subjectValue = commitMessageSubject ? commitMessageSubject.value.trim() : (commitMessage ? commitMessage.value.trim() : "");
  commitButton.disabled = !hasStaged || !subjectValue;
}

// Efficiently update commits list after a new commit
async function refreshCommitsAfterCommit() {
  if (!window.state.currentRepo || !window.state.currentBranch) return;
  
  // Prevent concurrent calls
  if (isRefreshingCommits) {
    console.log("[refreshCommitsAfterCommit] Already refreshing, skipping");
    return;
  }
  
  isRefreshingCommits = true;
  
  try {
    // For graph views, do a full reload since graph structure might change
    if (window.isGraphMode && window.isGraphMode()) {
      if (window.loadCommits) {
        await window.loadCommits();
      }
      return;
    }
    
    // For Activity view, just fetch the latest commit and prepend it
    const branchParam = window.state.currentBranch === "__ALL__" ? "HEAD" : window.state.currentBranch;
    const mode = window.state.historyMode || "activity";
    if (window.api) {
      const response = await window.api(
        "/api/repos/" +
          encodeURIComponent(window.state.currentRepo) +
          "/commits?branch=" +
          encodeURIComponent(branchParam) +
          "&mode=" +
          encodeURIComponent(mode) +
          "&limit=1"
      );
      
      if (Array.isArray(response) && response.length > 0) {
        const newCommit = response[0];
        
        // Check if this commit is already in the commits list
        const existsInCommits = window.state.commits.some(c => c.sha === newCommit.sha);
        
        if (!existsInCommits) {
          // Prepend the new commit to the lists
          window.state.commits.unshift(newCommit);
          
          // Mark commits for Activity view (will process all commits including the new one)
          if (window.markCommitsActiveStatus) {
            window.markCommitsActiveStatus();
          }
          
          // Apply any active filters (this will rebuild filteredCommits from commits)
          if (window.applyCommitFilter) {
            window.applyCommitFilter();
          }
          
          // Increment total count if we have it
          if (window.state.totalCommits !== null) {
            window.state.totalCommits += 1;
          }
          
          // Update the commit count display
          if (window.updateCommitCountDisplay) {
            window.updateCommitCountDisplay();
          }
          
          // Re-render the commit list (this is efficient - just adds one item at the top)
          if (window.renderCommitList) {
            window.renderCommitList();
          }
        } else {
          // Commit already exists, do a full refresh to ensure consistency
          console.log("[refreshCommitsAfterCommit] Commit already exists, doing full refresh");
          if (window.loadCommits) {
            await window.loadCommits();
          }
        }
      } else {
        // No commits returned, do a full refresh
        if (window.loadCommits) {
          await window.loadCommits();
        }
      }
    }
  } catch (e) {
    console.error("Error refreshing commits after commit:", e);
    // Fallback to full reload on error
    if (window.loadCommits) {
      await window.loadCommits();
    }
  } finally {
    isRefreshingCommits = false;
  }
}

// Initialize commit button and message field handlers
(function initStaging() {
  const commitButton = document.getElementById("commitButton");
  const commitMessageSubject = document.getElementById("commitMessageSubject");
  const commitMessageDescription = document.getElementById("commitMessageDescription");
  const commitMessage = document.getElementById("commitMessage");

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

  if (commitButton) {
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
      
      if (window.setStatus) {
        window.setStatus("Committing...");
      }
      try {
        if (window.api) {
          await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/commit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: commitMsg })
          });
          
          // Clear both fields after successful commit
          if (commitMessageSubject) commitMessageSubject.value = "";
          if (commitMessageDescription) commitMessageDescription.value = "";
          if (commitMessage) commitMessage.value = ""; // Legacy support
          
          if (window.state.stagedHunks) {
            window.state.stagedHunks.clear();
          }
          await loadStatus();
          await refreshCommitsAfterCommit();
          if (window.checkConflicts) {
            await window.checkConflicts();
          }
          if (window.setStatus) {
            window.setStatus("Commit successful");
          }
        }
      } catch (e) {
        if (window.setStatus) {
          window.setStatus(e.message, true);
        }
      }
    });
  }
})();

// Export functions to window
window.loadStatus = loadStatus;
window.renderStatusLists = renderStatusLists;
window.loadFileDiff = loadFileDiff;
window.renderDiff = renderDiff;
window.stageHunk = stageHunk;
window.unstageHunk = unstageHunk;
window.updateCommitButton = updateCommitButton;
window.refreshCommitsAfterCommit = refreshCommitsAfterCommit;
