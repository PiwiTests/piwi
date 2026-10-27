---
name: fix-a-reported-bug
description: Fix a bug someone reported from Piwi Picker, starting from its failing test. Use when the user names a Piwi bug report ("bug #37"), asks to "fix the reported bug", "reproduce this bug report", or pastes a link to /bug-reports/<id>.
---

# Fix a reported bug

A bug report sent from Piwi Picker is already a test: the steps someone took, the assertion that says what the page
should show, and the value it showed instead. This skill turns it into a committed failing test, reproduces the bug,
fixes it, and proves the fix with that same test.

## How you reach Piwi

Prefer the **Piwi MCP server** if it is connected: `get_bug_report` (the steps in words, what was expected, the
evidence, the reproductions, the tests that visit the page) and `render_steps` with `bugReportId` (the failing test).
Without it, the CLI does the same: `npx @piwitests/reporter bug <id>`, with the dashboard's URL and an API key in the
`PIWI_DASHBOARD_URL` and `PIWI_API_KEY` environment variables (or `--server-url` and `--api-key`). This command does not
read a `.env` file: export the variables, or pass the flags.

## Steps

1. **Read the report.** `get_bug_report { id }`. Note the page, each expected result with the value the page showed,
   the reporter's note, the failed requests and console errors. The evidence often names the cause (a `POST … 500`).

2. **Write the failing test.** `npx @piwitests/reporter bug <id> --write` writes the spec to the project's bugs folder
   (`tests/bugs` unless the project names another) and runs it once. It is marked `test.fail()`, tagged `@bug` and
   annotated `piwi:bug <id>`, so it passes while the bug exists. Exit code 0 means the bug reproduces here. Exit code 1
   means it does not: read the output. Exit code 2 means the report could not be read or the file could not be written
   (`--force` replaces an existing file). A step that finds no element means the page or the data differ here (a
   user, a cart, a flag the report assumed): make the test's setup provide them, in the project's style, rather than
   deleting steps.

3. **Look at the tests that already visit the page** (`missedBy` in `get_bug_report`). If one of them reaches the
   element, the missing piece is often one assertion in that test; say so in your report, and keep the bug's own spec
   as the regression test.

4. **Fix the bug** in the application code. Keep the change to what the evidence and the expected result point at.

5. **Prove the fix.** Remove the `test.fail()` line from the bug's spec and run it: it must pass. Run the tests that
   visit the page too (`npx playwright test <their files>`), so the fix breaks nothing around it.

6. **Report.** The cause, the fix, the spec file, and the two runs. Once the spec passes without `test.fail()` in a
   run on the project's default branch (not a `piwi bug` run), Piwi closes the report on its own; before that, such a
   run where the spec still carries `test.fail()` and passes marks it "looks fixed".

## Guardrails

- Never change the expected value in the spec to make it pass: it is what the reporter said the page should show. If
  you believe the reporter was wrong, stop and ask.
- Keep `piwi:bug <id>` on the test: it is how the report follows the fix.
- One bug, one spec. Do not fold the reproduction into an unrelated test.
