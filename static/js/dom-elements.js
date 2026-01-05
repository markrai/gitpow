/**
 * DOM Elements for GitPow
 * Centralized DOM element references
 * Extracted from script.js for better maintainability
 */

// ============================================================================
// Repository and Branch Selectors
// ============================================================================

const repoSelect = document.getElementById("repoSelect");
const branchSelect = document.getElementById("branchSelect");

// ============================================================================
// Repos Root Modal
// ============================================================================

const reposRootButton = document.getElementById("reposRootButton");
const reposRootModal = document.getElementById("reposRootModal");
const reposRootPathInput = document.getElementById("reposRootPathInput");
const reposRootCurrent = document.getElementById("reposRootCurrent");
const reposRootBrowseButton = document.getElementById("reposRootBrowse");
const reposRootUseDefaultButton = document.getElementById("reposRootUseDefault");
const reposRootCancelButton = document.getElementById("reposRootCancel");
const reposRootSaveButton = document.getElementById("reposRootSave");
const reposRootCloseButton = document.getElementById("reposRootClose");

// ============================================================================
// Main Content Areas
// ============================================================================

const commitList = document.getElementById("commitList");
const fileList = document.getElementById("fileList");
const searchInput = document.getElementById("searchInput");

// ============================================================================
// Context Menu
// ============================================================================

const contextMenu = document.getElementById("contextMenu");
const contextMenuOpenExplorer = document.getElementById("contextMenuOpenExplorer");
const contextMenuViewGitHub = document.getElementById("contextMenuViewGitHub");
const contextMenuCopyCommitId = document.getElementById("contextMenuCopyCommitId");
const contextMenuCheckoutCommit = document.getElementById("contextMenuCheckoutCommit");

// Exit Detached HEAD Modal
const exitDetachedHeadModal = document.getElementById("exitDetachedHeadModal");
const exitDetachedHeadClose = document.getElementById("exitDetachedHeadClose");
const exitDetachedHeadYes = document.getElementById("exitDetachedHeadYes");
const exitDetachedHeadNo = document.getElementById("exitDetachedHeadNo");

// ============================================================================
// Status and Settings
// ============================================================================

// Status element removed from toolbar - using unified statusMessage instead
const statusEl = null; // Kept for backward compatibility but not used
const settingsButton = document.getElementById("settingsButton");
const settingsModal = document.getElementById("settingsModal");
const settingsClose = document.getElementById("settingsClose");
const commitCountEl = document.getElementById("commitCount");
const branchLabelEl = document.getElementById("branchLabel");

// ============================================================================
// Commit/Staging Sections
// ============================================================================

const unstagedSection = document.getElementById("unstagedSection");
const stagedSection = document.getElementById("stagedSection");
const commitForm = document.getElementById("commitForm");
const stagedCommitSection = document.getElementById("stagedCommitSection");
const diffSection = document.getElementById("diffSection");
const diffSectionToggle = document.getElementById("diffSectionToggle");
const stagedCommitSectionToggle = document.getElementById("stagedCommitSectionToggle");
const unstagedList = document.getElementById("unstagedList");
const stagedList = document.getElementById("stagedList");
const unstagedCount = document.getElementById("unstagedCount");
const stagedCount = document.getElementById("stagedCount");
const diffView = document.getElementById("diffView");
const unstagedDiff = document.getElementById("unstagedDiff");
const stagedDiff = document.getElementById("stagedDiff");
const commitMessage = document.getElementById("commitMessage"); // Legacy - may not exist
const commitMessageSubject = document.getElementById("commitMessageSubject");
const commitMessageDescription = document.getElementById("commitMessageDescription");
const commitButton = document.getElementById("commitButton");

// ============================================================================
// Conflict Resolution
// ============================================================================

const conflictCenter = document.getElementById("conflictCenter");
const conflictFilesList = document.getElementById("conflictFilesList");
const conflictProgress = document.getElementById("conflictProgress");
const conflictTheirs = document.getElementById("conflictTheirs");
const conflictMine = document.getElementById("conflictMine");
const conflictBase = document.getElementById("conflictBase");
const conflictResult = document.getElementById("conflictResult");
const conflictButtons = document.getElementById("conflictButtons");

// ============================================================================
// Export to window for global access
// ============================================================================

// Repository/Branch
window.repoSelect = repoSelect;
window.branchSelect = branchSelect;

// Repos Root Modal
window.reposRootButton = reposRootButton;
window.reposRootModal = reposRootModal;
window.reposRootPathInput = reposRootPathInput;
window.reposRootCurrent = reposRootCurrent;
window.reposRootBrowseButton = reposRootBrowseButton;
window.reposRootUseDefaultButton = reposRootUseDefaultButton;
window.reposRootCancelButton = reposRootCancelButton;
window.reposRootSaveButton = reposRootSaveButton;
window.reposRootCloseButton = reposRootCloseButton;

// Main Content
window.commitList = commitList;
window.fileList = fileList;
window.searchInput = searchInput;

// Context Menu
window.contextMenu = contextMenu;
window.contextMenuOpenExplorer = contextMenuOpenExplorer;
window.contextMenuViewGitHub = contextMenuViewGitHub;
window.contextMenuCopyCommitId = contextMenuCopyCommitId;
window.contextMenuCheckoutCommit = contextMenuCheckoutCommit;

// Exit Detached HEAD Modal
window.exitDetachedHeadModal = exitDetachedHeadModal;
window.exitDetachedHeadClose = exitDetachedHeadClose;
window.exitDetachedHeadYes = exitDetachedHeadYes;
window.exitDetachedHeadNo = exitDetachedHeadNo;

// Status/Settings
window.statusEl = statusEl;
window.settingsButton = settingsButton;
window.settingsModal = settingsModal;
window.settingsClose = settingsClose;
window.commitCountEl = commitCountEl;
window.branchLabelEl = branchLabelEl;

// Commit/Staging
window.unstagedSection = unstagedSection;
window.stagedSection = stagedSection;
window.commitForm = commitForm;
window.stagedCommitSection = stagedCommitSection;
window.diffSection = diffSection;
window.diffSectionToggle = diffSectionToggle;
window.stagedCommitSectionToggle = stagedCommitSectionToggle;
window.unstagedList = unstagedList;
window.stagedList = stagedList;
window.unstagedCount = unstagedCount;
window.stagedCount = stagedCount;
window.diffView = diffView;
window.unstagedDiff = unstagedDiff;
window.stagedDiff = stagedDiff;
window.commitMessage = commitMessage;
window.commitMessageSubject = commitMessageSubject;
window.commitMessageDescription = commitMessageDescription;
window.commitButton = commitButton;

// Conflict Resolution
window.conflictCenter = conflictCenter;
window.conflictFilesList = conflictFilesList;
window.conflictProgress = conflictProgress;
window.conflictTheirs = conflictTheirs;
window.conflictMine = conflictMine;
window.conflictBase = conflictBase;
window.conflictResult = conflictResult;
window.conflictButtons = conflictButtons;
