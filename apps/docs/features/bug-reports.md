---
title: Bug reports
description: "Bug reports sent from Piwi Picker, kept in Piwi with their steps and evidence, each rendered as a failing Playwright test and followed through its runs until the fix holds."
lang: en-US
---

# Bug reports

<Needs extension />

A tester who [reports a bug](./report-a-bug) in Piwi Picker can send it to your Piwi instance. Piwi keeps it with its
steps, the value the page showed, and the evidence the tester chose to send; writes it as a failing Playwright test for
your project; and follows that test's runs: from the test being committed, to the bug looking fixed, to the report
closing when the fix holds.

## Sending a report

With the extension [connected to the instance](./extension-connection), the finished report offers
**Send to Piwi…**. It opens a preview of exactly what leaves the browser, for the project the tab's address maps to:

- the title and the steps, with the values typed during the recording (never a password, which is not recorded);
- one box per kind of evidence: the screenshots, the [screenshot of each step](./report-a-bug#evidence), the console
  errors and warnings, the failed requests (method, path and status, never a body) and the outline of the page;
- **Leave out the values I typed**, which removes them from the steps and from the evidence that repeats them; the
  failing test then reads them from environment variables.

Nothing is sent before **Send**, and only to the instance the extension is connected to. The first time, the preview
explains this. Anyone who can read a project can send a report to it, so a tester's own key is enough.

The report keeps the language it was written in; the test Piwi writes from it is the same in every language.

## The report's page

**Bug reports**, in a project's **More** menu, lists them newest first, by status. A report's page says what the
tester expected and what the page showed instead, where the report stands, and what to do next, with four tabs:

- **Steps**: the steps in words, each marked step with its expected result, the value the page showed and the note.
- **Evidence**: the screenshots, the page as each step began with its element outlined, the failed requests, the
  console entries and the page's outline.
- **Reproductions**: each time someone replayed it or ran it with Playwright and shared what they found (**Share
  result…** in Piwi Picker).
- **Spec**: the failing test.

**Dismiss** sets a report aside: runs no longer move it. **Reopen** brings it back.

### Why the suite missed it

The page also says, in one line, why no test caught the bug, from the [locators your tests use](./locator-usage) on
the report's page: "4 tests visit /cart; 2 reach the element marked, and none asserts its text". **Show the tests**
lists them, and the owner is the one of the spec file whose tests visit the page most (its `piwi:owner`, else
CODEOWNERS). It needs the [capture fixtures](/guide/capture-fixtures), which record the page each locator ran on.

Until a test names it, an open report is also an **escaped defect** on the [Test Map](./scenario-gaps): one blind spot
per page with open reports, ranked like any gap.

## The failing test

The **Spec** tab renders the steps as a Playwright spec with the same converter as Piwi Picker and
[`piwi codegen`](/reference/cli#codegen), with what Piwi knows about your project: calls to your
[test functions](./test-functions) where the steps match one, and for each element the locator your tests already use
when it is not brittle. Two versions:

- **To commit**: marked `test.fail()`, so it keeps your CI green while the bug exists, with the `@bug` tag and a
  `piwi:bug` annotation naming the report.
- **To run**: the same test without `test.fail()`, which fails on the expected result while the bug is there.

```ts
test('bug: coupon not applied to the total', {
  tag: ['@bug'],
  annotation: [{ type: 'piwi:bug', description: '37' }],
}, async ({ page }) => {
  test.fail(); // passes while the bug exists; remove this line with the fix
  await page.goto('/cart');
  await page.getByLabel('Coupon').fill('SPRING10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('cart-total')).toHaveText('Total: 42'); // recorded: 'Total: 40'
});
```

Two project settings shape it, under **Generated specs** in the **Source control** section of the project's **Settings**
tab: the folder bug specs go to (`tests/bugs` by default) and the module `test` and `expect` are imported from, such as
`../fixtures` when your tests use fixtures of their own.

From a terminal, [`piwi bug 37 --write`](/reference/cli#bug) writes the spec into that folder and runs it once, so you
see the bug before you fix it.

## From report to fix

Once a test naming the report (`piwi:bug 37`) runs on the default branch, the report follows it (the run `piwi bug --write`
starts moves nothing):

| Status | When |
|---|---|
| **Open** | Sent; no run has carried a test naming it yet. |
| **Test committed** | A test naming it ran and the bug still shows: with `test.fail()`, the test failed as expected. |
| **Looks fixed** | That test, still marked `test.fail()`, passed in every browser project that ran it. The run's [pull-request comment](./pr-feedback) says to remove `test.fail()` from its file, and the `bug.looks_fixed` [notification](/reference/notification-events) fires. |
| **Closed** | The test passed as an ordinary test, `test.fail()` removed: the fix holds. |

A closed report whose test fails again goes back to **Test committed**. A test marked `test.fail()` that passes is
never counted into a [failure cluster](./failure-clusters): it is good news about one test, shown as **Looks fixed** on
the run.

## Filing it in Jira

When the project is bound to Jira in its [issue tracking](./issue-tracking) settings, a report becomes a ticket in
three ways, all through the same outbox, links and attachments:

- **From the Send preview**: **Also create a Jira issue in SHOP** is offered to a sender who may create issues
  there (Contributor or above, or an administrator).
- **From the report's page**: **Create issue**, with the same modal as a failure cluster.
- **For every report**: **File every bug report**, in the project's two-way sync settings, files each report as it
  arrives, whoever sends it; the preview then says so.

The ticket carries the steps, what was expected and what the page showed, the evidence (the screenshots attached to
it), the failing test to commit, the reproductions and a link back, with the labels `piwi` and `piwi-bug-<id>`. It is
written in the binding's ticket language, whatever language the report was written in: the steps are written again in
that language, the reporter's own words (the title, the note, the values typed) stay as they were, and a line says which
language the report came in.

The ticket then follows the report: with **Comment on fix** and **Transition on fix** on, a report that looks fixed
comments on its ticket and moves it; with **Resolve on close** and **Reopen on ticket reopen**, the report closes and
reopens as its ticket moves into and out of Done.

## Running it with Playwright in the desktop app

For the exact verdict and a trace, the [desktop app](./desktop) runs a report's steps with Playwright in your project.
Pair it once: in the extension's settings, under **Desktop app**, click **Pair**, then **Allow** in the app's window,
which shows the same code. The address is on the app's **Setup** page, under **Connect Piwi Picker**
(`http://127.0.0.1:3000` unless another program holds that port); **Pair by hand** takes the token shown there.
The token goes only to an app that proves it holds it.

**Run with Playwright…**, in Replay's chooser or on a finished replay, shows what it sends (the title and the steps,
with the values typed in them) and sends it on **Send**. The request holds steps, never code. The app's window shows
it with the steps in words, the linked project to run it in, and the flags (headed and a trace by default, a
Playwright project, a repeat count). Nothing runs before **Run with Playwright**; **Decline** drops it, and a request
left unanswered expires after ten minutes.

The app writes the spec to run, with the project's settings, to `piwi-repro/bug-<id>.spec.ts` under the test directory
your Playwright config names, runs it in the **Local runs** tray with the project's own config, and deletes it when the
run ends. The verdict, read from where the test failed, goes back to Piwi Picker: **reproduced** when an expected
result does not hold, **not reproduced** when the test passes, or **diverged** at the step that failed first.

## Replaying a report from Piwi

A developer with the extension connected finds the project's open reports in **Replay a bug report**, beside the file
chooser: the report's steps play in their own tab, on their own dev server, and a step handed over shows its
screenshot. See [Replay a bug report](./replay-a-bug-report).

## For agents

The [MCP server](./mcp) has `list_bug_reports`, `get_bug_report` (the steps in words, what was expected, the evidence
and the reproductions), `render_steps`, which writes a report's failing test, or any steps file's, and
`set_bug_report_status`, which dismisses, reopens or closes a report.

## Related

- [Report a bug](./report-a-bug): recording a report in Piwi Picker
- [Steps files](/reference/steps-format): the format of the steps
- [Test metadata](/reference/test-metadata#ownership-metadata-piwi-annotations): the `piwi:bug` annotation
