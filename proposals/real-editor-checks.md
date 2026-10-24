# The plugins in the real editors: what the screenshot pipelines found, and the checks they could carry

The illustrations of the browser extension, the VS Code extension and the JetBrains plugin are captured in the real
products: Chromium with the extension loaded, the VS Code that `@vscode/test-electron` downloads, the latest WebStorm
release. Getting there took a set of findings about each product, verified while the three pipelines were built
(October 2026), that nothing else in the repository records: how each editor is launched from a script, driven, kept
quiet, and what it costs. This document is their durable home, and the record of a decision taken on the way: the
pipelines are not turned into continuous checks of the plugins yet. The second half says what such checks would be
and what they would need, so the decision can be revisited with the facts at hand.

**Status.** Proposed 2026-10-21. Being built: the VS Code check of section 6 is built (2026-10-24), as D3 has it: a
Playwright suite, `apps/vscode/tests/e2e/`, over the launcher the screenshot script now shares
(`apps/vscode/scripts/lib/vscode-window.mjs`, which pins the VS Code release both open), run every night and on demand
by `.github/workflows/nightly-vscode.yml`, not on pull requests. The JetBrains check remains deferred until a license
for CI exists. The three pipelines are still run by hand to recapture the illustrations; where this text and a script
differ, the script's header is right.

**Summary.** Three scripts capture the illustrations, all against the same fixture project and stub instance where an
instance is involved: `apps/extension/tests/e2e/docs-screenshots.spec.ts` (a Playwright test, skipped unless asked),
`apps/vscode/scripts/take-screenshots.mjs` (Playwright driving VS Code through its Electron support) and
`apps/jetbrains/scripts/take-screenshots.mjs` (WebStorm on an Xvfb display, driven through X input events). The
VS Code and JetBrains scripts prove, on every run, that the built plugin loads in the real editor, starts the editor
service, connects to an instance, and draws its failures, its quick fixes and its summaries. They assert none of it:
they wait for the moment to capture and write an image. The plugins' automated checks remain the in-process ones
(section 5), and for VS Code a nightly suite in the real editor (section 6). A check in the real JetBrains IDEs is
costly, mostly because of the license, and is deferred.

## 1. What exists

| Pipeline | Product | Driver | Images | Run |
|----------|---------|--------|--------|-----|
| `apps/extension/tests/e2e/docs-screenshots.spec.ts` | Chromium with the unpacked extension (`--load-extension`) | Playwright, a persistent context at `deviceScaleFactor: 2` | `picker-*.png`, `tested-elements-overlay.png`, 1280 × 800 (the size the stores take) | `PIWI_DOCS_SHOTS=1 npm run extension:test:e2e -- docs-screenshots` from `apps/extension/` |
| `apps/vscode/scripts/take-screenshots.mjs` | VS Code, downloaded by `@vscode/test-electron` | Playwright's `_electron.launch`, the workbench's DOM | `vscode-*.png`, a 1440 × 900 window at 2× | `xvfb-run -a -s "-screen 0 2880x1800x24" node scripts/take-screenshots.mjs` from `apps/vscode/`, after `npm run vscode:build` |
| `apps/jetbrains/scripts/take-screenshots.mjs` | The latest WebStorm release, downloaded into `apps/jetbrains/.ide/` | X input events (XTEST) through `scripts/xinput.py`, ImageMagick's `import` | `jetbrains-*.png`, a 1440 × 900 window at 2× | `node scripts/take-screenshots.mjs` from `apps/jetbrains/`, after `npm run editor:build -w packages/editor` and `./gradlew buildPlugin` |

Shared by the two editor scripts:

- **The fixture project**, `apps/vscode/scripts/lib/editor-fixture.mjs`: a small shop's Playwright suite, `acme-mugs`,
  with a page object whose line 15 holds a brittle locator (`locator('.btn-primary').nth(1)`), two tests failing on
  the latest CI run, a local run since that fixed a third, a flaky catalog test, a service the tests reach, and two
  Nitro server routes, one the checkout tests request and one none does (the `uncovered` scene changes it). It is
  a git repository with one commit, so the branch and commit the service reports exist. It carries type stubs for
  `@playwright/test` and `@piwitests/reporter` under `node_modules/` and a `tsconfig.json`, so neither editor's
  TypeScript service reports errors of its own.
- **The stub instance**, served by the same module: the routes the editor service reads (the project menu, the locator
  and code indexes, the test cases, the locator alternatives, the branch failures, the test functions, the healing of
  the failed cases, the run, the links, the screenshots) with answers consistent with the fixture.
