/**
 * Centralized localStorage keys for GitPow with legacy-prefix migration.
 *
 * The app was previously branded "gitzada" and wrote keys under `gitzada:*`.
 * New code should read/write through `gpStorage` using `gitpow:*`. On first
 * load, `migrateLegacyStorageKeys()` copies a curated set of legacy keys to
 * their new names so users don't lose their preferences. Reads also fall back
 * to the legacy key if the new one is not yet populated, giving one grace
 * period before the migration can be deleted.
 */

(function () {
  const LEGACY_PREFIX = "gitzada:";
  const PREFIX = "gitpow:";

  // Keys explicitly migrated from the legacy prefix. Kept intentionally narrow
  // so the migration stays predictable and easy to review.
  const MIGRATED_KEYS = [
    "reposRoot",
    "reposRootOnboarded",
    "lastRepoId",
  ];

  const MIGRATION_FLAG = PREFIX + "storageMigrated.v1";

  function legacyKey(name) {
    return LEGACY_PREFIX + name;
  }

  function newKey(name) {
    return PREFIX + name;
  }

  function safeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Ignore quota / private-mode errors; callers already tolerate this.
    }
  }

  function safeRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // See safeSet.
    }
  }

  function migrateLegacyStorageKeys() {
    if (safeGet(MIGRATION_FLAG) === "true") return;
    for (const name of MIGRATED_KEYS) {
      const legacyValue = safeGet(legacyKey(name));
      if (legacyValue !== null && safeGet(newKey(name)) === null) {
        safeSet(newKey(name), legacyValue);
      }
    }
    safeSet(MIGRATION_FLAG, "true");
  }

  // Run migration as early as possible.
  migrateLegacyStorageKeys();

  const gpStorage = {
    PREFIX,
    LEGACY_PREFIX,
    /**
     * Read a key. For keys listed in MIGRATED_KEYS, falls back to the legacy
     * prefix if the new key is missing so we don't regress existing users.
     */
    get(name) {
      const v = safeGet(newKey(name));
      if (v !== null) return v;
      if (MIGRATED_KEYS.includes(name)) {
        return safeGet(legacyKey(name));
      }
      return null;
    },
    set(name, value) {
      safeSet(newKey(name), String(value));
    },
    remove(name) {
      safeRemove(newKey(name));
      if (MIGRATED_KEYS.includes(name)) {
        safeRemove(legacyKey(name));
      }
    },
  };

  window.gpStorage = gpStorage;
})();
