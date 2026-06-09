# Frontend Boundaries

GitPow's browser code is still a classic-script frontend with a few focused
modules and one ES module for the graph. These boundaries are the current
contract for incremental refactors. They are intentionally conservative: keep
the app stable while shrinking `static/script.js` and `static/graph.js`.

## Loading Model

`static/index.html` loads scripts in this order:

1. Compatibility primitives: storage, cache, loading progress, event registry,
   utilities, state, API, UI helpers, and DOM handles.
2. Feature modules under `static/js/` that publish the small set of globals
   needed by the remaining orchestration code.
3. `static/graph.js` as an ES module because it imports Three.js through the
   page import map.
4. `static/script.js`, which is still the Activity-view orchestrator.
5. Late modules that depend on globals created by `script.js`.

Do not reorder scripts casually. If a module needs to move, document the
dependency that made the move safe.

## Ownership

- `static/js/api.js` owns HTTP/Tauri transport mapping only. It should not own
  rendering, state mutation policy, or feature workflows.
- `static/js/state.js` owns shared view state, constants, and settings accessors.
  New persistent settings should prefer `gpStorage`; legacy `gitzada:*` keys are
  tolerated only until a dedicated migration pass.
- `static/js/dom-elements.js` owns cached DOM handles. New feature modules
  should prefer local `getElementById` calls unless a handle is already part of
  the compatibility surface.
- `static/js/ui.js` owns status messages, small display helpers, and modal
  helpers that are reused across features.
- `static/js/*` feature modules own their named workflow: staging, conflicts,
  Git operations, detached HEAD, filters, navigation, resize handles, and so on.
- `static/script.js` owns bootstrap and Activity-view orchestration only. Any
  feature code extracted from it must be deleted from `script.js` in the same
  change.
- `static/graph.js` owns graph state, layout, rendering, and graph interaction
  until the graph decomposition phase starts.

## Event Wiring

Use `window.gpEvents` for singleton listeners: global keyboard/mouse handlers,
toolbar controls, view mode toggles, repo/branch/search controls, unload
cleanup, polling lifecycle, and commit-form controls.

`gpEvents.bind({ owner, key, target, type, handler, options })` replaces any
existing listener with the same `owner:key`. This makes duplicate binding bugs
observable and lets smoke tests assert listener counts.

Do not use the registry for per-row or per-render listeners yet. Commit items,
file items, dropdown options, and diff hunks may keep local listeners until
their renderers have explicit init/teardown boundaries.

## Global Shim Policy

Globals are a compatibility shim, not a pattern. Existing exports are reviewed
in `scripts/window-globals-allowlist.json`, and `node
scripts/check-window-globals.mjs` fails when a new `window.X = ...` assignment
is added without owner/reason metadata.

New globals are allowed only when all of these are true:

- The caller cannot yet import or receive the dependency directly.
- The owner module is clear.
- The allowlist explains why the export exists.
- The change does not introduce a second owner for the same behavior.

When extracting from `script.js`, expose only the names that existing callers
need, load the module before `script.js` if `script.js` calls it, and delete the
old copy from `script.js` in the same PR.

## Testing Expectations

Frontend guardrail changes should keep these checks green:

- `npm run smoke:lint`
- `npm run smoke:frontend`

Smoke tests should stay black-box where possible: exercise repo load, branch
switching, view-mode switching, and staging shell rendering through the running
HTTP app. Use `window.gpEvents.count(owner)` only for singleton listener
regression checks.
