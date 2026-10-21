# Desktop run progress (taskbar, Dock & tray)

A proposal to surface a live local test run's progress on the OS shell itself — the Windows taskbar button, the macOS
Dock icon, and the tray — so a run can be watched without the dashboard window open. It records what already exists,
what each native surface can and cannot show, and a staged design that starts as wiring and ends with the
platform-native flourishes.

**Status.** Shipping. Tiers 1–2 and most of tier 3 have landed: the `desktop_set_run_progress` command drives the
taskbar/Dock progress bar, the window title and the composed tray tooltip; a tray status dot and (Windows) a taskbar
overlay icon show run state; and a Windows taskbar thumbnail toolbar adds Stop/Open buttons under the thumbnail. The
dashboard aggregates its active runs and feeds the shell, showing progress whenever a run is active and flashing the
outcome (green pass / red fail) before clearing.
Still open: the live run menu in the tray (rollout step 3), the progress scenario of the ambient-state E2E test
(step 5), the optional Rerun thumbnail button, and the **in-place progress toast** (tier 3):
it duplicates the completion notifications that already exist, and its Windows AUMID/WinRT behaviour has to be validated
on a real desktop, so it is deferred rather than written blind. The Rust and front-end are unit-tested and compile for
both the native and the Windows target; the native *rendering* — bar colours, the status dot, the overlay icon, and the
thumb-button icons and their click handling (COM + a window subclass) — is compile-verified only and still needs a
visual/functional pass on Windows and macOS. Nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet. The design below is
the original text.

**Summary.** A "run" in the desktop shell is a local Playwright execution (`desktop_run_local_tests`, plus reproduce
and bisect), spawned via the bundled Node sidecar and streamed back as `piwi:local-run` events. The front end already
turns that stream into live progress — `progressDone` / `progressTotal` parsed from Playwright's list reporter, the
reproduce/bisect `phase`, the bisect step estimate, and a ready-made label from `localRunProgressLabel()`. The shell
already drives *ambient* native state from the webview through one Rust command, `desktop_set_activity` (a Dock/taskbar
badge count plus the tray tooltip). The missing piece is feeding run progress to the OS the same way: Tauri v2's
`set_progress_bar` fills the taskbar/Dock; the tray becomes the home for the *window-closed* case; and terminal state
maps to an overlay icon and the notifications that already fire. The work is one small Rust command mirroring
`desktop_set_activity` and one client watcher mirroring `installNativeNotifications` — not new instrumentation.

## What already exists

| Piece | Where | What it gives us |
|---|---|---|
| Local run stream | `runner.rs` (`RUN_EVENT`, `desktop_run_local_tests`), `LocalRuns::active_count` | one process per step, stdout/stderr/exit/phase/bisect events under a per-step id |
| Live fraction | `useDesktopLocalRuns.ts:115-118`, `:255-262` | `progressTotal` / `progressDone` parsed from `Running N tests using M workers` and per-test result marks, clamped to the announced total |
| Detail string | `useDesktopLocalRuns.ts:135-146` (`localRunProgressLabel`) | `"Running 7/12…"`, `"Step 2 of ~5 — a1b2c3d — testing…"`, `"Installing…"`, `"Checking out…"` |
| Active count | `useDesktopLocalRuns.ts:222` (`activeCount`) | how many runs are in flight, for aggregation |
| Terminal state | `LocalRunStatus` = `running \| passed \| failed \| stopped \| error` | the color/overlay decision at the end |
| Native bridge pattern | `lib.rs:145-164` (`desktop_set_activity`) | Rust command the webview invokes; sets Dock/taskbar **badge** (`set_badge_count`) and the **tray tooltip** |
| The tray | `lib.rs:1175` | persistent icon, tooltip, menu, left-click-opens — survives the window closing |
| Run-in-background | `lib.rs:1297-1301` | window can close while the server *and* runs keep going, leaving only the tray |
| Completion notifications | `useDesktopLocalRuns.ts:494-512`, `desktop.client.ts:169-215` | native OS notification + unread badge already fire when the window is hidden/unfocused |

So the run already knows its own progress and the shell already knows how to render ambient native state from it. This
proposal joins the two.

## The surfaces

### Taskbar / Dock progress bar — `set_progress_bar`

Tauri v2 (we are on `tauri = "2"`, `Cargo.toml:23`) exposes `WebviewWindow::set_progress_bar(ProgressBarState { status,
progress })`, `status ∈ { None, Normal, Indeterminate, Paused, Error }`, `progress` 0–100:

- **Windows** — fills the app's taskbar button (`ITaskbarList3::SetProgressValue/State`). `Normal` is green, `Error`
  red, `Paused` yellow, `Indeterminate` a marquee — the last is the honest state for the `install` / `checkout` /
  early phases where no count exists yet, switching to a determinate fraction once `progressTotal` is known.
- **macOS** — renders across the Dock icon. The determinate fraction is the reliable, cross-platform mode here; the
  color/`Paused`/`Error`/`Indeterminate` variants are a Windows strength and may not render distinctly on the Dock (an
  open question below).
- **Linux** — Unity launcher only, and Linux is deferred (`apps/desktop/AGENTS.md`).

**The load-bearing caveat for "without the window open":** on Windows the taskbar *button* exists only while a window
does. **Minimized is fine** — the button stays and the bar shows. But "Run in background" hides to the tray
(`lib.rs:1297-1301`), and then there is no button to fill. macOS keeps the Dock icon regardless. So the bar covers the
minimized case; the tray covers the fully-hidden case.

### The tray — the home for the window-closed case

Because the taskbar button can be absent, the tray icon (`lib.rs:1175`) is the real surface for headless watching, and
the richest one:

- **Live tooltip** — extend the existing `set_tooltip` from unread-count to the run label: `"Piwi — Running 7/12 ·
  web"`. Cheapest detail line, both OSes, works with no window.
- **Dynamic tray icon** — swap the image per state (idle / running / passed / failed) via `set_icon`, or render a small
  **progress ring** PNG each tick. An at-a-glance bar with no window at all.
- **Live tray menu** — regenerate the menu to list active runs (`"▶ web — 7/12"`) with a `Stop` item; we already own
  the menu and `stopRun` → `desktop_stop_local_tests`.

### Detail text (the bar carries none)

Neither the taskbar bar nor the Dock bar shows text. "With details" comes from the surfaces around it:

- **Window title** → `"▶ 7/12 · Piwi Dashboard"`. On Windows, hovering the taskbar button shows a thumbnail *and the
  title*, so the title is effectively the button's detail popup.
- **Tray tooltip** (above).
- **Overlay icon** — Windows `set_overlay_icon`: a corner badge on the button (spinner while running, ✓/✗ at the end).
  The macOS analog is the Dock badge we already drive with `set_badge_count`; macOS also supports a short text badge
  label, so `"7/12"` is possible there.

### Terminal state & notifications

At the end, map status → a brief `Normal` full bar (pass) or `Error` red bar (fail), an overlay ✓/✗ on Windows, then
clear after a few seconds. Completion notifications already fire when the window is hidden/unfocused
(`useDesktopLocalRuns.ts:494-512`); nothing new is needed there. A live, in-place **progress toast** (a Windows
notification whose bar advances as the run does) is a think-large option in the native tier below.

## Design

Mirror the shape that already works for ambient state.

**Rust — one command beside `desktop_set_activity`:**

```
desktop_set_run_progress(state, fraction, label)
```

where `state ∈ { none, indeterminate, normal, error, paused }`, `fraction: Option<f64>` (0–1), `label: Option<String>`.
It runs on the main thread (as `desktop_set_activity` does) and, in one call, updates every surface atomically:
`window.set_progress_bar(...)`, `window.set_title(...)`, `tray.set_tooltip(...)`, and — on Windows — `set_overlay_icon`
at terminal state. `state = none` clears all of it.

**Front end — a client watcher mirroring `installNativeNotifications`** (`desktop.client.ts:169`): watch
`useDesktopLocalRuns().runs`, derive the aggregate fraction and reuse `localRunProgressLabel`, and invoke the command
(debounced) on change. Clear on window `focus` and when `activeCount` hits 0 — the exact pattern the unread badge
already uses (`desktop.client.ts:172-176`).

**Aggregating concurrent runs onto one bar** (a window has exactly one): `done = Σ progressDone`, `total = Σ
progressTotal`; `Indeterminate` if any active run is in a countless phase (`install` / `checkout` / `bisect`); the bar
is otherwise the summed fraction. State-to-surface mapping:

