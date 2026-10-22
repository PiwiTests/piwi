---
title: AI provider
description: "Connect an LLM to the dashboard: Anthropic, OpenAI, a local OpenAI-compatible model or the Claude Code CLI, with model roles, response language and token limits."
lang: en-US
---

# AI provider

Piwi works without a model. Connect one and it powers [AI diagnosis](/features/ai-diagnosis) (the explanation of a
failure cluster or a single execution, and the cluster titles), semantic merging of failure clusters, the
**Fixed before** matches of [fix plans](/features/fix-plans#fixed-before), the authoring of [AI steps](/features/ai-steps)
and the AI narrative of [quality reports](/features/quality-reports). All of them use the same provider, configured
once on the server; API keys never leave it.

## Enabling AI diagnosis

Configure a provider via **Settings → AI**, or with environment variables. `PIWI_AI_PROVIDER` is the switch: once it
is set, the provider configuration comes from the environment and the UI shows its provider, key and base URL
read-only. A model or temperature picked in the UI still overrides the env one, and a role the environment leaves out
can be turned on in the UI by reusing a role it sets. Without `PIWI_AI_PROVIDER`, the other provider variables below
are not read.

| Variable | Description |
|----------|-------------|
| `PIWI_AI_PROVIDER` | `anthropic`, `openai`, or `claude-cli` |
| `PIWI_AI_API_KEY` | Provider API key (stored encrypted when set via the UI; never returned by the API) |
| `PIWI_AI_MODEL` | Model name (default: `claude-opus-4-8` for Anthropic) |
| `PIWI_AI_BASE_URL` | Base URL of the provider API: required for `openai`, OpenAI itself (`https://api.openai.com/v1`) included; optional for `anthropic` (a gateway or proxy) |
| `PIWI_AI_AUTO_DIAGNOSE` | `true` to diagnose, when a run finishes, the clusters that failed in it and have no completed diagnosis yet |
| `PIWI_AI_AUTO_DIAGNOSE_MAX` | Max clusters auto-diagnosed per finished run (budget cap; default `3`) |
| `PIWI_AI_RESEARCH_MODEL` / `_PROVIDER` / `_BASE_URL` / `_API_KEY` | Optional **research** model for two-stage diagnosis; provider/base URL/key default to the main ones |
| `PIWI_AI_EMBEDDING_PROVIDER` / `_MODEL` / `_BASE_URL` / `_API_KEY` | Optional **embedding** model for semantic failure clustering (OpenAI-compatible only: Anthropic has no embeddings API) |

A saved key is sent only to the provider and base URL it was saved for: pointing a role at another base URL in
**Settings → AI**, or testing one there, needs the key entered again.

The [Configuration reference](/reference/configuration#ai-diagnosis) lists every AI variable.

When a run finishes and `PIWI_AI_AUTO_DIAGNOSE` is on, the `PIWI_AI_AUTO_DIAGNOSE_MAX` budget is spent where it buys the most. The run's clusters are ordered by their representative failing execution's top [clue](/features/evidence#clues): a cluster whose failure carries **no deterministic clue** (the one the model has to reason about from scratch) goes first, then the ones with only a weak clue, and only then a failure a strong clue already explains, with the newest cluster breaking ties. A cluster that already has a completed or a running diagnosis is left out before the ordering, so a recurring, already-diagnosed cluster never takes one of the slots. Ignored clusters are left out too. A diagnosis you rated unhelpful takes a slot again once the evidence has changed since it ran, once per rating.

### Streaming diagnosis

A diagnosis streams: the model's reasoning appears in a live panel as it arrives, with a stage indicator (*Researching patterns* while a
[research model](#model-roles) pre-analyzes the failure, when one is configured, then *Diagnosing root cause*), and turns
into the result card when it completes. The [API docs](https://piwitests.dev/demo/docs) describe the streaming
protocol (the in-app reference at `/docs` shows the same spec).

To be told when a diagnosis finishes without watching the panel, turn on **Settings → AI → Diagnosis notifications**: a per-browser preference (stored on that device only) that shows a browser notification on completion once you grant the permission.

## Model roles

Piwi calls models in up to four distinct roles, each with its own complete provider configuration (or a **reuse** pointer to inherit another role's provider and credentials):

- **Diagnosis**: the main model that writes the final diagnosis (required to enable AI). The quality report narrative uses it too.
- **Research**: an optional cheaper, faster model that pre-analyzes the failure first (*two-stage diagnosis*).
- **Embedding**: an optional embeddings model that powers semantic failure clustering and the **Fixed before** similarity.
- **Assistant**: an optional model the [assistant](/features/assistant) answers with; unset, it uses the diagnosis model.

Configure each role in **Settings → AI → Model providers**. A role set to *reuse* another role uses that role's provider, key, and base URL (only its model can differ), so you don't re-enter credentials for, say, a Haiku research pass on the same Anthropic key.

## Providers

**Anthropic (recommended)**

```bash
PIWI_AI_PROVIDER=anthropic
PIWI_AI_API_KEY=sk-ant-...
PIWI_AI_MODEL=claude-opus-4-8
```

**OpenAI**

```bash
PIWI_AI_PROVIDER=openai
PIWI_AI_API_KEY=sk-...
PIWI_AI_BASE_URL=https://api.openai.com/v1
PIWI_AI_MODEL=gpt-4o
```

**OpenAI-compatible or local (Ollama, LM Studio, vLLM)**: set the provider to `openai` and point the base URL at the local endpoint:

```bash
PIWI_AI_PROVIDER=openai
PIWI_AI_BASE_URL=http://localhost:11434/v1
PIWI_AI_MODEL=llama3.1
PIWI_AI_API_KEY=ollama   # optional: sent only when set, for servers that check one
```

A local model keeps every diagnosis on your own infrastructure; see [Privacy & data flow](./privacy).

**Claude Code CLI (local, no API key)**: in the [desktop app](/features/desktop), pick **Claude Code (local)**. It runs the local `claude` CLI with your Claude Code sign-in, so **Settings → AI** manages sign-in and shows a live usage tally. Every role but embeddings can use it; `PIWI_CLAUDE_CLI_PATH` overrides the path. Each call runs with every tool and MCP server off, for one turn, and with none of the server's own environment variables, so an error message in a prompt cannot make the CLI run a command; a Claude Code version too old to turn its tools off is refused until you update it. The CLI reads the prompt as text, so a diagnosis it writes gets no screenshot.

Each role's form in **Settings → AI** has a **Test connection** button that checks its provider. The dashboard shows its AI actions only once a provider is configured.

## Response language

Set a **response language** and every free-text field a person reads (summary, root cause, evidence, fix description and
AI-generated cluster titles) comes back in that language, while code, locators, paths and error text stay verbatim. Set
it instance-wide in Settings → AI (or [`PIWI_AI_LANGUAGE`](/reference/configuration), e.g. `French`, which locks the
field), and override it per project under Project → Settings → AI diagnosis. This is what makes a French ticket's *Most
likely* section French: the ticket's copy follows the [destination's language](/features/issue-tracking#language) and
the prose follows this setting. Unset, responses are in English.

## Context limits (and token cost)

Every piece of evidence sent to the model costs tokens. Piwi caps each input so diagnoses stay fast and affordable. Override the caps in **Settings → AI** or via env (env wins; the UI then shows the field read-only).

The full list of `PIWI_AI_MAX_*` limit variables, their defaults and their clamping ranges lives in the [Configuration reference → AI context limits](/reference/configuration#ai-context-limits), generated from the same registry the server reads. The diagnosis context preview (**Context sent to AI**) shows what was trimmed to fit before you spend tokens.

Screenshots are the one input a provider can refuse outright: many self-hosted and gateway models are text-only and reject a request that carries images. Piwi retries that call without them, so the diagnosis still runs on the text evidence. Setting `PIWI_AI_MAX_IMAGES=0` skips the rejected first attempt.

## Usage and quality

**AI usage** in Settings → AI counts, per provider and model over 7, 30 or 90 days, the diagnoses, the failed ones,
the tokens and the average duration. A second table says how each model's diagnoses fared:

- **Rated helpful**: thumbs up over every rating. The share appears from 10 ratings; below that the panel says the
  sample is too small.
- **Patches that apply**: suggested patches that [apply](/features/ai-diagnosis#validated-patches) to the source
  they name, over every patch that could be checked.
- **Verified by the fix**: diagnoses whose cluster was fixed by a change to the files they named.
- **Regressed**: verified diagnoses whose failure came back.

Diagnoses an agent recorded get their own row, under the model it named. Each diagnosis also stores a hash of the
instructions it was written under (`promptSha` in its details), so diagnoses written before and after a change to
the custom instructions or the language can be told apart. Piwi never switches models on these numbers; the
[Analytics](/features/analytics#hand-back-outcomes) page shows the same ratings across projects.

## Related

- [AI diagnosis](/features/ai-diagnosis): what a diagnosis contains and how to run one
- [Source control](./source-control): the diffs and source files a diagnosis reads
- [Privacy & data flow](./privacy): exactly what a diagnosis sends, and where
- [Configuration reference](/reference/configuration#ai-diagnosis): every AI variable
