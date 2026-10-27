---
title: DeepSeek CLI
description: "Use the official DeepSeek Harness command line tool for Piwi diagnosis and the assistant, with private profiles and scoped read-only MCP access."
lang: en-US
---

# DeepSeek CLI

Piwi uses the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) command line tool, `dsh`.
It runs diagnosis, research and assistant roles using your DeepSeek credentials. No OpenAI API key is used.

## Setup

Install the supported official developer-preview release on the machine running Piwi:

```bash
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
```

Sign in through `dsh web`, or configure `DEEPSEEK_API_KEY` for that machine. Piwi reads the DeepSeek account grant or
saved DeepSeek API-key reference from `DSH_HOME/.credentials.yaml` (default: `.dsh/.credentials.yaml` in your home
directory). A saved account takes precedence; a saved API key takes precedence over the environment key.
Other provider credentials and `.env` files are excluded.

Select **DeepSeek Harness (local)** in **Settings → AI**. The desktop app discovers `dsh` on PATH; servers opt in by
setting `PIWI_DEEPSEEK_CLI_PATH` to its absolute launcher path. Use `PIWI_AI_PROVIDER=deepseek-cli` for environment-managed
configuration. No API key is stored in Piwi for this provider. **Recheck** reports installation compatibility and local
credential presence; credential validity is checked when a model is called. Sign-in and sign-out remain in Harness.

The integration targets `0.2.1-rc.2`. Harness is in developer preview, so Piwi refuses other versions until their
profile and event contracts have been verified.

## Models and output

Blank model fields use `deepseek-flash`; enter another model ID supported by your DeepSeek account or API access.
Embeddings need an OpenAI-compatible provider. CLI diagnosis sends text evidence and omits image attachments.

The official CLI emits JSONL messages, per-step usage and a final answer. Text streams in completed-message chunks.
Piwi adds cache reads and writes to uncached input tokens for its total input count, and reports the cache counts
separately. Missing usage stays unknown. Dollar cost is unknown because the CLI does not report it.

JSON Schema requests are included in the system instructions. Harness has no native JSON Schema output flag in this
release, so schema-conforming output depends on the model; this is not a strict structured-output guarantee.
Intermediate commentary is excluded from the returned structured answer.

## Isolation

Each run uses a private temporary home, working directory and generated profile with no inherited bundles. The profile
contains only official model and agent plugins, with the turn's Piwi MCP client added for assistant runs. Shell,
filesystem, web, skill, plugin-management and project-instruction plugins are absent. User profiles, plugins, endpoint
overrides, runtime injection variables and unrelated credentials are excluded.

Only the selected DeepSeek credential is copied. The assistant's MCP token stays in a private profile file, outside the
command line. The existing turn endpoint enforces the asking user's project scope, read-only tools and answer limits;
the token is revoked when the turn ends. Processes are killed at the turn timeout, and temporary files are removed.

## Related

- [AI provider](/guide/ai-provider)
- [Codex CLI](/guide/codex-cli)
- [Assistant](/features/assistant)
