Source code: the attached source archive holds the sources of this exact build. With Node.js 24 and npm, from the archive's root:

    npm ci --workspace=apps/extension --include-workspace-root
    npm run extension:build:release --workspace=apps/extension

apps/extension/dist/ is then identical to the uploaded add-on (diff -r); README.md at the archive's root has the details. Vite bundles and minifies; nothing is obfuscated or loaded remotely.

Network: none by default; every tool runs locally and content scripts never make requests. On the options page the user can opt in to three peers of their own, and only the options page and the background script talk to them:
- Their self-hosted Piwi instance (a URL and API key): reads projects, URL patterns, the function catalog, the locator index and bug reports; sends a bug report or a replay verdict only when the user clicks Send in a preview showing what is sent.
- The Piwi desktop app on 127.0.0.1 (a pasted token): gets a bug report's title and steps when the user clicks Send, and returns the verdict.
- Their editor on 127.0.0.1 (a pasted token, sent only after the editor proves it holds it): gets a locator or recorded steps on Send to editor. While paired, the background script keeps a WebSocket to the editor's run services to show the runs the editor started in the Runs window, and pause, step or resume them on the user's click or shortcut (no key until the user sets one). Their 20-second keepalive keeps the background script running while a service is up.

Permissions: activeTab, scripting, storage. The optional host permissions (http://*/*, https://*/*) grant nothing at install: the popup requests one origin when the user starts recording there, the options page the instance's origin on save. A content script registered for the instance's origin only sets data-piwi-picker (the add-on's version) on its pages, reading and sending nothing. The optional cookies permission is requested, for one site, when the user clicks Save login file: that site's cookies and localStorage go into a file the user downloads, nowhere else. devtools_page adds a pane and a panel that read the inspected page and its network log only while open, and send nothing.

innerHTML: every reported assignment inserts static markup or locator text HTML-escaped by the syntax highlighter (highlightLocator in packages/picker-dom/src/syntax-highlight.ts; overlay-element.ts and overlay-confirm.ts beside it).

Testing: no account is needed. Open any page, click the toolbar button and pick a tool: Pick an element, Lint overlay, Multi-pick, or Record actions (allow the site, click around, Stop to review the spec). What needs a Piwi instance can be skipped.
