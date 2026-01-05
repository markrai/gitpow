/**
 * Helper Functions for GitPow
 * Utility functions for UI interactions and helpers
 * Extracted from script.js for better maintainability
 */

// Local normalizePath function that uses the UI module's normalizePathForDisplay
function normalizePath(value) {
  return window.normalizePathForDisplay ? window.normalizePathForDisplay(value) : value;
}

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
  const diffSectionToggle = document.getElementById("diffSectionToggle");
  const diffSection = document.getElementById("diffSection");
  const stagedCommitSectionToggle = document.getElementById("stagedCommitSectionToggle");
  const stagedCommitSection = document.getElementById("stagedCommitSection");

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

function getGraphSymbol(commit, index, allCommits) {
  if (window.state.historyMode !== "full") return "";
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
  const isOnCurrentBranch = commit.branches && Array.isArray(commit.branches) && commit.branches.some(b => b === window.state.currentBranch);
  const isOnMainBranch = commit.isMain || (commit.branches && Array.isArray(commit.branches) && (commit.branches.includes("main") || commit.branches.includes("master")));
  if (!isOnCurrentBranch && !isOnMainBranch && commit.branches && Array.isArray(commit.branches) && commit.branches.length > 0) {
    return "faded-more";
  }
  return "";
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCollapsibleSections);
} else {
  initCollapsibleSections();
}

// Export functions to window
window.normalizePath = normalizePath;
window.toggleCollapse = toggleCollapse;
window.loadCollapseState = loadCollapseState;
window.initCollapsibleSections = initCollapsibleSections;
window.getGraphSymbol = getGraphSymbol;
window.getCommitFadeClass = getCommitFadeClass;
