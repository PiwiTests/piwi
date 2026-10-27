# Findings of the agent guide review

The agent guides were rewritten and then checked claim by claim against the code, first by area and then by an
adversarial review of the whole branch. The review fixed every statement that was wrong. It also found behavior in the
code that looks wrong, untested or inconsistent, and left it as it was, because each fix changes what a user sees, needs
a decision, or deserves its own pull request. This proposal keeps that list so the items can be picked up one by one.

Each finding says what happens, where, and the fix the review suggested. A finding names functions and files rather than
line numbers, which move.

**Status.** Proposed 2026-10-27, from the review of the agent guide restructuring. F1, F3, F4, F5 and F21 are fixed
and their entries removed; the others are open. The findings are independent: each can ship alone, in any order, and
close its line here.

## Bugs

### F2. A failed read during an editor refresh empties what the service held

- **What happens:** when the instance does not answer during `PiwiContext.refresh`, the code index becomes `null` and
  the function catalog and the vocabulary stay empty until the next refresh. Quick fixes and completion lose them for
  that time.
- **Where:** `packages/editor/src/context.ts`, `refresh` clears `functions` and `words` before reading and sets
  `codeIndex` from a read that answers `null` on a failure. `refreshCodeIndex` in the same file keeps the old index on a
  failure: the two paths disagree.
- **Fix:** keep the previous value when a read fails, in both paths, and test it with a stub instance that fails one
  read.

### F6. A recording's append can bring back a stopped recording (to confirm)

- **What happens (read in the code, not reproduced):** an append that reads the recording before `stopRecording` writes
  `active: false`, and writes after it, sets `active: true` back.
- **Where:** `apps/extension/src/shared/recording-storage.ts`: `startRecording`, `stopRecording` and
  `discardRecording` write the state outside the queue that `appendRecordingEvent` and `updateRecording` share.
- **Fix:** reproduce it with a spec that stops a recording while a click is being recorded; if it happens, send the
  three writes through the same queue.

## Behavior to align

### F7. The VS Code extension reads everything again on `piwi/statusChanged`

- **What happens:** the notification carries the whole new status, but the extension ignores it and reads the status,
  the run status, the failures, the coverage and the MCP servers again.
- **Where:** `apps/vscode/src/extension.ts`, `lc.onNotification(STATUS_NOTIFICATION, () => void updateStatus())`. The
  JetBrains plugin keeps the payload (`PiwiProjectService.statusChanged`).
- **Fix:** pass the payload to `updateStatus` and read only what depends on a changed field. The VS Code and editor
  guides then go back to "a client keeps what the service pushes".

### F8. Optional protocol fields the service always sends

- **What happens:** `failingTests`, `resolved`, `overlays`, `baseline` and `branches` of `piwi/runStatus` are optional
  in `packages/editor/src/protocol.ts` (and nullable in `Protocol.kt`), but the service always sends them, so client
  fallbacks such as `run.failingTests ?? r.failedTests` never run. `piwi.copyText` is a `PiwiCommand.command` the
  service never sends.
- **Fix:** make the always-sent fields required, remove the dead fallbacks in both clients, and remove `piwi.copyText`
  from the union, or document why it stays.

### F9. Text copied without `useCopy`

- **What happens:** three components copy text with `navigator.clipboard` directly, so they show no copied state and no
  toast: `app/components/gaps/GapsPanel.vue`, `app/components/analytics/DashboardBody.vue` and
  `app/pages/projects/[id]/test-functions.vue` (all under `apps/application/`).
- **Fix:** move them to `useCopy({ toast })`. `useCopy` swallows errors, so the error toast of `test-functions.vue`
  needs its own handling.

### F10. Two extension requests skip the connection health

- **What happens:** `fetchBugReportIntake` (`apps/extension/src/background/bug-reports.ts`) and
  `fetchBugReportStepShot` (`step-views.ts`) do not go through `withConnectionHealth`, so their failures do not show in
  the popup's connection line. Both catch their own errors, which may be intended.
- **Fix:** decide, then either wrap them or say in the guide why they are left out.

### F11. The JetBrains chords collide with some keymaps

