// graph.js - Mini Metro–style 2D commit graph
//
// Responsibilities:
// - Take commit list from API (with branches / primary_branch / parents)
// - Lay out commits into vertical lanes (one lane per branch)
// - Render stations (commits) and lines (edges) on a 2D canvas
// - Support panning, zooming, hover tooltips, and tag markers

const LANE_GAP = 80;          // distance between branch lanes in world units
const ROW_GAP = 36;           // distance between commits vertically
const STATION_RADIUS = 7;     // base station radius
const LINE_WIDTH = 4;         // main line thickness
const MERGE_RING_EXTRA = 3;   // extra radius for merge interchanges
const MAX_GRAPH_COMMITS = 400; // clamp commit history for readability
const MAX_VISIBLE_LANES = 10; // default max distinct branch lanes in "All" mode

const MAIN_BRANCH_COLOR = "#38bdf8"; // constant color for main-like branches

const lanePalette = [
  "#ff6b35", "#4ecdc4", "#ffb400", "#5c7cfa", "#ff4b91",
  "#00b894", "#e17055", "#a29bfe", "#00cec9", "#fd79a8",
  "#ffeaa7", "#81ecec"
];

const backgroundColor = "#050713";
const gridColor = "rgba(148, 163, 184, 0.12)";

function hexToCssRgba(hex, alpha) {
  const clean = String(hex || "#000000").replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r},${g},${b},${a})`;
}

function primaryBranchName(commit) {
  // Prefer explicit branch list so "All" mode can distinguish branches.
  const rawList = Array.isArray(commit.branches) ? commit.branches.slice() : [];

  // If we have multiple branches, de‑weight generic names like HEAD.
  let list =
    rawList.length > 1
      ? rawList.filter(
          (b) => b && b !== "HEAD" && !b.endsWith("/HEAD")
        )
      : rawList;

  if (list.length === 0 && rawList.length > 0) {
    list = rawList;
  }

  if (list.length > 0) {
    const rank = (name) => {
      if (!name) return 50;
      const n = String(name);
      const lower = n.toLowerCase();
      const isHead = n === "HEAD" || n.endsWith("/HEAD");
      const isMain =
        lower === "main" ||
        lower === "master" ||
        lower === "trunk" ||
        lower === "develop" ||
        lower.endsWith("/main") ||
        lower.endsWith("/master") ||
        lower.endsWith("/develop");

      // Remote feature branches: origin/feat-x
      if (n.includes("/") && !isMain && !isHead) return 0;
      // Local feature branches
      if (!n.includes("/") && !isMain && !isHead) return 1;
      // Main / master / develop
      if (isMain) return 2;
      // HEAD / HEAD-like
      if (isHead) return 10;
      return 5;
    };

    list.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra === rb) return String(a).localeCompare(String(b));
      return ra - rb;
    });

    return list[0];
  }

  // Legacy / safety fallback
  return commit.primary_branch || commit.primaryBranch || "main";
}

function getMainBaselineBranchName() {
  // 1) Prefer the repo's explicit default branch if the main app knows it.
  //    script.js sets window.state.defaultBranch from /branches.
  const globalDefault =
    (window.state && window.state.defaultBranch) || null;
  if (globalDefault) {
    return globalDefault;
  }

  // 2) Otherwise, prefer an explicit main-like branch in the current graph.
  const candidate =
    (graphState.branchOrder || []).find((b) => isMainLikeBranch(b)) ||
    graphState.branchOrder?.[0] ||
    "main";
  return candidate;
}

function buildCommitIndex(commits) {
  const index = new Map();
  (commits || []).forEach((c) => {
    if (c && c.sha) {
      index.set(c.sha, c);
    }
  });
  return index;
}

function findLatestCommitOnBranch(branchName, commits) {
  if (!branchName || !Array.isArray(commits)) return null;
  for (const c of commits) {
    if (!c) continue;
    const branches = Array.isArray(c.branches) ? c.branches : [];
    if (branches.includes(branchName) || primaryBranchName(c) === branchName) {
      return c;
    }
  }
  return null;
}

/**
 * Check if a commit appears to be the branch creation point.
 * A commit is likely the creation point if it's unique to this branch
 * (not shared with main/master or many other branches).
 */
function isBranchCreationCommit(commit, branchName) {
  if (!commit || !branchName) return false;

  const branches = Array.isArray(commit.branches) ? commit.branches : [];

  // Filter out HEAD refs and the target branch itself
  const otherBranches = branches.filter(b =>
    b !== branchName &&
    b !== "HEAD" &&
    !b.endsWith("/HEAD") &&
    !isMainLikeBranch(b)
  );

  // If this commit is only on this branch (possibly + HEAD), it's likely the creation point
  // If it's also on main/master, it's NOT the creation point (it's a merge base or shared commit)
  const isOnMainBranch = branches.some(b => isMainLikeBranch(b));
  if (isOnMainBranch) {
    return false; // This commit is shared with main, not unique to this branch
  }

  // If there are no other significant branches, this is likely the creation point
  return otherBranches.length === 0;
}

function findEarliestCommitOnBranch(branchName, commits) {
  if (!branchName || !Array.isArray(commits)) return null;

  // Find the first commit that is ONLY on this branch (not shared with other branches)
  // This is closer to when the branch was actually created
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i];
    if (!c) continue;
    const branches = Array.isArray(c.branches) ? c.branches : [];
    
    // Check if this commit is on the target branch
    const isOnBranch = branches.includes(branchName) || primaryBranchName(c) === branchName;
    if (!isOnBranch) continue;
    
    // If this commit is ONLY on this branch (or this branch is the primary), it's likely the branch creation point
    // For main/master branches, we can't use this logic, so just return the earliest commit
    const isMainBranch = isMainLikeBranch(branchName);
    if (isMainBranch) {
      return c; // For main branches, return the earliest commit
    }
    
    // For feature branches, find the first commit that is unique to this branch
    // (i.e., not on main/master or other major branches)
    const otherBranches = branches.filter(b => 
      b !== branchName && 
      !isMainLikeBranch(b) && 
      b !== "HEAD" && 
      !b.endsWith("/HEAD")
    );
    
    // If this commit is only on this branch (or only on this branch + HEAD), it's likely the creation point
    if (branches.length === 1 || (branches.length === 2 && branches.includes("HEAD"))) {
      return c;
    }
  }
  
  // Fallback: return the earliest commit on the branch
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i];
    if (!c) continue;
    const branches = Array.isArray(c.branches) ? c.branches : [];
    if (branches.includes(branchName) || primaryBranchName(c) === branchName) {
      return c;
    }
  }
  return null;
}

/**
 * Format a date string as relative time (e.g., "2 days ago")
 */
function formatRelativeTimeLocal(dateString) {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours === 0) {
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        return diffMinutes <= 1 ? "just now" : `${diffMinutes} minutes ago`;
      }
      return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
    } else if (diffDays < 7) {
      return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
    } else if (diffDays < 30) {
      const diffWeeks = Math.floor(diffDays / 7);
      return diffWeeks === 1 ? "1 week ago" : `${diffWeeks} weeks ago`;
    } else if (diffDays < 365) {
      const diffMonths = Math.floor(diffDays / 30);
      return diffMonths === 1 ? "1 month ago" : `${diffMonths} months ago`;
    } else {
      const diffYears = Math.floor(diffDays / 365);
      return diffYears === 1 ? "1 year ago" : `${diffYears} years ago`;
    }
  } catch (e) {
    return "";
  }
}

/**
 * Fetch branch creation info from the API
 * @param {string} repo - Repository name
 * @param {string} branchName - Branch name
 * @returns {Promise<Object|null>} Branch creation info or null on error
 */
async function fetchBranchCreationInfo(repo, branchName) {
  if (!repo || !branchName) {
    console.log("fetchBranchCreationInfo: missing repo or branchName", { repo, branchName });
    return null;
  }

  try {
    // Use the api() function from script.js which handles Tauri/HTTP routing
    const params = new URLSearchParams({ repo, branch: branchName });
    const url = `/api/branch-creation?${params}`;
    console.log("fetchBranchCreationInfo: calling api()", url);
    const data = await window.api(url);
    console.log("fetchBranchCreationInfo: got data", data);
    return data;
  } catch (e) {
    console.warn("Failed to fetch branch creation info:", e);
    return null;
  }
}

// Cache for branch creation info to avoid repeated API calls
const branchCreationCache = new Map();

/**
 * Get branch creation info (cached)
 */
async function getBranchCreationInfo(repo, branchName) {
  const cacheKey = `${repo}:${branchName}`;
  if (branchCreationCache.has(cacheKey)) {
    return branchCreationCache.get(cacheKey);
  }

  const info = await fetchBranchCreationInfo(repo, branchName);
  if (info) {
    branchCreationCache.set(cacheKey, info);
  }
  return info;
}

/**
 * Build enhanced tooltip content for a branch pill
 * @param {string} branchName - The branch name
 * @param {Object} aheadBehindInfo - Ahead/behind info from computeAheadBehindVsMain
 * @param {Object} creationInfo - Optional branch creation info from API
 * @returns {string} HTML content for the tooltip
 */
function buildBranchTooltipContent(branchName, aheadBehindInfo, creationInfo = null) {
  const parts = [];
  
  // Branch name (header)
  parts.push(`<div style="font-weight: 600; margin-bottom: 4px; color: #e5e7eb; white-space: nowrap;">${branchName}</div>`);
  
  // Separator line
  parts.push(`<div style="height: 1px; background: rgba(156, 163, 175, 0.3); margin: 4px 0;"></div>`);
  
  // Ahead/behind status
  if (aheadBehindInfo) {
    if (aheadBehindInfo.ahead > 0 || aheadBehindInfo.behind > 0) {
      const statusParts = [];
      if (aheadBehindInfo.ahead > 0) {
        statusParts.push(`${aheadBehindInfo.ahead} ahead`);
      }
      if (aheadBehindInfo.behind > 0) {
        statusParts.push(`${aheadBehindInfo.behind} behind`);
      }
      const upstreamLabel = aheadBehindInfo.upstream && aheadBehindInfo.upstream !== branchName 
        ? ` ${aheadBehindInfo.upstream}` 
        : "";
      parts.push(`<div style="font-size: 10px; color: #9ca3af; margin-bottom: 2px; white-space: nowrap;">${statusParts.join(", ")}${upstreamLabel}</div>`);
    } else {
      const upstreamLabel = aheadBehindInfo.upstream && aheadBehindInfo.upstream !== branchName 
        ? ` ${aheadBehindInfo.upstream}` 
        : "";
      parts.push(`<div style="font-size: 10px; color: #9ca3af; margin-bottom: 2px; white-space: nowrap;">up to date with${upstreamLabel}</div>`);
    }
  }
  
  // Get branch metadata
  const metadata = window.state?.branchMetadata?.[branchName];
  
  // Get last commit on this branch
  const lastCommit = findLatestCommitOnBranch(branchName, graphState.commits || []);
  
  // Last commit information
  if (lastCommit) {
    const lastCommitDate = lastCommit.date || metadata?.lastCommitDate;
    if (lastCommitDate) {
      // Use formatRelativeTime from script.js if available, otherwise format manually
      let relativeTime = "";
      const formatFn = (typeof window !== 'undefined' && typeof window.formatRelativeTime === 'function') 
        ? window.formatRelativeTime 
        : (typeof formatRelativeTime === 'function' ? formatRelativeTime : null);
      if (formatFn) {
        relativeTime = formatFn(lastCommitDate);
      } else {
        // Fallback: simple relative time calculation
        try {
          const date = new Date(lastCommitDate);
          const now = new Date();
          const diffMs = now - date;
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          if (diffDays === 0) {
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            if (diffHours === 0) {
              const diffMinutes = Math.floor(diffMs / (1000 * 60));
              relativeTime = diffMinutes <= 1 ? "(just now)" : `(${diffMinutes} minutes ago)`;
            } else {
              relativeTime = diffHours === 1 ? "(1 hour ago)" : `(${diffHours} hours ago)`;
            }
          } else if (diffDays < 7) {
            relativeTime = diffDays === 1 ? "(1 day ago)" : `(${diffDays} days ago)`;
          } else if (diffDays < 30) {
            const diffWeeks = Math.floor(diffDays / 7);
            relativeTime = diffWeeks === 1 ? "(1 week ago)" : `(${diffWeeks} weeks ago)`;
          } else if (diffDays < 365) {
            const diffMonths = Math.floor(diffDays / 30);
            relativeTime = diffMonths === 1 ? "(1 month ago)" : `(${diffMonths} months ago)`;
          } else {
            const diffYears = Math.floor(diffDays / 365);
            relativeTime = diffYears === 1 ? "(1 year ago)" : `(${diffYears} years ago)`;
          }
        } catch (e) {
          relativeTime = "";
        }
      }
      // Remove parentheses from relativeTime if present
      const cleanRelativeTime = relativeTime.replace(/[()]/g, '').trim();
      parts.push(`<div style="font-size: 10px; color: #9ca3af; margin-bottom: 2px;">Last commit: ${cleanRelativeTime}</div>`);
    }
    
    // Last commit author
    if (lastCommit.author) {
      parts.push(`<div style="font-size: 10px; color: #9ca3af; margin-bottom: 2px;">Author: ${lastCommit.author}</div>`);
    }
    
    // Branch creation date from API
    console.log("buildBranchTooltipContent: creationInfo=", creationInfo);
    if (creationInfo && creationInfo.found && creationInfo.commitDate) {
      const relativeTime = formatRelativeTimeLocal(creationInfo.commitDate);
      console.log("buildBranchTooltipContent: relativeTime=", relativeTime);
      if (relativeTime) {
        // For main-like branches (root commits), show "First commit" instead of "Created"
        const label = creationInfo.isRootCommit ? "First commit" : "Created";
        parts.push(`<div style="font-size: 10px; color: #9ca3af; margin-bottom: 2px; white-space: nowrap;">${label}: ${relativeTime}</div>`);
      }
    }
  } else if (metadata?.lastCommitDate || metadata?.last_commit_date) {
    // Fallback to metadata date if commit not found
    const metadataDate = metadata.lastCommitDate || metadata.last_commit_date;
    let relativeTime = "";
    const formatFn = typeof formatRelativeTime === 'function' ? formatRelativeTime : 
                     (typeof window !== 'undefined' && typeof window.formatRelativeTime === 'function') ? window.formatRelativeTime : null;
    if (formatFn) {
      relativeTime = formatFn(metadataDate);
    }
    const cleanRelativeTime = relativeTime.replace(/[()]/g, '').trim();
    if (cleanRelativeTime) {
      parts.push(`<div style="font-size: 10px; color: #9ca3af; margin-bottom: 2px;">Last commit: ${cleanRelativeTime}</div>`);
    }
  }
  
  // Branch status indicators
  const statusIndicators = [];
  if (metadata) {
    if (metadata.isMerged || metadata.is_merged) {
      statusIndicators.push('<span style="color: #10b981;">Merged</span>');
    }
    if (metadata.isStale || metadata.is_stale) {
      statusIndicators.push('<span style="color: #f59e0b;">Stale</span>');
    }
    if (metadata.isUnborn || metadata.is_unborn) {
      statusIndicators.push('<span style="color: #6b7280;">Unborn</span>');
    }
  }
  
  if (statusIndicators.length > 0) {
    parts.push(`<div style="font-size: 10px; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(156, 163, 175, 0.2);">Status: ${statusIndicators.join(", ")}</div>`);
  }
  
  return parts.join("");
}

function collectReachableCommits(headSha, commitIndex) {
  const seen = new Set();
  const stack = [];
  if (headSha && commitIndex.has(headSha)) {
    stack.push(headSha);
  }
  while (stack.length) {
    const sha = stack.pop();
    if (seen.has(sha)) continue;
    seen.add(sha);
    const c = commitIndex.get(sha);
    if (!c || !Array.isArray(c.parents)) continue;
    for (const p of c.parents) {
      if (p && !seen.has(p) && commitIndex.has(p)) {
        stack.push(p);
      }
    }
  }
  return seen;
}

// Compute an approximate ahead/behind count versus the main-like branch,
// using only the commits currently loaded into graphState.commits.
function computeAheadBehindVsMain(branchName) {
  if (!branchName || !Array.isArray(graphState.commits)) return null;

  // Main-like branches are the baseline; treat them as up-to-date.
  if (isMainLikeBranch(branchName)) {
    const upstream = getMainBaselineBranchName();
    return { ahead: 0, behind: 0, upstream };
  }

  const commits = graphState.commits;
  const commitIndex = buildCommitIndex(commits);

  const mainBranch = getMainBaselineBranchName();
  const mainHead = findLatestCommitOnBranch(mainBranch, commits);
  const branchHead = findLatestCommitOnBranch(branchName, commits);

  if (!mainHead || !branchHead) {
    return null;
  }

  const mainSet = collectReachableCommits(mainHead.sha, commitIndex);
  const branchSet = collectReachableCommits(branchHead.sha, commitIndex);

  let ahead = 0;
  branchSet.forEach((sha) => {
    if (!mainSet.has(sha)) ahead++;
  });

  let behind = 0;
  mainSet.forEach((sha) => {
    if (!branchSet.has(sha)) behind++;
  });

  return { ahead, behind, upstream: mainBranch };
}

function makeBranchOrder(branchNames) {
  const names = Array.from(branchNames);
  const rank = (name) => {
    if (name === "main" || name === "origin/main") return 0;
    if (name === "master" || name === "origin/master") return 1;
    if (name.startsWith("release")) return 2;
    if (name.startsWith("origin/")) return 3;
    if (name === "develop" || name === "origin/develop") return 4;
    return 10;
  };
  names.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra === rb) return a.localeCompare(b);
    return ra - rb;
  });
  return names;
}

function isMainLikeBranch(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  return (
    lower === "main" ||
    lower === "master" ||
    lower === "trunk" ||
    lower === "develop" ||
    lower.endsWith("/main") ||
    lower.endsWith("/master") ||
    lower.endsWith("/develop")
  );
}

function pickMergeSourceBranch(nodeBranch, commit) {
  const branches = Array.isArray(commit.branches) ? commit.branches : [];
  if (branches.length === 0) {
    return null;
  }

  // Prefer a branch that is not the lane branch and not main-like.
  let candidates = branches.filter(
    (b) => b && b !== nodeBranch && !isMainLikeBranch(b)
  );

  // If nothing non-main, fall back to any branch that's not the lane branch.
  if (candidates.length === 0) {
    candidates = branches.filter((b) => b && b !== nodeBranch);
  }

  if (candidates.length > 0) {
    return candidates[0];
  }

  // Last resort: try to parse from message, e.g. "Merge pull request #123 from origin/feat/login"
  if (commit.message) {
    const m = commit.message.match(/from\s+([^\s]+)/i);
    if (m && m[1]) {
      return m[1];
    }
  }

  return null;
}

function colorForBranch(branch, branchColor) {
  if (!branch) return "#4b5563";
  // Main-like branches always get the dedicated main color
  if (isMainLikeBranch(branch)) {
    branchColor.set(branch, MAIN_BRANCH_COLOR);
    return MAIN_BRANCH_COLOR;
  }
  if (branchColor.has(branch)) return branchColor.get(branch);
  // Hash to pick from palette
  let h = 0;
  const s = String(branch);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  const color = lanePalette[Math.abs(h) % lanePalette.length];
  branchColor.set(branch, color);
  return color;
}

const graphState = {
  canvas: null,
  ctx: null,
  nodes: [],      // { sha, x, y, branch, isHead, isMain, isMerge, commit }
  edges: [],      // { from, to }
  tags: [],       // { name, sha }
  shaToIndex: new Map(),
  camera: { scale: 1, offsetX: 0, offsetY: 0 },
  bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  branchOrder: [],
  branchLane: new Map(),   // branch -> lane index
  branchColor: new Map(),  // branch -> color
  lanePrimaryBranch: new Map(), // lane index -> primary branch label
  branchLabels: new Map(), // branch -> label container element
  branchLabelsSignature: "",
  allBranchesMode: false,
  orientation: "vertical", // "vertical" (lanes vertical, time down) or "horizontal" (lanes horizontal, time right)
  commits: [],
  focusBranch: null,
  highlightedBranch: null, // Branch being hovered over in pill - dims all other branches
  hoverIndex: -1,
  hoveredCommitMessageIndex: -1, // Index of commit message being hovered (for horizontal map)
  repo: null,
  maxVisibleLanesOverride: null,
  rawCommits: [],
  showCommitMessages: true,
  legendDragging: false,
  legendDragOffsetX: 0,
  legendDragOffsetY: 0,
  controlsDragging: false,
  controlsDragOffsetX: 0,
  controlsDragOffsetY: 0,
  overlay: null,
  tooltip: null,
  dragging: false,
  lastDragX: 0,
  lastDragY: 0,
};

// Cache tags per repo so we don't re-fetch them on every graph toggle.
const cachedTagsByRepo = new Map(); // repo -> tags array

// Flag to prevent autoFit() from resetting camera after autoFocusOnLatest()
let shouldPreserveCameraOnResize = false;

function ensureCanvas() {
  if (graphState.canvas) return graphState.canvas;
  const canvas = document.getElementById("graphCanvas");
  if (!canvas) {
    console.error("graphCanvas not found in DOM");
    return null;
  }
  graphState.canvas = canvas;
  graphState.ctx = canvas.getContext("2d");
  setupOverlay();
  setupInteractions(canvas);
  onResize();
  window.addEventListener("resize", onResize);
  return canvas;
}

function setupOverlay() {
  if (graphState.overlay) {
    // Ensure tooltip is accessible
    if (!graphState.tooltip) {
      graphState.tooltip = graphState.overlay.querySelector("#graphTooltip");
    }
    // Ensure legend status is accessible
    if (!graphState.legendStatus) {
      graphState.legendStatus = graphState.overlay.querySelector("#graphLegendStatus");
    }
    return;
  }
  const container = document.getElementById("graphContainer");
  if (!container) return;
  // Keep fixed positioning set by switchViewMode, don't override to relative
  // container.style.position = "relative";
  const overlay = document.createElement("div");
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.pointerEvents = "none";
  overlay.innerHTML = `
    <style>
      #graphShowMessagesToggle:focus,
      #graphHorizontalMapTransparency:focus,
      #graphHorizontalMapSize:focus {
        outline: 1px solid rgba(56, 189, 248, 0.3);
        outline-offset: 2px;
      }
      #graphShowMessagesToggle:focus-visible,
      #graphHorizontalMapTransparency:focus-visible,
      #graphHorizontalMapSize:focus-visible {
        outline: 1px solid rgba(56, 189, 248, 0.4);
        outline-offset: 2px;
      }
    </style>
    <div id="graphTooltip"
         style="position:absolute; padding:6px 8px; background:rgba(15,23,42,0.96);
                color:#e5e7eb; border-radius:6px; border:1px solid #1f2937;
                font-size:12px; display:none; max-width:260px;
                box-shadow:0 12px 30px rgba(0,0,0,0.5);"></div>
    <div id="graphBranchLabels"
         style="position:absolute; top:-4px; left:8px; right:8px; display:flex;
                flex-wrap:wrap; gap:6px; pointer-events:auto;"></div>
    <!-- Informational Legend - Bottom Left -->
    <div id="graphLegendHelp"
         style="position:absolute; bottom:10px; left:10px; max-width:260px;
                pointer-events:auto; font-size:11px; color:#e5e7eb;
                font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <div id="graphLegendBody"
           style="padding:8px; border-radius:10px;
                  background:rgba(15,23,42,0.6); border:1px solid rgba(31,41,55,0.5);
                  box-shadow:0 14px 40px rgba(0,0,0,0.6); display:block;">
        <div style="font-size:9px; color:#9ca3af; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; font-weight:600;">Legend</div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="width:10px; height:10px; border-radius:50%; background:#38bdf8;"></span>
          <span>Commit</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="position:relative; width:14px; height:14px; border-radius:50%;
                       border:2px solid #22c55e; box-sizing:border-box;">
            <span style="position:absolute; inset:3px; border-radius:50%; border:2px solid #0f172a;"></span>
          </span>
          <span>Merge commit / interchange</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="position:relative; width:14px; height:14px; border-radius:50%;
                       border:2px solid #38bdf8; box-sizing:border-box;">
            <span style="position:absolute; inset:3px; background:#38bdf8;"></span>
            <span style="position:absolute; inset:4px; background:#f9fafb; border-radius:3px;"></span>
          </span>
          <span>Pull request merge commit (non‑squash)</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="width:10px; height:10px; transform:rotate(45deg);
                       border-radius:2px; border:2px solid #38bdf8;
                       background:#f9fafb;"></span>
          <span>Squash merge from PR</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="width:12px; height:12px; transform:rotate(45deg);
                       border-radius:2px; border:2px solid #facc15;
                       background:rgba(250,204,21,0.2);"></span>
          <span>Tag / release</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="flex:1; height:4px; border-radius:999px;
                       background:linear-gradient(to right,#38bdf8,#38bdf8);"></span>
          <span>Branch lane (line & track)</span>
        </div>
      </div>
    </div>
    <!-- Controls - Top Right -->
    <div id="graphControls"
         style="position:absolute; top:10px; right:10px;
                pointer-events:auto; font-size:11px; color:#e5e7eb;
                font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <div style="padding:8px; border-radius:10px;
                  background:rgba(15,23,42,0.6); border:1px solid rgba(31,41,55,0.5);
                  box-shadow:0 14px 40px rgba(0,0,0,0.6); display:block;">
        <div style="font-size:9px; color:#9ca3af; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; font-weight:600;">Controls</div>
        <div id="graphLegendStatus"
             style="margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid rgba(31,41,55,0.5);
                    font-size:10px; color:#9ca3af; display:none; text-align:center;">
        </div>
        <div id="graphZoomControls"
             style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:9px; color:#9ca3af; min-width:65px;">Zoom</span>
          <div style="display:flex; gap:4px; align-items:center;">
            <button id="graphZoomOut"
                    style="width:45px; height:22px; border-radius:999px; border:1px solid #4b5563;
                           background:rgba(15,23,42,0.95); color:#e5e7eb; cursor:pointer;
                           font-size:14px; display:flex; align-items:center; justify-content:center;">-</button>
            <button id="graphZoomIn"
                    style="width:45px; height:22px; border-radius:999px; border:1px solid #4b5563;
                           background:rgba(15,23,42,0.95); color:#e5e7eb; cursor:pointer;
                           font-size:14px; display:flex; align-items:center; justify-content:center;">+</button>
            <span id="graphZoomLevel"
                  style="min-width:50px; font-size:10px; color:#9ca3af; text-align:center; margin-left:4px;">0%</span>
          </div>
        </div>
        <div id="graphHorizontalMapControls" style="display:none; margin-top:8px; padding-top:8px; border-top:1px solid rgba(31,41,55,0.5);">
          <div style="display:flex; flex-direction:column; gap:6px;">
            <label style="display:flex; align-items:center; gap:6px; font-size:10px; color:#cbd5e1; margin-bottom:2px;">
              <input id="graphShowMessagesToggle"
                     type="checkbox"
                     style="width:12px; height:12px; cursor:pointer; accent-color:#38bdf8;">
              <span>Show commit messages</span>
            </label>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:9px; color:#9ca3af; min-width:65px;">Opacity</span>
              <div style="flex:1; min-width:0; display:flex; align-items:center;">
                <input type="range" id="graphHorizontalMapTransparency" min="0.05" max="1" step="0.01" value="1" style="width:100%; height:1px; cursor:pointer; margin:0; padding:0;">
              </div>
              <span id="graphHorizontalMapTransparencyValue" style="min-width:25px; text-align:right; color:#9ca3af; font-size:8px;">100%</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:9px; color:#9ca3af; min-width:65px;">Size</span>
              <div style="flex:1; min-width:0; display:flex; align-items:center;">
                <input type="range" id="graphHorizontalMapSize" min="0.5" max="1" step="0.01" value="1" style="width:100%; height:1px; cursor:pointer; margin:0; padding:0;">
              </div>
              <span id="graphHorizontalMapSizeValue" style="min-width:25px; text-align:right; color:#9ca3af; font-size:8px;">100%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(overlay);
  graphState.overlay = overlay;
  graphState.tooltip = overlay.querySelector("#graphTooltip");
  graphState.legendStatus = overlay.querySelector("#graphLegendStatus");
  graphState.zoomLevel = overlay.querySelector("#graphZoomLevel");

  // Zoom controls - use visual center so zoom happens at the center of the
  // graph content area (like Google Maps), not the raw canvas center
  const zoomInBtn = overlay.querySelector("#graphZoomIn");
  const zoomOutBtn = overlay.querySelector("#graphZoomOut");
  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const center = getVisualCenter();
      zoomAt(1.4, center.x, center.y);
    });
  }
  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const center = getVisualCenter();
      zoomAt(1 / 1.4, center.x, center.y);
    });
  }

  // Make legend draggable
  const legendContainer = overlay.querySelector("#graphLegendHelp");
  const legendBody = overlay.querySelector("#graphLegendBody");
  if (legendContainer && legendBody) {
    legendContainer.style.cursor = "grab";

    legendBody.addEventListener("mousedown", (e) => {
      // Ignore drags starting from interactive controls
      const targetId = e.target && e.target.id;
      if (
        targetId === "graphZoomIn" ||
        targetId === "graphZoomOut" ||
        targetId === "graphShowMessagesToggle"
      ) {
        return;
      }
      if (e.button !== 0) return; // left button only
      e.preventDefault();
      e.stopPropagation();
      graphState.legendDragging = true;
      legendContainer.style.cursor = "grabbing";

      const rect = legendContainer.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      graphState.legendDragOffsetX = e.clientX - rect.left;
      graphState.legendDragOffsetY = e.clientY - rect.top;

      // Switch to left/top positioning so we can freely move it.
      const left = rect.left - containerRect.left;
      const top = rect.top - containerRect.top;
      legendContainer.style.right = "auto";
      legendContainer.style.left = `${left}px`;
      legendContainer.style.top = `${top}px`;
    });

    window.addEventListener("mousemove", (e) => {
      if (!graphState.legendDragging) return;
      const containerRect = container.getBoundingClientRect();
      let newLeft = e.clientX - containerRect.left - graphState.legendDragOffsetX;
      let newTop = e.clientY - containerRect.top - graphState.legendDragOffsetY;

      // Clamp within container bounds
      const legendRect = legendContainer.getBoundingClientRect();
      const width = legendRect.width;
      const height = legendRect.height;
      newLeft = Math.max(0, Math.min(newLeft, containerRect.width - width));
      newTop = Math.max(0, Math.min(newTop, containerRect.height - height));

      legendContainer.style.left = `${newLeft}px`;
      legendContainer.style.top = `${newTop}px`;
    });

    window.addEventListener("mouseup", () => {
      if (graphState.legendDragging) {
        graphState.legendDragging = false;
        legendContainer.style.cursor = "grab";
      }
    });

    // Add touch support for legend dragging
    legendBody.addEventListener("touchstart", (e) => {
      // Ignore drags starting from interactive controls
      const targetId = e.target && e.target.id;
      if (
        targetId === "graphZoomIn" ||
        targetId === "graphZoomOut" ||
        targetId === "graphShowMessagesToggle"
      ) {
        return;
      }
      if (e.touches.length !== 1) return; // Only handle single touch
      e.preventDefault();
      e.stopPropagation();
      graphState.legendDragging = true;
      legendContainer.style.cursor = "grabbing";

      const touch = e.touches[0];
      const rect = legendContainer.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      graphState.legendDragOffsetX = touch.clientX - rect.left;
      graphState.legendDragOffsetY = touch.clientY - rect.top;

      // Switch to left/top positioning so we can freely move it.
      const left = rect.left - containerRect.left;
      const top = rect.top - containerRect.top;
      legendContainer.style.right = "auto";
      legendContainer.style.left = `${left}px`;
      legendContainer.style.top = `${top}px`;
    }, { passive: false });

    window.addEventListener("touchmove", (e) => {
      if (!graphState.legendDragging) return;
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const touch = e.touches[0];
      const containerRect = container.getBoundingClientRect();
      let newLeft = touch.clientX - containerRect.left - graphState.legendDragOffsetX;
      let newTop = touch.clientY - containerRect.top - graphState.legendDragOffsetY;

      // Clamp within container bounds
      const legendRect = legendContainer.getBoundingClientRect();
      const width = legendRect.width;
      const height = legendRect.height;
      newLeft = Math.max(0, Math.min(newLeft, containerRect.width - width));
      newTop = Math.max(0, Math.min(newTop, containerRect.height - height));

      legendContainer.style.left = `${newLeft}px`;
      legendContainer.style.top = `${newTop}px`;
    }, { passive: false });

    window.addEventListener("touchend", () => {
      if (graphState.legendDragging) {
        graphState.legendDragging = false;
        legendContainer.style.cursor = "grab";
      }
    });

    window.addEventListener("touchcancel", () => {
      if (graphState.legendDragging) {
        graphState.legendDragging = false;
        legendContainer.style.cursor = "grab";
      }
    });
  }

  // Make controls draggable
  const controlsContainer = overlay.querySelector("#graphControls");
  const controlsBody = controlsContainer?.querySelector("div");
  if (controlsContainer && controlsBody) {
    controlsContainer.style.cursor = "grab";

    controlsBody.addEventListener("mousedown", (e) => {
      // Ignore drags starting from interactive controls
      const targetId = e.target && e.target.id;
      if (
        targetId === "graphZoomIn" ||
        targetId === "graphZoomOut" ||
        targetId === "graphShowMessagesToggle" ||
        e.target.tagName === "INPUT" ||
        e.target.tagName === "BUTTON" ||
        e.target.tagName === "LABEL"
      ) {
        return;
      }
      if (e.button !== 0) return; // left button only
      e.preventDefault();
      e.stopPropagation();
      graphState.controlsDragging = true;
      controlsContainer.style.cursor = "grabbing";

      const rect = controlsContainer.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      graphState.controlsDragOffsetX = e.clientX - rect.left;
      graphState.controlsDragOffsetY = e.clientY - rect.top;

      // Switch to left/top positioning so we can freely move it.
      const left = rect.left - containerRect.left;
      const top = rect.top - containerRect.top;
      controlsContainer.style.right = "auto";
      controlsContainer.style.left = `${left}px`;
      controlsContainer.style.top = `${top}px`;
    });

    window.addEventListener("mousemove", (e) => {
      if (!graphState.controlsDragging) return;
      const containerRect = container.getBoundingClientRect();
      let newLeft = e.clientX - containerRect.left - graphState.controlsDragOffsetX;
      let newTop = e.clientY - containerRect.top - graphState.controlsDragOffsetY;

      // Clamp within container bounds
      const controlsRect = controlsContainer.getBoundingClientRect();
      const width = controlsRect.width;
      const height = controlsRect.height;
      newLeft = Math.max(0, Math.min(newLeft, containerRect.width - width));
      newTop = Math.max(0, Math.min(newTop, containerRect.height - height));

      controlsContainer.style.left = `${newLeft}px`;
      controlsContainer.style.top = `${newTop}px`;
    });

    window.addEventListener("mouseup", () => {
      if (graphState.controlsDragging) {
        graphState.controlsDragging = false;
        controlsContainer.style.cursor = "grab";
      }
    });

    // Add touch support for controls dragging
    controlsBody.addEventListener("touchstart", (e) => {
      // Ignore drags starting from interactive controls
      const targetId = e.target && e.target.id;
      if (
        targetId === "graphZoomIn" ||
        targetId === "graphZoomOut" ||
        targetId === "graphShowMessagesToggle" ||
        e.target.tagName === "INPUT" ||
        e.target.tagName === "BUTTON" ||
        e.target.tagName === "LABEL"
      ) {
        return;
      }
      if (e.touches.length !== 1) return; // Only handle single touch
      e.preventDefault();
      e.stopPropagation();
      graphState.controlsDragging = true;
      controlsContainer.style.cursor = "grabbing";

      const touch = e.touches[0];
      const rect = controlsContainer.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      graphState.controlsDragOffsetX = touch.clientX - rect.left;
      graphState.controlsDragOffsetY = touch.clientY - rect.top;

      // Switch to left/top positioning so we can freely move it.
      const left = rect.left - containerRect.left;
      const top = rect.top - containerRect.top;
      controlsContainer.style.right = "auto";
      controlsContainer.style.left = `${left}px`;
      controlsContainer.style.top = `${top}px`;
    }, { passive: false });

    window.addEventListener("touchmove", (e) => {
      if (!graphState.controlsDragging) return;
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const touch = e.touches[0];
      const containerRect = container.getBoundingClientRect();
      let newLeft = touch.clientX - containerRect.left - graphState.controlsDragOffsetX;
      let newTop = touch.clientY - containerRect.top - graphState.controlsDragOffsetY;

      // Clamp within container bounds
      const controlsRect = controlsContainer.getBoundingClientRect();
      const width = controlsRect.width;
      const height = controlsRect.height;
      newLeft = Math.max(0, Math.min(newLeft, containerRect.width - width));
      newTop = Math.max(0, Math.min(newTop, containerRect.height - height));

      controlsContainer.style.left = `${newLeft}px`;
      controlsContainer.style.top = `${newTop}px`;
    }, { passive: false });

    window.addEventListener("touchend", () => {
      if (graphState.controlsDragging) {
        graphState.controlsDragging = false;
        controlsContainer.style.cursor = "grab";
      }
    });

    window.addEventListener("touchcancel", () => {
      if (graphState.controlsDragging) {
        graphState.controlsDragging = false;
        controlsContainer.style.cursor = "grab";
      }
    });
  }

  // Commit message toggle
  const showMessagesToggle = overlay.querySelector("#graphShowMessagesToggle");
  if (showMessagesToggle) {
    // Ensure graphState.showCommitMessages is initialized
    if (graphState.showCommitMessages === undefined || graphState.showCommitMessages === null) {
      graphState.showCommitMessages = true;
    }
    // Always sync the checkbox with the state
    showMessagesToggle.checked = !!graphState.showCommitMessages;
    showMessagesToggle.addEventListener("change", (e) => {
      graphState.showCommitMessages = !!e.target.checked;
      draw();
    });
  }

  // Horizontal map controls (transparency and size sliders)
  const horizontalMapControls = overlay.querySelector("#graphHorizontalMapControls");
  const transparencySlider = overlay.querySelector("#graphHorizontalMapTransparency");
  const transparencyValue = overlay.querySelector("#graphHorizontalMapTransparencyValue");
  const sizeSlider = overlay.querySelector("#graphHorizontalMapSize");
  const sizeValue = overlay.querySelector("#graphHorizontalMapSizeValue");

  // Update visibility based on orientation
  function updateHorizontalMapControlsVisibility() {
    if (horizontalMapControls) {
      horizontalMapControls.style.display = graphState.orientation === "horizontal" ? "block" : "none";
    }
  }
  updateHorizontalMapControlsVisibility();

  // Transparency slider handler
  if (transparencySlider) {
    const savedOpacity = Math.max(0.05, Math.min(1.0, parseFloat(localStorage.getItem("gitzada:horizontalMapTransparency") || "1.0") || 1.0));
    transparencySlider.value = savedOpacity;
    if (transparencyValue) {
      transparencyValue.textContent = Math.round(savedOpacity * 100) + "%";
    }
    transparencySlider.addEventListener("input", (e) => {
      let opacity = parseFloat(e.target.value);
      if (isNaN(opacity) || opacity < 0.05) {
        opacity = 0.05;
        e.target.value = opacity;
      } else if (opacity > 1.0) {
        opacity = 1.0;
        e.target.value = opacity;
      }
      localStorage.setItem("gitzada:horizontalMapTransparency", String(opacity));
      if (transparencyValue) {
        transparencyValue.textContent = Math.round(opacity * 100) + "%";
      }
      // Ensure toggle state is preserved - defensive check
      const showMessagesToggle = overlay.querySelector("#graphShowMessagesToggle");
      if (showMessagesToggle && graphState.showCommitMessages !== false) {
        showMessagesToggle.checked = true;
        graphState.showCommitMessages = true;
      }
      draw();
    });
  }

  // Size slider handler
  if (sizeSlider) {
    const savedSize = parseFloat(localStorage.getItem("gitzada:horizontalMapSize") || "1.0");
    sizeSlider.value = savedSize;
    if (sizeValue) {
      sizeValue.textContent = Math.round(savedSize * 100) + "%";
    }
    sizeSlider.addEventListener("input", (e) => {
      const size = parseFloat(e.target.value);
      localStorage.setItem("gitzada:horizontalMapSize", String(size));
      if (sizeValue) {
        sizeValue.textContent = Math.round(size * 100) + "%";
      }
      draw();
    });
  }

  // Store update function for use when orientation changes
  graphState.updateHorizontalMapControlsVisibility = updateHorizontalMapControlsVisibility;
}

