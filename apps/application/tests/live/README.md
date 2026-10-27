# Live E2E tests

These specs talk to **real** external services, so they are excluded from the main Playwright suite
(`playwright.config.ts` ignores `tests/live/`), each carry their own config, and run only on demand. They cost tokens
or write to a real account — never wire them into `push`/`pull_request` CI.

## AI diagnosis — `ai-diagnosis-live.spec.ts`

The real two-stage diagnosis pipeline against a real model.

```bash
OPENCODE_API_KEY=<key> npm run app:test:ai:live
```

Uses its own port and a throwaway SQLite DB under `.live-temp/diagnosis/`.

## Assistant — `assistant-live.spec.ts`

The assistant's answers to about 150 questions over the demo seed, measured against a real model. The questions are
in `assistant-questions.ts`, spread over eight topics (why a failure happened, flaky tests, what changed in a run,
where a setting is, how to set something up, what Piwi is, show-me guides, changes to apply); some are asked on a
page, with the page context the panel sends. Each names the tools a good answer calls, the facts it must say (from the
failure stories, the demo examples, the seed or the bundled docs), the blocks that fit it (a proposal card for a
change) and, for a guide, the anchors it should stop on. `tests/unit/assistant-questions.test.ts` checks the set
itself in the normal unit suite, with no model.

```bash
OPENCODE_API_KEY=<key> npm run app:test:assistant:live
```

```powershell
$env:OPENCODE_API_KEY='<key>'; npm run app:test:assistant:live
```

- **The model**: the same variables as the diagnosis run, an OpenAI-compatible endpoint: `OPENCODE_API_KEY` (or
  `PIWI_AI_API_KEY`), `PIWI_AI_BASE_URL` (default `https://opencode.ai/zen/v1`) and `PIWI_AI_MODEL` (default
  `deepseek-v4-flash`). `PIWI_AI_ASSISTANT_MODEL` and its siblings give the assistant its own model, as on a server.
- **What it costs**: one conversation per question, each a few model calls that carry the tool definitions and tool
  results of up to 12,000 characters: tens of thousands of input tokens a question, several million for the whole
  set. The summary counts the tokens of each topic. The daily assistant caps are off for the run. `PIWI_ASSISTANT_LIVE_QUESTIONS` asks part of the set: question ids or topics, comma-separated
  (`PIWI_ASSISTANT_LIVE_QUESTIONS=flaky,show-me`).
- **The server**: it seeds a throwaway SQLite database from the demo seed under `.live-temp/assistant/server/` and
  boots its own dev server on port 3104 (build cache in `.live-temp/assistant/nuxt-build/`), so a dev server on 3000
  can keep running.
- **The report**: `.live-temp/assistant/report.json` holds every answer with its score, the tools it called, its
  blocks and anchors and the facts it missed; `.live-temp/assistant/summary.md` scores each topic and the whole run
  and lists the weakest answers. Both are rewritten after every answer, so an interrupted run leaves what it got.
- **Scoring**: an answer scores the mean of its checks: it called one of the expected tools without an error; the
  share of its facts it says, in its text or its blocks' words; it has one of the expected blocks; its guide stops on
  one of the expected anchors. An answer that ended in an error scores 0. The run fails only when the overall score
  is below `PASS_THRESHOLD` in `assistant-scoring.ts`.

To check the runner, the scoring and the report with no key and no tokens, run it against the scripted mock model: it
answers four questions as their expectations describe and one badly, and the run checks the scores and the report it
gets.

```bash
PIWI_ASSISTANT_LIVE_MOCK=1 npm run app:test:assistant:live
```

```powershell
$env:PIWI_ASSISTANT_LIVE_MOCK='1'; npm run app:test:assistant:live
```

## Jira Cloud — `jira-live.spec.ts`

The real Jira integration against a Jira Cloud site. It files a **French** issue, reads it back through the Jira REST
API (asserting the French headings, the `piwi` labels and the `Piwi-Cluster:` trailer), exercises a policy comment and
**one transition** through the milestone-3 sync policies, and then **deletes every issue it created** plus any stray
issue carrying the `piwi-live-test` label — so a free-plan site never fills up. Every issue it files carries
`piwi-live-test`.

```bash
PIWI_JIRA_BASE_URL=https://your-team.atlassian.net \
PIWI_JIRA_EMAIL=you@example.com \
PIWI_JIRA_API_TOKEN=<token> \
PIWI_LIVE_JIRA_PROJECT_KEY=PIWI \
npm run app:test:jira:live
```

- The config throws a clear error at load if any of the four variables is unset.
- It boots the server with the env-managed Jira connection (from `PIWI_JIRA_*`) and its own port + `.live-temp/jira/`
  DB, so it never touches a real dashboard database.
- Issue types, priorities and transitions are addressed **by id**, so a French-configured site (French issue-type and
  status names) works unchanged — that is part of what this test proves.
- A classic or a scoped token works. The spec's own read-back and cleanup calls route a scoped token through the
  `api.atlassian.com` gateway, as the server does. The token's account needs the **Delete Issues** project permission
  on top of the ones the integration needs, or the cleanup leaves the issue behind (the run logs a warning).
- The GitHub Actions workflow `.github/workflows/live-jira.yml` runs it on `workflow_dispatch`, mapping the four
  repository secrets of the same names into the job.

> **Never commit credentials.** `.env*` is gitignored; pass the values through the environment.
