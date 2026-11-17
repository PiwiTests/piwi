# One Record button for scenarios and bug reports

**Status.** Proposed 2026-11-17 and being built on the branch that adds it. Every step of the delivery plan below is
planned for that branch.

**Summary.** Piwi Picker's popup had two tiles that start the same recorder: **Record actions** and **Report a bug**.
They differ only by the tools of their bar and by what their last panel exports, and each lacks what the other has.
This record merges them into one **Record** tile, one bar and one finish panel. Every recording collects the evidence a
bug report needs, and a recording becomes a bug report only through what the person marks as wrong.

## Why

What each mode offered before this change:

| | Record actions | Report a bug |
| --- | --- | --- |
| Capture (clicks, fills, navigation across pages) | the same recorder | the same recorder |
| Pause | yes | no |
| Checks that pass (Check an element, Check the address) | yes | no: Mark what's wrong refuses the value the page shows |
| Anomalies (Mark what's wrong, Something is missing, Wrong page) | no | yes |
| The project's test functions, in the bar and in the code | yes | no |
| The code | a plain test | a `test.fail()` test tagged `@bug` |
| Send to editor | yes | no |
| The window's size (`setViewportSize` in the code) | no | yes |
| Evidence (console, failed requests, screenshots, one per step) | no | yes |
| Markdown report, `.piwibug`, Send to Piwi | no | yes |

- **Testers used Report a bug to prepare scenarios**, for its evidence and step screenshots, and got a test marked to
  fail, with no check that passes, no test function and no way to the editor.
- **Report a bug frightened people**: in a browser extension's menu it reads as reporting a bug to the extension's
  authors, the tile is red, the toolbar badge says `BUG`, and in Chrome the debugging banner appears as it starts.
- **A recording of actions ran at Playwright's default viewport**, whatever the size it was recorded at: a responsive
  page recorded on a wide screen could fail on its narrow layout.
- **The bars wrap text where they should not**: the title breaks between the count and its noun, and in French two of
  the bug bar's buttons hold their label on two lines.

## Decisions

1. **One tile, Record**, with the line "A scenario, or a bug with its evidence". The red tile and the `BUG` badge go.
   Replay a bug report becomes **Replay a recording**, which it already was.
2. **Every recording of the extension collects evidence**, as a bug recording did: the debugging protocol in Chrome and
   Edge from the start (its banner is expected, and the bar says why), the main-world evidence script elsewhere and
   once the session is lost, the viewport, and a screenshot of each step. The IDE bundle is unchanged: no evidence, no
   finish panel.
3. **One bar**: the last steps, **Check an element**, **Check the address**, **Something is missing**, **Screenshot**
   (while the debugging protocol takes them), **Pause** and **Finish**, the matching test functions when connected, and
   the evidence lines.
4. **Check an element absorbs Mark what's wrong, and Check the address absorbs Wrong page.** The dialog starts from what
   the page shows. Keeping it records a check that passes; changing it records an anomaly, which keeps what the page
   showed (`actual`). The dialog says which of the two Add will record before it is pressed. A state check offers the
   element's current states (a check) and their opposites (an anomaly).
5. **One finish panel**, its first action following what was recorded: **Copy test** without an anomaly, **Copy failing
   test** with one (`renderBugSpec`). Then Send to editor (when paired), Replay, Copy report, Download the `.piwibug`,
   Send to Piwi… (when connected) and Discard. The test functions apply to the copied code in both cases.
6. **The steps file download goes.** The `.piwibug` holds `steps.json`, and Replay, the desktop app and the instance
   read it. The steps format stays: Send to editor, the desktop app's runs, the instance's Steps export and Replay's
   chooser keep using it, and the chooser still opens a `.json`.
7. **The popup gets out of the permission prompt's way.** When the site is not granted yet, the popup closes right after
   the request, inside the click, and the worker starts the recording when the grant lands (`RecordIntent`, already
   there for a prompt that closes the popup). A refusal fires no event, so nothing can reopen the popup; the next popup
   on that tab says the recording did not start because the site was not allowed.
8. **The DevTools Record tab** finishes a recording through the page, as the popup does, and copies the same test as the
   finish panel. It loses Download steps.

## Layout rules for the bars

- **No label wraps inside a button.** Buttons keep their label on one line (`white-space: nowrap`), and a row of buttons
  wraps between buttons.
- **A count stays with its noun**: the bar's title has its row to itself, beside the move button only.
- **Checked by a spec** in English, French and German, at the bar's width: no button whose label takes two lines.

## Delivery plan

1. **Storage and worker**: `RecordingState.mode` and `RecordIntent.mode` go; every recording gets its evidence token,
   its evidence script, its debugging session and its step screenshots; the badge is `REC` alone.
2. **The bar and the check dialogs** (`record-panel.ts`, `bug-panel.ts`, `check-panel.ts`).
3. **The finish panel** (`bug-panel.ts`), the `.piwibug` (its spec follows decision 5), Replay's chooser, and the
   DevTools Record tab.
4. **The popup**: the tiles, their keys, the screenshot tile during a recording, and the permission prompt.
5. **Catalogs** in the five languages, and the store listings.
6. **Docs and texts**: the docs pages of the extension, the dashboard's texts naming Report a bug, `ARCHITECTURE.md`
   and `AGENTS.md`.
7. **Tests**: unit and end-to-end specs of the recorder, the bug report, the popup, the permission intent, Replay and
   DevTools, and a layout check of the bar.
