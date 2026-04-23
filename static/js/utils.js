/**
 * Utility functions for GitPow
 * Extracted from script.js for better maintainability
 */

// ============================================================================
// Color Utilities
// ============================================================================

/**
 * Convert hex color to RGB object
 * @param {string} hex - Hex color string (e.g., "#22c55e")
 * @returns {Object} RGB object with r, g, b properties
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 34, g: 197, b: 94 };
}

/**
 * Generate a stable, pleasant accent color from a string (e.g. SHA or filename)
 * @param {string} str - Input string to hash
 * @returns {string} HSL color string
 */
function hashColor(str) {
  if (!str) return "#374151";
  let h = 0;
  const len = Math.min(str.length, 16);
  for (let i = 0; i < len; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

/**
 * File extension based color hint (more semantic than random)
 * @param {string} path - File path
 * @returns {string} Color string
 */
function fileAccent(path) {
  const lower = (path || "").toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".jsx") || lower.endsWith(".tsx")) return "#22c55e";
  if (lower.endsWith(".json")) return "#f97316";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".sass") || lower.endsWith(".less")) return "#3b82f6";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "#ec4899";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "#eab308";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "#8b5cf6";
  if (lower.endsWith(".sh") || lower.endsWith(".bat") || lower.endsWith(".ps1")) return "#10b981";
  if (lower.endsWith(".py")) return "#0ea5e9";
  if (lower.endsWith(".go")) return "#38bdf8";
  if (lower.endsWith(".rs")) return "#f97316";
  return hashColor(path);
}

// ============================================================================
// Date/Time Formatting
// ============================================================================

/**
 * Format relative time: "2 days ago", "3 hours ago", etc.
 * @param {string} dateString - ISO date string
 * @returns {string} Relative time string with parentheses
 */
function formatRelativeTime(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return "";

    const now = new Date();
    const diffMs = now - date;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffSeconds < 60) {
      return diffSeconds <= 1 ? "(just now)" : `(${diffSeconds} seconds ago)`;
    } else if (diffMinutes < 60) {
      return diffMinutes === 1 ? "(1 minute ago)" : `(${diffMinutes} minutes ago)`;
    } else if (diffHours < 24) {
      return diffHours === 1 ? "(1 hour ago)" : `(${diffHours} hours ago)`;
    } else if (diffDays < 7) {
      return diffDays === 1 ? "(1 day ago)" : `(${diffDays} days ago)`;
    } else if (diffWeeks < 4) {
      return diffWeeks === 1 ? "(1 week ago)" : `(${diffWeeks} weeks ago)`;
    } else if (diffMonths < 12) {
      return diffMonths === 1 ? "(1 month ago)" : `(${diffMonths} months ago)`;
    } else {
      return diffYears === 1 ? "(1 year ago)" : `(${diffYears} years ago)`;
    }
  } catch (e) {
    return "";
  }
}

/**
 * Format date in human-readable form: "Sat, Nov 6th 2025 @ 12:05:35 PM"
 * @param {string} dateString - ISO date string
 * @returns {string} Human-readable date string
 */
function formatHumanDate(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const dayName = days[date.getDay()];
    const month = months[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();

    // Get ordinal suffix (1st, 2nd, 3rd, 4th, etc.)
    const getOrdinal = (n) => {
      const s = ["th", "st", "nd", "rd"];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };

    // Format time
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 should be 12
    const minutesStr = minutes.toString().padStart(2, '0');
    const secondsStr = seconds.toString().padStart(2, '0');
    const timeStr = `${hours}:${minutesStr}:${secondsStr} ${ampm}`;

    return `${dayName}, ${month} ${getOrdinal(day)} ${year} @ ${timeStr}`;
  } catch (e) {
    return dateString;
  }
}

/**
 * Format a month header from date string
 * @param {string} dateString - ISO date string
 * @returns {string} Month header string (e.g., "November 2025")
 */
function formatMonthHeader(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return "";
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  } catch (e) {
    return "";
  }
}

/**
 * Get a unique key for a month from date string
 * @param {string} dateString - ISO date string
 * @returns {string} Month key (e.g., "2025-11")
 */