- **The image helper**, `apps/vscode/scripts/lib/image.mjs`: an image written at a width, and the window cut out of
  a screen capture whose surround is black.
- **The harness exception**: `apps/application/scripts/take-feature-screenshots.mjs` lists the `picker-`, `vscode-`
  and `jetbrains-` prefixes as external, so `npm run app:screens:check` leaves these images alone.

The two editor pipelines show the same editor service, so a change to the fixture recaptures both sets, and the pair
of images per editor is the same pair: the heal offered on the failing line, and the run's failures beside the spec.

## 2. What was found about the JetBrains IDEs

All of it verified on WebStorm 2026.2.3 (build 262.10968.77), the release current at the time, on Linux under Xvfb.

### The IDE itself

- **Download.** JetBrains' releases API gives the latest release:
  `https://data.services.jetbrains.com/products/releases?code=WS&latest=true&type=release`, then
  `WS[0].downloads.linux.link`, a tar.gz of about 1 GB that unpacks to `WebStorm-<build>/`. The script keeps it in
  `apps/jetbrains/.ide/` (gitignored), beside the 2024.1 the Gradle build downloads for its sandbox, which is not
  the one to capture in: the images should show the current UI.
- **Launcher and its variables.** `bin/webstorm` (native) or `bin/webstorm.sh`. The properties file and the VM
  options file are named by `WEBIDE_PROPERTIES` and `WEBIDE_VM_OPTIONS`: the launcher's variable base name is
  `WEBIDE`, whatever the product is called, and `WEBSTORM_*` names are ignored. `JAVA_TOOL_OPTIONS` must be unset in
  the environment: it overrides the IDE's own options, and the IDE says so in a notification.
- **Command line.** `webstorm <project> --line N --column M <file>` opens the file with the caret at that position
  and the editor focused. The command line processor of this build accepts `--line`, `--column`, `--edit`,
  `--temp-project` and `--wait`. This is the reliable way to put the caret somewhere: the editor state written in
  `.idea/workspace.xml` before the first open (`FileEditorManager`, the caret) is not restored, and Go to File
  (Ctrl+Shift+N) does nothing while the editor has no focus. Go to Line (Ctrl+G) takes `line:column`.
- **Properties that keep it quiet.** In `idea.properties` or as `-D` options: `idea.trust.all.projects=true` (no
  trust dialog), `jb.consents.confirmation.enabled=false` and `jb.privacy.policy.text=<!--999.999-->` (no consent
  and privacy dialogs), `idea.initially.ask.config=never` (no import-settings dialog),
  `ide.show.tips.on.startup.default.value=false`, `ide.no.platform.update=true`, `idea.suppress.statistics.report=true`.
  The paths: `idea.config.path`, `idea.system.path`, `idea.plugins.path`, `idea.log.path`.
- **Scale and theme.** `-Dsun.java2d.uiScale=2` renders at 2× on an Xvfb screen of 2880 × 1800, giving a 1440 × 900
  window; the frame bounds come from `ProjectFrameBounds` in `workspace.xml`. `options/laf.xml` with
  `<laf themeId="ExperimentalDark" />` is the new UI's dark theme. `-Dawt.useSystemAAFontSettings=lcd` keeps the
  text crisp.
- **Startup markers in `idea.log`.** `Project frame set to` once the project window shows; `License required` when
  the license dialog is up. Once the system directory holds the indexes, a launch reaches the project frame in about
  ten seconds; the first launch on a fresh system directory takes about a minute, and the first diagnostics of the
  plugin another thirty to forty seconds after the frame.

### The license

- **A release asks for a license** at the first start on a config directory without one, in a dialog with three
  tabs: *Free non-commercial use* (a JetBrains account is required to log in), *Paid license* (subscription,
  activation code, license server) and *Start trial*. **Start trial** claims a 30-day trial of the IDE with an
  internet connection and nothing else: no account, no form. The trial is written as `<config>/webstorm.key`, and the
  IDE starts licensed from then on. The 2024.1 release shows the same tab. An EAP build has no trial: it asks for a
  JetBrains account, so it cannot serve a script.
- **One trial per IDE version per machine.** The dialog says it: a version's trial can be claimed once on a machine.
  The script keeps the config directory in `apps/jetbrains/.ide/config` across runs for this reason, and claims the
  trial only when asked (`--start-trial`), by clicking the tab and the button at their places in the 1440 × 900
  window; `--config <dir>` copies an activated IDE's config directory in instead.
