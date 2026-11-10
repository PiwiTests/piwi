Source: the attached archive holds this build's sources. With Node.js 24 and npm, from its root:

    npm ci --workspace=apps/extension --include-workspace-root
    npm run extension:build:release --workspace=apps/extension

apps/extension/dist-firefox/ is then identical to the upload (diff -r); README.md at the root has details. Vite bundles and minifies; nothing is obfuscated or loaded remotely.

Network: none by default. Tools run locally; content scripts never make requests. On the options page the user can pair three peers of their own; only the options page and background script then talk to them, and connecting or pairing sends the browser and OS names:
- Their Piwi instance (URL and API key): reads projects, URL patterns, the function catalog, the locator index and bug reports. Sends a bug report (recorded steps, evidence the user kept ticked) or a replay verdict (verdict, site, user agent) only on Send in a preview of what is sent.
- The Piwi desktop app on 127.0.0.1 (token pasted, or handed over when the user allows Pair in the app): gets a bug report's title and steps on Send and returns the verdict.
- Their editor on 127.0.0.1 (token pasted, sent only after the editor proves it holds it): gets a locator or recorded steps on Send to editor.
While paired, whenever the background script starts and without user action, it asks the editor and the app (after the same proof) for their run services and keeps a WebSocket to each, to show their runs in the Runs window and pause, step or resume them on the user's click or shortcut (no key until set). The services' 20 s keepalive keeps the background script running. Nothing read from a page is sent otherwise.

Permissions: activeTab, scripting, storage. Optional host permissions (http://*/*, https://*/*) grant nothing at install: the popup requests one origin when the user starts recording there, the options page a peer's origin on save. For the instance's origin a content script only sets data-piwi-picker (the version) on its pages. Optional cookies is requested for one site on Save login file: its cookies and localStorage go into a file the user downloads, nowhere else. devtools_page adds a pane and panel that read the inspected page and its network log only while open, sending nothing. While a bug recording or replay (or a request condition) runs, a main-world script for that origin wraps fetch/XHR, calling the originals unchanged, to note failed requests (no header or body) or delay or fail matching ones.

innerHTML: each reported assignment inserts static markup, a lowercased tag name, or locator text HTML-escaped by the highlighter (packages/picker-dom/src/syntax-highlight.ts, overlay-element.ts, overlay-confirm.ts).

Testing: no account needed. Open any page, click the toolbar button, pick a tool: Pick an element, Lint overlay, Multi-pick or Record actions (allow the site, click around, Stop to review the spec). Instance features can be skipped.
