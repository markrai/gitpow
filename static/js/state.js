/**
 * Application State Management for GitPow
 * Centralized state object and state-related utilities
 * Extracted from script.js for better maintainability
 */

// ============================================================================
// Graph View Performance Constants
// ============================================================================

const GRAPH_VIEW_MAX_COMMITS = 10000; // Hard safety cap for graph rendering
const GRAPH_VIEW_MIN_PER_BRANCH = 50; // Minimum commits per branch when splitting
const GRAPH_VIEW_MAX_BRANCHES_PARALLEL = 10; // Max branches to fetch in parallel
const GRAPH_BRANCH_HISTORY_LIMIT = 500; // Hard safety cap for branch history queries
const GRAPH_VIEW_MAX_BRANCHES_FOR_ALL = 50; // Max branches to include in __ALL__ graph mode (deprecated, use getMaxBranchesForAll())
const DEFAULT_SEEK_DEPTH_PER_BRANCH = 100; // Default per-branch seek depth for All-branches map views
const DEFAULT_GLOBAL_COMMIT_CAP = 2000; // Default global commit cap for All-branches map views
const DEFAULT_MAX_BRANCHES_FOR_ALL = 50; // Default max branches to include in __ALL__ graph mode

// ============================================================================
// Loading State Management
// ============================================================================

let isLoadingCommits = false;
// Track what commits are loaded to avoid duplicate fetches
// Format: "repo:branch:mode" (e.g., "myrepo:main:activity" or "myrepo:__ALL__:full")
let loadedCommitsKey = null;
let currentLoadRequestId = null; // Track the current fetch operation to prevent race conditions
let lastStatusUpdateTime = 0; // Track when status was last updated to prevent rapid updates
// Preserve __ALL__ commits separately so they don't get overwritten when switching to single-branch views
let cachedAllBranchesCommits = null;
let cachedAllBranchesKey = null;
// Track if background preload is in progress to avoid duplicate preloads
let isPreloadingAllBranches = false;
// Track if preload is scheduled (queued but not started yet)
let isPreloadScheduled = false;
// Abort controller for the current all-branches aggregation request (graph mode)
let currentCommitsAllBranchesController = null;
// Cache for "commits ago" calculations: (repo, currentCommitSha, creationCommitSha) -> commitsAgo
let commitsAgoCache = new Map();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse cache key correctly, handling Windows paths with colons
 * Format is always: "repo:branch:mode"
 * We split from the right since repo can contain colons (e.g., "C:\dev\project:branch:mode")
 * @param {string} cacheKey - The cache key to parse
 * @returns {Object} { repo, branch, mode }
 */
function parseCacheKey(cacheKey) {
  if (!cacheKey) return { repo: null, branch: null, mode: null };
  // Split from the right - last part is mode, second-to-last is branch, everything before is repo
  const lastColon = cacheKey.lastIndexOf(":");
  if (lastColon === -1) return { repo: cacheKey, branch: null, mode: null };
  const mode = cacheKey.substring(lastColon + 1);

  const secondLastColon = cacheKey.lastIndexOf(":", lastColon - 1);
  if (secondLastColon === -1) return { repo: cacheKey.substring(0, lastColon), branch: null, mode };
  const branch = cacheKey.substring(secondLastColon + 1, lastColon);
  const repo = cacheKey.substring(0, secondLastColon);

  return { repo, branch, mode };
}

/**
 * Get seek depth per branch setting from localStorage
 * @returns {number} Seek depth value (clamped to valid range)
 */
function getSeekDepthPerBranch() {
  const raw = localStorage.getItem("gitzada:seekDepthPerBranch");
  const parsed = raw != null ? parseInt(raw, 10) : NaN;
  let value = Number.isFinite(parsed) ? parsed : DEFAULT_SEEK_DEPTH_PER_BRANCH;
  // Clamp to sane bounds
  if (value < 10) value = 10;
  if (value > GRAPH_BRANCH_HISTORY_LIMIT) value = GRAPH_BRANCH_HISTORY_LIMIT;
  return value;
}

/**
 * Get global commit cap setting from localStorage
 * @returns {number} Commit cap value (clamped to valid range)
 */
