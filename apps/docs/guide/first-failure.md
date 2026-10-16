---
title: Your first failure, explained
description: "Read one failing test in the dashboard from top to bottom: the headline, the likely cause, the next step, the cluster and the evidence."
lang: en-US
---

# Your first failure, explained

You've landed your first run ([Getting started](./getting-started)) and one test is red. This page walks through reading it. Piwi lays a failing execution out **diagnosis-first**, in one column read top to bottom: *what* broke, *why*, *what to do next*, then the evidence.

Open the failing test from the run page (click its row) to reach its **execution page**.

<figure>
  <img src="/screenshots/gather-evidence.png" alt="A failing execution laid out diagnosis-first: one situation block with the headline and the line under it, most likely, next step and the cluster, and one evidence card with tabs">
  <figcaption>One failing execution, read top to bottom: the situation block that says what broke, what is most likely and what to do, then the evidence.</figcaption>
</figure>

The top of the page is one **situation block**. Above its heading, a small **identity** line carries the status, the test title, Playwright marks such as `@fixme` or `@slow`, and whether the test is quarantined. The lines below it are the rest of this page, in order.

## 1. The headline: what broke

The heading is a plain-English sentence built from the Playwright error, before you read a word of the raw error itself:

> `getByRole('button', { name: 'Pay' }) never became enabled — click timed out after 30 s`

It is read from the action or matcher, the locator, the expected and received values and the timeout; an unknown error shape falls back to the error's first line. A failure in a hook or fixture says where it happened (`In beforeEach: …`), and an `expect` you gave a message leads with it (`"cart shows the item" failed: …`). The verbatim error is one click away under **Raw error**: Piwi never rewrites it, it only leads with a readable summary. The same headline names the test on the run page, in [alerts](/features/notifications), in the [pull-request comment](/features/pr-feedback), in the MCP tools and in your terminal, so you recognize it everywhere.

A smaller line under the headline says since when it fails, on which commit and by whom, and whether it **still fails**:

> *New regression since a1b2c3d by Alice Chen, 1 day ago · Not the latest: failed again in run #2 and run #1, 53 minutes ago · Open the latest*

*Latest execution of this test* means nothing ran it since; otherwise the line says what the newer runs did (failed again, with another error, or passed) and **Open the latest** goes to the newest execution. Only the same Playwright project counts, and the line names it when another project ran later: a Firefox pass does not clear a Chromium failure. An exceptional case (a new regression, a newly flaky test, an infrastructure failure) leads the line. A test that passed on retry reads *Passed on retry* in its status and leads with its failed attempt's error, and the line says which attempt failed (*Failed on attempt 1, passed on attempt 2*), with a link to it.

## 2. Most likely: why

Under the headline, the **Most likely** line gives you the one explanation, not a pile of them. It is built from **[clues](/features/evidence#clues)**: deterministic, rule-based findings correlated from the evidence, with *no model involved*. When the clues match a known pattern (some patterns need only one clue), the line is a [story](./concepts#story), one sentence that chains them:

> *"the Pay button stayed disabled because POST /api/checkout/quote was still in flight (28 s); the console said so 7.8 s before the click gave up"*

A strong or medium story leads; otherwise the cluster's completed [AI diagnosis](/features/ai-diagnosis) does, else a weak story, else the strongest clue. The [cluster page](/features/failure-clusters) follows the same rule, so both pages give the same explanation for the same failure. The line carries a strength (*Strong*, *Medium* or *Weak*, or the diagnosis's confidence) and how many clues **agree**; an **All clues** disclosure lists every clue, each with a **citation** to the evidence it came from. Click a citation and the page jumps to the proof. When no rule fires and no diagnosis completed, the line is absent. The [Clue rules](/reference/clues) page lists every rule.

A test that did not run gets its reason here instead: the test that blocked it, or where the run stopped (*The run reached its maximum number of failures (3 failed) and stopped before this test started*), with a meta line when Playwright reported it.

## 3. Next: what to do