| Run state | Bar | Tray tooltip | Overlay (Win) |
|---|---|---|---|
| running, count known | `Normal`, fraction | `Running 7/12 · web` | spinner |
| running, countless phase | `Indeterminate` | `Installing… · web` | spinner |
| all passed | `Normal` 100 → clear after ~3s | `Last run passed` | ✓ |
| any failed (none running) | `Error` → clear after ~5s | `Last run failed` | ✗ |
| stopped / none active | `None` (clear) | idle (open hint) | none |

**ACL.** The webview only ever invokes our own `desktop_*` command, and the window/tray mutations happen in Rust —
exactly how `set_badge_count` works today with no `core:window` grant in `capabilities/default.json`. Keeping this a
Rust command (rather than calling `setProgressBar` from JS, which would need `core:window:allow-set-progress-bar`)
avoids widening the ACL surface and keeps the multi-surface update in one place.

## Platform matrix

| Surface | Windows | macOS | Linux |
|---|---|---|---|
| Determinate bar (`set_progress_bar`) | taskbar button | Dock icon | Unity only (deferred) |
| Indeterminate / color / paused-error states | yes | fraction only (verify) | — |
| Overlay icon | `set_overlay_icon` | Dock badge (`set_badge_count`) / text label | — |
| Works while minimized | yes | yes | — |
| Works while hidden to tray | no button → **tray** | Dock persists | — |
| Thumbnail toolbar buttons / in-place progress toast | `windows-rs` (native tier) | — | — |

## Compatibility and degradation

- **Web build untouched.** The watcher installs only when the bridge is present (`tauriCore()` truthy), the same guard
  `desktop.client.ts` already uses; a plain browser at the loopback URL has no bridge.
- **No window on Windows.** Lead the UX on the tray, treat the taskbar bar as the bonus for the minimized case; never
  assume a button exists.
- **Aux windows** (`desktop_open_window` — trace viewer, attachments) are not the run's home; progress lives on `main`.
- **Focus clears it.** Once the user is looking at the app, the in-app runs tray is the detailed view; the OS surfaces
  reset, matching the unread-badge policy.

## Alternatives considered

1. **In-app only** (the runs tray already shows all of this). Rejected: the entire ask is *without the window open*.
2. **Completion notification only** (already shipped). Keeps its place, but a one-shot toast at the end is not "keep an
   eye on a run" — no live signal while it runs.
3. **Drive `setProgressBar` from JS directly.** Rejected: needs a new `core:window` ACL entry and splits the
   bar/title/tooltip/overlay updates across the boundary; a single Rust command matches `desktop_set_activity` and
   updates every surface together.
4. **Animated tray icon instead of the OS bar.** Rejected as the *primary* surface — it misses the literal taskbar/Dock
   affordance users expect and that Tauri gives us for free. It is worth having *as well*, for the tray-only case.

## Open questions

- **macOS indeterminate.** Confirm what the Dock renders for `Indeterminate` / `Paused` / `Error`; if it shows nothing,
  fall back to a slow determinate sweep for countless phases on macOS.
- **Aggregation semantics.** One bar, many runs: summed fraction vs. most-recent run vs. worst-state-wins. Summed is
  proposed; revisit if concurrent runs of very different sizes feel wrong.
- **Tray icon: animate or swap?** A rendered progress ring per tick is the most informative; discrete state icons are
  cheaper. Decide on polish vs. cost.
- **Retain-on-complete duration.** How long the pass/fail bar lingers before clearing, so it is not gone before it is
  seen.
- **When to show at all.** Always, or only when the window is hidden/unfocused/minimized (the policy the unread badge
  already follows)? Showing a bar under a window the user is actively watching may be noise.

## Rollout sketch

1. **Rust command** — `desktop_set_run_progress` (bar + title + tooltip; Windows overlay), with a unit-tested
   state→`ProgressBarStatus` mapping. No front-end change required to land it.
2. **Client watcher** — the composable/plugin mirroring `installNativeNotifications`: derive the aggregate + label,
   invoke debounced, clear on focus / no active runs.
3. **Tray enrichment** — dynamic icon and a live run menu (the tray-only surface for the hidden-window case).
4. **Native tier (Windows, `windows-rs`)** — thumbnail toolbar buttons (Stop / Open / Rerun) and an in-place progress
   toast, behind `#[cfg(windows)]`; not required for a solid v1.
5. **E2E** — extend the ambient-state smoke test (`apps/application/tests/desktop-ambient.spec.ts`) with a progress
   scenario asserting the command is invoked as a run advances and cleared when it ends.