- **The trial is bound to the machine through `user.home`.** Pointing the Java property `user.home` elsewhere (tried
  so the project view would show `~/acme-mugs` rather than the temporary path) brought the license dialog back on the
  next start, `License required` in the log, the key file still in place. The script does not touch `user.home`; the
  failures scene hides the project view instead.
- **The trial's balloon**, "Free trial has started. 30 days left", is not a notification: it is a *got it* tooltip
  anchored to the trial status bar widget (module `intellij.platform.trialPromotion.idesWithoutFreeTier`, message
  `trial.status.bar.widget.got.it.trial.started.in.ide.without.free.tier.title`), so Clear All Notifications leaves
  it. `GotItTooltip` reads the system property `ide.integration.test.disable.got.it.tooltips`;
  `-Dide.integration.test.disable.got.it.tooltips=true` turns every got-it tooltip off, which is what the script does.
  The green *Trial* badge in the status bar is the widget itself and stays.

### Noise the IDE adds, and how each is removed

- **"IDE error occurred"**, a red icon in the status bar with a balloon: raised by the *JetBrains OS Integration*
  plugin (`com.intellij.platform.daemon`, `plugins/platform-daemon-plugin/`), whose daemon client fails on a bare
  display, not by the plugin under capture. The script lists it in `<config>/disabled_plugins.txt` and sets
  `-Didea.fatal.error.notification=disabled`; with both, nothing shows.
- **The AI Assistant promotion** in the frame: `com.intellij.ml.llm` in `disabled_plugins.txt`.
- **Code author hints** above every declaration: the fixture's one commit signs every line, so Code Vision shows the
  author everywhere. The provider's id is `vcs.code.vision`; `options/editor.xml` with a `CodeVisionSettings`
  component whose `disabledCodeVisionProviderIds` set holds it turns the hints off while keeping the plugin's own
  Code Vision lines (`piwi.summary`).
- **Tips, update checks, exit confirmation**: `options/ide.general.xml` (`showTipsOnStartup`, `confirmExit`) and
  `options/updates.xml` (`CHECK_NEEDED`).
- **Project-level prompts**: `.idea/.gitignore` holding `*` keeps the IDE from asking to add its own files to git.

### Driving the IDE from a script

- **X input events** through XTEST (`scripts/xinput.py`, a `ctypes` binding to `libXtst`): key chords named with X
  keysyms (`alt+Return`, `ctrl+g`), typed text, pointer moves and clicks, chained on one command line. They reach the
  focused window of the display, which is why each scene launches the IDE with its file on the command line: the
  editor is focused from the start.
- **Actions without a shortcut get one** from a keymap the script writes: `<config>/keymaps/Screenshots.xml`, with
  `parent="Default for XWin"` (the Linux default), binds `ActivatePiwiToolWindow` (the action of a tool window is
  `Activate<Id>ToolWindow`), `ClearAllNotifications` and `HideAllWindows` to `shift ctrl alt F10` to `F12`, and
  `options/keymap.xml` makes it the active keymap. A shortcut is deterministic where a click on the tool window's
  stripe button (which hides a visible window) or a search for the action by name is not.
- **The capture** is ImageMagick's `import -window root` on the display, trimmed of its black surround and written at
  1440 px wide. The window came out 885 px tall, the status bar included.
- **Scenes.** *heal*: the page object at line 15, column 5, all tool windows hidden (the intention's preview then
  fits beside the popup), Alt+Enter, three seconds. *failures*: the spec at line 1, tool windows hidden, the Piwi tool
  window activated, four seconds. Each scene is one launch, about a minute once the IDE is cached; the two scenes run
  in about five minutes on the container they were built in. `--probe` captures the IDE as it stands on the page
  object without driving it, the way to look before a new scene is written.

### Building the plugin where the network is proxied

Gradle's dependency resolution from Maven Central answered 429 through the container's proxy. An init script in
`~/.gradle/init.d/` that rewrites `repo.maven.apache.org` to `https://cache-redirector.jetbrains.com/maven-central`,
with `--no-configuration-cache`, got `./gradlew buildPlugin` through. This is the environment's problem, not the
build's, and the script is not in the repository.

## 3. What was found about VS Code

Verified on VS Code 1.143.0, the stable build `@vscode/test-electron` downloaded at the time, on Linux under Xvfb.