function getGlobalCommitCap() {
  const raw = localStorage.getItem("gitzada:globalCommitCap");
  const parsed = raw != null ? parseInt(raw, 10) : NaN;
  let value = Number.isFinite(parsed) ? parsed : DEFAULT_GLOBAL_COMMIT_CAP;
  // Clamp to sane bounds and safety hard cap
  if (value < 200) value = 200;
  if (value > GRAPH_VIEW_MAX_COMMITS) value = GRAPH_VIEW_MAX_COMMITS;
  return value;
}

/**
 * Get max branches for all setting from localStorage
 * @returns {number} Max branches value (clamped to valid range)
 */
function getMaxBranchesForAll() {
  const raw = localStorage.getItem("gitzada:maxBranchesForAll");
  const parsed = raw != null ? parseInt(raw, 10) : NaN;
  let value = Number.isFinite(parsed) ? parsed : DEFAULT_MAX_BRANCHES_FOR_ALL;
  // Clamp to sane bounds
  if (value < 10) value = 10;
  if (value > 500) value = 500; // Reasonable upper limit
  return value;
}

/**
 * Return a filtered/prioritized branch list for "__ALL__" graph mode.
 * - Always includes: default branch, main-like branches, current branch.
 * - Prefers local branches over remote branches.
 * - Caps total branches to keep loading fast and the graph readable.
 * @param {string[]} allBranches - Array of all branch names
 * @param {string} defaultBranch - The default branch name
 * @param {string} currentBranch - The currently selected branch
 * @returns {string[]} Filtered and prioritized branch list
 */
function getBranchesForAllGraphMode(allBranches, defaultBranch, currentBranch) {
  if (!Array.isArray(allBranches) || allBranches.length === 0) return [];

  const unique = new Set(allBranches);
  const mainLike = new Set(["main", "master", "trunk", "develop"]);

  const prioritized = [];
  const locals = [];
  const remotes = [];

  for (const name of unique) {
    if (!name) continue;
    const isRemote = name.includes("/");
    if (isRemote) {
      remotes.push(name);
    } else {
      locals.push(name);
    }
  }

  const pushUnique = (arr, name) => {
    if (!name) return;
    const idx = arr.indexOf(name);
    if (idx === -1 && unique.has(name)) {
      arr.unshift(name);
    }
  };

  // Start with locals, then remotes, both sorted alphabetically for stability.
  locals.sort();
  remotes.sort();
  prioritized.push(...locals, ...remotes);

  // Bump default, current, and main-like branches toward the front.
  const promote = (name) => {
    if (!name) return;
    const idx = prioritized.indexOf(name);
    if (idx > 0) {
      prioritized.splice(idx, 1);
      prioritized.unshift(name);
    }
  };

  promote(defaultBranch);
  if (currentBranch && currentBranch !== "__ALL__") {
    promote(currentBranch);
  }
  for (const name of prioritized.slice()) {
    if (mainLike.has(name)) promote(name);
  }

  // Enforce global cap for "__ALL__" branches in graph mode.
  const maxBranches = state.maxBranchesForAll || getMaxBranchesForAll();
  if (prioritized.length > maxBranches) {
    return prioritized.slice(0, maxBranches);
  }
  return prioritized;
}

// ============================================================================
// Color Settings State
// ============================================================================

const colorSettings = {
  commitMessage: localStorage.getItem("gitzada:color:commitMessage") || "#FFC000",
  activeCommit: localStorage.getItem("gitzada:color:activeCommit") || "#22c55e",
  addedFile: localStorage.getItem("gitzada:color:addedFile") || "#22c55e",
  modifiedFile: localStorage.getItem("gitzada:color:modifiedFile") || "#3b82f6",
  removedFile: localStorage.getItem("gitzada:color:removedFile") || "#ef4444",
  diffAdded: localStorage.getItem("gitzada:color:diffAdded") || "#22c55e",
  diffRemoved: localStorage.getItem("gitzada:color:diffRemoved") || "#ef4444",
  diffHunk: localStorage.getItem("gitzada:color:diffHunk") || "#60a5fa"
};

