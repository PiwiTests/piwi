---
title: AI diagnosis
description: "An LLM you configure explains a failure cluster against your git diff, with a suggested patch checked against your source before you see it. Off by default."
lang: en-US
---

# AI diagnosis

When a run finishes, Piwi groups related failures into [failure clusters](./failure-clusters) and, optionally, asks an
LLM to explain why each broke, against the code that changed.

## Semantic merging (optional)

If an **embedding** model role is configured (Settings → AI), Piwi adds a semantic layer on top of the deterministic
fingerprint. After a run, the clusters first seen in it are embedded and compared (cosine similarity) against the
project's other open clusters; near-duplicates above `PIWI_CLUSTER_SIMILARITY_THRESHOLD` (default `0.92`) are merged
into the longest-lived cluster, and a fingerprint alias sends future occurrences to the survivor. This catches one root
cause phrased differently enough to dodge the fingerprint. The text is cleaned before embedding (ANSI codes, framework
stack frames and volatile tokens removed), and older clusters without a vector are embedded a few at a time over the
runs that follow.

Pairs in the **ambiguous band**, between `PIWI_CLUSTER_SUGGEST_THRESHOLD` (default `0.80`) and the merge threshold, are
not merged automatically. When AI is configured, a model judges the pair from its error text, locators, most-affected
tests and overlap: it merges on a confident yes, turns a less confident yes into a **merge suggestion** on the
project's Failure clusters tab, for a Maintainer or above to approve or dismiss, and leaves a no apart. Without AI, or
past five model calls in a run, the pair becomes a suggestion directly. This runs after every finished run
whenever an embedding role is configured, independently of auto-diagnose.