- **Launch.** Playwright's `_electron.launch` on the downloaded binary, with `--extensionDevelopmentPath` (the built
  extension, no packaging), `--user-data-dir` and `--extensions-dir` under a temporary root, and
  `--disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates --no-sandbox --disable-gpu
  --force-device-scale-factor=2`, the workspace last. Under `xvfb-run -a -s "-screen 0 2880x1800x24"` the window is
  1440 × 900 at 2×. The extension reads the instance from `PIWI_DASHBOARD_URL`, `PIWI_PROJECT_NAME` and a
  `PIWI_DESKTOP_CONFIG` that points at no file.
- **Settings that keep it quiet**, written to the user data directory before launch: `chat.disableAIFeatures` (no
  Chat view, no sign-in prompt), `workbench.secondarySideBar.defaultVisibility: hidden`, and the Toggle Secondary
  Side Bar command when the bar shows anyway. The window title's `[Extension Development Host]` and `[Superuser]`
  suffixes are removed by editing the title's DOM text before the capture.
- **Driving it through the DOM.** The command palette is opened with F1 and the command typed as `>title`; the row to
  click is the first `.quick-input-list .monaco-list-row` whose `.label-name` starts with the title, because the
  palette's fuzzy match ranks other commands first for some titles (a plain Enter opened a terminal). Go to Line
  (Ctrl+G) takes `:line:column`; with the line alone the input waits. The quick-fix menu is `.action-widget`,
  filtered by text (`Heal: use`) and `.first()`, since several widgets can exist; the hover is
  `.monaco-hover:not(.hidden)`. Notifications are cleared at the start of a scene, never while a menu is open: the
  palette's text would land in the editor.
- **The Marketplace README.** `vsce` rewrites every relative image link to
  `https://github.com/PiwiTests/platform/raw/HEAD/<path>` and ignores `repository.directory`, so a relative link
  from `apps/vscode/README.md` breaks on the Marketplace. The README links the images by their docs-site address,
  `https://piwitests.dev/screenshots/vscode-<scene>.png`, which the docs drift test checks resolve.
- **Scenes.** *heal*: the page object, the Problems panel focused below, the caret at the failing line, the quick
  fixes open. *failures*: the spec, the failures view in the side bar. *hover*: the page object, the hover over the
  failing locator. A scene that fails leaves `vscode-<scene>-failed.png` with the window as it stood.

## 4. What was found about the browser extension

- **2× images** come from the persistent context's `deviceScaleFactor: 2` (`launchWithExtension` takes it); setting
  the device metrics through CDP (`Emulation.setDeviceMetricsOverride`) after launch did not change the captures.
- **The popup** is captured as a screenshot of its page and composited over the page capture, top right, with a
  blurred shadow; `sharp` composites before it resizes (the composite must be no larger than the base), so the two
  steps are two pipelines.
- **The pick** targets the unique Checkout button: with an element that has several matches, the picker's anchors
  step makes the scoped pick ambiguous and the capture non-deterministic. A recording review is seeded through the
  extension's storage stub (`stubChromeStorage`) with a seven-step recording; the DevTools pane is captured at 440 × 360
  and written at 880 px wide.

## 5. How the plugins are verified today

- **The editor service** (`packages/editor/`): unit tests on the analysis, the commands, the context, the coverage,
  the failure tree, the host state and the imports, with fixtures of their own. Both plugins run this service, so this
  is where the behaviour they show is checked.
- **VS Code** (`apps/vscode/`): unit tests (`npm run vscode:test`) and an integration suite
  (`npm run vscode:test:integration`) that starts a stub instance, writes a fixture repository and drives a real
  VS Code through its public commands (`vscode.executeCodeActionProvider`, `vscode.executeCodeLensProvider`, …) and the
  API the extension's `activate` returns. No DOM: what the workbench draws is not checked.
- **JetBrains** (`apps/jetbrains/`): platform tests on `BasePlatformTestCase` (`PiwiPluginTest`, `GlueTest`,
  `OpenOriginsTest`, `PiwiRecordingTest`, `Lsp4jAccessTest`) that start the language server from `dist/` in the test
  IDE, headless, with no license involved. What the IDE draws (the tool window, the intentions, Code Vision, the
  status bar) is not checked.
- **The screenshot scripts** add, by hand and without assertions, the one thing the above cannot: the built plugin in
  the real product, with the real LSP client and the real UI. A run that reaches its captures is evidence that the
  plugin loads, the service starts, the connection is made and the UI appears; a run that does not, or an image that
  looks wrong, is a finding to chase.

## 6. What a check in the real editors would be

### VS Code: built, nightly

