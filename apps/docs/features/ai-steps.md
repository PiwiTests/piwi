---
title: AI steps
description: "Write test steps in plain English: an agent resolves each one once into a committed artifact, and CI replays it as ordinary Playwright with no model calls."
lang: en-US
---

# AI steps

AI steps let you locate elements and drive flows in **plain English**, without giving up the determinism of hand-written Playwright:

```typescript
// Find one element by description
await page.piwiLocator('the email address field').fill('ada@example.com')

// Run a whole flow, with type-safe parameters
await page.piwiRun('sign in as {email}', { email: 'ada@example.com' })
```

The guiding principle is **the LLM is a compiler, not a runtime**. The first time a prompt is seen, an agent resolves it **once** into a committed, deterministic JSON artifact. Every run after that *replays* that artifact with ordinary Playwright calls — **zero LLM calls and zero network** in the default `replay` mode. Your CI stays fast, offline, and reproducible; the model is only ever involved while authoring.

::: tip This composes with the capture fixtures
AI steps are a separate opt-in from the [capture fixtures](/guide/capture-fixtures), and compose with them. Replayed actions flow through the instrumented page, so they feed traces, reports, and [locator healing](/features/locator-healing) exactly like hand-written code.
:::

## Setup

Extend your test with `extendPiwiAi`. Compose it over `extendPiwiFixtures` to get the capture fixtures too:

```typescript
// tests/fixtures.ts
import { test as base } from '@playwright/test'
import { extendPiwiFixtures, extendPiwiAi } from '@piwitests/reporter'

// AI steps + capture fixtures
export const test = extendPiwiAi(extendPiwiFixtures(base))
export { expect } from '@playwright/test'
```

`page` now carries two extra methods:

| Method | Returns | Use for |
|--------|---------|---------|
| `page.piwiLocator(template)` | a real, synchronous `Locator` | locating one element by description |
| `page.piwiRun(template)` | `Promise<void>` | replaying a compiled multi-step flow |

While a missing entry is being authored (`resolve` mode), `piwiLocator` returns a stand-in that supports direct actions such as `.fill()` and `.click()`, but not chaining (`.first()`) or `expect(...)`; those work once the entry is committed.

Placeholders are type-checked at compile time: a template with `{param}` **requires** a matching params object, and a misspelled or missing name is a TypeScript error.

```typescript
await page.piwiRun('add {qty} of {sku} to the cart', { qty: '2', sku: 'PIWI-1' })
```

## The lifecycle: author once, replay forever

An AI step moves through three modes, set with the `ai.mode` option or `PIWI_AI`. An `ai.mode` set in `wrapConfig` overrides `PIWI_AI`, including the one `piwi ai resolve` sets:

| Mode | What it does |
|------|--------------|
| `replay` *(default)* | Executes the committed artifact read-only. **Never** calls the model. Fails closed on a missing entry. |
| `resolve` | Authors any missing entry by driving the model, verifies it against the live page, and writes it to disk. |
| `heal` | Not available yet: currently behaves exactly like `resolve` — committed entries are replayed as they are, and missing ones are authored. |

The intended workflow:

1. **Write** the test with `piwiLocator` / `piwiRun` prompts.
2. **Author** locally in `resolve` mode (see below). The agent produces a JSON artifact next to your spec under `__piwi__/`.
3. **Commit** that artifact to git alongside the test.
4. **Replay** everywhere else — locally and in CI — with zero model calls.

### Authoring (resolve mode)

