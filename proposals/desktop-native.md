# The desktop app as a desktop app

A review of what the desktop app lacks to behave like a desktop application rather than a server in a window, and a
plan for what it could become once it does. It covers the shell (`apps/desktop/`), the dashboard code that runs only
inside it (`app/plugins/desktop.client.ts`, `app/components/desktop/`), and what Tauri 2.12 offers that the shell does
not use yet.

**Status.** Proposed 2026-11-01, against `main` at v0.63.0 (`11909c0e`). Step 1, the defects filed as
[PiwiTests/piwi#997](https://github.com/PiwiTests/piwi/issues/997), is built: `shut_down` runs on `RunEvent::Exit` too
and the macOS app menu's Quit asks first; the Dock icon brings the hidden window back; on Windows and Linux a
notification click opens what it is about, and on macOS 14 and later the main window is not suspended in the background
(Windows and Linux offer no such policy); the log rotates and the tray shows it; Settings › Storage sets the desktop
app's retention, and its server runs the retention sweep a few minutes after it starts; what the server serves downloads
straight to disk, while a file the page builds (a chart image, a workbook) still crosses IPC. The Rust is unit-tested and the page side
has Playwright specs with a faked bridge, but the macOS menu, the Dock, the background policy and the notification
clicks are compile-checked only and still need a pass on macOS and Windows. Step 2 is built: the windows open where they
were left (`tauri-plugin-window-state`), Cmd/Ctrl +, - and 0 zoom the dashboard (the trace and output windows on Windows
only), a run that fails unseen asks for attention, the machine does not idle-sleep while a local run goes, and the macOS
app menu holds Settings, Import, Back and Forward and the Help items. The tray lists the local runs going, each with
Stop, and Windows and Linux take the menu's keys with Ctrl in the page. Step 3 is built: a `piwi://open/<page>` link
opens that page in the app, starting it if needed, and the shell shows the server's notifications from a stream of its
own (`/api/desktop/notifications`), with the choices the window gives it and an unread count it keeps itself, so they
no longer depend on the page; registering the scheme with each installer and the links on macOS still need a pass on
real installs. Nothing beyond step 3 is built, and nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet.

**Summary.** The shell is strong where Piwi is unique: it runs, reproduces and bisects tests in throwaway worktrees,
hosts Flake Lab, connects MCP clients, opens Playwright archives and bug reports, and shows a run's progress on the
taskbar, the Dock and the tray. What made it feel like a server in a window was the layer around the window. The review
found that once the window was closed the app barely existed: its alerts came from the hidden page and could not be
clicked, the Dock icon did not answer, Cmd+Q skipped the quit cleanup, it had no menu of its own, and nothing outside
the app could link into it. The plan fixes those defects first, adds the conventions a desktop application is expected
to follow, then turns the app into the developer's link to the team instance and a lab that works while they do not.

## What exists

| Piece            | Where                                                     | What it does                                                                                   |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Server sidecar   | `lib.rs` (`spawn_server_process`, `supervise_server`)     | runs the unmodified built server on a loopback port, restarts it after a crash                 |
| Window trust     | `lib.rs` (`health_ok`, `main_window_may_navigate`)        | the window loads only the sidecar this launch spawned, and IPC is granted to its origin only   |
| Local runs       | `runner.rs`, `repro.rs`, `worktree.rs`, `hub_env.rs`      | runs, reproductions, bisects and Flake Lab in the linked folder or a throwaway worktree        |
| Tray             | `lib.rs` (`TrayIconBuilder`)                              | Open, Open data folder, Run in background, Start on login, Quit; tooltip and status dot        |
| Ambient state    | `desktop_set_activity`, `desktop_set_run_progress`        | unread badge, taskbar and Dock progress bar, title, Windows overlay icon and thumbnail buttons |
| Opened files     | `queue_open_files`, `RunEvent::Opened`, file associations | `.zip` archives and `.piwibug` reports from drag and drop, "Open with" or a second launch      |
| Browser hand-off | `server/middleware/desktop-handoff.ts`                    | a dashboard link opened in the browser shows in the window                                     |
| MCP              | `mcp_clients.rs`, `mcp_stdio.rs`                          | one-click connection of seven clients, the stdio bridge for Claude Desktop                     |
| Notifications    | `desktop.client.ts` (`installNativeNotifications`)        | the page's `new Notification()` becomes a native notification                                  |
| Updates          | `updates.rs`, two Windows channels                        | signed in-app updates on every installer, `.deb` and `.rpm` included                           |

## What it lacks

### Defects

As the review found them at v0.63.0, each checked against the code and Tauri's source. Filed as
[#997](https://github.com/PiwiTests/piwi/issues/997), and fixed by step 1:

1. **Cmd+Q, the Dock's Quit and logging out skip `shut_down`.** It runs only on `RunEvent::ExitRequested`, which
   those paths never emit: tao implements `applicationWillTerminate:` but not `applicationShouldTerminate:`, so Tauri
   emits only `RunEvent::Exit` ([tauri-apps/tauri#9198][tauri-9198]). Nothing asks while local runs are going, the
   runs get no grace to report their end, and `~/.piwi/desktop.json` stays behind.
2. **The Dock icon does not bring a hidden window back.** tao answers `applicationShouldHandleReopen:` with the
   visibility it is given, so AppKit does nothing, and the shell has no `RunEvent::Reopen` arm.
3. **Background alerts depend on the hidden page.** `useNotificationStream` holds the `EventSource` that produces them.
   A click never opens what they are about, although the notification plugin reports clicks on the desktop since 2.6.0.
   On macOS, WebKit suspends a hidden view after about five minutes unless `backgroundThrottling` is disabled
   ([tauri-apps/tauri#12181][tauri-12181]), so the alerts likely stop.
4. **`logs/server.log` never rotates**, and gains a line per stored trace and attachment.
5. **Retention cannot be turned on**: `PIWI_RETENTION_DAYS` is read from the environment only, which the sidecar
   inherits from the app's and nothing in the app sets; and the nightly sweep runs at 03:17, when a desktop app is
   rarely open.
6. **Downloads cross IPC as one base64 string**: about five times the file in memory, and a failure above about 402 MB
   on Windows, where V8 caps a string at 536,870,888 characters.

### Conventions

What a desktop application is expected to do, by surface. Each line names the Tauri mechanism.

- **Menus and keyboard.**
  - A macOS app menu with Piwi's commands: Import report (⌘O), New window (⌘N), Settings (⌘,), Back and Forward
    (⌘[ and ⌘]), Re-run failed, Stop runs, Show logs, Check for updates, the docs. On Windows and Linux the same
    shortcuts work in the page, without a menu bar.
  - Native context menus on a test, a run or a file: Re-run, Open in IDE, Copy locator, Reveal in Finder (`Menu`,
    `menu.popup()`).
  - Zoom: `zoomHotkeysEnabled` is off, so ⌘+ and Ctrl+ do nothing on any platform.
- **Windows that remember.** Only the main window's maximized state is saved; trace and output windows open at a fixed
  size (`tauri-plugin-window-state`). On macOS, native tabs (`tabbingIdentifier`) and a title bar merged into the
  sidebar (`titleBarStyle: "Overlay"`, `trafficLightPosition`).
- **Presence with the window closed.**
  - A live tray menu listing the running runs with Stop: step 3 of [desktop-run-progress.md](desktop-run-progress.md).
  - A menubar-only mode on macOS while running in the background (`set_dock_visibility`, 2.5).
  - A Dock bounce or a taskbar flash when a run fails unseen (`request_user_attention`).
  - The machine kept awake during a bisect or a lab session (the `keepawake` crate).
- **Links into the app.** A `piwi://` scheme (`tauri-plugin-deep-link`, with single-instance's `deep-link` feature),
  so a Slack alert, an email, a pull-request comment or a terminal opens the page. A Dock menu and a Jump List have no
  Tauri API ([tauri-apps/tauri#9916][tauri-9916], [#14699][tauri-14699]): native code, `windows-rs` already in use.
- **Files.** Dragging a trace, a screenshot or a `.piwibug` out of the window into Slack or a tracker
  (`tauri-plugin-drag`); Save As rather than always Downloads.
- **Care for the data.** Back up and restore while the app runs (the docs say to copy the folder with the app closed),
  choose the data folder, set the retention, keep `secret.key` and the token in the OS keychain (the `keyring` crate;
  Tauri's Stronghold plugin is deprecated). The keychain changes the backup instructions and needs a migration.
- **Trust and reach.** The installers are unsigned, so every first launch meets Gatekeeper's Open Anyway or
  SmartScreen: a Developer ID with notarization, and Azure Artifact Signing through `bundle.windows.signCommand`.
  Homebrew cask, winget and Scoop manifests. Windows ARM64 and Linux ARM64 builds: only x86-64 Windows and Linux and
  Apple-silicon macOS ship today.

## Further

Each direction says what it serves among the four aims of [`ROADMAP.md`](../ROADMAP.md) and what is hard.

### The team's CI on the developer's desk

The app knows only its own server; the editor extensions carry team-instance failures to it. The app could follow the
team instance directly: the tray shows the developer's branches and pull requests, the failing tests they own
(CODEOWNERS) and their clusters, and alerts open the page. **Reproduce on my machine** on a CI failure, in the team's
web UI or a Slack alert, becomes a `piwi://` link that creates the reproduction request the window already asks about
(`desktop-repro.ts`), as the editors' requests do. **Send to the team** uploads a local run or a reproduction through
the team instance's import. Serves _explain the failures_ and _hand back a fix_.

Hard: today the app never holds a team key, by the docs' own words. It needs a key scoped to reading, kept in the OS
keychain, an explicit consent, and deep links that either only open a page or ask in the window first.

### Ask Piwi from anywhere

A global shortcut opens a small search panel over any application: tests, runs, clusters. With a Playwright error copied
from a CI log or a chat, the panel reads the clipboard once and answers _known: cluster #42, flaky since Tuesday, owned
by X, fix plan ready_. `computeErrorFingerprint(rawError)` (`shared/error-fingerprint.ts`) already computes the
fingerprint clusters are keyed by, so the server side is one endpoint. Tauri: `tauri-plugin-global-shortcut` (X11 only
on Linux), `tauri-plugin-clipboard-manager`, `tauri-nspanel` for a Spotlight-style panel on macOS. Serves _explain the
failures_.

### The tray as a control panel

A popover under the tray icon (`tauri-plugin-positioner`): the running runs with pause, step and stop, which the run hub
already supports, the last result of each linked project, the failure inbox, Re-run failed. Beside it, a small
always-on-top window with the live view of the test a headless run is on, to watch it while coding. Linux trays report
no clicks under Tauri's `libappindicator` backend, so they keep the menu.

### A lab that works while the developer does not

Flake Lab sessions and bisects queued for idle time or the night, only on mains power, with the machine kept awake, and
a summary notification in the morning. The runs exist; the scheduler, the idle and power checks are new. Serves
_explain the failures_. Running the team instance's flake plans unattended would break the rule that the app runs
nothing until someone starts it, so it waits for a trust design.

### Setup that disappears

When a run reports from a folder no project is linked to, the window offers to link it: the reporter knows its config
folder and would send it to the desktop app only. Linked folders are watched (`tauri-plugin-fs` `watch`): a saved spec
re-runs what changed (`playwright test --only-changed`), and a run made without the reporter is imported as its
`blob-report/` appears. It overlaps the editor extensions, and serves the people outside VS Code and the JetBrains IDEs.

### The operating system as a surface

Quick Look previews of `.piwibug` files and trace archives, Spotlight and Windows Search entries for tests and
clusters, a desktop widget with a suite's health. Each needs a native extension outside Tauri (Swift, a Windows widget
provider), so they come last.

### Not proposed: a mobile app

Tauri 2 targets iOS and Android, but neither the Node sidecar nor Playwright runs there, so a phone app would be a thin
client of a team instance, which a progressive web app covers. Push notifications would need an APNs or FCM relay, at
odds with zero telemetry.

## What Tauri offers

Tauri 2.12.5, as locked. Versions name the release that added an API.

| Capability                                                       | Used           | What it gives Piwi                                                      |
| ---------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| Notification `on_action` (plugin 2.6, 2.7 locked)                | yes, clicks    | click-to-open, Open and Re-run buttons (Windows: while the toast shows) |
| `backgroundThrottling` (2.3, macOS 14+)                          | yes            | the hidden window keeps working                                         |
| `tauri-plugin-deep-link`                                         | yes            | `piwi://` links (macOS: the bundle installed in `/Applications` only)   |
| `tauri-plugin-global-shortcut`, `tauri-plugin-clipboard-manager` | no             | the quick lookup; images copied to the clipboard                        |
| `tauri-plugin-window-state`, `tauri-plugin-positioner`           | window-state   | remembered windows; the tray popover                                    |
| `tauri-plugin-fs` `watch`, `tauri-plugin-log` rotation           | no             | watched folders; a log that rotates                                     |
| App and context menus, `zoomHotkeysEnabled`                      | app menu, zoom | menus, right-click, zoom                                                |
| `set_dock_visibility` (2.5), `request_user_attention`            | attention      | menubar-only background mode; a bounce or a flash on failure            |
| `on_download`, `on_new_window` (2.8)                             | no             | native downloads and windows                                            |
| Mica, vibrancy, Liquid Glass (2.12), title bar overlay, tabs     | no             | each platform's look                                                    |
| Several webviews in one window                                   | no             | a trace beside its run; still behind `unstable`                         |
| `keyring`, `tauri-plugin-drag`, `tauri-nspanel`, `keepawake`     | keepawake      | keychain, drag-out, panels, no sleep mid-run (community crates)         |
| Dock menu, Jump List                                             | —              | no Tauri API: native code                                               |

Checked and not missing: `.deb` and `.rpm` installs update in place (the release's `latest.json` lists both, supported
since the updater plugin 2.10), and `git` and Homebrew's tools are found from a Finder launch (`run_path_env`).

## Rollout

1. **The defects of #997.** Exit cleanup on every path, a Cmd+Q that asks, the Dock reopening the window, clickable
   notifications and a window macOS does not suspend, a rotating log, a retention setting, downloads the shell writes.
2. **Conventions, cheap ones first.** Zoom, window state, `request_user_attention`, keeping the machine awake during a
   bisect or a lab session, the app menu, the live tray menu.
3. **Links and alerts the shell owns.** `piwi://`, and notifications read by the shell from the server's stream, so
   they no longer depend on the page.
4. **Trust and reach.** Signing and notarization, package-manager manifests, ARM64 builds.
5. **The quick lookup and the team companion**, then the lab schedule and the watched folders.

## Open questions

- **A team key in the app.** Read-only scope and the keychain may be enough, or the editor may stay the only broker.
- **Notification clicks on macOS.** The notification plugin reports clicks only by holding a thread and a main-loop
  timer for each notification until it leaves Notification Center, which nothing can clear from the app, so clicks stay
  off on macOS. Bounded tracking there needs the plugin, or the shell showing notifications itself.
- **Shell-owned notifications.** The page builds each notification's text from the event; the shell would need the
  same text without a second implementation, so the server may have to send it.
- **The macOS menubar mode.** Hiding the Dock icon in the background is what menubar applications do, but it also
  hides the app from ⌘Tab.

[tauri-9198]: https://github.com/tauri-apps/tauri/issues/9198
[tauri-9916]: https://github.com/tauri-apps/tauri/issues/9916
[tauri-12181]: https://github.com/tauri-apps/tauri/pull/12181
[tauri-14699]: https://github.com/tauri-apps/tauri/issues/14699
