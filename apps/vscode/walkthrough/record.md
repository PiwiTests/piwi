## Record a test

Recording runs your project's own Playwright: it needs no instance.

- **Piwi: Record a new test file** creates a spec next to the active test file, or in the config's `testDir`, and
  records into it.
- **Piwi: Record here** (`Ctrl+Shift+Alt+R`, `Cmd+Shift+Alt+R` on macOS) records at the cursor: steps inside a test, a
  new test elsewhere.

A browser opens on the start page you give, and what you do there is written into the file as you do it, in a tinted
block with **Stop**, **Pause** and **Resume** above it. The same keys stop the recording, and one Undo after Stop
removes what it wrote. Once connected, the recording calls your page objects.