function getMonthKey(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  } catch (e) {
    return "";
  }
}

// ============================================================================
// Memory and Cache Utilities
// ============================================================================

/**
 * Format bytes to human-readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string (e.g., "1.5 MB")
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

/**
 * Calculate memory usage
 * @returns {string} Memory usage info
 */
function getMemoryUsage() {
  let memoryInfo = "N/A";
  if (performance.memory) {
    const used = performance.memory.usedJSHeapSize;
    const total = performance.memory.totalJSHeapSize;
    const limit = performance.memory.jsHeapSizeLimit;
    memoryInfo = `${formatBytes(used)} / ${formatBytes(total)} (limit: ${formatBytes(limit)})`;
  } else {
    // Fallback: estimate from state objects
    try {
      const stateSize = window.state ? JSON.stringify(window.state).length : 0;
      const commitsSize = window.state?.commits ? JSON.stringify(window.state.commits).length : 0;
      const filesSize = window.state?.files ? JSON.stringify(window.state.files).length : 0;
      const estimated = stateSize + commitsSize + filesSize;
      memoryInfo = `~${formatBytes(estimated)} (estimated)`;
    } catch (e) {
      memoryInfo = "Unable to calculate";
    }
  }
  return memoryInfo;
}

/**
 * Calculate cache usage
 * @returns {string} Cache usage info
 */
function getCacheUsage() {
  let totalCacheSize = 0;
  const cacheBreakdown = [];

  // Calculate localStorage size
  try {
    let localStorageSize = 0;
    for (let key in localStorage) {
      if (localStorage.hasOwnProperty(key)) {
        localStorageSize += localStorage[key].length + key.length;
      }
    }
    totalCacheSize += localStorageSize;
    cacheBreakdown.push(`localStorage: ${formatBytes(localStorageSize)}`);
  } catch (e) {
    // localStorage might not be available
  }

  // Calculate in-memory caches
  try {
    // cachedAllBranchesCommits
    if (typeof window.cachedAllBranchesCommits !== 'undefined' && window.cachedAllBranchesCommits) {
      const size = JSON.stringify(window.cachedAllBranchesCommits).length;
      totalCacheSize += size;
      cacheBreakdown.push(`commits cache: ${formatBytes(size)}`);
    }

    // commitsAgoCache
    if (typeof window.commitsAgoCache !== 'undefined' && window.commitsAgoCache instanceof Map) {
      let size = 0;
      window.commitsAgoCache.forEach((value, key) => {
        size += JSON.stringify(key).length + JSON.stringify(value).length;
      });
      totalCacheSize += size;
      cacheBreakdown.push(`commits ago: ${formatBytes(size)}`);
    }

    // Check graph.js caches if available
    try {
      if (typeof window !== 'undefined' && window.graphState) {
        const graphState = window.graphState;
        // Estimate graphState size (commits, nodes, edges, tags)
        let graphStateSize = 0;
        if (graphState.commits && Array.isArray(graphState.commits)) {
          graphStateSize += JSON.stringify(graphState.commits).length;
        }
        if (graphState.nodes && Array.isArray(graphState.nodes)) {
          graphStateSize += JSON.stringify(graphState.nodes).length;
        }
        if (graphState.edges && Array.isArray(graphState.edges)) {
          graphStateSize += JSON.stringify(graphState.edges).length;
        }
        if (graphState.tags && Array.isArray(graphState.tags)) {
          graphStateSize += JSON.stringify(graphState.tags).length;
        }
        if (graphStateSize > 0) {
          totalCacheSize += graphStateSize;
          cacheBreakdown.push(`graph state: ${formatBytes(graphStateSize)}`);
        }
      }
    } catch (e) {
      // graphState might not be accessible or serializable
    }
  } catch (e) {
    console.warn("Error calculating cache sizes:", e);
  }

  const cacheInfo = totalCacheSize > 0
    ? `${formatBytes(totalCacheSize)} (${cacheBreakdown.join(", ")})`
    : "No cache data";

  return cacheInfo;
}

// ============================================================================
// GitHub/Avatar Utilities
// ============================================================================

