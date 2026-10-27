---
title: Codex CLI
description: "Use a local Codex ChatGPT login for Piwi diagnosis and the assistant, with isolated execution, structured output and scoped read-only tools."
lang: en-US
---

# Codex CLI

Piwi can use [Codex CLI](https://github.com/openai/codex) for diagnosis, research and the assistant without an OpenAI
API key. The CLI must be installed on the machine running Piwi.

## Setup

1. Install Codex CLI and run `codex login` with your ChatGPT account.
2. Choose **Codex (local)** in **Settings → AI**. The desktop app finds `codex` on PATH; a self-hosted server enables it
   with `PIWI_CODEX_CLI_PATH` pointing to the executable's absolute path. Alternatively, set `PIWI_AI_PROVIDER=codex-cli`
   for environment-managed settings.
3. Use **Recheck** in the status card to check availability, version and authentication. Sign-in and sign-out stay in
   Codex. No API key or Piwi secret-encryption key is needed for this provider.

Piwi reuses the file-backed login at `CODEX_HOME/auth.json` (default: `.codex/auth.json` in your home directory).
For a keyring-only login, set `cli_auth_credentials_store = "file"` in your Codex configuration and run `codex login`.
Use a recent CLI with the isolation flags; Piwi refuses incompatible versions.

## Models and output

Diagnosis, research and assistant roles accept a model ID; blank uses `gpt-5.4`. Embeddings need an OpenAI-compatible
provider. Codex receives JSON Schema through its structured-output option. Its JSONL events stream completed messages,
so text can arrive in message-sized chunks. Input-token counts already include cached input tokens; the cached count
is also reported separately. Codex does not report a dollar cost, so Piwi leaves it unknown. Image attachments are
omitted for CLI diagnosis; text evidence is still sent.

## Isolation

Each invocation uses a private temporary home and working directory with only a login snapshot. Refreshed credentials
are saved back if the source login is unchanged. User configuration, project instructions, skills, hooks, plugins and
unrelated credentials are excluded. Built-in execution, filesystem and web tools are disabled. The assistant receives
only its turn's MCP endpoint, with its short-lived token and allowed tools; calls retain the asking user's project
scope, read-only access and answer limits. Temporary files are removed when the process exits or times out.

## Related

- [AI provider](/guide/ai-provider)
- [Assistant](/features/assistant)
- [Configuration reference](/reference/configuration#ai-diagnosis)