function setupInteractions(canvas) {
  canvas.addEventListener("mousedown", (e) => {
    // Check if clicking on a commit node
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    let clickedNode = null;
    let bestDist = 22; // Same threshold as hover detection
    graphState.nodes.forEach((n) => {
      const p = worldToScreen(n.x, n.y);
      const dx = p.x - mx;
      const dy = p.y - my;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        clickedNode = n;
      }
    });
    
    if (clickedNode && clickedNode.commit && clickedNode.commit.sha) {
      // User clicked on a commit node - switch to Activity View and select it
      const commitSha = clickedNode.commit.sha;
      
      // Switch to Activity View and select the commit
      if (window.switchToActivityView && typeof window.switchToActivityView === 'function') {
        window.switchToActivityView(commitSha);
      }
      return; // Don't start dragging
    }
    
    // No node clicked - start dragging
    graphState.dragging = true;
    graphState.lastDragX = e.clientX;
    graphState.lastDragY = e.clientY;
  });
  window.addEventListener("mouseup", () => {
    graphState.dragging = false;
  });
  window.addEventListener("mousemove", (e) => {
    if (graphState.dragging) {
      const dx = e.clientX - graphState.lastDragX;
      const dy = e.clientY - graphState.lastDragY;
      graphState.lastDragX = e.clientX;
      graphState.lastDragY = e.clientY;
      const invScale = 1 / graphState.camera.scale;
      graphState.camera.offsetX += dx * invScale;
      graphState.camera.offsetY += dy * invScale;
      // Don't clamp during dragging - allow smooth panning
      draw();
    } else {
      handleHover(e);
    }
  });
  
  // Touch event handlers for touch screen support
  // Track touch state
  graphState.touching = false;
  graphState.touchStartDistance = null;
  graphState.touchStartScale = null;
  graphState.touchCenterX = null;
  graphState.touchCenterY = null;
  
  // Helper function to get distance between two touches
  const getTouchDistance = (touch1, touch2) => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.hypot(dx, dy);
  };
  
  // Helper function to get center point between two touches
  const getTouchCenter = (touch1, touch2) => {
    return {
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2
    };
  };
  
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      // Single touch - check for node click or start dragging
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const mx = touch.clientX - rect.left;
      const my = touch.clientY - rect.top;
      
      // Reset pinch-to-zoom state when starting single touch
      graphState.touchStartDistance = null;
      graphState.touchStartScale = null;
      graphState.touchCenterX = null;
      graphState.touchCenterY = null;
      
      let clickedNode = null;
      let bestDist = 22; // Same threshold as hover detection
      graphState.nodes.forEach((n) => {
        const p = worldToScreen(n.x, n.y);
        const dx = p.x - mx;
        const dy = p.y - my;
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
          bestDist = d;
          clickedNode = n;
        }
      });
      
      if (clickedNode && clickedNode.commit && clickedNode.commit.sha) {
        // User tapped on a commit node - switch to Activity View and select it
        const commitSha = clickedNode.commit.sha;
        
        // Switch to Activity View and select the commit
        if (window.switchToActivityView && typeof window.switchToActivityView === 'function') {
          window.switchToActivityView(commitSha);
        }
        e.preventDefault();
        return; // Don't start dragging
      }
      
      // No node clicked - start dragging
      graphState.touching = true;
      graphState.lastDragX = touch.clientX;
      graphState.lastDragY = touch.clientY;
      e.preventDefault(); // Prevent scrolling
    } else if (e.touches.length === 2) {
      // Two touches - initialize pinch-to-zoom
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const rect = canvas.getBoundingClientRect();

      // Initialize pinch-to-zoom state with current touch positions
      graphState.touchStartDistance = getTouchDistance(touch1, touch2);
      graphState.touchStartScale = graphState.camera.scale;
      const center = getTouchCenter(touch1, touch2);
      const centerX = center.x - rect.left;
      const centerY = center.y - rect.top;
      graphState.touchCenterX = centerX;
      graphState.touchCenterY = centerY;
      graphState.touching = true;

      // Calculate and store the world point under the initial pinch center
      // This point will be kept under the finger center throughout the gesture
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const isHorizontal = graphState.orientation === "horizontal";
      const marginX = isHorizontal ? 60 : w * 0.2;
      const marginY = isHorizontal ? h * 0.15 : 40;
      const scale = graphState.camera.scale;
      graphState.touchWorldX = (centerX - marginX) / scale - graphState.camera.offsetX;
      graphState.touchWorldY = (centerY - marginY) / scale - graphState.camera.offsetY;

      // Reset single-touch drag state
      graphState.lastDragX = null;
      graphState.lastDragY = null;

      e.preventDefault(); // Prevent scrolling and zooming
    }
  }, { passive: false });
  
  window.addEventListener("touchmove", (e) => {
    if (!graphState.touching) return;
    
    if (e.touches.length === 1) {
      // Single touch - panning
      // Only pan if we're not in the middle of a pinch gesture
      if (graphState.touchStartDistance === null && graphState.lastDragX !== null && graphState.lastDragY !== null) {
        const touch = e.touches[0];
        const dx = touch.clientX - graphState.lastDragX;
        const dy = touch.clientY - graphState.lastDragY;
        graphState.lastDragX = touch.clientX;
        graphState.lastDragY = touch.clientY;
        const invScale = 1 / graphState.camera.scale;
        graphState.camera.offsetX += dx * invScale;
        graphState.camera.offsetY += dy * invScale;
        draw();
      }
      e.preventDefault(); // Prevent scrolling
    } else if (e.touches.length === 2) {
      // Two touches - pinch-to-zoom
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const currentDistance = getTouchDistance(touch1, touch2);
      const rect = canvas.getBoundingClientRect();
      const currentCenter = getTouchCenter(touch1, touch2);
      const currentCenterX = currentCenter.x - rect.left;
      const currentCenterY = currentCenter.y - rect.top;

      if (graphState.touchStartDistance && graphState.touchStartDistance > 0 &&
          graphState.touchWorldX !== undefined && graphState.touchWorldY !== undefined) {
        // Calculate new scale from the ratio of distances
        const scaleFactor = currentDistance / graphState.touchStartDistance;
        const newScale = Math.max(0.05, Math.min(10, graphState.touchStartScale * scaleFactor));

        if (newScale !== graphState.camera.scale) {
          // Get margins for current orientation
          const w = canvas.clientWidth;
          const h = canvas.clientHeight;
          const isHorizontal = graphState.orientation === "horizontal";
          const marginX = isHorizontal ? 60 : w * 0.2;
          const marginY = isHorizontal ? h * 0.15 : 40;

          // Apply new scale
          graphState.camera.scale = newScale;

          // Calculate offset to keep the original world point under the current finger center
          // Formula: offset = (screen - margin) / scale - world
          graphState.camera.offsetX = (currentCenterX - marginX) / newScale - graphState.touchWorldX;
          graphState.camera.offsetY = (currentCenterY - marginY) / newScale - graphState.touchWorldY;

          updateZoomLevelDisplay();
          draw();
        }
      } else {
        // Initialize pinch state - capture the world point under initial finger center
        graphState.touchStartDistance = currentDistance;
        graphState.touchStartScale = graphState.camera.scale;

        // Calculate world coordinates of the initial pinch center
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const isHorizontal = graphState.orientation === "horizontal";
        const marginX = isHorizontal ? 60 : w * 0.2;
        const marginY = isHorizontal ? h * 0.15 : 40;
        const scale = graphState.camera.scale;

        graphState.touchWorldX = (currentCenterX - marginX) / scale - graphState.camera.offsetX;
        graphState.touchWorldY = (currentCenterY - marginY) / scale - graphState.camera.offsetY;
      }
      e.preventDefault(); // Prevent scrolling and zooming
    }
  }, { passive: false });
  
  window.addEventListener("touchend", (e) => {
    // Handle transitions between single and multi-touch
    if (e.touches.length === 1) {
      // Transition from 2 touches to 1 - switch to panning mode
      const touch = e.touches[0];
      graphState.lastDragX = touch.clientX;
      graphState.lastDragY = touch.clientY;
      graphState.touching = true;
      // Reset pinch-to-zoom state to allow panning
      graphState.touchStartDistance = null;
      graphState.touchStartScale = null;
      graphState.touchCenterX = null;
      graphState.touchCenterY = null;
      graphState.touchWorldX = undefined;
      graphState.touchWorldY = undefined;
    } else if (e.touches.length === 2) {
      // Still have 2 touches - reinitialize pinch state
      // This handles the case where one finger is lifted and another is added
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const rect = canvas.getBoundingClientRect();
      graphState.touchStartDistance = getTouchDistance(touch1, touch2);
      graphState.touchStartScale = graphState.camera.scale;
      const center = getTouchCenter(touch1, touch2);
      const centerX = center.x - rect.left;
      const centerY = center.y - rect.top;
      graphState.touchCenterX = centerX;
      graphState.touchCenterY = centerY;
      graphState.touching = true;

      // Recalculate world point for new finger positions
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const isHorizontal = graphState.orientation === "horizontal";
      const marginX = isHorizontal ? 60 : w * 0.2;
      const marginY = isHorizontal ? h * 0.15 : 40;
      const scale = graphState.camera.scale;
      graphState.touchWorldX = (centerX - marginX) / scale - graphState.camera.offsetX;
      graphState.touchWorldY = (centerY - marginY) / scale - graphState.camera.offsetY;

      // Reset single-touch drag state
      graphState.lastDragX = null;
      graphState.lastDragY = null;
    } else {
      // No touches remaining - reset all state
      graphState.touching = false;
      graphState.touchStartDistance = null;
      graphState.touchStartScale = null;
      graphState.touchCenterX = null;
      graphState.touchCenterY = null;
      graphState.touchWorldX = undefined;
      graphState.touchWorldY = undefined;
      graphState.lastDragX = null;
      graphState.lastDragY = null;
    }
  }, { passive: false });
  
  window.addEventListener("touchcancel", (e) => {
    // Reset all touch state when touch is cancelled
    graphState.touching = false;
    graphState.touchStartDistance = null;
    graphState.touchStartScale = null;
    graphState.touchCenterX = null;
    graphState.touchCenterY = null;
    graphState.lastDragX = null;
    graphState.lastDragY = null;
  }, { passive: false });
  
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.001);
      zoomAt(factor, offsetX, offsetY);
    },
    { passive: false }
  );
  
  // Arrow key navigation for graph panning
  // Only active when graph view is visible
  let arrowKeyHandler = null;
  const attachKeyboardNavigation = () => {
    if (arrowKeyHandler) return; // Already attached
    
    arrowKeyHandler = (e) => {
      // Check if graph view is active
      const graphContainer = document.getElementById("graphContainer");
      if (!graphContainer || graphContainer.style.display === "none") {
        return; // Graph not visible, let other handlers process
      }
      
      // Don't intercept if user is typing in an input/textarea
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
        return;
      }
      
      // Only handle arrow keys
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") {
        return;
      }
      
      // Pan speed: faster with Shift, slower with fine control
      const panSpeed = e.shiftKey ? 100 : 30;
      const invScale = 1 / graphState.camera.scale;
      const step = panSpeed * invScale;
      
      let handled = false;
      
      // Zoom controls: CTRL+UP (zoom in) and CTRL+DOWN (zoom out)
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          // Zoom in: use center of viewport
          const center = getVisualCenter();
          const zoomFactor = 1.2; // 20% zoom in
          zoomAt(zoomFactor, center.x, center.y);
          handled = true;
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          // Zoom out: use center of viewport
          const center = getVisualCenter();
          const zoomFactor = 1 / 1.2; // 20% zoom out
          // Prevent zooming out too far
          if (graphState.camera.scale * zoomFactor >= 0.1) {
            zoomAt(zoomFactor, center.x, center.y);
          }
          handled = true;
        }
      } else {
        // Pan controls (without CTRL)
        // Get inversion settings from main state
        const invertUpDown = window.state && window.state.invertUpDown ? window.state.invertUpDown : false;
        const invertLeftRight = window.state && window.state.invertLeftRight ? window.state.invertLeftRight : false;
        
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          graphState.camera.offsetX += invertLeftRight ? step : -step;
          handled = true;
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          graphState.camera.offsetX += invertLeftRight ? -step : step;
          handled = true;
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          // Up arrow moves view up (toward newer commits)
          graphState.camera.offsetY += invertUpDown ? -step : step;
          handled = true;
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          // Down arrow moves view down (toward older commits)
          graphState.camera.offsetY += invertUpDown ? step : -step;
          handled = true;
        }
      }
      
      if (handled) {
        draw();
      }
    };
    
    // Use capture phase to handle before other listeners
    window.addEventListener("keydown", arrowKeyHandler, true);
  };
  
  // Attach keyboard navigation when canvas is set up
  attachKeyboardNavigation();
  
  // Also make canvas focusable for keyboard navigation
  canvas.setAttribute("tabindex", "0");
  canvas.style.outline = "none";
  
  // Focus canvas when clicked to enable keyboard navigation
  canvas.addEventListener("click", () => {
    canvas.focus();
  });
}