Each pair is judged once: the model's no is kept. A pair that someone dismissed, or that came from [moving tests to a
new cluster](#split-a-cluster-by-hand), is never merged automatically, however close the two clusters score.

<figure>
  <img src="/diagrams/failure-clustering-semantic-merge.svg" alt="Diagram of the semantic merging flow: clusters are embedded, compared by cosine similarity, and kept apart, adjudicated by a model, or merged depending on the score">
  <figcaption>The cosine score decides between keeping two clusters apart, asking a model (or a person), and merging them.</figcaption>
</figure>

With auto-diagnose on, new clusters also get a short **title** from one cheap batched model call per run. Without one,
a cluster is named from its error kind, locator, route and spec file, such as
`Timeout on getByLabel('Email address') in checkout.spec.ts`.

### Split a cluster by hand

The opposite of a merge needs no AI. When some of a cluster's tests fail with the same error for a different reason,
select them in the cluster page's **Affected tests** and choose **Move to a new cluster** (Maintainer or above).
Their failures move to a new cluster at once, with the triage note you type, and the cluster they left gains a line
naming the move. Later failures of those tests with the same error join the new cluster, the other tests' failures
stay where they were, and the two clusters are never merged automatically.

## Enabling AI diagnosis

AI diagnosis needs an [AI provider](/guide/ai-provider): the providers, model roles, streaming and automatic diagnosis of new clusters are set up there.

## Response language

A diagnosis comes back in the [response language](/guide/ai-provider#response-language) set for the instance or the project.

## What a diagnosis contains

Each result includes:

- **Category** and **confidence**
- **Root cause**: the most likely explanation
- **Evidence**: the signals the model relied on, each citing a section of the page
- **Suggested fix** and **prevention tips**

<figure>
  <img src="/screenshots/ai-diagnosis.png" alt="The AI diagnosis of a failure cluster on the cluster page">
  <figcaption>The AI diagnosis of a failure cluster: category, confidence, root cause, evidence and a suggested fix.</figcaption>
</figure>

## Diagnosing one execution

A cluster page diagnoses every failure that shares a fingerprint. On a single failing
[execution](./evidence#one-execution-diagnosis-first), the **Diagnosis** section of **More ways to fix** shows the
cluster's diagnosis summary and patch with an **Open** link; without one, it diagnoses just that execution, with the same
panel and model: handy when a failure has not clustered yet. Execution and cluster
diagnoses are stored separately, and running one never overwrites the other.

A stored diagnosis stays on screen even with no provider configured. With no result and no provider, **Copy prompt**
copies the exact request the model would receive, trimmed to the
[context limits](/guide/ai-provider#context-limits-and-token-cost), so you can paste it into your own AI tool.

## SCM-grounded context

The diagnosis is fed the code that changed. On a cluster page you can:

- **Pin a baseline commit**: the diagnosis includes the diff between that commit and the run.
- **Browse and cherry-pick commits**: add the full diff of specific commits.
- **Preview the exact context** before running it, so nothing leaves your server by surprise.

Without a pinned baseline, the diff starts at the last green run before the cluster first appeared, else at the last
run where this test passed; the context preview names which one it used. With the repository reachable, Piwi also sends the
**full current content** of the most suspect changed files and of the failing test's local imports (page objects,
helpers, fixtures), capped by `PIWI_AI_MAX_SOURCE_FILES` (default 4) and `PIWI_AI_MAX_SOURCE_FILE_CHARS`. The
repository connection is set up on [Source control](/guide/source-control).

When the failing tests recorded [coverage](./server-coverage), the context lists their
[suspect lines](/guide/concepts#suspect-lines): the changed lines they executed, ranked by how many passing tests of the same run executed them too. Their files' patches
come first within the patch budget.

### Validated patches

Every suggested patch is dry-run, hunk by hunk, against the source files the model was shown. The patch carries one
badge: **Applies cleanly**, **Applies with offset** (`git apply` should still succeed),
**Does not apply** (the file diverged), **Invalid diff**, or **Unverified** (the file was not in the context). When a
fix is [verified](./failure-clusters#did-the-fix-work), the patch is checked again at the fix's commit. The model
is told to return no patch unless it can quote the lines it changes. Applying a patch is always manual: **Copy**,
**Copy apply command** or **Download `.patch`**. Only [auto-heal](./auto-heal) writes to your repository, with
deterministic locator edits.

## Diagnoses written by an agent

A coding agent can record its own diagnosis on a cluster, or on one failure, with the MCP tool `record_diagnosis`, in
the same JSON a model returns here. It needs no AI provider on this instance, its patch is validated against the
source the failure happened at when [source control](/guide/source-control) is connected, and the panel shows it as
**written by an agent** with the model it named. It replaces the current diagnosis, which stays in the history.
Declining the **Agent diagnoses** capability refuses them; declining AI diagnosis does not.

For one failure, `run_execution_diagnosis` runs the diagnosis of the failure page, and `get_execution_diagnosis` reads
what is stored, whoever wrote it.

## Locator healing

When the failure is a broken locator, the context includes the ranked replacements and the recommended fix from
[Locator healing](./locator-healing), and the model is told to use that fix rather than invent a locator.

## Fix plans

The diagnosis, its patch, the locator fix, the top five suspect lines and the verify command come together in a fix
plan: see [Fix plans, reproduce & bisect](./fix-plans).

## Diagnosis history

Every re-diagnose keeps the previous result; a nightly sweep keeps the newest 20 per cluster
(`PIWI_RETENTION_DIAGNOSIS_VERSIONS`, `0` keeps all). **History** in the panel header lists them
newest first, with the model, category, confidence and token cost, and shows what changed since each one.

A re-diagnose sends the previous assessment to the model: its category, confidence, summary and root cause, the
cluster's triage note, and, when you rated it unhelpful, your note and an instruction not to repeat it without new
evidence. A rating belongs to the version it rated: the new diagnosis starts unrated, and the history keeps the old
one's thumbs.

A diagnosis is flagged **may be stale** only when the evidence changed since it ran **and** the cluster is still
failing; the banner says whether new occurrences or new evidence caused it.

## Custom instructions

Tailor the analysis to your stack with **global** instructions (Settings → AI) and **per-project** instructions (Project → Settings → AI diagnosis). Use them to describe your architecture, common false positives, or house style for fixes.

## Context limits (and token cost)

Each input sent to the model is capped to keep diagnoses fast and affordable; the caps are set on the [AI provider](/guide/ai-provider#context-limits-and-token-cost) page.

## Privacy

API keys are encrypted at rest with [`PIWI_SECRET_KEY`](/reference/configuration#general). When you run a diagnosis, the bounded context above is sent to your configured provider; for fully local analysis, use Ollama or another self-hosted OpenAI-compatible model.

## Try it in the demo

The [live demo](https://piwitests.dev/demo/) needs no AI provider: some clusters carry a completed diagnosis with a validated patch, and the others run a simulated streaming diagnosis.

<DemoExamples />

## Related

- [Triage a run gone red](/recipes/mass-failure): clusters first, then a diagnosis for the few causes left
- [Failure clusters & the inbox](./failure-clusters): how failures are grouped, and whether the fix worked
- [Privacy & data flow](/guide/privacy): exactly what a diagnosis sends, and where
- [Notifications & alerts](./notifications): `diagnosis.completed`, `cluster.new`, `cluster.fixed` and `cluster.regressed`
- [MCP server](/features/mcp): let AI agents query clusters and diagnoses directly
