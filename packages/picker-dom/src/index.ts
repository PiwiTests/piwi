/**
 * `@piwitests/picker-dom` — the shared DOM element-picker overlay used by the
 * reporter's live picker and the dashboard's snapshot picker: probing,
 * hover/highlight, actionable-ancestor snapping, anchor scoping, and locator
 * syntax highlighting.
 *
 * The browser-context modules (`probe`, `overlay-element`, `overlay-anchors`,
 * `overlay-confirm`, `overlay-pause`, `overlay-stop`) each export self-contained functions with no module-scope
 * references — every host re-serializes them via `Function.prototype.toString()`
 * (`page.evaluate` for the reporter, `String()` into a `<script>` tag for the
 * snapshot picker), so a closure over anything outside the function body would
 * silently break at runtime. `anchor-alternatives` is ordinary, Node-safe TS
 * that runs wherever its caller runs.
 */
export * from './types.js';
export * from './probe.js';
export * from './overlay-element.js';
export * from './overlay-anchors.js';
export * from './overlay-confirm.js';
export * from './overlay-pause.js';
export * from './overlay-stop.js';
export * from './anchor-alternatives.js';
export * from './syntax-highlight.js';
export * from './dom-role.js';
