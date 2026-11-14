---
title: AI diagnosis
description: "An LLM you configure explains a failure cluster against your git diff, with a suggested patch checked against your source before you see it. Off by default."
lang: en-US
---

# AI diagnosis

<Needs reporter llm />

An LLM you configure explains why a [failure cluster](./failure-clusters), or one execution, broke, against the code
that changed. This page covers the diagnosis (its content, when it runs, what the model receives, how it fares) and
the model's two clustering jobs: titles and semantic merging. Setting up the model is on
[AI provider](/guide/ai-provider); acting on the result, on [Fix plans](./fix-plans).

## Enabling AI diagnosis

It needs an [AI provider](/guide/ai-provider), where providers, model roles and auto-diagnose are set up.

## Response language

A diagnosis comes back in the [response language](/guide/ai-provider#response-language) set for the instance or the project.

## What a diagnosis contains

- **Category** and **confidence**
- **Root cause**: the most likely explanation
- **Evidence**: the signals relied on, each citing a section of the page
- **Suggested fix** and **prevention tips**

<figure>
  <img src="/screenshots/ai-diagnosis.png" alt="The AI diagnosis of a failure cluster on the cluster page">
  <figcaption>The AI diagnosis of a failure cluster.</figcaption>
</figure>

## Diagnosing automatically

With **auto-diagnose** on ([AI provider](/guide/ai-provider#enabling-ai-diagnosis)), a finished run's clusters with
no completed or running diagnosis, not ignored, are diagnosed up to a per-run budget, ordered by their representative
execution's top [clue](/reference/clues): **no clue** first (the model reasons from scratch), then a weak clue only,
then a failure a strong clue explains, newest cluster first on ties. A diagnosis you rated unhelpful takes a slot again once the evidence changed since it ran, once per
rating. New clusters also get a short **title** from one batched call per run; otherwise a cluster is named from its error
kind, locator, route and spec file, such as `Timeout on getByLabel('Email address') in
checkout.spec.ts`.

## Watching it stream

The model's reasoning streams into a live panel with a stage indicator (*Researching patterns*
while a [research model](/guide/ai-provider#model-roles), when one is configured, pre-analyzes the failure, then
*Diagnosing root cause*), and turns into the result card when it completes. The
[API docs](https://piwitests.dev/demo/settings/api) (`/settings/api` on your instance) describe its protocol.

## Diagnosing one execution

On an [execution page](./evidence#one-execution-diagnosis-first), the **Diagnosis** section of **More ways to fix**
shows the cluster's diagnosis summary and patch with an **Open** link; without one, it diagnoses that execution alone,
with the same panel and model. Execution and cluster diagnoses are stored apart; one never overwrites the other. A
stored diagnosis stays on screen with no provider configured; with no result and no provider, **Copy prompt** copies
the exact request, trimmed to the [context limits](/guide/ai-provider#context-limits-and-token-cost), for your own AI
tool.

## SCM-grounded context

The diagnosis is fed the code that changed. On a cluster page, **pin a baseline commit** (the diff from it to the
run), **cherry-pick commits** (their full diffs), and **preview the exact context** before running it. Unpinned, the
diff starts at the last green run before the cluster first appeared, else the last run before it where this test
passed; the preview names which. When the host lists only part of a large diff (its newest commits, its first files),
or the patches are cut to budget, the section is marked truncated. With the repository reachable
([Source control](/guide/source-control)), the **full current content** of the most suspect changed files and of the
failing test's local imports (page objects, helpers, fixtures) is sent too, capped by `PIWI_AI_MAX_SOURCE_FILES`
(default 4) and `PIWI_AI_MAX_SOURCE_FILE_CHARS`.

When the failing tests recorded [coverage](./server-coverage), the context lists their
[suspect lines](/guide/concepts#suspect-lines), the changed lines they ran, ranked by how many passing tests of the run
ran them too; their files' patches come first within the budget.

### Validated patches

Every suggested patch is dry-run, hunk by hunk, against the source files the model was shown, and carries one badge:
**Applies cleanly**, **Applies with offset** (`git apply` should still succeed), **Does not apply** (the file
diverged), **Invalid diff**, or **Unverified** (the file was not in the context). When a fix is
[verified](./failure-clusters#did-the-fix-work), the patch is checked again at the fix's commit. The model is told to
return no patch unless it can quote the lines it changes. Applying one is always yours
([the actions](./fix-plans#the-next-step)); only [auto-heal](./auto-heal) writes to your repository, with deterministic
locator edits.

## Diagnoses written by an agent

A coding agent can record its own diagnosis on a cluster or one failure with the MCP tool `record_diagnosis` (on one
failure, the [REST API](https://piwitests.dev/demo/settings/api) too), in the JSON a model returns here. It needs no
provider, its patch is validated against the failing commit's source when [source control](/guide/source-control) is
connected, and the panel shows it **written by an agent** with the model it named. It replaces the current diagnosis (kept in the
history). Declining the **Agent diagnoses** capability refuses them; declining AI diagnosis does not.

For one failure, `run_execution_diagnosis` runs the page's diagnosis and `get_execution_diagnosis` reads the stored
one, whoever wrote it.

## Locator healing

For a broken locator, the context holds [Locator healing](./locator-healing)'s ranked replacements and recommended
fix, which the model is told to use rather than invent one.

## Fix plans

The diagnosis, its patch, the locator fix, the top five suspect lines and the verify command form a
[fix plan](./fix-plans).

## Diagnosis history

A re-diagnose keeps the previous result; a nightly sweep keeps the newest 20 per cluster
(`PIWI_RETENTION_DIAGNOSIS_VERSIONS`, `0` keeps all). **History** in the panel header lists them newest first, with
model, category, confidence and token cost, and what changed since each. A re-diagnose sends the model the previous
category, confidence, summary and root cause, the triage note, and, when you rated it unhelpful, your note and an
instruction not to repeat it without new evidence. The new diagnosis starts unrated; the history keeps the old one's
thumbs.

A diagnosis is flagged **may be stale** only when the evidence changed since it ran **and** the cluster is still
failing; the banner says whether new occurrences or new evidence caused it.

## How diagnoses fare

**AI usage** in Settings → AI ([what it counts](/guide/ai-provider#usage-and-quality)) also says how each model's
diagnoses fared:

- **Rated helpful**: thumbs up over every rating, from 10 ratings (below, the panel says the sample is too small);
- **Patches that apply**: suggested patches that [apply](#validated-patches), over every patch that could be checked;
- **Verified by the fix**: diagnoses whose cluster a change to the files they named fixed;
- **Regressed**: verified diagnoses whose failure came back.

Agent diagnoses get their own row, under the model the agent named. Each diagnosis stores a hash of the instructions
it was written under (`promptSha` in its details), telling apart diagnoses before and after a change to the custom
instructions or the language. Piwi never switches models on these numbers;
[Analytics](./analytics#hand-back-outcomes) shows the ratings across projects.

## Custom instructions

**Global** instructions (Settings → AI) and **per-project** ones (Project → Settings → AI diagnosis) describe your
architecture, common false positives or house style for fixes.

## Context limits (and token cost)

Each input sent to the model is capped to keep diagnoses fast and affordable; the caps are set on the [AI provider](/guide/ai-provider#context-limits-and-token-cost) page.

## Privacy

API keys are encrypted at rest with [`PIWI_SECRET_KEY`](/reference/configuration#general). A diagnosis sends the
bounded context above to your provider; for local analysis, use Ollama or another self-hosted OpenAI-compatible model.

## Semantic merging (optional)

With **Semantic clustering** on (Settings → AI) and an embedding model, a semantic layer sits on top of the
[fingerprint](./failure-clusters#how-failures-are-grouped). After a run, its new clusters are embedded and compared (cosine similarity) with the project's other open
clusters; near-duplicates above `PIWI_CLUSTER_SIMILARITY_THRESHOLD` (default `0.92`) are merged
into the longest-lived cluster ([what the survivor keeps](./failure-clusters#how-failures-are-grouped)), and a
fingerprint alias sends future occurrences to it. This catches one root cause phrased differently enough to dodge the
fingerprint. The text is cleaned first (ANSI codes, framework stack frames, volatile tokens), and older clusters are
embedded a few at a time over the runs that follow.

Pairs in the **ambiguous band**, between `PIWI_CLUSTER_SUGGEST_THRESHOLD` (default `0.80`) and the merge threshold,
go to a model, which judges the error text, locators, most-affected tests and overlap: a confident yes merges, a less
confident yes becomes a **merge suggestion** (Clusters view of the project's Failures tab) for a Maintainer or above to
approve or dismiss, and a no stays apart. Without AI, or past five model calls in a run, the pair becomes a
suggestion. This runs after every run that [sends notifications](/reference/test-metadata#run-origin), independently
of auto-diagnose.

Each pair is judged once: the model's no is kept. A pair someone dismissed, or [split by hand](#split-a-cluster-by-hand),
is never merged automatically, however close the score.

<figure>
  <img src="/diagrams/failure-clustering-semantic-merge.svg" alt="Diagram of the semantic merging flow: clusters are embedded, compared by cosine similarity, and kept apart, adjudicated by a model, or merged depending on the score">
  <figcaption>The cosine score decides between keeping two clusters apart, asking a model (or a person), and merging them.</figcaption>
</figure>

### Split a cluster by hand

Moving tests out of a cluster needs no AI: see [Failure clusters](./failure-clusters#split-a-cluster-by-hand).

## Try it in the demo

The [live demo](https://piwitests.dev/demo/) needs no provider: some clusters carry a diagnosis with a validated patch,
the others stream a simulated one.

<DemoExamples />

## Related

- [Triage a run gone red](/recipes/mass-failure): clusters first, then a diagnosis
- [Failure clusters & the inbox](./failure-clusters): grouping, and whether the fix worked
- [Privacy & data flow](/guide/privacy): what a diagnosis sends, and where
- [Notifications & alerts](./notifications): `diagnosis.completed` and the cluster events
- [MCP server](/features/mcp): clusters and diagnoses for agents
