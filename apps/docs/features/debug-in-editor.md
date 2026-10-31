---
title: Debug in my editor
description: "From a failure's page in the dashboard, open the failing line in VS Code or a JetBrains IDE and, once you say yes there, run that test headed with one worker to stop at that line, with the locator healing's suggestion outlined on the page."
lang: en-US
---

# Debug in my editor

<Needs reporter fixtures />

On a failed execution's page, **Debug in my editor** takes you from the failure to the same test, stopped at the
failing line in your editor, on your machine. It sits on the **Source** tab, beside the open link of the frame where
the failure enters your code (a page object's line included), in the captured frames and in the full stack alike.

1. Click it. The dashboard hands your editor its [open link](./ide-integration) with `debug=1`: the Piwi plugin of a
   JetBrains IDE, or the Piwi extension in VS Code, Cursor or VSCodium, as your **Open in IDE** method picks
   ([Auto](./ide-integration#auto-the-first-method-that-works) asks the plugin first).
2. The editor opens the failing line, then asks in a notification, never a dialog: **Debug this test here? Piwi runs
   “Checkout › pays” in the Playwright project “chromium”, headed, one worker, and stops at line 16.** Nothing runs
   until you click **Debug**.
3. Piwi runs that test alone, found in its spec by its title, in the Playwright project it failed in, headed, with
   `--workers=1` and your breakpoints, and stops at the failing line. From there the
   [controls](./editor-run-control) apply, and so does [Code from a pause](./editor-stop-code).
4. When the instance holds a [locator healing](./locator-healing) for the failure, the **Locator fix** panel's
   recommended locator is counted on the stopped page and outlined there, and the editor says so:
   **Piwi's suggested locator: getByTestId('pay') (outlined on the page).** While the cursor stays on the stopped line,
   its end says the same, and the outline stays. Without an instance, or a recommendation, the run only stops.

## The stop is the run's alone

The failing line is a breakpoint of that one run, never one of your editor's: your breakpoint list stays as it was.
Once the test stopped there, the run drops it, so a retry, or a later call on that line, runs on. Breakpoints you set
or remove meanwhile apply as in any run, the failing line kept until the stop.

## What a link may ask

A link is anyone's to write, so the editor reads it as data, never as a command:

- The files must be in the window's folders (VS Code) or an open project (JetBrains IDE) once every symbolic link is
  followed, and under a Playwright config's folder: the failing line's a script file, the test's a spec.
- The line and the execution are positive whole numbers. The title and the project are plain text: no control
  character, no `[`, `]`, `<`, `>`, backtick or backslash, and a project name no shell expands. A field named twice
  refuses the link.
- A refused link opens and runs nothing, and says why. The command is built by the editor service from the test it
  finds in your spec, as for every run Piwi starts.

A JetBrains IDE also answers only a page of the instance a project is connected to, or of the desktop app, as for
Open in IDE.

## Limits

- **The test as your spec has it.** The title must name one test of the spec as saved: a test renamed since the run is
  not found, and two of that title in describe blocks the dashboard does not name are refused. A title written with
  `${…}` parts matches with any text in their place, but one made of such parts alone matches nothing; Piwi passes the
  run's title as `--grep` too, so of the tests the line declares, only those whose title holds it run.
- **The line as your file has it.** The failing line is the run's: when the file changed since, the run stops at that
  line's number, or not at all when nothing there stops; a failure before it holds the test, as in any run with
  breakpoints.
- **Piwi's own editor clients.** The `vscode://file` and `jetbrains://` links, and IDE Remote Control, carry no
  `debug=1`. VS Code hands the link to its window focused last.
- **Not on a phone.** The button is hidden below the tablet width.

## Privacy

The link carries the failing file and line, the test's spec and title, its Playwright project and the execution's id,
from your browser to your editor on the same machine: through your operating system (VS Code), or the IDE's built-in
server on `127.0.0.1` (JetBrains). The suggested locator comes from the instance the editor is connected to.

## Related

- [Open in IDE](./ide-integration): the two links this one extends, and the method that picks between them.
- [Pause and step from the editor](./editor-run-control): the controls at the stop.
- [Locator healing](./locator-healing): where the suggested locator comes from.
- [Failure evidence](./evidence): the Source tab and the rest of the failure's page.