Authoring needs a running Piwi dashboard with an AI provider configured (**Settings → AI**, or the `PIWI_AI_PROVIDER` [environment variables](/reference/configuration#ai-diagnosis)). The reporter sends each iteration to the server; the server calls the model and returns one decision, which the reporter compiles deterministically. **API keys stay on the server.**

Point the reporter at that server and run the suite in resolve mode:

```bash
export PIWI_DASHBOARD_URL="https://piwi.example.com"   # the authoring server
export PIWI_API_KEY="…"                                # a key with upload rights
export PIWI_AI=resolve

npx playwright test           # or: npx piwi ai resolve --grep "sign in"
```

`piwi ai resolve` runs the suite in resolve mode for you (forcing `--workers=1` so authoring is serial). Once it finishes, review and **commit** the generated files.

::: warning Authoring drives the real page
In `resolve` mode each step is executed against the live page with your real parameter values so the flow can advance. Author against a disposable environment, not production.
:::

### Replay and CI

In `replay` mode a missing entry is a hard, actionable failure — the run does not silently pass and does not reach for a model:

```
piwi AI: no committed entry for "sign in as {email}" in test "checkout".
  expected file: tests/__piwi__/checkout.spec.ts/checkout.sign-in-as-email.a1b2c3d4.json
  run:  piwi ai resolve --grep "checkout"
```

That means an environment with no model access (a locked-down CI runner, an air-gapped box) can never accidentally author — it either replays a committed artifact or fails. If you would rather a missing entry mark the test **fixme** (yellow) instead of failing red, set `ai.onMiss: 'fixme'` (`PIWI_AI_ON_MISS=fixme`).

Replay is plain Playwright: commit the artifacts and your existing CI job replays them.

## What's inside an artifact — and why it's safe

An entry is **data, never code**: an allowlisted locator program plus, for a flow, an ordered list of steps and a postcondition oracle. Determinism and safety come from several guarantees:

- **Deterministic bytes.** The model only *names* an element (its ARIA role, accessible name and snapshot `ref`); the [`@piwitests/core`](/guide/concepts#locator-snapshot) scorer turns that into the committed locator, or Playwright's own locator for the `ref` when two elements share the name. Sampling never changes the file; a no-op re-resolution leaves the tree clean.
- **No evaluation.** Every locator method and action is checked against an allowlist before it touches the page. A tampered or malformed artifact can never become arbitrary execution.
- **Drift guard.** Each step records the element's role/name at author time. On replay, if the page positively shows that element has drifted (a rename), the flow **stops before acting** rather than clicking the wrong thing.
- **Postcondition oracle.** Every flow ends with an assertion the agent chose (an element became visible/hidden, or the URL changed). Replay verifies it, so a subtly wrong flow fails loudly instead of passing.
- **Ajax waiting, race-proof.** A step can wait for a network response it triggers (an XHR/fetch the agent observed while authoring). The wait is armed *before* the action fires, so a fast reply can never slip through the gap.

## Intent in the dashboard

Each test's replayed AI steps are reported to the dashboard as a small usage manifest: the committed artifacts it exercised (powering the project's **AI steps** liveness tab) plus **intent mappings** — each compiled locator paired with the prompt it came from. Two places use them:

- **Locator healing**: when the failing locator was compiled from a prompt, the healing panel shows it — *"Compiled from prompt: 'the email address field'"* — so you fix the intent, not just the selector.
- **AI diagnosis**: the diagnosis context includes an *AI Steps* section listing the prompts behind the test's locators, so a root cause can be phrased in intent terms ("the element the test calls *the email address field* was renamed"). Capped by `PIWI_AI_MAX_STEP_INTENTS` (default 20, `0` disables).

Intent mappings keep `{param}` placeholders and `{{param}}` markers: parameter values never appear.

## Privacy

Parameter values are **masked out of everything sent to the model**, with one exception: the opt-in `screenshotFallback` image is sent as-is. The page snapshot the agent sees has your `{param}` values replaced with markers, and placeholders survive compilation as markers that are substituted locally at replay. With `screenshotFallback` off (the default), secrets in parameters never leave your machine. See [Privacy & data flow](/guide/privacy) for the full picture.

## Keep the artifacts healthy

`piwi ai check` is offline and fits a CI lint step: it exits `1` on an entry whose prompt was deleted or renamed, or a
file that isn't in canonical form, and reports two prompts that collide as a warning that does not fail it.
`piwi ai prune` is not available yet (it exits `2`): delete an orphaned entry's file by hand, and re-author a
non-canonical one with `piwi ai resolve --update-ai`. Every subcommand and flag is in the
[CLI reference](/reference/cli#ai).

## Configuration

Set these under the `ai` key of `wrapConfig`'s second argument, which copies them into the `PIWI_AI*` variables the
test workers read; an `ai` key on a plain `['@piwitests/reporter', { … }]` entry is ignored, so without `wrapConfig`
use the environment variables. Every option has an environment-variable equivalent, and all
of them are in the [AI steps section of Reporter options](/reference/reporter-options#ai-steps). Authoring also reads
`PIWI_DASHBOARD_URL` and `PIWI_API_KEY` (the server that runs the model), and `PIWI_AI_UPDATE=true` (or
`--update-ai`) forces re-authoring of entries that already exist.

On the **server** side, two limits bound each authoring iteration (see the
[AI steps section](/reference/configuration#ai-steps) of the configuration reference):

- `PIWI_AI_STEP_MAX_SNAPSHOT_CHARS`: snapshot characters the model receives.
- `PIWI_AI_STEP_MAX_OUTPUT_TOKENS`: output tokens the model may return. **Reasoning models** spend tokens on hidden
  chain-of-thought, so raise this (up to `8192`) when authoring with one, or the JSON decision can be truncated.

A key makes at most 300 authoring calls in five minutes (a 20-step flow takes about 40), then gets a 429.

## Related

- [Reporter](/guide/reporter) — installing and configuring the reporter.
- [Capture fixtures](/guide/capture-fixtures) — the sibling opt-in that powers healing and performance data.
- [AI diagnosis](/features/ai-diagnosis) — the dashboard's failure-analysis AI (a different feature that reuses the same provider config).