function onResize() {
  const canvas = graphState.canvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = graphState.ctx;
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  
  // Do NOT auto-fit on generic resize events once we've focused/zoomed the
  // camera. Auto-fitting here was resetting `graphState.camera.scale` to a
  // very small value for large graphs (e.g. ~0.04), which made the zoom
  // indicator show large negative percentages (e.g. -96%) immediately after
  // autoFocusOnLatest() had set the scale to 1.0 (0% zoom).
  //
  // Instead, keep the current scale and only clamp offsets so the camera stays
  // within bounds. autoFit() is still available for explicit callers (e.g.,
  // the internal fallback in autoFocusOnLatest when it cannot determine a
  // reasonable focus region).
  clampCamera();
  draw();
}

function worldToScreen(x, y) {
  const canvas = graphState.canvas;
  if (!canvas) return { x: 0, y: 0 };

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const s = graphState.camera.scale;
  const isHorizontal = graphState.orientation === "horizontal";

  // Define margins for both layouts
  const verticalMarginX = w * 0.2;
  const verticalMarginY = 40;
  const horizontalMarginX = 60;
  const horizontalMarginY = h * 0.15;

  let sx, sy;

  if (isHorizontal) {
    // In horizontal mode, X is time (horizontal), Y is lanes (vertical).
    sx = (x + graphState.camera.offsetX) * s + horizontalMarginX;
    sy = (y + graphState.camera.offsetY) * s + horizontalMarginY;
  } else {
    // In vertical mode, X is lanes (horizontal), Y is time (vertical).
    sx = (x + graphState.camera.offsetX) * s + verticalMarginX;
    sy = (y + graphState.camera.offsetY) * s + verticalMarginY;
  }

  return { x: sx, y: sy };
}