/**
 * Apply color settings to CSS custom properties
 */
function applyColorSettings() {
  document.documentElement.style.setProperty("--color-commit-message", colorSettings.commitMessage);
  document.documentElement.style.setProperty("--color-active-commit", colorSettings.activeCommit);
  document.documentElement.style.setProperty("--color-added-file", colorSettings.addedFile);
  document.documentElement.style.setProperty("--color-modified-file", colorSettings.modifiedFile);
  document.documentElement.style.setProperty("--color-removed-file", colorSettings.removedFile);
  document.documentElement.style.setProperty("--color-diff-added", colorSettings.diffAdded);
  document.documentElement.style.setProperty("--color-diff-removed", colorSettings.diffRemoved);
  document.documentElement.style.setProperty("--color-diff-hunk", colorSettings.diffHunk);
}

// ============================================================================
// Main Application State
// ============================================================================

let state = {
  repos: [],
  branches: [],
  branchMetadata: null, // Map of branch name -> metadata (merged, stale, unborn, lastCommitDate)
  commits: [],
  filteredCommits: [],
  totalCommits: null, // Total number of commits available (null if unknown)
  // Snapshot of the last Activity view so we can restore it instantly
  lastActivityRepo: null,
  lastActivityBranch: null,
  lastActivityCommits: null,
  lastActivityFilteredCommits: null,
  lastActivityTotalCommits: null,
  files: [],
  changedFiles: [], // Files changed in the current commit (added/modified/removed)
  currentRepo: null,
  currentBranch: null,
  defaultBranch: null,
  currentCommit: null,
  currentFile: null,
  historyMode: "activity", // activity, neo-vertical, neo-horizontal
  dateFormatHuman: localStorage.getItem("gitzada:dateFormatHuman") !== "false", // Toggle for human-readable date format (default: true)
  separateByMonths: localStorage.getItem("gitzada:separateByMonths") !== "false", // Group commits by month (default: true)
  invertUpDown: localStorage.getItem("gitzada:invertUpDown") === "true", // Invert up/down arrow behavior
  invertLeftRight: localStorage.getItem("gitzada:invertLeftRight") === "true", // Invert left/right arrow behavior in graph view
  seekDepthPerBranch: getSeekDepthPerBranch(), // Per-branch seek depth for All-branches map views
  globalCommitCap: getGlobalCommitCap(), // Global commit cap for All-branches map views
  maxBranchesForAll: getMaxBranchesForAll(), // Max branches to include in __ALL__ graph mode
  expandedMonths: new Set(), // Track which months are expanded (by monthKey)
  contextMenuFile: null, // File path for context menu
  contextMenuCommit: null, // Commit object for context menu
  detachedHeadCommit: null, // Commit object when in detached HEAD state { sha, message }
  previousBranch: null, // Branch name before entering detached HEAD state
  isCheckingOutBranch: false, // Flag to prevent re-detection of detached HEAD during checkout
  // canvasOpen removed - commit canvas is now integrated into diffPanel
  status: { files: [] },
  currentDiffFile: null,
  unstagedDiffData: null,
  stagedDiffData: null,
  stagedHunks: new Set(), // Track which hunks are staged
  draggedCommit: null,
  conflicts: { files: [], hasConflicts: false },
  currentConflictFile: null,
  conflictData: null,
  scene3d: null,
  camera3d: null,
  renderer3d: null,
  controls3d: null,
  raycaster3d: null,
  mouse3d: null,
  commitObjects3d: new Map(),
  branchHierarchy: [],
  branchAngles: {}
};

// ============================================================================
// File Creation Request Queue
// ============================================================================

let fileCreationQueue = [];
let fileCreationInProgress = false;
const MAX_CONCURRENT_FILE_REQUESTS = 5;
let activeFileRequests = 0;
const FILE_CREATION_BATCH_SIZE = 20;

// ============================================================================
// Status Polling
// ============================================================================

let statusPollInterval = null;

// ============================================================================
// Export to window for global access
// ============================================================================