- **What happens:** `Ctrl+Alt+Shift+R`, `F` and `K` are free in VS Code, but bundled JetBrains plugins and keymaps use
  some of them: the Kotlin plugin (`R`, `K`), the macOS keymap (`Cmd+Alt+Shift+R`, Force Refresh), and the Visual Studio,
  ReSharper and Xcode keymaps preinstalled in Rider. The list is in `apps/vscode/ARCHITECTURE.md`, "Keybindings".
- **Fix:** a product decision: keep the chords and document the conflicts in the docs page, or pick chords free in
  every bundled keymap.

## Tests and tooling

### F12. Rules with no test

- The blob-id guard of `packages/editor/src/workspace.ts` (`BLOB`): add `blobText(repo, '--output=x')` → `null`.
- The JetBrains `K` chord (`Piwi.RunTestAtCursor`): `PiwiPluginTest` checks only `R` and `F`.
- One undo step per recording in VS Code: only the JetBrains plugin has `PiwiRecordingTest`.
- `piwi-client.test.ts` (extension) catches a content script importing `piwi-client.js` directly, but not through a
  shared module.
- The tool names, commands and flags the skills under `packages/reporter/templates/skills/` name: a rename breaks the
  skills installed in users' projects without failing a test.

### F13. Hard-coded browser path in the reporter's integration suite

- **Where:** `packages/reporter/tests/integration/playwright.config.ts` launches `/opt/pw-browsers/chromium`, so
  `npm run reporter:test:integration` fails outside that sandbox.
- **Fix:** read `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, else use Playwright's own download, as the dashboard's scripts do.

### F14. The guides' CI path filter is kept by hand

- **What happens:** the `Agent guides` job of `ci.yml` runs on the paths of its `guides` filter. A future guide link
  into a folder no filter covers (`apps/jetbrains/`, `integrations/`, `examples/`, `.claude/`) would break without
  failing the pull request that breaks it.
- **Fix:** in `agent-guides.test.ts`, check that every link target matches a pattern of the `js` or `guides` filter
  read from `ci.yml`. It needs `yaml` and `picomatch` as devDependencies of the dashboard.

### F15. `generate-llms.mjs` keeps its own list of generated pages

- **Where:** `apps/docs/scripts/generate-llms.mjs` (`GENERATED`) repeats `apps/application/shared/docs-generated-pages.ts`.
- **Fix:** read the shared list, through the same jiti alias the other generators use.

## Release tooling

### F16. `release-notes.yml` breaks the CI conventions

- It sets `permissions: contents: write` for the whole workflow, its steps have no `name`, and it installs Node with
  `actions/setup-node` and `node-version: 24` instead of `setup-workspace` and `.node-version`
  (`.github/AGENTS.md`). Its comment says it skips a release with hand-written notes, but `cmdApply` replaces a
  polished body when the new notes are polished too.
- **Fix:** move the write permission to the job, name the steps, use `setup-workspace`, and correct the comment.
  actionlint is the only check a change to it gets before merging.

### F17. Release artifacts without an expiry

- Six uploads keep the repository default: four in `reusable-publish-extension.yml`, one in
  `reusable-publish-jetbrains.yml` and one in `reusable-publish-vscode.yml`.
- **Fix:** give them a `retention-days`, or record them in `.github/AGENTS.md` as kept on purpose (store packages for an
  upload by hand).

### F18. `release-notes.mjs apply` can skip the changelog or its own guard

- It writes the release body before `CHANGELOG.md`, so a failing `gh release edit` leaves the changelog unwritten. It
  also treats any failure of `gh release view` as "no body", which skips the guard that protects hand-written notes.
- **Fix:** write `CHANGELOG.md` first, and stop on a `gh release view` failure that is not "release not found".

## Records

### F19. ADR `editor-local-runs.md` D8 describes a protocol that no longer exists

- D8 says "a published client talks to an older service and the other way round". Each client now bundles the service
  of its own commit and the protocol changes in one step (`packages/editor/ARCHITECTURE.md`, "Clients and versions").
- **Fix:** a new ADR that supersedes D8, as [`adr/AGENTS.md`](../adr/AGENTS.md) requires, rather than an edit of the
  accepted record.

### F20. The npm package descriptions do not carry the positioning line

- The root guide says eight surfaces carry the positioning line. The `description` of
  `packages/reporter/package.json` does not carry it, and the one of `packages/server/package.json` paraphrases it.
- **Fix:** align them, or state in the root guide that the npm descriptions carry a short form, and which one.
