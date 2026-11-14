---
title: Bug reports
description: "Bug reports sent from Piwi Picker, kept in Piwi with their steps and evidence, each rendered as a failing Playwright test and followed through its runs until the fix holds."
lang: en-US
---

# Bug reports

<Needs extension />

A tester who [reports a bug](./report-a-bug) in Piwi Picker can send it to your Piwi instance. Piwi keeps it with its
steps and the evidence the tester chose to send; writes it as a failing Playwright test for
your project; and follows that test's runs: from the test being committed, to the bug looking fixed, to the report
closing when the fix holds. This page covers what needs an instance: sending a report, the failing test (the one
Piwi Picker copies too), and following it to the fix. Recording a report is on
[Report a bug](./report-a-bug), and playing one again, in the browser or with Playwright, on
[Replay a bug report](./replay-a-bug-report).

## Sending a report

With the extension [connected to the instance](./extension-connection), the finished report offers
**Send to Piwi…**. It opens a preview of exactly what leaves the browser, for the project the tab's address maps to:

- the title and the steps, with the values typed during the recording (never a password, which is not recorded);
- one box per kind of evidence: the screenshots, the [screenshot of each step](./report-a-bug#evidence), the console
  errors and warnings, the failed requests (method, path and status, never a body) and the outline of the page;
- **Leave out the values I typed**, which removes them from the steps and from the evidence that repeats them; the
  failing test then reads them from environment variables.

Nothing is sent before **Send**, and only to the connected instance. Anyone who can read a project can send a report to it, so a tester's own key is enough.

The report keeps the language it was written in; the test Piwi writes from it is the same in every language.

## The report's page

**Bug reports**, in a project's **More** menu, lists them newest first, by status. A report's page says what the
tester expected and what the page showed instead, where the report stands, and what to do next, with these tabs:

- **Steps**: the steps in words, each marked step with its expected result, the value the page showed and the note.
- **Evidence**: the screenshots, the page as each step began with its element outlined, the failed requests, the
  console entries and the page's outline.
- **Reproductions**: each time someone replayed it or ran it with Playwright and shared what they found (**Share
  result…** in Piwi Picker).
- **Spec**: the failing test.

**Dismiss** sets a report aside: runs no longer move it. **Reopen** brings it back.

<figure>
  <img src="/screenshots/bug-report.png" alt="A bug report's page: situation, state, next step and why the suite missed it, over its steps">
  <figcaption>A report's page.</figcaption>
</figure>

### Why the suite missed it

The page also says, in one line, why no test caught the bug, from the [locators your tests use](./locator-usage) on
the report's page: "4 tests visit /cart; 2 reach the element marked, and none asserts its text". **Show the tests**
lists them, and the owner is the one of the spec file whose tests visit the page most (its `piwi:owner`, else
CODEOWNERS). It needs the [capture fixtures](/guide/capture-fixtures), which record the page each locator ran on.

Until a test names it, an open report is also an **escaped defect** on the [Test Map](./scenario-gaps): one blind spot
per page with open reports, ranked like any gap. A report closed while no test names it becomes a gap of its own,
*fixed without a regression test*, and every report of the last 180 days raises the escape history of the gaps on its
page ([exposure](/reference/gap-detectors#exposure)).

## The failing test

A report's failing test, the one Piwi Picker's **Copy failing test** gives and the one the **Spec** tab shows, is
written by one converter, also [`piwi codegen`](/reference/cli#codegen)'s: the `@bug` tag, paths instead of the
recorded site's URLs so your `baseURL` applies, the most stable locator recorded for each element, a URL check after
each step that leads to another page, the recorded viewport sizes, and the value the page showed beside the marked
assertion, as a comment. Marked `test.fail()`, it passes while the bug exists and keeps your CI green; once the bug is
fixed, Playwright reports the expected failure as a failure: remove `test.fail()` and the test guards the fix.

The **Spec** tab adds what Piwi knows about your project: calls to your [test functions](./test-functions) where the
steps match one, and for each element the locator your tests already use when it is not brittle, which is why its
`getByLabel('Coupon')` below reads `getByRole('textbox', { name: 'Coupon' })` in the copy Piwi Picker makes alone. Two
versions:

- **To commit**: marked `test.fail()`, with a `piwi:bug` annotation naming the report.
- **To run**: the same test without `test.fail()` or the annotation, which fails on the expected result while the bug
  is there.

```ts
test('bug: coupon not applied to the total', {
  tag: ['@bug'],
  annotation: [{ type: 'piwi:bug', description: '37' }],
}, async ({ page }) => {
  test.fail(); // passes while the bug exists; remove this line with the fix
  await page.goto('/cart');
  await page.getByLabel('Coupon').fill('SPRING10');
  await page.getByRole('button', { name: 'Apply coupon' }).click();
  await expect(page.getByTestId('cart-total')).toHaveText('Total: 36.00'); // recorded: 'Total: 40.00'
});
```

Two project settings shape it, under **Generated specs** in the **Source control** section of the project's **Settings**
tab: the folder bug specs go to (`tests/bugs` by default) and the module `test` and `expect` are imported from, such as
`../fixtures` when your tests use fixtures of their own.

From a terminal, [`piwi bug 37 --write`](/reference/cli#bug) writes the spec into that folder and runs it once.

<figure>
  <img src="/screenshots/bug-report-spec.png" alt="A bug report's Spec tab: the failing Playwright test written from the report's steps, ready to commit">
  <figcaption>A report's Spec tab: the failing test, written with the project's settings.</figcaption>
</figure>

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

Piwi Picker sends a report's steps to the [desktop app](./desktop), once
[paired with it](./extension-connection#pair-with-the-desktop-app), which runs them with Playwright in your project for
the exact verdict and a trace: see [Running it with Playwright](./replay-a-bug-report#running-it-with-playwright).

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
