/**
 * File Navigation for GitPow
 * Functions for file selection, file creation info, and file list rendering
 * Extracted from script.js for better maintainability
 */

// Track the previously active file element to avoid O(n) DOM traversal
let previousActiveFileElement = null;

// Helper function to convert hex to RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// Lightweight update of file active state without full re-render
function updateActiveFileState(newFilePath) {
  const fileList = document.getElementById("fileList");
  if (!fileList) return;

  // Remove active state from previous element only (O(1) instead of O(n))
  if (previousActiveFileElement) {
    previousActiveFileElement.classList.remove('active');
    previousActiveFileElement.style.background = '';
  }

  // Find and activate the new file
  const newActiveItem = fileList.querySelector(`[data-file-path="${CSS.escape(newFilePath)}"]`);
  if (newActiveItem) {
    newActiveItem.classList.add('active');

    // Apply status-based background color
    const fileInfo = window.state.changedFiles?.find(f => f.path === newFilePath);
    if (fileInfo && window.colorSettings) {
      let rgb;
      if (fileInfo.status === 'added') {
        rgb = hexToRgb(window.colorSettings.addedFile);
      } else if (fileInfo.status === 'removed') {
        rgb = hexToRgb(window.colorSettings.removedFile);
      } else if (fileInfo.status === 'modified') {
        rgb = hexToRgb(window.colorSettings.modifiedFile);
      }
      if (rgb) {
        newActiveItem.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
      }
    }

    previousActiveFileElement = newActiveItem;
  } else {
    previousActiveFileElement = null;
  }
}

// Process file creation info queue with rate limiting
async function processFileCreationQueue() {
  if (window.fileCreationInProgress || !window.fileCreationQueue || window.fileCreationQueue.length === 0) {
    return;
  }
  
  window.fileCreationInProgress = true;
  
  const MAX_CONCURRENT_FILE_REQUESTS = window.MAX_CONCURRENT_FILE_REQUESTS || 3;
  const FILE_CREATION_BATCH_SIZE = window.FILE_CREATION_BATCH_SIZE || 5;
  
  while (window.fileCreationQueue.length > 0 && window.activeFileRequests < MAX_CONCURRENT_FILE_REQUESTS) {
    const batchItems = window.fileCreationQueue.splice(0, FILE_CREATION_BATCH_SIZE);
    window.activeFileRequests++;
    
    // Process this batch
    loadFileCreationInfoBatch(batchItems).finally(() => {
      window.activeFileRequests--;
      // Process next batch after a small delay
      setTimeout(() => {
        processFileCreationQueue();
      }, 100);
    });
  }
  
  window.fileCreationInProgress = false;
}

// Render file creation info into the UI for a single file
async function renderFileCreationInfo(filePath, metaElement, creationInfo) {
  if (!window.state.currentRepo || !window.state.currentCommit) {
    return;
  }
  
  if (!metaElement || !creationInfo || !creationInfo.found) {
    return;
  }
  
  try {
      // Check cache first
      const cacheKey = `${window.state.currentRepo}:${window.state.currentCommit.sha}:${creationInfo.commitSha}`;
      let commitsAgo = null;
      
      if (window.commitsAgoCache && window.commitsAgoCache.has(cacheKey)) {
        commitsAgo = window.commitsAgoCache.get(cacheKey);
        console.log("[renderFileCreationInfo] Using cached commitsAgo:", commitsAgo, "for", cacheKey);
      } else {
        // Find the index of this commit in the commits list
        let commitIndex = window.state.commits.findIndex(c => c && c.sha === creationInfo.commitSha);
        let currentCommitIndex = window.state.commits.findIndex(c => c && c.sha === window.state.currentCommit.sha);
        
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
          if (window.cachedAllBranchesCommits && window.cachedAllBranchesCommits.length > 0) {
            const parsed = window.parseCacheKey && window.parseCacheKey(window.cachedAllBranchesKey);
            if (parsed && parsed.repo === window.state.currentRepo) {
              // Check if both commits are in the __ALL__ cache
              const creationCommitIndex = window.cachedAllBranchesCommits.findIndex(c => c && c.sha === creationInfo.commitSha);
              const currentCommitIndexInCache = window.cachedAllBranchesCommits.findIndex(c => c && c.sha === window.state.currentCommit.sha);
              
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
              if (!window.state.currentCommit) {
                return;
              }
              if (window.api) {
                const commitsBetweenResponse = await window.api("/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/commits-between?from=" + encodeURIComponent(creationInfo.commitSha) + "&to=" + encodeURIComponent(window.state.currentCommit.sha));
                if (commitsBetweenResponse && commitsBetweenResponse.count !== undefined) {
                  commitsAgo = commitsBetweenResponse.count;
                }
              }
            } catch (e) {
              console.error("Could not calculate commits between", e);
            }
          }
          
          // Cache the result
          if (commitsAgo !== null && window.commitsAgoCache) {
            window.commitsAgoCache.set(cacheKey, commitsAgo);
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
          if (window.highlightCommitBySha) {
            window.highlightCommitBySha(creationInfo.commitSha, filePath);
          }
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
    console.error("Error rendering file creation info:", e, { filePath, repo: window.state.currentRepo });
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
  if (!window.state.currentRepo || !window.state.currentCommit) {
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
    
    const url = "/api/repos/" + encodeURIComponent(window.state.currentRepo) + "/file-creation-batch?" + params.toString();
    if (window.api) {
      const creationMap = await window.api(url);
      
      // Re-check currentCommit in case it changed during async operation
      if (!window.state.currentCommit) {
        return;
      }
      
      for (const item of validItems) {
        const { filePath, metaElement } = item;
        const creationInfo = creationMap && creationMap[filePath];
        if (creationInfo && creationInfo.found) {
          await renderFileCreationInfo(filePath, metaElement, creationInfo);
        }
      }
    }
  } catch (e) {
    // Log error for debugging
    console.error("Error loading file creation info batch:", e, { repo: window.state.currentRepo });
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

// Export functions to window
window.updateActiveFileState = updateActiveFileState;
window.loadFileCreationInfo = loadFileCreationInfo;
window.loadFileCreationInfoBatch = loadFileCreationInfoBatch;
window.processFileCreationQueue = processFileCreationQueue;
window.renderFileCreationInfo = renderFileCreationInfo;