/**
 * Extract GitHub username from email/author
 * @param {string} email - Email address
 * @param {string} author - Author name
 * @returns {string|null} GitHub username or null
 */
function getGitHubUsername(email, author) {
  // Check for GitHub no-reply email pattern: {username}@users.noreply.github.com
  // GitHub emails can be in two formats:
  // 1. {username}@users.noreply.github.com (direct username)
  // 2. {id}+{username}@users.noreply.github.com (numeric ID + username)
  if (email) {
    const githubEmailMatch = email.match(/^([^@]+)@users\.noreply\.github\.com$/i);
    if (githubEmailMatch) {
      const localPart = githubEmailMatch[1];
      // If the local part contains a '+', extract the username after it
      // Format: {numeric-id}+{username} -> extract {username}
      if (localPart.includes('+')) {
        const parts = localPart.split('+');
        // Take the last part after '+' (in case there are multiple '+')
        const username = parts[parts.length - 1];
        // Validate it's a valid GitHub username
        if (username && /^[a-zA-Z0-9]([a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username)) {
          return username;
        }
      } else {
        // No '+' means it's the username directly
        return localPart;
      }
    }

    // Try to infer from email domain
    if (email.includes('github')) {
      const localPart = email.split('@')[0];
      // Handle + separator: take the part after the last '+'
      let cleanLocal = localPart;
      if (localPart.includes('+')) {
        const parts = localPart.split('+');
        cleanLocal = parts[parts.length - 1];
      }
      // Handle . separator: take the part before the first '.'
      cleanLocal = cleanLocal.split('.')[0];
      if (cleanLocal && /^[a-zA-Z0-9]([a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(cleanLocal)) {
        return cleanLocal;
      }
    }
  }

  // Try to extract GitHub username from author name
  if (author) {
    // Check for pattern like "Name (@username)" or "Name (username)"
    const authorMatch = author.match(/\(@?([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})\)/);
    if (authorMatch) {
      return authorMatch[1];
    }

    // Check if author name looks like a GitHub username
    const usernamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
    if (usernamePattern.test(author.trim())) {
      return author.trim();
    }
  }

  return null;
}

/**
 * Generate avatar URL from email/author using GitHub avatars
 * @param {string} email - Email address
 * @param {string} author - Author name
 * @param {number} size - Avatar size in pixels
 * @returns {string|null} Avatar URL or null
 */
function getAvatarUrl(email, author, size = 20) {
  const username = getGitHubUsername(email, author);
  if (username) {
    return `https://github.com/${username}.png?size=${size}`;
  }
  return null;
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Normalize path for Windows (replaces forward slashes with backslashes, strips trailing backslash).
 * Orphaned today (no callers); kept under an unambiguous name so future callers can opt in
 * without colliding with helpers.js's display-oriented normalizePath.
 * @param {string} value - Path string
 * @returns {string} Normalized Windows path
 */
function normalizeWindowsPath(value) {
  if (!value) return value;
  // Replace forward slashes with backslashes for Windows
  let normalized = value.replace(/\//g, '\\');
  // Remove trailing backslash
  if (normalized.endsWith('\\')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// ============================================================================
// File Type Utilities
// ============================================================================

/**
 * Check if a file is an image based on extension
 * @param {string} filePath - File path
 * @returns {boolean} True if image file
 */
function isImageFile(filePath) {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'];
  const lower = filePath.toLowerCase();
  return imageExtensions.some(ext => lower.endsWith(ext));
}

// ============================================================================
// Export to window for global access
// ============================================================================

// Make utilities available globally
window.hexToRgb = hexToRgb;
window.hashColor = hashColor;
window.fileAccent = fileAccent;
window.formatRelativeTime = formatRelativeTime;
window.formatHumanDate = formatHumanDate;
window.formatMonthHeader = formatMonthHeader;
window.getMonthKey = getMonthKey;
window.formatBytes = formatBytes;
window.getMemoryUsage = getMemoryUsage;
window.getCacheUsage = getCacheUsage;
window.getGitHubUsername = getGitHubUsername;
window.getAvatarUrl = getAvatarUrl;
window.normalizeWindowsPath = normalizeWindowsPath;
window.isImageFile = isImageFile;
