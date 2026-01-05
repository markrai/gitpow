/**
 * View Mode Management for GitPow
 * Functions for switching between graph and Activity views, status polling
 * Extracted from script.js for better maintainability
 */

// Status polling interval is managed in state.js

// Helper function to check if we're in graph view mode
function isGraphMode() {
  return window.state.historyMode === "neo-vertical" || window.state.historyMode === "neo-horizontal";
}

// Helper function to switch UI between graph and other views
function switchViewMode(isNeo) {
  const timeline3d = document.getElementById("timeline3d");
  const helixControls = document.getElementById("helixControls");
  const filesPanel = document.querySelector(".panel:nth-child(2)");
  const filesPanelHeader = document.getElementById("filesPanelHeader");
  const diffPanel = document.getElementById("diffPanel");
  const layout = document.querySelector(".layout");
  const graphContainer = document.getElementById("graphContainer");
  const commitsPanel = document.querySelector(".panel:first-child");
  const commitList = document.getElementById("commitList");
  const stagedCommitSection = document.getElementById("stagedCommitSection");
  const unstagedSection = document.getElementById("unstagedSection");
  const stagedSection = document.getElementById("stagedSection");
  const commitForm = document.getElementById("commitForm");
  
  if (isNeo) {
    // Hide panels and show WebGL graph view
    if (commitsPanel) commitsPanel.style.display = "none";
    if (commitList) commitList.style.display = "none";
    if (timeline3d) timeline3d.style.display = "none";
    if (helixControls) helixControls.style.display = "none";
    if (diffPanel) diffPanel.style.display = "none";
    if (filesPanel) filesPanel.style.display = "none";
    if (filesPanelHeader) filesPanelHeader.style.display = "none";
    if (layout) layout.style.display = "none";
    
    // Hide commit canvas sections in graph views
    if (stagedCommitSection) stagedCommitSection.style.display = "none";
    if (graphContainer) {
      // Position graph container to start right below toolbar using fixed positioning
      const toolbar = document.querySelector(".toolbar");
      if (toolbar) {
        // Get the toolbar's actual bottom position including border
        const toolbarRect = toolbar.getBoundingClientRect();
        const toolbarBottom = toolbarRect.bottom;
        graphContainer.style.position = "fixed";
        graphContainer.style.top = toolbarBottom + "px";
        graphContainer.style.left = "0";
        graphContainer.style.right = "0";
        graphContainer.style.bottom = "0";
      } else {
        graphContainer.style.top = "56px";
      }
      graphContainer.style.display = "block";
    }
    
    // Stop polling when switching to graph views
    stopStatusPolling();
  } else {
    // Show panels and hide graph view
    if (commitsPanel) commitsPanel.style.display = "";
    if (commitList) commitList.style.display = "";
    if (graphContainer) graphContainer.style.display = "none";
    if (filesPanelHeader) filesPanelHeader.style.display = "";
    if (layout) layout.style.display = "";
    if (layout) layout.style.gridTemplateColumns = "";
    
    // Show commit canvas sections in Activity view
    if (stagedCommitSection) stagedCommitSection.style.display = "";
    
    // Show inner sections (they will be populated by loadStatus)
    if (unstagedSection) unstagedSection.style.display = "";
    if (stagedSection) stagedSection.style.display = "";
    if (commitForm) commitForm.style.display = "";
    
    // Load status to populate commit canvas sections
    if (window.loadStatus) {
      window.loadStatus();
    }
    
    // Start polling status for real-time updates (every 2 seconds)
    startStatusPolling();
  }
}

function startStatusPolling() {
  // Clear any existing interval
  stopStatusPolling();
  
  // Only poll if in Activity view
  if (isGraphMode()) return;
  
  // Poll every 2 seconds
  // Use statusPollInterval from state.js (exposed via window.statusPollInterval)
  window.statusPollInterval = setInterval(async () => {
    if (!isGraphMode() && window.state.currentRepo) {
      try {
        if (window.loadStatus) {
          await window.loadStatus();
        }
      } catch (e) {
        // Silently fail - don't spam errors for polling
        console.debug("Status poll failed:", e);
      }
    } else {
      // Stop polling if we switched to graph view
      stopStatusPolling();
    }
  }, 2000);
}

function stopStatusPolling() {
  // Use statusPollInterval from state.js (exposed via window.statusPollInterval)
  if (window.statusPollInterval) {
    clearInterval(window.statusPollInterval);
    window.statusPollInterval = null;
  }
}

// Clean up polling on page unload
window.addEventListener("beforeunload", () => {
  stopStatusPolling();
});

// Export functions to window
window.isGraphMode = isGraphMode;
window.switchViewMode = switchViewMode;
window.startStatusPolling = startStatusPolling;
window.stopStatusPolling = stopStatusPolling;
