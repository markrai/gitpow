/**
 * Singleton event registry for long-lived UI wiring.
 *
 * Use this only for global or singleton controls. Per-row/per-item listeners
 * should stay local to their render functions until those renderers are
 * extracted behind clearer lifecycle boundaries.
 */
(function () {
  const bindings = new Map();

  function bindingId(owner, key) {
    return `${owner}:${key}`;
  }

  function removeBinding(id) {
    const binding = bindings.get(id);
    if (!binding) return;
    binding.target.removeEventListener(binding.type, binding.handler, binding.options);
    bindings.delete(id);
  }

  function bind({ owner, key, target, type, handler, options }) {
    if (!owner || !key) {
      throw new Error("gpEvents.bind requires owner and key");
    }
    if (!target || typeof target.addEventListener !== "function") {
      throw new Error(`gpEvents.bind(${owner}:${key}) requires an EventTarget`);
    }
    if (!type || typeof handler !== "function") {
      throw new Error(`gpEvents.bind(${owner}:${key}) requires type and handler`);
    }

    const id = bindingId(owner, key);
    removeBinding(id);
    target.addEventListener(type, handler, options);
    bindings.set(id, { owner, key, target, type, handler, options });

    return () => removeBinding(id);
  }

  function cleanupOwner(owner) {
    for (const [id, binding] of Array.from(bindings.entries())) {
      if (binding.owner === owner) {
        removeBinding(id);
      }
    }
  }

  function count(owner) {
    if (!owner) return bindings.size;
    let total = 0;
    for (const binding of bindings.values()) {
      if (binding.owner === owner) total += 1;
    }
    return total;
  }

  window.gpEvents = { bind, cleanupOwner, count };
})();
