---
title: Fix plans, reproduce & bisect
description: "The next step for a failure, the other ways to fix it, and the recipes to reproduce it locally and bisect to the commit that broke it."
lang: en-US
---

# Fix plans, reproduce & bisect

<Needs reporter />

A **fix plan** gathers everything Piwi knows about a failure cluster into one answer to "what do I do about this?" — the [AI diagnosis](./ai-diagnosis) and its validated patch, the ranked [locator replacement](./ai-diagnosis#locator-healing) with the exact file and line to edit, the failing tests, the owning team, and the command that verifies the work. None of it needs a model of its own: a cluster with no AI diagnosis still returns its failing tests, its locator suggestions and its verification command, so the plan is useful with no AI provider configured at all.

## Where to get it

The same plan is reachable three ways:

- **On the cluster page** — the recommended action leads as the **Next** line, and the section it points at sits right under the situation block as its own card, above the **Affected tests** selector and the evidence; everything else lives in [**More ways to fix**](#more-ways-to-fix), the folded toolbox below the evidence: the diagnosis and its patch, the locator fix, the verify command, the reproduce recipe, and a **Copy as Markdown** action for a ticket.
- **As Markdown**: the REST API returns the same rendering as plain text, so an export or a script can drop it straight into an issue (see the [API docs](https://piwitests.dev/demo/docs)).
- **For agents** — the `get_fix_plan` [MCP tool](/reference/mcp-tools#get_fix_plan) returns the structured plan, so a coding agent gets in one call what a person reads on the card.

The plan also names a Playwright command scoped to the affected spec files and (up to five) test titles, and Piwi records the fix once they pass.

## The next step

Both the cluster and the [execution](./evidence#one-execution-diagnosis-first) page lead with a single **Next** line — one action chosen for you, with a word on why, not a row of equal buttons. A policy picks it from what the page knows, first match wins: open a **blocking** failure, **open the run** when the run stopped before the test, **mark resolved** a verified-but-open cluster (unless the diagnosis verified the fix and its patch still applies at the fix's commit: the patch comes first, with *Mark resolved* in its menu) or one whose ticket is Done and that stopped failing, **replace the locator** when [healing](./locator-healing) has one, **apply the diagnosed patch** (or follow the diagnosis when its patch is stale, unchecked or missing), **see what changed** when a fix regressed, **compare attempts** on a retry pass, **re-run in CI** for a crash or failed navigation, **diagnose with AI**, else **reproduce locally**. A step that copies a change says where it comes from: the AI diagnosis with its confidence (and its summary when **Most likely** shows another explanation), or locator healing and what it captured the locator from. For a code change the line shows the change itself, up to six lines of the patch or the failing and the recommended locator, with how many lines it leaves out. **Copy apply command** copies `git apply` with the whole patch inline, to run at the repository root (bash, zsh, Git Bash) (**Download .patch** is the portable route), **Copy locator** copies the recommended locator (the primary without a line to rewrite), and **Full patch** opens the whole patch in the Diagnosis section below. Where the fix is a code change, the step's **···** menu also holds **Copy retry command**; every other action lives in the toolbox below.

<figure>
  <img src="/screenshots/next-step-change.png" alt="The Next line of a failure cluster: Replace the locator, the edit it copies as a diff under its call site, where the edit comes from, and the Copy apply command button">
  <figcaption>A locator step shows the edit it copies, where the edit goes, and where the replacement comes from.</figcaption>
</figure>

## More ways to fix

Both pages carry one **More ways to fix** toolbox, below the evidence and above the history. Each way to fix, verify or reproduce is a section folded to one line (a label and a one-line summary), so no code block opens by default. The section the next step points at opens with the page: inside the toolbox on an execution, and on a cluster as its own card under the situation block, with the rest folded below the evidence. You unfold the rest as needed.

## Reproduce and bisect

The fix plan also hands back the two things you do next: a copy-paste recipe that reproduces the failure locally, and a generated `git bisect` that finds the commit that broke it. Both sit in the toolbox's **Reproduce and bisect** section, and travel with the plan through `?format=markdown` and the `get_fix_plan` MCP tool. The exact test command leads; **Show the full recipe ▸** unfolds the checkout and installs, and the bisect follows under **Find the breaking commit**.

The **recipe** is the local reproduction, in order: check out the commit the run failed on (`git switch --detach <sha>`), install dependencies, pin Playwright to the run's version, install the browser it ran on, and run exactly the failing test. Each part degrades on its own — no recorded commit skips the checkout and says so, an unknown version drops the pin — and the run's environment is listed beside it. Every command is `git`, `npm` or `npx`, identical on Linux, macOS and Windows; the dashboard still offers **Linux / macOS** and **Windows (PowerShell)** tabs.

```bash
# Check out the failing commit
git switch --detach 9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d
# Install dependencies
npm ci
# Pin Playwright to the run's version
npm install -D @playwright/test@1.52.0
# Install the browser
npx playwright install chromium
# Run the failing test
npx playwright test "tests/admin/users.spec.ts" --project="Chromium"
```

The **bisect** walks the commits between the last green run and the failing one, re-running the test at each step — a non-zero exit marks a commit bad — until it names the first commit that broke it, then `git bisect reset` returns you to where you started.

```bash
git bisect start <failing-commit> <last-green-commit>
git bisect run npx playwright test "tests/admin/users.spec.ts" -g "Users table paginates 25 rows per page"
git bisect reset
```

The bisect needs two commits, the failing run's and the **last green** run's, which the reporter records from git (`collectScmInfo`, on by default): when either is missing, or the two are the same commit, the section says so in one line instead of showing a script. The recipe is always there.

In the [desktop app](/features/desktop#reproducing-a-failure-and-finding-the-breaking-commit) the same section can do the work for you: **Reproduce here** runs the recipe against the linked folder in a throwaway `git worktree` (your checkout is never touched), and **Find the breaking commit here** drives the whole bisect with live progress, then records the first bad commit on the cluster. For a failure on a team instance, your [editor](/features/editor-failures#ci-failures-in-the-problems-panel) passes the bisect to the desktop app and shares the first bad commit back with its own key; an agent records one with the `set_cluster_bisect` [MCP tool](/reference/mcp-tools).

## Fixed before

An open cluster often isn't new — the same failure, or one close to it, was fixed weeks ago. The fix plan looks back over the project's **resolved** clusters (resolved, or with a verified fix that held) and, when one resembles the open cluster closely enough, shows it in the **Fixed before** section of the toolbox — on both pages, and in the `?format=markdown` export and the `get_fix_plan` MCP tool.

A match is scored deterministically first — the same fingerprint family (error kind, masked message, masked locator), the same failing locator, the same spec file or test — and then, when an [embedding model](/guide/ai-provider#model-roles) is configured, by semantic similarity of the stored cluster vectors. The top three matches are shown, each with **when** it was resolved, the **commit** that fixed it (linked when the repository host is known), **how long** it stayed open, the triage note, the earlier diagnosis and its thumbs feedback (a diagnosis rated unhelpful shows only the thumbs-down, never its text), and one short reason it matched ("same error and locator", "same spec, similar message (0.91)"); the Markdown export and the MCP tool also name its owner. Nothing matches → the section renders nothing, no empty-state noise.

**Apply the same triage** copies the earlier cluster's triage note onto the open one, prefixed `Same as cluster #N:` so the history reads as an intentional reuse. It never changes the open cluster's status — a new cluster is never marked resolved just because an old one was. The same top match is fed to the AI diagnosis as a *Previously fixed similar failure* clue, so the model can reuse a known fix rather than re-derive it.

## Related

- [AI diagnosis](./ai-diagnosis): the diagnosis and validated patch a fix plan wraps
- [Failure clusters & the inbox](./failure-clusters) — the clusters a fix plan is attached to
- [Auto-heal PRs](./auto-heal) — when Piwi opens the locator fix as a pull request itself
- [MCP server](/features/mcp) — the `get_fix_plan` tool
- [Desktop app](/features/desktop#reproducing-a-failure-and-finding-the-breaking-commit) — run the recipe and drive the bisect locally