function screenToWorld(sx, sy) {
  const canvas = graphState.canvas;
  if (!canvas) return { x: 0, y: 0 };

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const s = graphState.camera.scale;
  if (s === 0) return { x: 0, y: 0 };
  const isHorizontal = graphState.orientation === "horizontal";

  // Define margins matching worldToScreen
  const verticalMarginX = w * 0.2;
  const verticalMarginY = 40;
  const horizontalMarginX = 60;
  const horizontalMarginY = h * 0.15;

  let x, y;

  if (isHorizontal) {
    x = (sx - horizontalMarginX) / s - graphState.camera.offsetX;
    y = (sy - horizontalMarginY) / s - graphState.camera.offsetY;
  } else {
    x = (sx - verticalMarginX) / s - graphState.camera.offsetX;
    y = (sy - verticalMarginY) / s - graphState.camera.offsetY;
  }

  return { x, y };
}

/**
 * Get the visible viewport bounds in world coordinates.
 * Used for culling - skip rendering objects outside these bounds.
 * Returns { minX, maxX, minY, maxY } with padding for partially visible objects.
 */
function getVisibleBounds() {
  const canvas = graphState.canvas;
  if (!canvas) return { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // Convert screen corners to world coordinates
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(w, h);

  // Add padding for objects that are partially visible (stations, labels, etc.)
  const padding = 100; // world units

  return {
    minX: Math.min(topLeft.x, bottomRight.x) - padding,
    maxX: Math.max(topLeft.x, bottomRight.x) + padding,
    minY: Math.min(topLeft.y, bottomRight.y) - padding,
    maxY: Math.max(topLeft.y, bottomRight.y) + padding
  };
}

function getCanvasCenter() {
  const canvas = graphState.canvas;
  if (!canvas) return { x: 0, y: 0 };
  // Use clientWidth/clientHeight to match screenToWorld coordinate system
  return {
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2
  };
}

/**
 * Returns the screen coordinates of the center of the currently visible
 * world-space region. This ensures zoom in/out happens at the visual center
 * of what the user is looking at, similar to Google Maps behavior.
 */
function getVisualCenter() {
  const canvas = graphState.canvas;
  if (!canvas) return { x: 0, y: 0 };

  // Simply use the canvas center - the zoomAt function will handle
  // the coordinate transformation correctly
  return {
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2
  };
}

function updateZoomLevelDisplay() {
  if (!graphState.zoomLevel) return;
  const scale = graphState.camera.scale || 1;
  // Use 1.0 as baseline (0%), show percentage difference
  const percentage = Math.round((scale - 1.0) * 100);
  const sign = percentage >= 0 ? '+' : '';
  graphState.zoomLevel.textContent = `${sign}${percentage}%`;
}

function zoomAt(factor, sx, sy) {
  const canvas = graphState.canvas;
  if (!canvas) return;
  const oldScale = graphState.camera.scale || 1;
  const newScale = Math.max(0.05, Math.min(10, oldScale * factor));
  if (newScale === oldScale) {
    return;
  }

  // Get margins for current orientation
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const isHorizontal = graphState.orientation === "horizontal";
  const marginX = isHorizontal ? 60 : w * 0.2;
  const marginY = isHorizontal ? h * 0.15 : 40;

  const oldOffsetX = graphState.camera.offsetX;
  const oldOffsetY = graphState.camera.offsetY;

  // Convert screen point to world coordinates using OLD scale
  // Formula: world = (screen - margin) / scale - offset
  const worldX = (sx - marginX) / oldScale - oldOffsetX;
  const worldY = (sy - marginY) / oldScale - oldOffsetY;

  // Apply new scale
  graphState.camera.scale = newScale;

  // Calculate what offset is needed to keep the same world point at the same screen position
  // Rearranging: offset = (screen - margin) / scale - world
  const newOffsetX = (sx - marginX) / newScale - worldX;
  const newOffsetY = (sy - marginY) / newScale - worldY;

  graphState.camera.offsetX = newOffsetX;
  graphState.camera.offsetY = newOffsetY;

  updateZoomLevelDisplay();
  draw();
}

function clampCamera() {
  const canvas = graphState.canvas;
  if (!canvas || !graphState.nodes.length) return;
  const s = graphState.camera.scale || 1;
  if (s <= 0) return;

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const { minX, maxX, minY, maxY } = graphState.bounds;
  const isHorizontal = graphState.orientation === "horizontal";

  // Margins and clamps should adapt to orientation
  const verticalMarginX = w * 0.2;
  const verticalMarginY = 40;
  const horizontalMarginX = 60;
  const horizontalMarginY = h * 0.15;
  
  const topClamp = 32;
  const bottomClamp = Math.max(topClamp + 40, h - 32);
  const leftClamp = 32;
  const rightClamp = Math.max(leftClamp + 40, w - 32);

  if (isHorizontal) {
    // Horizontal: X is time, Y is lanes.
    const minOffsetX = (leftClamp - horizontalMarginX) / s - minX;
    const maxOffsetX = (rightClamp - horizontalMarginX) / s - maxX;

    if (minOffsetX > maxOffsetX) {
      graphState.camera.offsetX = (minOffsetX + maxOffsetX) / 2;
    } else {
      graphState.camera.offsetX = Math.max(minOffsetX, Math.min(maxOffsetX, graphState.camera.offsetX));
    }
    
    const minOffsetY = (topClamp - horizontalMarginY) / s - minY;
    const maxOffsetY = (bottomClamp - horizontalMarginY) / s - maxY;

    if (minOffsetY > maxOffsetY) {
      graphState.camera.offsetY = (minOffsetY + maxOffsetY) / 2;
    } else {
      graphState.camera.offsetY = Math.max(minOffsetY, Math.min(maxOffsetY, graphState.camera.offsetY));
    }
  } else {
    // Vertical: X is lanes, Y is time.
    const minOffsetY = (topClamp - verticalMarginY) / s - minY;
    const maxOffsetY = (bottomClamp - verticalMarginY) / s - maxY;

    if (minOffsetY > maxOffsetY) {
      graphState.camera.offsetY = (minOffsetY + maxOffsetY) / 2;
    } else {
      graphState.camera.offsetY = Math.max(minOffsetY, Math.min(maxOffsetY, graphState.camera.offsetY));
    }
    
    // Corrected logic for vertical X clamping
    const minOffsetX = (leftClamp - verticalMarginX) / s - minX;
    const maxOffsetX = (w - 32 - verticalMarginX) / s - maxX;

    if (minOffsetX > maxOffsetX) {
      graphState.camera.offsetX = (minOffsetX + maxOffsetX) / 2;
    } else {
      graphState.camera.offsetX = Math.max(minOffsetX, Math.min(maxOffsetX, graphState.camera.offsetX));
    }
  }
}

function layoutCommits(commits) {
  graphState.nodes = [];
  graphState.edges = [];
  graphState.shaToIndex.clear();
  graphState.branchOrder = [];
  graphState.branchLane.clear();
  graphState.branchColor.clear();
  graphState.lanePrimaryBranch.clear();

  if (!commits || commits.length === 0) {
    graphState.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    return;
  }

  // Two modes:
  // - Per-branch lanes (All view): dedicate a lane per branch name.
  // - Topology-based lanes (non-All): derive lanes from the commit graph.
  const n = commits.length;
  const laneOf = new Array(n).fill(-1);

  const usePerBranchLanes = graphState.allBranchesMode;

  if (usePerBranchLanes) {
    // --- Per-branch lanes ---------------------------------------------------
    const branchNames = new Set();
    commits.forEach((c) => {
      branchNames.add(primaryBranchName(c));
      if (Array.isArray(c.branches)) {
        c.branches.forEach((b) => {
          if (b) branchNames.add(b);
        });
      }
    });
    
    // Filter branch names to only active branches if Active Only is enabled
    const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
    if (activeOnly && window.state && window.state.branchMetadata) {
      const activeBranchSet = new Set(
        Array.from(branchNames).filter(branchName => {
          const metadata = window.state.branchMetadata[branchName];
          return window.isBranchActive && window.isBranchActive(branchName, metadata);
        })
      );
      // Replace branchNames set with filtered set
      branchNames.clear();
      activeBranchSet.forEach(b => branchNames.add(b));
    }
    
    const orderedBranches = makeBranchOrder(branchNames);

    // Bump focus/default branch and main-like branches to the front
    let prioritizedBranches = orderedBranches.slice();
    const focus = graphState.focusBranch;
    const promote = (name) => {
      if (!name) return;
      const idx = prioritizedBranches.indexOf(name);
      if (idx > 0) {
        prioritizedBranches.splice(idx, 1);
        prioritizedBranches.unshift(name);
      }
    };

    // Promote the focus/default branch first
    promote(focus);

    // Also ensure main-like branches are near the front
    prioritizedBranches
      .filter((name) => isMainLikeBranch(name))
      .forEach((name) => promote(name));

    // Check if branch collapsing is enabled (default: false - show all branches)
    const collapseBranchesEnabled = localStorage.getItem("gitzada:collapseBranches") === "true";
    
    // Limit number of visible lanes to keep the view readable (only if collapsing is enabled)
    let laneCap;
    if (collapseBranchesEnabled) {
      laneCap =
        typeof graphState.maxVisibleLanesOverride === "number"
          ? graphState.maxVisibleLanesOverride
          : MAX_VISIBLE_LANES;
    } else {
      // If collapsing is disabled, show all branches (no limit)
      laneCap = prioritizedBranches.length;
    }
    
    const visibleBranches = prioritizedBranches.slice(0, laneCap);
    const hiddenBranches = prioritizedBranches.slice(laneCap);

    graphState.branchOrder = visibleBranches;
    visibleBranches.forEach((name, idx) => {
      graphState.branchLane.set(name, idx);
      graphState.lanePrimaryBranch.set(idx, name);
      colorForBranch(name, graphState.branchColor);
    });

    // Determine otherLaneIndex based on whether collapsing is enabled
    let otherLaneIndex = -1;
    
    // Aggregate less-active branches into a shared "other" lane at the end (only if collapsing is enabled).
    if (collapseBranchesEnabled) {
      otherLaneIndex = hiddenBranches.length ? visibleBranches.length : -1;
      if (otherLaneIndex >= 0) {
        const otherLabel = `other (${hiddenBranches.length})`;
        graphState.lanePrimaryBranch.set(otherLaneIndex, otherLabel);
        graphState.branchLane.set(otherLabel, otherLaneIndex);
        graphState.branchOrder.push(otherLabel);
        graphState.branchColor.set(otherLabel, "rgba(148,163,184,0.65)");
      }
    } else {
      // If collapsing is disabled, add all hidden branches as individual lanes
      hiddenBranches.forEach((name, idx) => {
        const laneIndex = visibleBranches.length + idx;
        graphState.branchLane.set(name, laneIndex);
        graphState.lanePrimaryBranch.set(laneIndex, name);
        graphState.branchOrder.push(name);
        colorForBranch(name, graphState.branchColor);
      });
    }

    // Build indexBySha for parent lookups
    const indexBySha = new Map();
    commits.forEach((comm, i) => indexBySha.set(comm.sha, i));
    
    commits.forEach((c, idx) => {
      const branch = primaryBranchName(c);
      const isMerge = !!c.isMerge || !!c.is_merge || (c.parents && c.parents.length > 1);
      
      let lane;
      
      if (isMerge) {
        // For merge commits, place them in the lane of the branch they're merging INTO
        // This is typically the first parent's branch (the target branch)
        let targetBranch = branch; // fallback to current branch
        
        if (c.parents && c.parents.length > 0) {
          const firstParentSha = c.parents[0];
          const firstParentIdx = indexBySha.get(firstParentSha);
          if (firstParentIdx !== undefined && firstParentIdx < idx) {
            // Parent is earlier in history, get its branch
            const parentCommit = commits[firstParentIdx];
            targetBranch = primaryBranchName(parentCommit);
          } else {
            // Try to find main/master as target
            const mainBranches = ['main', 'master', 'trunk', 'develop'];
            for (const mb of mainBranches) {
              if (graphState.branchLane.has(mb)) {
                targetBranch = mb;
                break;
              }
            }
          }
        }
        
        // Place merge commit in target branch's lane
        lane = graphState.branchLane.get(targetBranch);
        if (lane == null) {
          lane = graphState.branchLane.get(branch) ?? (otherLaneIndex >= 0 ? otherLaneIndex : 0);
        }
      } else {
        // Non-merge commits stay in their own branch's lane
        lane = graphState.branchLane.get(branch);
        if (lane == null) {
          lane = otherLaneIndex >= 0 ? otherLaneIndex : 0;
        }
      }
      
      laneOf[idx] = lane;
    });
  } else {
    // --- Topology-based lanes (compact) ------------------------------------
    const indexBySha = new Map();
    for (let i = 0; i < n; i++) {
      indexBySha.set(commits[i].sha, i);
    }

    // Process from oldest to newest
    const order = [];
    for (let i = n - 1; i >= 0; i--) order.push(i);

    const active = []; // lane -> last commit index, or -1 when lane is free

    for (const ci of order) {
      const c = commits[ci];
      const parentIdxs = (c.parents || [])
        .map((sha) => indexBySha.get(sha))
        .filter((idx) => idx !== undefined);

      let lane = -1;

      // Prefer lane of first parent that already has a lane
      for (const pIdx of parentIdxs) {
        const pl = laneOf[pIdx];
        if (pl >= 0) {
          lane = pl;
          break;
        }
      }

      // If no parent lane, reuse a free lane if possible
      if (lane === -1) {
        for (let li = 0; li < active.length; li++) {
          if (active[li] === -1) {
            lane = li;
            break;
          }
        }
      }

      // If still none, allocate a new lane
      if (lane === -1) {
        lane = active.length;
        active.push(ci);
      } else {
        active[lane] = ci;
      }

      laneOf[ci] = lane;

      // Free lanes of other parents that merged into this lane
      for (const pIdx of parentIdxs) {
        const pl = laneOf[pIdx];
        if (pl >= 0 && pl !== lane && active[pl] === pIdx) {
          active[pl] = -1;
        }
      }
    }
  }

  // Track which branches predominantly occupy each lane (helps label lanes)
  const laneBranchVotes = new Map(); // lane -> Map<branchName,count>

  // Build nodes
  commits.forEach((c, idx) => {
    const branch = primaryBranchName(c);
    const lane = laneOf[idx] ?? 0;
    let x;
    let y;
    if (graphState.orientation === "vertical") {
      x = lane * LANE_GAP;
      y = idx * ROW_GAP;
    } else {
      x = idx * ROW_GAP;
      y = lane * LANE_GAP;
    }
    const node = {
      sha: c.sha,
      x,
      y,
      branch,
      isHead: !!c.isHead || !!c.is_head,
      isMain: !!c.isMain || !!c.is_main,
      isMerge: !!c.isMerge || !!c.is_merge || (c.parents && c.parents.length > 1),
      commit: c,
    };
    graphState.shaToIndex.set(c.sha, graphState.nodes.length);
    graphState.nodes.push(node);

    // For topology-based lanes we want lane labels that reflect all branches
    // that flow through a lane, not just the primary branch heuristic.
    let votes = laneBranchVotes.get(lane);
    if (!votes) {
      votes = new Map();
      laneBranchVotes.set(lane, votes);
    }
    const voteBranches =
      Array.isArray(c.branches) && c.branches.length > 0
        ? c.branches
        : [branch];
    voteBranches.forEach((b) => {
      if (!b) return;
      votes.set(b, (votes.get(b) || 0) + 1);
    });
  });

  // Decide primary branch per lane and prepare branchOrder / branchLane.
  // In per-branch (All vertical) mode, branchOrder/branchLane were already
  // set explicitly and should not be overridden.
  if (!usePerBranchLanes) {
    const laneCount = laneOf.reduce((m, v) => Math.max(m, v), 0) + 1;
    const laneBranches = [];
    for (let lane = 0; lane < laneCount; lane++) {
      const votes = laneBranchVotes.get(lane) || new Map();
      let best = null;
      let bestCount = -1;
      let mainCandidate = null;
      for (const [branchName, count] of votes.entries()) {
        if (isMainLikeBranch(branchName)) {
          if (!mainCandidate || count > bestCount) {
            mainCandidate = branchName;
          }
        }
        if (count > bestCount) {
          best = branchName;
          bestCount = count;
        }
      }
      const label = mainCandidate || best || `lane-${lane}`;
      laneBranches.push(label);
      graphState.lanePrimaryBranch.set(lane, label);
      if (!graphState.branchLane.has(label)) {
        graphState.branchLane.set(label, lane);
      }
      colorForBranch(label, graphState.branchColor);
    }
    graphState.branchOrder = makeBranchOrder(new Set(laneBranches));
  }

  // Build edges child -> parent
  graphState.nodes.forEach((n) => {
    const parents = n.commit.parents || [];
    parents.forEach((pSha) => {
      const toIdx = graphState.shaToIndex.get(pSha);
      if (toIdx !== undefined) {
        const fromIdx = graphState.shaToIndex.get(n.sha);
        if (fromIdx !== undefined) {
          graphState.edges.push({ from: fromIdx, to: toIdx });
        }
      }
    });
  });

  // Compute bounds
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  graphState.nodes.forEach((n) => {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  });
  if (!isFinite(minX)) {
    minX = 0;
    maxX = 1;
    minY = 0;
    maxY = 1;
  }
  graphState.bounds = { minX, maxX, minY, maxY };
}

function branchMatches(nodeBranch, focusBranch) {
  if (!nodeBranch || !focusBranch) return false;
  if (nodeBranch === focusBranch) return true;
  const nb = String(nodeBranch);
  const fb = String(focusBranch);
  if (nb.endsWith("/" + fb)) return true;
  if (fb.endsWith("/" + nb)) return true;
  return false;
}

function autoFocusOnLatest() {
  const canvas = graphState.canvas;
  if (!canvas || !graphState.nodes.length) return;

  // Choose target branch: explicit focusBranch, otherwise default/main-like from branchOrder,
  // falling back to the first branch or first node's branch.
  let targetBranch = graphState.focusBranch;
  if (!targetBranch) {
    // Prefer the explicit default branch from the main app state when available.
    const globalDefault = (window.state && window.state.defaultBranch) || null;
    if (globalDefault) {
      const hasDefaultBranchNodes = graphState.nodes.some((n) =>
        branchMatches(n.branch, globalDefault)
      );
      if (hasDefaultBranchNodes) {
        targetBranch = globalDefault;
      }
    }

    // Otherwise, try a main-like branch in branchOrder.
    if (!targetBranch) {
      const mainLike = graphState.branchOrder.find(isMainLikeBranch);
      if (mainLike) {
        targetBranch = mainLike;
      }
    }

    // Then first branch in branchOrder.
    if (!targetBranch && graphState.branchOrder.length > 0) {
      targetBranch = graphState.branchOrder[0];
    }

    // Finally, fall back to the first node's branch.
    if (!targetBranch && graphState.nodes.length > 0) {
      targetBranch = graphState.nodes[0].branch;
    }
  }

  // Collect nodes on that branch
  // Check both n.branch (primary branch name) and commit.branches array
  // to catch cases like origin/main where nodes might have branch="main" but commit.branches includes "origin/main"
  let branchNodes = graphState.nodes.filter((n) => {
    // First check the node's primary branch
    if (branchMatches(n.branch, targetBranch)) return true;
    // Also check the commit's branches array directly
    if (n.commit && Array.isArray(n.commit.branches)) {
      return n.commit.branches.some(b => branchMatches(b, targetBranch));
    }
    return false;
  });
  if (!branchNodes.length) {
    // Fallback: use isMain flag for default branch
    branchNodes = graphState.nodes.filter((n) => n.isMain);
  }
  if (!branchNodes.length) {
    // Final fallback: generic fit
    autoFit();
    return;
  }

  // Find latest commit on branch (top in vertical, left in horizontal)
  let latest = branchNodes[0];
  for (const n of branchNodes) {
    if (graphState.orientation === "vertical") {
      if (n.y < latest.y) latest = n;
    } else {
      if (n.x < latest.x) latest = n;
    }
  }

  const { minX: gxMinX, maxX: gxMaxX, minY: gxMinY, maxY: gxMaxY } =
    graphState.bounds;
  const contextAhead = 20;  // newer/above
  const contextBehind = 120; // older/below

  let minX, maxX, minY, maxY;
  if (graphState.orientation === "vertical") {
    const laneX = latest.x;
    minX = Math.max(gxMinX, laneX - LANE_GAP * 1.5);
    maxX = Math.min(gxMaxX, laneX + LANE_GAP * 1.5);
    const yTop = latest.y - ROW_GAP * contextAhead;
    const yBottom = latest.y + ROW_GAP * contextBehind;
    minY = Math.max(gxMinY, yTop);
    maxY = Math.min(gxMaxY, yBottom);
  } else {
    const laneY = latest.y;
    minY = Math.max(gxMinY, laneY - LANE_GAP * 1.5);
    maxY = Math.min(gxMaxY, laneY + LANE_GAP * 1.5);
    const xStart = latest.x - ROW_GAP * contextAhead;
    const xEnd = latest.x + ROW_GAP * contextBehind;
    minX = Math.max(gxMinX, xStart);
    maxX = Math.min(gxMaxX, xEnd);
  }

  if (!(isFinite(minX) && isFinite(maxX) && isFinite(minY) && isFinite(maxY))) {
    autoFit();
    return;
  }

  // Keep zoom at 0% (scale = 1.0) and center the latest commit on screen.
  const s = 1.0;
  graphState.camera.scale = s;
  updateZoomLevelDisplay();

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  if (graphState.orientation === "vertical") {
    const verticalMarginX = w * 0.2;
    const verticalMarginY = 40;
    // Center horizontally: commit node at visual center.
    graphState.camera.offsetX = (w / 2 - verticalMarginX) / s - latest.x;
    // Center vertically: commit node at visual center.
    graphState.camera.offsetY = (h / 2 - verticalMarginY) / s - latest.y;
  } else {
    const horizontalMarginX = 60;
    const horizontalMarginY = h * 0.15;
    // Center horizontally: time axis in horizontal mode.
    graphState.camera.offsetX = (w / 2 - horizontalMarginX) / s - latest.x;
    // Center vertically: lanes axis in horizontal mode.
    graphState.camera.offsetY = (h / 2 - horizontalMarginY) / s - latest.y;
  }
}

function autoFit() {
  const canvas = graphState.canvas;
  if (!canvas || !graphState.nodes.length) return;
  const { minX, maxX, minY, maxY } = graphState.bounds;
  // Fallback when autoFocusOnLatest can't pick a branch.
  // Keep zoom at 1.0 so the indicator shows 0%,
  // and center the overall graph bounds.
  const s = 1.0;
  graphState.camera.scale = s;
  updateZoomLevelDisplay();

  const cxWorld = (minX + maxX) / 2;
  graphState.camera.offsetX = -cxWorld;

  // Vertically, center the entire graph as a simple, predictable fallback.
  const cyWorld = (minY + maxY) / 2;
  graphState.camera.offsetY = -cyWorld;

  clampCamera();
}

function computeLaneExtents() {
  const extents = new Map(); // lane -> { min, max } along time axis
  graphState.nodes.forEach((n) => {
    const laneCoord =
      graphState.orientation === "vertical" ? n.x : n.y;
    const timeCoord =
      graphState.orientation === "vertical" ? n.y : n.x;
    const lane = Math.round(laneCoord / LANE_GAP);
    let e = extents.get(lane);
    if (!e) {
      e = { min: timeCoord, max: timeCoord };
      extents.set(lane, e);
    } else {
      if (timeCoord < e.min) e.min = timeCoord;
      if (timeCoord > e.max) e.max = timeCoord;
    }
  });
  return extents;
}

function drawGrid(ctx) {
  const { branchOrder, branchLane, branchColor, focusBranch } = graphState;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = gridColor;
  const laneExtents = computeLaneExtents();
  branchOrder.forEach((b) => {
    const lane = branchLane.get(b);
    if (lane == null) return;
    const ext = laneExtents.get(lane);
    if (!ext) return;
    const isFocus =
      !focusBranch || b === focusBranch || b.endsWith("/" + focusBranch);
    ctx.strokeStyle = isFocus
      ? hexToCssRgba(branchColor.get(b) || "#1f2937", 0.18)
      : "rgba(31,41,55,0.18)";
    const laneCoord = lane * LANE_GAP;
    let top, bottom;
    if (graphState.orientation === "vertical") {
      top = worldToScreen(laneCoord, ext.min);
      bottom = worldToScreen(laneCoord, ext.max);
    } else {
      top = worldToScreen(ext.min, laneCoord);
      bottom = worldToScreen(ext.max, laneCoord);
    }
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.stroke();
  });
  ctx.restore();
}

function drawLaneTracks(ctx) {
  const { branchOrder, branchLane, branchColor, focusBranch, bounds } =
    graphState;
  const canvas = graphState.canvas;
  if (!canvas) return;

  ctx.save();
  const laneExtents = computeLaneExtents();

  branchOrder.forEach((name) => {
    const lane = branchLane.get(name);
    if (lane == null) return;
    const ext = laneExtents.get(lane);
    if (!ext) return;
    const color = branchColor.get(name) || "#1f2937";
    const isFocus =
      !focusBranch ||
      name === focusBranch ||
      name.endsWith("/" + focusBranch);

    const laneCoord = lane * LANE_GAP;
    let start, end;
    if (graphState.orientation === "vertical") {
      start = worldToScreen(laneCoord, ext.min);
      end = worldToScreen(laneCoord, ext.max);
    } else {
      start = worldToScreen(ext.min, laneCoord);
      end = worldToScreen(ext.max, laneCoord);
    }
    const centerScreen = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };
    const trackWidthPx = Math.max(
      8,
      LANE_GAP * graphState.camera.scale * 0.55
    );

    ctx.fillStyle = hexToCssRgba(color, isFocus ? 0.14 : 0.06);
    if (graphState.orientation === "vertical") {
      const trackTop = start.y;
      const trackHeight = end.y - start.y;
      if (trackHeight > 0) {
        ctx.fillRect(
          centerScreen.x - trackWidthPx / 2,
          trackTop,
          trackWidthPx,
          trackHeight
        );
      }
    } else {
      const trackLeft = start.x;
      const trackWidth = end.x - start.x;
      if (trackWidth > 0) {
        ctx.fillRect(
          trackLeft,
          centerScreen.y - trackWidthPx / 2,
          trackWidth,
          trackWidthPx
        );
      }
    }
  });

  ctx.restore();
}