`apps/vscode/tests/e2e/editor.spec.mjs` asserts what this section lists, plus the Testing view's tree and its results,
in one window for the whole suite; `npm run vscode:test:e2e` from `apps/vscode/`, after `npm run vscode:build`, under
`xvfb-run -a -s "-screen 0 1920x1200x24"` on Linux. A local run takes about 15 seconds once VS Code is downloaded. The
integration suite keeps its own stub instance. What follows is the reasoning it was built from.

The screenshot script already waits on real UI states to capture: the quick-fix row that starts with `Heal: use`,
the hover's content, the Problems panel. A Playwright test suite over the same launcher turns those waits into
assertions:

- the Problems panel lists the two failures at their lines, with the reasons the stub gives;
- the quick fixes on the failing line offer the recommended locator first;
- the hover on the failing locator names the failing tests and the run;
- the failures view's tree has the run, the local run since and the three cases;
- the status bar item shows the counts;
- the Code Lens lines above the locators and the application file name the tests behind them.

Cost: a Playwright config in `apps/vscode/tests/e2e/`, the launcher of the script moved to a shared module, the stub
instance of `tests/integration/run.mjs` (a second copy of the fixture's, with fewer routes) folded into the fixture
module, Xvfb in the workflow, the VS Code download cached (about 100 MB, `@vscode/test-electron` caches it). A run is one to two
minutes. Risk: the workbench's DOM (class names, the quick input's rows) changes across VS Code versions, where the
integration suite's public commands do not; the suite should pin the VS Code version it downloads and move it on
purpose.

### JetBrains: costly, mainly for the license

There is no DOM. Three ways to assert, from the cheapest:

1. **The IDE's log and the service's traffic.** The current script can check, after a launch, that `idea.log` holds
   the plugin's start, the editor service's start and no error from the plugin, and the stub can record which routes
   the service read. This proves loading and connection, not what is drawn. It needs the trial or a license, like the
   captures.
2. **The IntelliJ Platform's integration test framework**: the IDE Starter with the Driver API, which the
   IntelliJ Platform Gradle plugin exposes as `TestFrameworkType.Starter` (present in the 2.19.0 the build uses). It
   downloads an IDE, installs the plugin,
   opens a project and asserts on UI components (tool windows, editor text, popups) rather than pixels. This is the
   framework JetBrains documents for UI tests. It brings its own IDE download, the same license constraint, and a
   run of several minutes.
3. **Pixels.** Comparing the captures with references. Fonts, hints and timing make this brittle; not recommended.

The license is the real cost. A trial is one per IDE version per machine for 30 days; a runner that is a fresh
machine every time could claim one on each run, which is not what the trial is for, and a persistent runner runs out
after a month. The proper way is a license in the workflow's secrets (a key, or a license server): JetBrains grants
free licenses to open-source projects, and whether a fair-source project (FSL-1.1-MIT) qualifies is not established.
Until a license exists, a real-IDE check is a job run by hand or nightly on a machine someone activates, not a check
on every pull request.

## 7. Decisions

| # | Decision |
|---|----------|
| D1 | **No continuous check in the real editors for now.** The three pipelines stay what they are: the way to recapture the illustrations, documented in `apps/docs/AGENTS.md` (Marketing screenshots), `apps/vscode/AGENTS.md` and `apps/jetbrains/AGENTS.md` (Screenshots), and run by hand before a release that changes what the editors show. |
| D2 | **The plugins' verification stays in-process**: the editor service's unit tests, VS Code's unit and integration suites, the JetBrains platform tests. A change to what an editor draws is checked by recapturing and looking. |
| D3 | **When a real-editor check is wanted, VS Code comes first**, as a Playwright suite over the screenshot launcher, nightly rather than per pull request. The JetBrains IDEs follow through the Starter framework once a license for CI exists. |
| D4 | **The facts above are the reference** for anyone touching the pipelines; a finding that changes (a property renamed, a dialog moved) is corrected here and in the script's header together. |

## Not in this plan

- Uploading the Marketplace screenshots automatically (the JetBrains Marketplace and the Chrome Web Store take them
  through their listing editors; whether their APIs take screenshots was not checked).
- Capturing in IntelliJ IDEA Ultimate or Rider: the plugin is the same, and WebStorm is the product most of its users
  run.
- Capturing in the Firefox build of the extension: the images are the same page, and the stores accept the same
  sizes.

## Open questions

- A license for CI: which kind (key or license server), from which programme, and where it is kept.
- Whether the Starter framework runs in the 2024.1 the Gradle build targets or needs the build's platform version
  raised.
- Whether the VS Code suite should drive the stable `@vscode/test-electron` download or the Insiders build the
  Marketplace's users will run first.