The **Next** line names the one thing to do, chosen for you rather than offered as a menu: apply the diagnosed patch, replace the [broken locator](/features/locator-healing), reproduce it locally, re-run in CI, or mark the cluster resolved; for a test that did not run, open the failure that blocked it or the run. When the step's change comes from somewhere, the line under it says where: the cluster's AI diagnosis with its confidence (and its summary, when Most likely shows another explanation), or locator healing and what it captured the locator from. A code change shows on the line itself, up to six lines of the patch or the failing and the recommended locator, and the button says what it copies: **Copy apply command** (`git apply` with the patch inline) or **Copy locator**. Where the work is a code change, the step's **···** menu copies the exact command to re-run this test (**Copy retry command**). The full policy is on the [fix-plans page](/features/fix-plans#the-next-step).

## 4. The cluster: who else, and the ticket

The **Cluster** line names the [failure cluster](/features/failure-clusters) the failure joins and how many other tests of the run share it, with its triage status, whether an earlier fix did not hold, and who owns the test. It ends with the cluster's [issue](/features/issue-tracking) and its status, or offers to create or link one.

With [coverage](/features/server-coverage), a **What changed** line counts the changed lines the test ran and names the first of its [suspect lines](/guide/concepts#suspect-lines).

The block closes on a **facts** line, one size smaller: the failing file and line (open it in your IDE), browser and viewport, duration against its average, the attempts, the branch, and the CI build. A **Details** popover holds the rest, and **Raw error** shows the verbatim error with a **Copy failure** action.

## 5. The evidence: see it

One **evidence card** with tabs (**Timeline, Screen, Source, Network, Console, State, Performance**, plus **Attempts** when the test retried) holds everything captured. It opens on **Timeline** when it can place two or more steps, requests or console entries, otherwise on the tab the leading clue cites, and a click on any citation switches tabs for you; a test that passed on retry opens on **Attempts**. The one to know first is **Timeline**: it places the test's steps, console entries, network requests and backend logs on a single clock and marks the **moment of failure**, so "console (1) / network (3)" becomes *what the app was doing when the test gave up*. **Screen** holds the failure screenshot, the visual diff against the last green run, and the failure-time page state; **Source** shows the test source as a real call stack, so a failure inside a helper shows the helper. Each tab is described on [Failure evidence](/features/evidence).

::: tip Most of this needs one file
The error, trace, headline and clustering work with the reporter alone, and an uploaded trace recovers the console, network and failure-time snapshot. Web Vitals, page state and locator healing come from the [capture fixtures](./capture-fixtures), one file in your test setup. A tab that needs them and never received any data is left out, and until you decide on the fixtures one footer line names what they would add.
:::

## 6. More ways to fix

Below the evidence, **More ways to fix** is the folded toolbox holding every *other* way to fix, verify or reproduce, each section collapsed to one line. The section the **Next** step points at is already open:

- a **[replacement locator](/features/locator-healing)** when a locator broke, ranked by stability and in your suite's own style;
- the **[AI diagnosis](/features/ai-diagnosis)** and its validated patch, when you've configured a model (optional, and grounded in your real diff);
- **verify** (re-run in CI or locally), **reproduce and bisect**, whether this failure was **fixed before**, the tests it **blocked**, and a link to the cluster's **[fix plan](/features/fix-plans)**.

Below the toolbox, a **history** strip shows this test's recent executions and how long it has been failing.

## You're not reading it alone

This execution is one member of a **[failure cluster](/features/failure-clusters)**: Piwi groups every test that failed for the same reason, so forty red tests become three problems you triage once. Once a later run passes every test it covers, the cluster records [whether the fix held](/features/failure-clusters#did-the-fix-work).

## Related

- [Failure evidence](/features/evidence): each evidence tab, attempts, the page diff and the trace views
- [Clue rules](/reference/clues): every rule behind the **Most likely** line
- [Failure clusters & the inbox](/features/failure-clusters): triaging failures as groups
- [Capture fixtures](./capture-fixtures): the one file that unlocks the richer evidence
- [Core concepts](./concepts): run, execution, cluster, fingerprint, baseline
