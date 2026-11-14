---
title: Privacy & data flow
description: "Exactly what leaves your server and when, what never does, what Piwi does not capture, and how secrets are stored."
lang: en-US
---

# Privacy & data flow

Test results are revealing: they carry your source paths, error messages, screenshots of your app,
network calls, and sometimes your git history. This page lists where they go.

**There is no telemetry**, no usage analytics, no crash reporting, and no license or
activation call. The server never checks for updates; the desktop app checks at startup (optional, in
**Settings → About**) and on **Check for updates**, then reads the newer releases' notes from GitHub, anonymously.
Every outbound call the server makes is listed below; all but two are opt-in.

## What leaves your server

| Destination | When | Carries |
|---|---|---|
| Your AI provider | Only if you configure [AI diagnosis](/features/ai-diagnosis) | The diagnosis context: error text, failing steps, test and related source files, console and network entries, page (ARIA/DOM) snapshots, server logs, the relevant git diff, and up to five failure screenshots by default (`PIWI_AI_MAX_IMAGES=0` sends none). [AI-step](/features/ai-steps) authoring sends masked page snapshots |
| Your git host | Whenever runs report a GitHub, GitLab or Bitbucket remote (the reporter records `origin` by default) | Without a token: anonymous public-API reads of the repository's default branch and its CODEOWNERS; the desktop app reads a project's linked clone with `git` instead, and asks the host only for a commit the clone lacks. With a token: commits, diffs and files, plus the PR comments, commit statuses, heal branches and CI re-runs of the features you turn on |
| A URL you attach as a link | When someone adds a link to a run, test or cluster | A request for its title (the git host's API for an issue or PR link) |
| Your issue tracker (Jira) | Only if you [connect it](/features/issue-tracking) | Issue reads, and the issues and comments you file |
| Zephyr Scale Cloud | Only if you [connect it](/features/test-management) | A run's results |
| Your CI server | Only if you [connect one](/features/ci-rerun) | The re-run or Flake Lab request |
| Your SMTP server | Only if you configure [email notifications](/features/notifications) | Notification and account emails |
| Slack, Teams or your webhook URLs | Only for subscriptions you create, and [report schedules](/features/quality-reports#report-schedules) that name the channel | The event payload (run status, cluster, test names, file paths, short error excerpts), or the quality report |
| Your S3 endpoint | Only if you switch [storage](/operate/storage) to S3 | Trace files, HTML reports, attachments |
| Your PostgreSQL server | Only if you [use one](/operate/database#postgresql) | Everything but the files |
| Google / GitHub | Only if you enable [OAuth sign-in](/operate/authentication#oauth-google-github) | OAuth exchange and profile picture |
| Your OpenTelemetry collector | Only if you name one ([tracing](/operate/tracing)) | A span per request and SQL statement, with its text |
| A project's OpenAPI URL | Only if a project [sets one](/features/scenario-gaps#declared-surface) | A request for the document |

The reporter sends your instance what its options switch on. [Code reach](/features/code-reach) and
[server coverage](/features/server-coverage), off by default, send repository-relative paths; line numbers and
blob ids only with `coverage.browser` or `coverage.server` set to `'functions'` or `'lines'`. `piwi coverage
upload` adds the commit's tracked paths. Source code and hit counts never leave.

Two rows need no setting, the anonymous git-host reads and a link's title: both fail quietly offline, so an
air-gapped instance works the same.

The **AI provider** alone receives your source code and the full failure context, at the endpoint
*you* set (a local model over Ollama or vLLM keeps it on the machine). Preview and cap that context:
[AI diagnosis → Privacy](/features/ai-diagnosis#privacy).

## What never leaves your server

- **Traces.** Your instance serves the Playwright trace viewer at `/trace-viewer/`: opening a trace
  uploads it nowhere, unlike the hosted `trace.playwright.dev`.
- **The API reference.** Rendered in-app from your instance's OpenAPI spec, with no third-party CDN, so it
  works offline.
- **Screenshots, videos, HTML reports.** Stored on your disk or S3 bucket, served by your instance.
- **HTML report execution.** Reports run their scripts in a CSP sandbox with a unique opaque origin, with an
  in-memory Web Storage facade for Playwright's settings UI, discarded with the report; they cannot read the
  dashboard's cookies or local storage. Uploaded reports remain untrusted active content.
- **Your IDE mapping.** The [Open in editor](/features/ide-integration) workspace root stays in your browser's
  local storage, never sent to the dashboard.

## What reaches your server from Piwi Picker

The [browser extension](/features/extension) works with no instance. Connecting sends the browser's and operating
system's names. Connected, it reads a project's URL patterns, function catalog and locator index, and sends a URL
pattern you add and a [bug report](/features/bug-reports), only on **Send** in its preview, which shows
exactly what goes. It carries the recorded steps with the values
typed (never a password, and none with **Leave out the values I typed**), and whichever evidence the reporter
kept ticked: screenshots of the tab, a screenshot of each step when the instance takes them, console errors and warnings, failed requests (method, path without query values,
status; never a header or a body) and an outline of the page. It goes only to the connected
instance, stored there like a run's evidence.

**Share result**, after a replay of a report from the instance, sends the verdict, the site it ran on and the
browser's name to that report, on **Send** in its preview.

Paired with the [desktop app](/features/extension-connection#pair-with-the-desktop-app), it also sends a
report's title and steps, with their typed values and nothing else, to that app on this machine on **Send** in the
**Run with Playwright** preview.

## What Piwi deliberately does not capture

Never captured, so it cannot leak:

- **Input values in locator snapshots.** The [capture fixtures](./capture-fixtures) record what an
  element *is* (role, accessible name, test id), never what was typed into it. Traces and the
  failure-time ARIA snapshot keep typed values, password fields too: don't fill real secrets in tests.
  Error call logs never keep them, nor a request's credential headers, nor steps or an assertion's values on a
  password field or one whose locator names a secret (`Mot de passe`).
  The **DOM** view and AI diagnosis show them, passwords masked.
- **Page-inventory field contents.** The [page inventory](./reporter#configuration-options)
  (`capturePageInventory`, **off by default**) records the names of a page's controls and links so the
  dashboard can tell which the suite never exercises. The name of a control that holds user input (a
  textbox, `select`, `textarea` or contenteditable editor) is never read from its content, so a
  recovery code or a draft never leaves the browser; link hrefs are stripped of their query and hash,
  which can carry signed tokens.
- **Storage and cookie values.** Page state records the *names* of `localStorage` /`sessionStorage`
  keys and their value lengths, and cookie names with their flags. Never the values. Focus, mouse and
  selection name elements, never values or selected text. A URL fragment's credentials are masked
  (`#access_token=[masked]`).
- **Sensitive headers.** `Authorization`, `Cookie` and friends are masked server-side in Piwi's trace
  network view, as are token-shaped strings in URLs, bodies and [test errors](/reference/test-metadata#test-errors).
  Piwi stores the trace file split and compressed but with its content unchanged, so the trace viewer and a
  downloaded trace still show them.
- **Backend logs, in production.** The [backend-log integrations](./backend-logs) emit their header only
  in development and test environments by default.

## Secrets at rest

Credentials you store in the dashboard are encrypted with AES-256-GCM using `PIWI_SECRET_KEY`:
AI provider keys, SCM tokens (the instance's and each project's), webhook signing secrets, Slack bot
tokens, the Jira and Zephyr Scale connections' credentials, CI server tokens, and a scheduled
report's share-link token on its way to delivery. **Set it in production.** Unset, or set to the
published development default, the dashboard refuses to save a credential and names the variable.
Generate a key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

API keys are stored as SHA-256 hashes and shown once, at creation. A leaked database gives an
attacker no usable key.

Secrets set by environment variable are never written to the database nor returned by the API:
the settings UI shows them read-only, with a lock badge.

## The demo

The [live demo](https://piwitests.dev/demo/) has no backend: the real application runs in a service
worker, against an in-browser SQLite database of fake data. Nothing you click reaches a server.

## Retention

The data you keep is yours to manage: `PIWI_RETENTION_DAYS` prunes old runs and their files
nightly, or delete in bulk from **Settings → Storage**.
Deleting a run removes its executions, traces, reports, and any evidence payloads nothing else
references: [Storage → Data retention](/operate/storage#data-retention).

## Verifying any of this

The source is public and the outbound surface small: watch the container's egress, or read
[`server/utils/`](https://github.com/PiwiTests/piwi/tree/main/apps/application/server/utils): the AI
provider, SCM, SMTP, notification, OAuth, Jira, Zephyr Scale, CI server, OpenTelemetry, OpenAPI, avatar and
link-unfurl clients alone open a socket there; the S3 client is in `server/storage/`, PostgreSQL's in
`server/database/`.

## Related
- [Authentication](/operate/authentication), [API keys](/operate/api-keys) and [Access, roles and groups](/operate/project-access)
- [Production checklist](/operate/production-checklist#before-you-expose-it): hardening a public instance
- [Why Piwi?](./comparison#is-my-data-safe-does-piwi-phone-home): the short form
