---
title: Results in Zephyr Scale
description: "Send a finished CI run's results to Zephyr Scale Cloud as one test run, one result per test case key, with a dry run first and a link back to the Piwi run."
lang: en-US
---

# Results in Zephyr Scale

<Needs reporter admin />

When a CI run of the whole suite finishes, Piwi can write its results to Zephyr Scale Cloud: one **test run** (a test
cycle in Zephyr) holding one result for each test case key the run's tests carry. The test run links back to the
run's page in Piwi, and the run's page shows what was sent.

It is **off until an [administrator connects Zephyr Scale and binds the project](/operate/zephyr-scale#bind-a-project)**,
and a new binding starts as a **dry run** that sends nothing.

## When a run is sent

A run is sent once, when it finishes, if all of these hold:

- the project is bound to a Zephyr project, the binding is **Enabled**, and the run is in the binding's branches and
  environments;
- the run came from CI and ran the whole suite to the end. A partial run (a filter, a selection, a rerun of the failed
  tests), a run that was interrupted or timed out, a run from a developer's machine, the desktop app or an editor, a
  lab run and an imported run send nothing;
- the project's test case catalog has been read, and at least one test of the run carries a key the catalog holds.

A run split across shards is sent once, after its last shard reports, with the results of every shard. Sending is a
background action: the run is not held up, and a send that fails because Zephyr is down is retried with a growing
wait.

The binding is read again when the results go out. If it was turned off, became a dry run or names another Zephyr
project since the run finished, nothing is sent and the run's panel says why. If Zephyr already holds the test run by
then, the send fails and names it, so you can find it in Zephyr.

## What is sent

- **One result per test case key.** When several tests carry the same key, or one test runs in several browsers or
  repeats, the worst outcome wins: a failure beats a flaky test, which beats a pass.
- **Only keys the catalog holds.** A key a test carries that is not a case in the project is left out and listed on the
  run's page, so a typo never creates anything in Zephyr. Tests with no key are not sent.
- **Flaky and skipped tests follow the binding.** A flaky test is reported as a pass, as a fail, or with the flaky
  status you name; a skipped test is left out or reported as not executed. See **Result statuses** under
  [Bind a project](/operate/zephyr-scale#bind-a-project).
- **The first line of the error** is added to a failed result only when the binding says so. It is off by default.
- **The test run's name** comes from the binding's [name template](/operate/zephyr-scale#the-test-run-name). Its
  description holds the run's address in Piwi, the branch, the short commit and the counts sent.

Piwi never imports test cases, steps or results from Zephyr: the catalog it keeps holds only each case's key, name,
status and folder.

## On the run's page

A run that was sent, or would be, shows a **Zephyr Scale** panel in its header:

- **A live send** shows the key of the test run, how many results were sent and the counts, for example
  `SHOP-R2`, "12 results sent: 10 passed, 1 failed, 1 flaky, 0 not executed". The key is also listed with the run's
  links.
- **A dry run** says that nothing was sent and shows what a live sync would send, so you can check the keys, the
  counts and the keys the catalog does not hold before you turn the dry run off.
- **A run that was not sent** says why: for instance that the catalog was not read yet or that no test carries a
  mapped key.
- **A failed send** shows the error, and Maintainers and above get **Sync again**.

## Outcome unknown, and Sync again

Zephyr creates a new test run every time results are uploaded, so Piwi never uploads the same run blindly. It records
that an upload started before it begins, and the test run's key as soon as Zephyr names it.

A large upload can take longer than the request is allowed to wait, so Piwi may not know whether Zephyr received it.
The panel then says the outcome is unknown. It does not retry on its own. **Sync again** first looks in Zephyr for the
test run that run's upload may have made, by its name and start time:

- one that is found is linked to the Piwi run and is not made again;
- none found uploads the results again;
- when Zephyr gives no answer Piwi can trust (more executions or test runs than it reads, or a test run it cannot
  read), nothing is sent, the send stays failed and the message says why. Check the project in Zephyr before you try
  again.

Two people who press **Sync again** at the same time send the results once: the second is told the sync changed.

A send that failed before the upload, or after the test run was made, only repeats the step that failed. **Sync again**
works on a failed send; a dry run has nothing to repeat. It is refused, and says why, while the binding is turned off,
is a dry run, or names another connection or another Zephyr project.

## Linked back to the run

The test run in Zephyr gets a web link to the Piwi run's page, titled with the run's number, when the server knows its
public address: set [`PIWI_SITE_URL`](/reference/configuration#integrations). The Piwi run lists the Zephyr test run
among its links, as the key, and removing the link there does not delete anything in Zephyr.

## Good to know

- Zephyr Scale **Cloud** only. Zephyr Scale Server and Data Center, Xray and other tools are not supported.
- Piwi writes through the connection's token, one request budget per connection, shared with the catalog.
  See [Request rate](/operate/zephyr-scale#request-rate).
- If you would rather have Zephyr own the test run, Playwright's built-in `junit` reporter writes a file Zephyr Scale
  can import itself. Use one or the other for a project, not both, or the results are recorded twice.

## Related

- [Zephyr Scale Cloud](/operate/zephyr-scale): connect it, bind a project and read the test case catalog
- [Test metadata](/reference/test-metadata): the tags and external IDs a test carries its case key in
- [Issue tracking (Jira)](./issue-tracking): the other integration that writes to an external tool
- [Integrations](/operate/integrations): how connections are managed