function drawEdges(ctx) {
  const { edges, nodes, branchColor, lanePrimaryBranch, focusBranch, highlightedBranch } =
    graphState;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Viewport culling: get visible bounds and skip edges entirely outside
  const bounds = getVisibleBounds();

  edges.forEach((e) => {
    const from = nodes[e.from];
    const to = nodes[e.to];
    if (!from || !to) return;

    // Viewport culling: skip edges where both endpoints are outside visible bounds
    const fromOutside = from.x < bounds.minX || from.x > bounds.maxX || from.y < bounds.minY || from.y > bounds.maxY;
    const toOutside = to.x < bounds.minX || to.x > bounds.maxX || to.y < bounds.minY || to.y > bounds.maxY;
    if (fromOutside && toOutside) return;

    // In vertical mode, lanes are along x-axis; in horizontal mode, lanes are along y-axis
    const laneCoord = graphState.orientation === "vertical" ? from.x : from.y;
    const lane = Math.round(laneCoord / LANE_GAP);
    const laneBranch = lanePrimaryBranch.get(lane) || from.branch;
    const baseColor = colorForBranch(laneBranch, branchColor);
    const isMainLane = isMainLikeBranch(laneBranch);
    const isFocus =
      !focusBranch ||
      laneBranch === focusBranch ||
      laneBranch.endsWith("/" + focusBranch);

    // Check if this edge's branch is highlighted (hovered pill)
    const isHighlighted = highlightedBranch && (
      laneBranch === highlightedBranch ||
      laneBranch.endsWith("/" + highlightedBranch)
    );
    const isDimmedByHighlight = highlightedBranch && !isHighlighted;

    // Main branch gets a single, consistent, dominant line color
    ctx.strokeStyle = isMainLane ? MAIN_BRANCH_COLOR : baseColor;

    // Apply dimming when another branch is highlighted
    if (isDimmedByHighlight) {
      ctx.globalAlpha = 0.15;
      ctx.lineWidth = LINE_WIDTH * 0.6;
    } else {
      ctx.globalAlpha = isMainLane ? 1.0 : (isFocus ? 1.0 : 0.25);
      ctx.lineWidth = isMainLane ? LINE_WIDTH * 1.8 : (isFocus ? LINE_WIDTH * 1.4 : LINE_WIDTH * 0.8);
    }

    const p0 = worldToScreen(from.x, from.y);
    const p3 = worldToScreen(to.x, to.y);

    const midWorldY = (from.y + to.y) / 2;
    const p1 = worldToScreen(from.x, midWorldY);
    const p2 = worldToScreen(to.x, midWorldY);

    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.stroke();
  });

  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawNodes(ctx) {
  const { nodes, branchColor, lanePrimaryBranch, focusBranch, highlightedBranch } = graphState;

  // Viewport culling: get visible bounds and skip nodes outside
  const bounds = getVisibleBounds();

  nodes.forEach((n, idx) => {
    // Viewport culling: skip nodes outside visible bounds
    if (n.x < bounds.minX || n.x > bounds.maxX || n.y < bounds.minY || n.y > bounds.maxY) return;

    const p = worldToScreen(n.x, n.y);
    // In vertical mode, lanes are along x-axis; in horizontal mode, lanes are along y-axis
    const laneCoord = graphState.orientation === "vertical" ? n.x : n.y;
    const lane = Math.round(laneCoord / LANE_GAP);
    const laneBranch = lanePrimaryBranch.get(lane) || n.branch;
    const color = colorForBranch(laneBranch, branchColor);
    const isMainLane = isMainLikeBranch(laneBranch);
    const isFocus =
      !focusBranch ||
      laneBranch === focusBranch ||
      laneBranch.endsWith("/" + focusBranch);

    // Check if this node's branch is highlighted (hovered pill)
    const isHighlighted = highlightedBranch && (
      laneBranch === highlightedBranch ||
      laneBranch.endsWith("/" + highlightedBranch)
    );
    const isDimmedByHighlight = highlightedBranch && !isHighlighted;
    const rOuter =
      STATION_RADIUS +
      (n.isHead ? 3 : 0) +
      (idx === graphState.hoverIndex ? 2 : 0) +
      (isMainLane ? 2 : 0);
    const rInner = STATION_RADIUS - 1;

    // Outer ring
    ctx.save();
    // Apply dimming when another branch is highlighted
    if (isDimmedByHighlight) {
      ctx.globalAlpha = 0.15;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, rOuter, 0, Math.PI * 2);
    ctx.fillStyle = backgroundColor;
    ctx.fill();
    ctx.lineWidth = isDimmedByHighlight ? 2 : 3;
    ctx.strokeStyle = color;
    ctx.stroke();

    // Fill
    ctx.beginPath();
    ctx.arc(p.x, p.y, rInner, 0, Math.PI * 2);
    ctx.fillStyle = isMainLane || isFocus ? color : hexToCssRgba(color, 0.3);
    ctx.fill();

    // Merge interchange: white inner ring
    if (n.isMerge) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, rInner - 3, 0, Math.PI * 2);
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Simple PR icon: small white square for commits that look like
    // non‑squash pull request merge *commits* (i.e. preserve branch history).
    const msg = (n.commit.message || "").toLowerCase();
    const looksLikePrMerge =
      msg.startsWith("merge pull request") ||
      msg.startsWith("merge pull request #");
    if (n.isMerge && looksLikePrMerge) {
      const iconSize = 6;
      ctx.beginPath();
      ctx.rect(
        p.x - iconSize / 2,
        p.y - iconSize / 2,
        iconSize,
        iconSize
      );
      ctx.fillStyle = "#f9fafb";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }

    // Squash-merge hint: single-parent commit whose message looks like
    // "feat: something (#123)" or similar. We render a small diamond inside
    // the station to distinguish from regular commits.
    const looksLikeSquash =
      !n.isMerge &&
      /\(#\d+\)/.test(msg);
    if (looksLikeSquash) {
      const size = 6;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.rect(-size / 2, -size / 2, size, size);
      ctx.fillStyle = "#f9fafb";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Optional: show commit message labels when enabled.
    // Ensure showCommitMessages is always a boolean and never accidentally false
    if (graphState.showCommitMessages !== false && n.commit && n.commit.message) {
      const full = (n.commit.message || "").split("\n")[0];
      const maxLen = 60;
      const text =
        full.length > maxLen ? full.slice(0, maxLen - 1) + "…" : full;

      ctx.save();
      // Use stored font preferences for each orientation
      let fontFamily;
      let fontSize = 10; // Default font size
      if (graphState.orientation === "horizontal") {
        fontFamily = localStorage.getItem("gitzada:fontHorizontalMap") || "Arial, sans-serif";
        // Apply size multiplier for horizontal map
        const sizeMultiplier = parseFloat(localStorage.getItem("gitzada:horizontalMapSize") || "1.0");
        fontSize = 10 * sizeMultiplier;
      } else {
        fontFamily = localStorage.getItem("gitzada:fontVerticalMap") || "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      }
      ctx.font = `${fontSize}px ${fontFamily}`;
      ctx.textBaseline = "middle";

      if (graphState.orientation === "vertical") {
        // Vertical map: horizontal pill to the right of the node.
        const paddingX = 6;
        const paddingY = 3;
        const textWidth = ctx.measureText(text).width;
        const boxX = p.x + rOuter + 6;
        const boxY = p.y - 9;
        const boxW = textWidth + paddingX * 2;
        const boxH = 18;

        // Apply dimming for commit messages when another branch is highlighted
        const msgOpacity = isDimmedByHighlight ? 0.15 : 1.0;
        ctx.fillStyle = `rgba(15,23,42,${0.96 * msgOpacity})`;
        ctx.strokeStyle = `rgba(31,41,55,${0.9 * msgOpacity})`;
        ctx.lineWidth = 1;
        const radius = 9;
        ctx.beginPath();
        ctx.moveTo(boxX + radius, boxY);
        ctx.lineTo(boxX + boxW - radius, boxY);
        ctx.quadraticCurveTo(
          boxX + boxW,
          boxY,
          boxX + boxW,
          boxY + radius
        );
        ctx.lineTo(boxX + boxW, boxY + boxH - radius);
        ctx.quadraticCurveTo(
          boxX + boxW,
          boxY + boxH,
          boxX + boxW - radius,
          boxY + boxH
        );
        ctx.lineTo(boxX + radius, boxY + boxH);
        ctx.quadraticCurveTo(
          boxX,
          boxY + boxH,
          boxX,
          boxY + boxH - radius
        );
        ctx.lineTo(boxX, boxY + radius);
        ctx.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Apply dimming to text color
        const textOpacity = isDimmedByHighlight ? 0.15 : 1.0;
        ctx.fillStyle = `rgba(229, 231, 235, ${textOpacity})`;
        ctx.fillText(text, boxX + paddingX, p.y);
      } else {
        // Horizontal map: angled label drawn below the node, with end aligned to node.
        // Get size multiplier from localStorage (default 1.0 = 100%)
        const sizeMultiplier = parseFloat(localStorage.getItem("gitzada:horizontalMapSize") || "1.0");
        const basePadding = 6;
        const baseFontSize = 10;
        const padding = basePadding * sizeMultiplier;
        const fontSize = baseFontSize * sizeMultiplier;
        
        // Set font with scaled size
        const fontFamily = localStorage.getItem("gitzada:fontHorizontalMap") || "Arial, sans-serif";
        ctx.font = `${fontSize}px ${fontFamily}`;
        const textWidth = ctx.measureText(text).width;
        const textHeight = fontSize;
        const angle = -Math.PI / 4; // -45 degrees
        
        // Calculate box dimensions (before rotation)
        const boxW = textWidth + padding * 2;
        const boxH = textHeight + padding * 2;
        
        // For -45 degree rotation, the end of the text (right side) will be at the bottom-right
        // when rotated. We want this end to align with the node.
        // The right edge of the box is at boxW/2 from center, and bottom is at boxH/2 from center.
        // After -45 degree rotation, the bottom-right corner moves.
        // To align the end with the node, we position the center such that:
        // - The right edge of the text aligns horizontally with the node
        // - The bottom edge aligns vertically with the node (or slightly below)
        
        // Position rotation center so the end of the text aligns with the node
        // The end of the text is at (boxW/2, boxH/2) in unrotated coordinates
        // After -45 rotation, this point moves to:
        // x' = (boxW/2) * cos(-45) - (boxH/2) * sin(-45)
        // y' = (boxW/2) * sin(-45) + (boxH/2) * cos(-45)
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const endOffsetX = (boxW / 2) * cos - (boxH / 2) * sin;
        const endOffsetY = (boxW / 2) * sin + (boxH / 2) * cos;
        
        // Position center so the end aligns with the node
        const centerX = p.x - endOffsetX;
        const centerY = p.y - endOffsetY +15;

        // Save context for rotation
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(angle);

        // Get opacity from slider (full opacity if hovered)
        let baseOpacity = parseFloat(localStorage.getItem("gitzada:horizontalMapTransparency") || "1.0");
        if (isNaN(baseOpacity) || baseOpacity < 0.05) {
          baseOpacity = 0.05;
        } else if (baseOpacity > 1.0) {
          baseOpacity = 1.0;
        }
        const isHovered = graphState.hoveredCommitMessageIndex === idx;
        // Apply dimming when another branch is highlighted (multiply with existing opacity)
        const highlightDim = isDimmedByHighlight ? 0.15 : 1.0;
        const opacity = (isHovered ? 1.0 : baseOpacity) * highlightDim;

        // Background pill (more transparent so graph remains visible underneath)
        // Apply opacity slider to both fill and stroke
        ctx.fillStyle = `rgba(15,23,42,${0.7 * opacity})`;
        ctx.strokeStyle = `rgba(31,41,55,${0.9 * opacity})`;
        ctx.lineWidth = 1;
        const baseRadius = 6;
        const radius = baseRadius * sizeMultiplier;
        const pillX = -boxW / 2;
        const pillY = -boxH / 2;
        ctx.beginPath();
        ctx.moveTo(pillX + radius, pillY);
        ctx.lineTo(pillX + boxW - radius, pillY);
        ctx.quadraticCurveTo(
          pillX + boxW,
          pillY,
          pillX + boxW,
          pillY + radius
        );
        ctx.lineTo(pillX + boxW, pillY + boxH - radius);
        ctx.quadraticCurveTo(
          pillX + boxW,
          pillY + boxH,
          pillX + boxW - radius,
          pillY + boxH
        );
        ctx.lineTo(pillX + radius, pillY + boxH);
        ctx.quadraticCurveTo(
          pillX,
          pillY + boxH,
          pillX,
          pillY + boxH - radius
        );
        ctx.lineTo(pillX, pillY + radius);
        ctx.quadraticCurveTo(pillX, pillY, pillX + radius, pillY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Draw text at angle with opacity (full opacity if hovered)
        const r = parseInt("e5", 16);
        const g = parseInt("e7", 16);
        const b = parseInt("eb", 16);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }

      ctx.restore();
    }

    // In horizontal view, show a subtle stub for merged-from branches beneath merge commits.
    if (graphState.orientation === "horizontal" && n.isMerge) {
      const sourceBranch = pickMergeSourceBranch(laneBranch, n.commit);
      if (sourceBranch) {
        const sourceColor = colorForBranch(sourceBranch, branchColor);
        const stubStartY = p.y + rOuter + 3;
        const stubEndY = stubStartY + 10;
        const labelY = stubEndY + 9;
        const label = sourceBranch.split("/").pop() || sourceBranch;

        ctx.save();
        ctx.strokeStyle = hexToCssRgba(sourceColor, isFocus ? 0.9 : 0.6);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, stubStartY);
        ctx.lineTo(p.x, stubEndY);
        ctx.stroke();

        ctx.fillStyle = "rgba(15,23,42,0.96)";
        ctx.strokeStyle = hexToCssRgba(sourceColor, 0.9);
        ctx.lineWidth = 1;
        const paddingX = 6;
        const paddingY = 3;
        // Use stored font preference for branch pills based on orientation
        let branchFontFamily;
        if (graphState.orientation === "horizontal") {
          branchFontFamily = localStorage.getItem("gitzada:fontHorizontalMap") || "Arial, sans-serif";
        } else {
          branchFontFamily = localStorage.getItem("gitzada:fontVerticalMap") || "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        }
        ctx.font = `10px ${branchFontFamily}`;
        const textWidth = ctx.measureText(label).width;
        const pillWidth = textWidth + paddingX * 2;
        const pillHeight = 14;
        const pillX = p.x - pillWidth / 2;
        const pillY = labelY;

        ctx.beginPath();
        const radius = pillHeight / 2;
        ctx.moveTo(pillX + radius, pillY);
        ctx.lineTo(pillX + pillWidth - radius, pillY);
        ctx.quadraticCurveTo(
          pillX + pillWidth,
          pillY,
          pillX + pillWidth,
          pillY + radius
        );
        ctx.lineTo(pillX + pillWidth, pillY + pillHeight - radius);
        ctx.quadraticCurveTo(
          pillX + pillWidth,
          pillY + pillHeight,
          pillX + pillWidth - radius,
          pillY + pillHeight
        );
        ctx.lineTo(pillX + radius, pillY + pillHeight);
        ctx.quadraticCurveTo(
          pillX,
          pillY + pillHeight,
          pillX,
          pillY + pillHeight - radius
        );
        ctx.lineTo(pillX, pillY + radius);
        ctx.quadraticCurveTo(pillX, pillY, pillX + radius, pillY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#e5e7eb";
        ctx.textBaseline = "middle";
        ctx.fillText(label, pillX + paddingX, pillY + pillHeight / 2);
        ctx.restore();
      }
    }

    ctx.restore();
  });
}

function drawTags(ctx) {
  if (!graphState.tags || !graphState.tags.length) return;
  const { shaToIndex, nodes } = graphState;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#facc15";
  ctx.fillStyle = "rgba(250, 204, 21, 0.25)";

  // Viewport culling: get visible bounds
  const bounds = getVisibleBounds();

  // Group tags by commit so multiple tags stack cleanly.
  const tagsByIndex = new Map(); // nodeIndex -> [tag]
  graphState.tags.slice(0, 400).forEach((tag) => {
    const idx = shaToIndex.get(tag.sha);
    if (idx === undefined) return;
    let arr = tagsByIndex.get(idx);
    if (!arr) {
      arr = [];
      tagsByIndex.set(idx, arr);
    }
    arr.push(tag);
  });

  tagsByIndex.forEach((tags, idx) => {
    const n = nodes[idx];
    if (!n) return;
    // Viewport culling: skip tags on nodes outside visible bounds
    if (n.x < bounds.minX || n.x > bounds.maxX || n.y < bounds.minY || n.y > bounds.maxY) return;
    const p = worldToScreen(n.x, n.y);
    const size = 9;
    const baseLeft = p.x + 16;

    tags.slice(0, 4).forEach((tag, i) => {
      const left = baseLeft + i * (size + 4);
      const top = p.y - size - 2;

      ctx.save();
      ctx.translate(left, top);
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.rect(-size / 2, -size / 2, size, size);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
  });

  ctx.restore();
}

function getBranchLabelsSignature() {
  const { branchOrder, branchLane } = graphState;
  if (!Array.isArray(branchOrder) || !branchOrder.length) return "";
  const lanes = branchOrder
    .map((name) => {
      const lane = branchLane.get(name);
      return lane == null ? "x" : String(lane);
    })
    .join("|");
  return `${branchOrder.join("|")}::${lanes}`;
}

/**
 * Dims all branch pill elements except the one being hovered.
 * @param {string} highlightedName - The branch name to keep fully visible
 */
function dimOtherBranchPills(highlightedName) {
  graphState.branchLabels.forEach((pillEl, branchName) => {
    const isHighlighted = branchName === highlightedName ||
      branchName.endsWith("/" + highlightedName);
    const pillInner = pillEl.querySelector(".branch-pill-inner");
    if (pillInner) {
      pillInner.style.opacity = isHighlighted ? "1" : "0.15";
      pillInner.style.transition = "opacity 0.15s ease";
    }
  });
}

/**
 * Restores all branch pill elements to full opacity.
 */
function restoreBranchPillsOpacity() {
  graphState.branchLabels.forEach((pillEl) => {
    const pillInner = pillEl.querySelector(".branch-pill-inner");
    if (pillInner) {
      pillInner.style.opacity = "1";
      pillInner.style.transition = "opacity 0.15s ease";
    }
  });
}

function createBranchLabelElement(name, labelsDiv) {
  const branchId = `branch-pill-${name.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const container = document.createElement("div");
  container.id = branchId;
  container.className = "branch-pill-container";
  container.dataset.branchName = name;
  container.style.position = "absolute";
  container.style.transform = "translate(0px, 0px)";
  container.style.pointerEvents = "auto";

  const color = colorForBranch(name, graphState.branchColor);
  const isMainBranch = isMainLikeBranch(name);

  const pillSpan = document.createElement("span");
  pillSpan.className = "branch-pill-inner";
  pillSpan.style.display = "inline-flex";
  pillSpan.style.alignItems = "center";
  pillSpan.style.gap = "6px";
  pillSpan.style.padding = "4px 8px";
  pillSpan.style.borderRadius = "999px";
  pillSpan.style.fontSize = "11px";
  pillSpan.style.fontWeight = "600";
  pillSpan.style.whiteSpace = "nowrap";
  pillSpan.style.cursor = "pointer";
  pillSpan.style.transition = "opacity 0.15s ease";

  const iconWrapper = document.createElement("span");
  iconWrapper.style.display = "inline-flex";
  iconWrapper.style.alignItems = "center";
  iconWrapper.style.gap = "4px";

  const dot = document.createElement("span");
  dot.style.width = "10px";
  dot.style.height = "10px";
  dot.style.borderRadius = "50%";
  dot.style.background = color;
  dot.style.flexShrink = "0";
  iconWrapper.appendChild(dot);

  if (isMainBranch) {
    const mainIcon = document.createElement("span");
    mainIcon.className = "branch-pill-main-icon";
    mainIcon.style.fontSize = "12px";
    mainIcon.style.color = "#020617";
    mainIcon.textContent = "�~.";
    iconWrapper.appendChild(mainIcon);
  }

  const textSpan = document.createElement("span");
  textSpan.textContent = name;

  pillSpan.appendChild(iconWrapper);
  pillSpan.appendChild(textSpan);

  const tooltipEl = document.createElement("div");
  tooltipEl.className = "branch-pill-tooltip";
  tooltipEl.style.display = "none";
  tooltipEl.style.position = "absolute";
  tooltipEl.style.bottom = "100%";
  tooltipEl.style.left = "50%";
  tooltipEl.style.transform = "translateX(-50%)";
  tooltipEl.style.marginBottom = "4px";
  tooltipEl.style.padding = "6px 8px";
  tooltipEl.style.background = "rgba(15,23,42,0.96)";
  tooltipEl.style.color = "#e5e7eb";
  tooltipEl.style.borderRadius = "6px";
  tooltipEl.style.border = "1px solid #1f2937";
  tooltipEl.style.fontSize = "11px";
  tooltipEl.style.whiteSpace = "normal";
  tooltipEl.style.width = "max-content";
  tooltipEl.style.lineHeight = "1.4";
  tooltipEl.style.zIndex = "1000";
  tooltipEl.style.boxShadow = "0 8px 24px rgba(0,0,0,0.5)";

  container.appendChild(pillSpan);
  container.appendChild(tooltipEl);
  labelsDiv.appendChild(container);

  // Clicking the special "other (N)" aggregate pill expands hidden branches
  // into dedicated lanes. It does not correspond to a real git branch, so
  // skip ahead/behind API calls and tooltip wiring for it.
  if (/^other \(\d+\)$/.test(name)) {
    container.style.cursor = "pointer";
    container.title = "Click to expand other branches";
    container.addEventListener("click", () => {
      const currentMax =
        typeof graphState.maxVisibleLanesOverride === "number"
          ? graphState.maxVisibleLanesOverride
          : MAX_VISIBLE_LANES;
      graphState.maxVisibleLanesOverride = Math.max(currentMax, 30);

      const commits = graphState.rawCommits || [];
      if (typeof renderGraph === "function") {
        renderGraph(commits, {
          repo: graphState.repo,
          allBranches: graphState.allBranchesMode,
          focusBranch: graphState.focusBranch,
        });
      } else if (
        window.graphView &&
        typeof window.graphView.renderGraph === "function"
      ) {
        window.graphView.renderGraph(commits, {
          repo: graphState.repo,
          allBranches: graphState.allBranchesMode,
          focusBranch: graphState.focusBranch,
        });
      }
    });

    return container;
  }

  let hoverTimeout = null;

  const showTooltip = async () => {
    if (!graphState.repo || !tooltipEl) return;

    const label = name || "branch";

    // Compute approximate ahead/behind vs main from the visible commit graph.
    const info = computeAheadBehindVsMain(name);

    // Fetch branch creation info from API (cached)
    const creationInfo = await getBranchCreationInfo(graphState.repo, name);

    // Build enhanced tooltip content with creation info
    const tooltipContent = buildBranchTooltipContent(label, info, creationInfo);
    tooltipEl.innerHTML = tooltipContent;
    tooltipEl.style.display = "block";
  };

  const hideTooltip = () => {
    if (tooltipEl) {
      tooltipEl.style.display = "none";
    }
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
  };

  container.addEventListener("mouseenter", () => {
    hoverTimeout = setTimeout(showTooltip, 300); // Small delay before showing
  });

  container.addEventListener("mouseleave", () => {
    hideTooltip();
  });

  return container;
}

function drawBranchLabels() {
  const labelsDiv = graphState.overlay?.querySelector("#graphBranchLabels");
  if (!labelsDiv) return;
  const { branchOrder, branchLane, nodes, focusBranch } = graphState;

  if (!Array.isArray(branchOrder) || !branchOrder.length) {
    labelsDiv.innerHTML = "";
    graphState.branchLabels.clear();
    graphState.branchLabelsSignature = "";
    return;
  }

  const signature = getBranchLabelsSignature();
  const needsRebuild = signature !== graphState.branchLabelsSignature;

  // For each lane, find the newest commit along the time axis (top in vertical,
  // leftmost in horizontal) to anchor the label.
  const laneTopNode = new Map(); // lane -> node
  nodes.forEach((n) => {
    const laneCoord =
      graphState.orientation === "vertical" ? n.x : n.y;
    const timeCoord =
      graphState.orientation === "vertical" ? n.y : n.x;
    const lane = Math.round(laneCoord / LANE_GAP);
    const existing = laneTopNode.get(lane);
    if (!existing) {
      laneTopNode.set(lane, n);
    } else {
      const existingTime =
        graphState.orientation === "vertical" ? existing.y : existing.x;
      if (timeCoord < existingTime) {
        laneTopNode.set(lane, n);
      }
    }
  });

  if (needsRebuild) {
    const html = branchOrder
    .map((name) => {
      const lane = branchLane.get(name);
      if (lane == null) return "";
      const topNode = laneTopNode.get(lane);
      let anchorXWorld;
      let anchorYWorld;
      if (topNode) {
        anchorXWorld = topNode.x;
        anchorYWorld = topNode.y;
      } else if (graphState.orientation === "vertical") {
        anchorXWorld = lane * LANE_GAP;
        anchorYWorld = graphState.bounds.minY;
      } else {
        anchorXWorld = graphState.bounds.minX;
        anchorYWorld = lane * LANE_GAP;
      }
      const anchorScreen = worldToScreen(anchorXWorld, anchorYWorld);
      const offsetPx =
        graphState.orientation === "vertical" ? 35 : 42;
      const x =
        graphState.orientation === "vertical"
          ? anchorScreen.x
          : Math.max(8, anchorScreen.x);
      const y = Math.max(6, anchorScreen.y - offsetPx);
      const color = colorForBranch(name, graphState.branchColor);
      const isMainBranch = isMainLikeBranch(name);
      const isFocus =
        !focusBranch ||
        name === focusBranch ||
        name.endsWith("/" + focusBranch);
      const branchId = `branch-pill-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
      return `<div style="position:absolute; transform:translate(${x}px, ${y}px); pointer-events:auto;"
                     data-branch-name="${name.replace(/"/g, '&quot;')}"
                     id="${branchId}"
                     class="branch-pill-container">
        <span class="branch-pill-inner" style="display:inline-flex; align-items:center; gap:6px; padding:4px 8px;
                     border-radius:999px; background:${
                       isMainBranch ? MAIN_BRANCH_COLOR : (isFocus ? "rgba(15,23,42,0.96)" : "rgba(15,23,42,0.7)")
                     }; border:1px solid ${
                       isMainBranch ? "transparent" : color
                     };
                     color:${isMainBranch ? "#020617" : "#e5e7eb"}; font-size:11px; font-weight:600; opacity:${
                       isFocus || isMainBranch ? 1 : 0.6
                     }; white-space:nowrap; cursor:pointer; transition:opacity 0.15s ease;">
          <span style="display:inline-flex; align-items:center; gap:4px;">
            <span style="width:10px; height:10px; border-radius:50%; background:${color}; flex-shrink:0;"></span>
            ${
              isMainBranch
                ? `<span style="font-size:12px; color:${isMainBranch ? "#020617" : "#e5e7eb"};">★</span>`
                : ""
            }
          </span>
          <span>${name}</span>
        </span>
        <div class="branch-pill-tooltip" style="display:none; position:absolute; bottom:100%; left:50%; transform:translateX(-50%); margin-bottom:4px; padding:6px 8px; background:rgba(15,23,42,0.96); color:#e5e7eb; border-radius:6px; border:1px solid #1f2937; font-size:11px; white-space:normal; width:max-content; line-height:1.4; z-index:1000; box-shadow:0 8px 24px rgba(0,0,0,0.5);"></div>
      </div>`;
    })
    .join("");
  labelsDiv.innerHTML = html;

  graphState.branchLabels.clear();
  
  // Add hover + click handlers for branch pills
  branchOrder.forEach((name) => {
    const branchId = `branch-pill-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const pillEl = document.getElementById(branchId);
    if (!pillEl) return;

    graphState.branchLabels.set(name, pillEl);

    // Clicking the special "other (N)" aggregate pill expands hidden branches
    // into dedicated lanes. It does not correspond to a real git branch, so
    // skip ahead/behind API calls and tooltip wiring for it.
    if (/^other \(\d+\)$/.test(name)) {
      pillEl.style.cursor = "pointer";
      pillEl.title = "Click to expand other branches";
      pillEl.addEventListener("click", () => {
        const currentMax =
          typeof graphState.maxVisibleLanesOverride === "number"
            ? graphState.maxVisibleLanesOverride
            : MAX_VISIBLE_LANES;
        graphState.maxVisibleLanesOverride = Math.max(currentMax, 30);

        const commits = graphState.rawCommits || [];
        if (typeof renderGraph === "function") {
          renderGraph(commits, {
            repo: graphState.repo,
            allBranches: graphState.allBranchesMode,
            focusBranch: graphState.focusBranch,
          });
        } else if (
          window.graphView &&
          typeof window.graphView.renderGraph === "function"
        ) {
          window.graphView.renderGraph(commits, {
            repo: graphState.repo,
            allBranches: graphState.allBranchesMode,
            focusBranch: graphState.focusBranch,
          });
        }
      });
      return;
    }
    
    const tooltipEl = pillEl.querySelector('.branch-pill-tooltip');
    let hoverTimeout = null;
    
    const showTooltip = async () => {
      if (!graphState.repo || !tooltipEl) return;

      const label = name || "branch";

      // Compute approximate ahead/behind vs main from the visible commit graph.
      const info = computeAheadBehindVsMain(name);

      // Fetch branch creation info from API (cached)
      const creationInfo = await getBranchCreationInfo(graphState.repo, name);

      // Build enhanced tooltip content with creation info
      const tooltipContent = buildBranchTooltipContent(label, info, creationInfo);
      tooltipEl.innerHTML = tooltipContent;
      tooltipEl.style.display = "block";
    };

    const hideTooltip = () => {
      if (tooltipEl) {
        tooltipEl.style.display = "none";
      }
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
    };

    pillEl.addEventListener('mouseenter', () => {
      hoverTimeout = setTimeout(showTooltip, 300); // Small delay before showing
      // Highlight this branch and dim all others
      graphState.highlightedBranch = name;
      draw();
      // Dim other branch pill elements
      dimOtherBranchPills(name);
    });

    pillEl.addEventListener('mouseleave', () => {
      hideTooltip();
      // Clear highlight and restore all branches
      graphState.highlightedBranch = null;
      draw();
      // Restore all branch pill elements
      restoreBranchPillsOpacity();
    });
  });

  graphState.branchLabelsSignature = signature;
  }

  // Update label positions and focus styling
  branchOrder.forEach((name) => {
    const lane = branchLane.get(name);
    if (lane == null) return;

    const labelEl = graphState.branchLabels.get(name);
    if (!labelEl) return;

    const topNode = laneTopNode.get(lane);
    let anchorXWorld;
    let anchorYWorld;
    if (topNode) {
      anchorXWorld = topNode.x;
      anchorYWorld = topNode.y;
    } else if (graphState.orientation === "vertical") {
      anchorXWorld = lane * LANE_GAP;
      anchorYWorld = graphState.bounds.minY;
    } else {
      anchorXWorld = graphState.bounds.minX;
      anchorYWorld = lane * LANE_GAP;
    }

    const anchorScreen = worldToScreen(anchorXWorld, anchorYWorld);
    const offsetPx = graphState.orientation === "vertical" ? 35 : 42;
    const x =
      graphState.orientation === "vertical"
        ? anchorScreen.x
        : Math.max(8, anchorScreen.x);
    const y = Math.max(6, anchorScreen.y - offsetPx);

    labelEl.style.transform = `translate(${x}px, ${y}px)`;

    const color = colorForBranch(name, graphState.branchColor);
    const isMainBranch = isMainLikeBranch(name);
    const isFocus =
      !focusBranch ||
      name === focusBranch ||
      name.endsWith("/" + focusBranch);

    const pillSpan = labelEl.querySelector(".branch-pill-inner");
    if (pillSpan) {
      pillSpan.style.background = isMainBranch
        ? MAIN_BRANCH_COLOR
        : isFocus
        ? "rgba(15,23,42,0.96)"
        : "rgba(15,23,42,0.7)";
      pillSpan.style.border = `1px solid ${
        isMainBranch ? "transparent" : color
      }`;
      pillSpan.style.color = isMainBranch ? "#020617" : "#e5e7eb";
      pillSpan.style.opacity = isFocus || isMainBranch ? "1" : "0.6";
    }
  });
}

function ensureLegendAccessible() {
  // Ensure legend status element is accessible
  if (!graphState.legendStatus && graphState.overlay) {
    graphState.legendStatus = graphState.overlay.querySelector("#graphLegendStatus");
  }
}

function draw() {
  const canvas = graphState.canvas;
  const ctx = graphState.ctx;
  if (!canvas || !ctx) return;

  // Ensure legend is accessible before drawing
  ensureLegendAccessible();

  ctx.save();
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  if (!graphState.nodes.length) {
    ctx.restore();
    return;
  }

  drawLaneTracks(ctx);
  drawGrid(ctx);
  drawEdges(ctx);
  drawNodes(ctx);
  drawTags(ctx);
  drawBranchLabels();

  ctx.restore();
}

function handleHover(e) {
  if (!graphState.nodes.length || !graphState.canvas) return;
  const rect = graphState.canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  let bestIdx = -1;
  let bestDist = 22;
  graphState.nodes.forEach((n, idx) => {
    const p = worldToScreen(n.x, n.y);
    const dx = p.x - mx;
    const dy = p.y - my;
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = idx;
    }
  });

  graphState.hoverIndex = bestIdx;
  
  // Check if hovering over commit message in horizontal map
  let hoveredCommitMessageIdx = -1;
  if (graphState.orientation === "horizontal" && graphState.showCommitMessages !== false) {
    graphState.nodes.forEach((n, idx) => {
      if (!n.commit || !n.commit.message) return;
      
      const p = worldToScreen(n.x, n.y);
      const rOuter = STATION_RADIUS + (n.isHead ? 3 : 0) + (idx === graphState.hoverIndex ? 2 : 0);
      
      const full = (n.commit.message || "").split("\n")[0];
      const maxLen = 60;
      const text = full.length > maxLen ? full.slice(0, maxLen - 1) + "…" : full;
      
      // Measure text to get dimensions (using current size multiplier)
      const tempCtx = graphState.ctx;
      const fontFamily = localStorage.getItem("gitzada:fontHorizontalMap") || "Arial, sans-serif";
      const sizeMultiplier = parseFloat(localStorage.getItem("gitzada:horizontalMapSize") || "1.0");
      const baseFontSize = 10;
      const fontSize = baseFontSize * sizeMultiplier;
      tempCtx.save();
      tempCtx.font = `${fontSize}px ${fontFamily}`;
      const textWidth = tempCtx.measureText(text).width;
      tempCtx.restore();
      
      const basePadding = 6;
      const padding = basePadding * sizeMultiplier;
      const textHeight = fontSize;
      const boxW = textWidth + padding * 2;
      const boxH = textHeight + padding * 2;
      const angle = -Math.PI / 4;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const endOffsetX = (boxW / 2) * cos - (boxH / 2) * sin;
      const endOffsetY = (boxW / 2) * sin + (boxH / 2) * cos;
      const centerX = p.x - endOffsetX;
      const centerY = p.y - endOffsetY + 15;
      
      // Transform mouse coordinates to rotated coordinate system
      const dx = mx - centerX;
      const dy = my - centerY;
      const rotatedX = dx * cos + dy * sin;
      const rotatedY = -dx * sin + dy * cos;
      
      // Check if mouse is within the rotated box bounds
      if (rotatedX >= -boxW / 2 && rotatedX <= boxW / 2 &&
          rotatedY >= -boxH / 2 && rotatedY <= boxH / 2) {
        hoveredCommitMessageIdx = idx;
      }
    });
  }
  
  const prevHovered = graphState.hoveredCommitMessageIndex;
  graphState.hoveredCommitMessageIndex = hoveredCommitMessageIdx;
  
  const tooltip = graphState.tooltip;
  if (!tooltip) {
    // Redraw if hover state changed even without tooltip
    if (prevHovered !== hoveredCommitMessageIdx) {
      draw();
    }
    return;
  }

  if (bestIdx === -1) {
    tooltip.style.display = "none";
    // Redraw if hover state changed
    if (prevHovered !== hoveredCommitMessageIdx) {
      draw();
    } else {
      draw();
    }
    return;
  }

  const node = graphState.nodes[bestIdx];
  const p = worldToScreen(node.x, node.y);
  const c = node.commit || {};
  const shaShort = (c.sha || "").slice(0, 7);
  const msg = c.message || "";
  const author = c.author || "";
  const date = c.date ? new Date(c.date).toLocaleString() : "";

  tooltip.style.display = "block";
  tooltip.style.transform = `translate(${p.x + 12}px, ${p.y + 12}px)`;
  tooltip.innerHTML = `
    <div style="font-weight:700; margin-bottom:4px;">${shaShort}</div>
    <div style="margin-bottom:4px; color:#e5e7eb;">${msg}</div>
    <div style="font-size:11px; color:#9ca3af;">${author}${date ? " • " + date : ""}</div>
    <div style="font-size:11px; color:#cbd5e1; margin-top:4px;">${node.branch}</div>
  `;

  // Redraw if hover state changed
  if (prevHovered !== hoveredCommitMessageIdx) {
    draw();
  } else {
    draw();
  }
}

async function loadTagsForRepo(repo) {
  if (!repo) {
    graphState.tags = [];
    return;
  }

  // Reuse cached tags for this repo if available.
  if (cachedTagsByRepo.has(repo)) {
    graphState.tags = cachedTagsByRepo.get(repo);
    return;
  }

  try {
    const tags = await window.api(`/api/repos/${encodeURIComponent(repo)}/tags`);
    if (Array.isArray(tags)) {
      graphState.tags = tags;
      cachedTagsByRepo.set(repo, tags);
    } else {
      graphState.tags = [];
    }
  } catch (e) {
    console.warn("Failed to load tags for graph view", e);
    graphState.tags = [];
  }
}

async function renderGraph(commits, options = {}) {
  // Set flag early to prevent autoFit from resetting scale during ensureCanvas/onResize
  shouldPreserveCameraOnResize = true;
  
  ensureCanvas();
  const repo = options.repo || options.repository || graphState.repo;
  graphState.repo = repo || null;
  graphState.allBranchesMode = !!options.allBranches;
  graphState.focusBranch = options.focusBranch || null;
  // Preserve raw commits so we can re-render (e.g., when expanding "other" lane)
  graphState.rawCommits = commits ? commits.slice() : [];

  if (!commits || !commits.length) {
    graphState.nodes = [];
    graphState.edges = [];
    graphState.tags = [];
    draw();
    return;
  }

  let useCommits = commits;
  
  // Filter commits by active branches if Active Only is enabled
  // BUT: In all-branches mode (vertical map view), don't filter commits here
  // because we need all commits to determine which branches exist.
  // The branch lane filtering happens in layoutCommits() instead.
  const activeOnly = localStorage.getItem("gitzada:activeOnly") === "true";
  if (activeOnly && window.state && window.state.branchMetadata && !graphState.allBranchesMode) {
    // Get list of active branches
    const activeBranches = new Set(
      (window.state.branches || []).filter(branchName => {
        const metadata = window.state.branchMetadata[branchName];
        return window.isBranchActive && window.isBranchActive(branchName, metadata);
      })
    );
    
    // Filter commits to only include those on active branches
    useCommits = useCommits.filter(c => {
      // If commit has no branches, include it (it's on current branch or orphaned)
      if (!c.branches || c.branches.length === 0) {
        return true;
      }
      // Include if commit is on at least one active branch
      return c.branches.some(branch => activeBranches.has(branch));
    });
  }
  
  // Clamp commit history in All-branches mode to keep the view readable.
  if (graphState.allBranchesMode && useCommits.length > MAX_GRAPH_COMMITS) {
    useCommits = useCommits.slice(0, MAX_GRAPH_COMMITS);
  }

  // Warn if commit count exceeds rendering threshold
  if (useCommits.length > 10000) {
    console.warn(`Large commit set (${useCommits.length}). Graph rendering may be slow.`);
  }

  graphState.commits = useCommits.slice();
  layoutCommits(useCommits);
  
  // Ensure canvas is ready before focusing (wait for next frame to ensure sizing)
  await new Promise(resolve => requestAnimationFrame(resolve));
  autoFocusOnLatest();
  
  await loadTagsForRepo(graphState.repo);
  draw();
}

function setGraphStatusMessage(text) {
  // Use unified status message function (works in both graph and activity modes)
  if (typeof setStatusMessage === 'function') {
    setStatusMessage(text);
  } else {
    // Fallback if setStatusMessage is not available (shouldn't happen in normal usage)
    console.warn("setStatusMessage not available, falling back to console");
    if (text && text.trim()) {
      console.log("Status:", text);
    }
  }
}

function setGraphLegendStatus(text) {
  // Ensure overlay and legend elements are set up
  if (!graphState.overlay) {
    setupOverlay();
  }
  
  // Use centralized helper to ensure legend is accessible
  ensureLegendAccessible();
  
  if (!graphState.legendStatus) {
    // If still not found, try to ensure overlay is created
    ensureCanvas();
    ensureLegendAccessible();
  }
  
  if (!graphState.legendStatus) {
    console.warn("graphLegendStatus element not found - legend may not be initialized");
    return; // Silently fail if element not found
  }
  
  if (text && text.trim()) {
    graphState.legendStatus.textContent = text;
    graphState.legendStatus.style.display = 'block';
  } else {
    graphState.legendStatus.style.display = 'none';
  }
}

function setGraphOrientation(orientation) {
  if (orientation !== "vertical" && orientation !== "horizontal") {
    console.warn("Invalid orientation:", orientation, "- must be 'vertical' or 'horizontal'");
    return;
  }
  
  // Preserve current legend status before orientation change
  const currentLegendStatus = graphState.legendStatus?.textContent || "";
  
  graphState.orientation = orientation;
  
  // Update horizontal map controls visibility
  if (graphState.updateHorizontalMapControlsVisibility) {
    graphState.updateHorizontalMapControlsVisibility();
  }
  
  // If commits are already loaded, update the layout
  if (graphState.commits && graphState.commits.length) {
    layoutCommits(graphState.commits);
    autoFocusOnLatest();
    draw();
    // Restore legend status after orientation change
    if (currentLegendStatus && graphState.legendStatus) {
      setGraphLegendStatus(currentLegendStatus);
    }
  }
}

// Expose graphState for external access if needed
window.graphState = graphState;

window.graphView = { renderGraph, setGraphStatusMessage, setGraphLegendStatus, setGraphOrientation };
// Note: setGraphStatusMessage now uses the unified setStatusMessage function from script.js

export {};
