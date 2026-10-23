## Run the failing tests

- **Piwi: Re-run the failing tests** (`Ctrl+Shift+Alt+F`, `Cmd+Shift+Alt+F` on macOS) runs every test still failing,
  one run per Playwright config.
- **Piwi: Run the test at the cursor** (`Ctrl+Shift+Alt+K`, `Cmd+Shift+Alt+K` on macOS) runs the test whose `test(…)`
  call holds the cursor. **Piwi: Verify the test at the cursor ×3** runs it three times without retries.
- **Piwi: Run this spec** runs the tests of the spec Piwi knows.

A spec's context menu holds the commands that run the test at the cursor and the spec.

Each run is a task in its own terminal, in the Playwright config's folder. When it ends, a notification says what it
fixed and what still fails, and the failures, the gutter and the status bar show its results. With a breakpoint in a
test or a page object, the run pauses there in the browser.