// Constants
window.GRAPH_VIEW_MAX_COMMITS = GRAPH_VIEW_MAX_COMMITS;
window.GRAPH_VIEW_MIN_PER_BRANCH = GRAPH_VIEW_MIN_PER_BRANCH;
window.GRAPH_VIEW_MAX_BRANCHES_PARALLEL = GRAPH_VIEW_MAX_BRANCHES_PARALLEL;
window.GRAPH_BRANCH_HISTORY_LIMIT = GRAPH_BRANCH_HISTORY_LIMIT;
window.GRAPH_VIEW_MAX_BRANCHES_FOR_ALL = GRAPH_VIEW_MAX_BRANCHES_FOR_ALL;
window.DEFAULT_SEEK_DEPTH_PER_BRANCH = DEFAULT_SEEK_DEPTH_PER_BRANCH;
window.DEFAULT_GLOBAL_COMMIT_CAP = DEFAULT_GLOBAL_COMMIT_CAP;
window.DEFAULT_MAX_BRANCHES_FOR_ALL = DEFAULT_MAX_BRANCHES_FOR_ALL;
window.MAX_CONCURRENT_FILE_REQUESTS = MAX_CONCURRENT_FILE_REQUESTS;
window.FILE_CREATION_BATCH_SIZE = FILE_CREATION_BATCH_SIZE;

// State variables (as getters/setters for proper reference sharing)
Object.defineProperty(window, 'isLoadingCommits', {
  get: () => isLoadingCommits,
  set: (v) => { isLoadingCommits = v; }
});
Object.defineProperty(window, 'loadedCommitsKey', {
  get: () => loadedCommitsKey,
  set: (v) => { loadedCommitsKey = v; }
});
Object.defineProperty(window, 'currentLoadRequestId', {
  get: () => currentLoadRequestId,
  set: (v) => { currentLoadRequestId = v; }
});
Object.defineProperty(window, 'lastStatusUpdateTime', {
  get: () => lastStatusUpdateTime,
  set: (v) => { lastStatusUpdateTime = v; }
});
Object.defineProperty(window, 'cachedAllBranchesCommits', {
  get: () => cachedAllBranchesCommits,
  set: (v) => { cachedAllBranchesCommits = v; }
});
Object.defineProperty(window, 'cachedAllBranchesKey', {
  get: () => cachedAllBranchesKey,
  set: (v) => { cachedAllBranchesKey = v; }
});
Object.defineProperty(window, 'isPreloadingAllBranches', {
  get: () => isPreloadingAllBranches,
  set: (v) => { isPreloadingAllBranches = v; }
});
Object.defineProperty(window, 'isPreloadScheduled', {
  get: () => isPreloadScheduled,
  set: (v) => { isPreloadScheduled = v; }
});
Object.defineProperty(window, 'currentCommitsAllBranchesController', {
  get: () => currentCommitsAllBranchesController,
  set: (v) => { currentCommitsAllBranchesController = v; }
});
Object.defineProperty(window, 'commitsAgoCache', {
  get: () => commitsAgoCache,
  set: (v) => { commitsAgoCache = v; }
});
Object.defineProperty(window, 'fileCreationQueue', {
  get: () => fileCreationQueue,
  set: (v) => { fileCreationQueue = v; }
});
Object.defineProperty(window, 'fileCreationInProgress', {
  get: () => fileCreationInProgress,
  set: (v) => { fileCreationInProgress = v; }
});
Object.defineProperty(window, 'activeFileRequests', {
  get: () => activeFileRequests,
  set: (v) => { activeFileRequests = v; }
});
Object.defineProperty(window, 'statusPollInterval', {
  get: () => statusPollInterval,
  set: (v) => { statusPollInterval = v; }
});

// Functions
window.parseCacheKey = parseCacheKey;
window.getSeekDepthPerBranch = getSeekDepthPerBranch;
window.getGlobalCommitCap = getGlobalCommitCap;
window.getMaxBranchesForAll = getMaxBranchesForAll;
window.getBranchesForAllGraphMode = getBranchesForAllGraphMode;
window.applyColorSettings = applyColorSettings;

// Color settings object
window.colorSettings = colorSettings;

// Main state object
window.state = state;
