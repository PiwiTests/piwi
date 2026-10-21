# Connecting Piwi Picker in one step, with URL patterns kept on the server

- Status: accepted
- Date: 2026-09-28

A design record for two changes to how the browser extension (`apps/extension`) and a Piwi instance
(`apps/application`) meet: a **Connect** button that replaces pasting an API key, and **project URL patterns** that
live on the instance instead of in each browser.

## Problem

Connecting Piwi Picker today takes four steps in two places: open the dashboard, create an API key, copy it, paste it
into the extension's settings with the instance URL, then type one URL pattern → project mapping per site. The
mappings live in `chrome.storage.local` only, so every tester of a team types the same patterns again, and a pattern
fixed in one browser stays wrong in all the others. The instance already knows which sites a project's suite visits
(the pages its locators ran on, the page nodes of the Test Map), yet nothing suggests a pattern from them.

## The connect flow

An OAuth 2.0 device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)), adapted to Piwi's
JSON conventions. It needs no page scraping, no `externally_connectable` (whose `matches` cannot list arbitrary
self-hosted origins) and no redirect URI registered per browser, so it works the same in Chrome, Edge and Firefox.

1. The user types the instance URL and clicks **Connect**. Inside that click, the settings page requests the
   instance's origin as an optional host permission (the one permission connecting needs; nothing standing changes).
2. The extension calls `POST /api/extension/connect` with its browser and operating system. The instance answers
   `{ deviceCode, userCode, verificationUrl, interval, expiresIn }`.
3. The extension opens `verificationUrl` (`/extension/connect?code=ABCD-EFGH`) in a tab and shows the same code.
4. That page requires a session. Signing in, with a password or through OAuth, returns to it (`/login?redirect=…`;
   an OAuth sign-in carries the path through a short-lived cookie). It shows who is connecting
   ("Piwi Picker in Chrome on Windows"), the code, and **Allow** / **Deny**.
5. The extension polls `POST /api/extension/connect/token` with the device code every `interval` seconds. Once the
   user allowed, the answer carries a new API key for that user, created at that moment and named after the browser.
   The extension stores it, closes the tab it opened and shows "Connected as <name>".

Pasting a key stays available under **Use an API key instead**.

With authentication off there is no account to own a key: **Allow** still has to be clicked, and the token answer
carries an empty key, which is what the extension already sends to such an instance.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/extension/connect` | public | Start: `{ browser?, os? }` → `{ deviceCode, userCode, verificationUrl, interval, expiresIn }` |
| `POST /api/extension/connect/token` | public (the device code) | Poll: `{ deviceCode }` → `{ status }`, one of `pending`, `slow_down` (with `interval`), `denied`, `expired`, or `approved` with `apiKey` and `user` |
| `GET /api/extension/connect/request?code=` | any signed-in user | What the verification page shows: client name, code, expiry, status |
| `POST /api/extension/connect/decision` | any signed-in user | `{ userCode, allow }` → the request's new status |
| `GET /api/extension/url-patterns` | any signed-in user (the key) | Every pattern of every project the user can see, with the projects the user may edit, and the user's name |
| `GET /api/projects/:id/url-patterns` | project access | The project's patterns, in order, each with `environment`, `branch`, `pathPrefix` and `testPathPrefix` |
| `PUT /api/projects/:id/url-patterns` | administrator | Replace the list (the settings editor) |
| `POST /api/projects/:id/url-patterns` | administrator | Add one (the extension's **Add to Piwi**); 409 when the project has it already |
| `GET /api/projects/:id/url-patterns/suggestions` | project access | Origins the suite visited, as `https://host/**` patterns |

The polling answer is a 200 with a `status` rather than RFC 8628's 400 error codes: every other Piwi endpoint
reserves 4xx for a request that is wrong, and a pending authorization is not one. Only the rate limit answers 429.

Editing a project's patterns takes the role that edits the project itself (administrator, like
`PATCH /api/projects/:id`), checked before any lookup. Reading them takes access to the project.

## Tables

**`extension_device_codes`** — one row per connect attempt.

| Column | |
|---|---|
| `device_code_hash`, `user_code_hash` | SHA-256 of each code; the plaintext of neither is stored |
| `client_name` | "Piwi Picker in Chrome on Windows", built by the server from two sanitized words |
| `status` | `pending` → `approved` or `denied` → `consumed` |
| `user_id` | who decided; null until then |
| `api_key_id` | the key the token answer created (set null if the key is revoked) |
| `interval_seconds`, `last_polled_at` | the polling contract |
| `expires_at`, `decided_at`, `created_at` | |

Rows expired for more than a day are deleted on the next start.

**`project_url_patterns`** — `(project_id, pattern, environment, branch, path_prefix, test_path_prefix, position)`, unique on project and pattern,
deleted with the project. `pattern` uses the extension's glob syntax unchanged (`urlMatches` in
`@piwitests/core/function-match`: `*` within one path segment, `**` across segments, the whole URL anchored), so a
local mapping and a server pattern mean the same thing. `environment` is a free label (`staging`, `production`); the
extension shows it beside the project. `branch` is what the local mapping's branch already is: the branch deployed at
those URLs, which Tested elements reads. `path_prefix` (added with the path-prefix mapping of
[`locator-stability-and-pages.md`](locator-stability-and-pages.md), open question 2) is the part of the site's path the
tests never saw: `/app` for a site serving `/app/checkout` whose tests ran at `/checkout`. It is normalized by
`parsePathPrefix` in `@piwitests/core/page-key` (a leading slash, no trailing one, no query, hash or wildcard, at most
four segments), on the server and in both editors, and a local mapping carries the same field. `test_path_prefix` is
the reverse, the part of the path the tests ran under and the site does not, with the same rules. Wherever the
extension compares the open page with the tests' page keys (This page, Missing here, Several match here, the pick
results) and in a bug report's page key, it removes the path prefix first, whole segments only (`/application` keeps
its path), then puts the tests' prefix in front; a path outside a set path prefix is left as it is. The report's
context names both prefixes, so its "why the suite missed it" lookup maps the steps' pages the same way.

## Security choices

- **Codes.** The device code is 256 random bits (`pdc_` + hex). The user code is 8 characters from a 20-letter
  alphabet without vowels or look-alikes (`BCDFGHJKLMNPQRSTVWXZ`, shown `ABCD-EFGH`), 34 bits, enough for a code
  that lives ten minutes behind a rate limit. Both are stored hashed.
- **Lifetime.** A request expires after 10 minutes. The key is created when the token call first sees the request
  approved, in the same update that marks it consumed (`WHERE status = 'approved'`), so two concurrent polls cannot
  both receive a key and a key is never returned twice. The plaintext key is never stored.
- **Rate limits.** Per client address: 10 starts per 10 minutes, and 120 token polls per 10 minutes. Polling one code
  faster than its interval answers `slow_down` and adds 5 seconds to its interval (RFC 8628 §3.5). Looking a user code
  up from the verification page is limited to 20 misses per 10 minutes per user.
- **Consent.** The verification page never approves on load: Allow is a POST from a signed-in page, with the
  session cookie's `SameSite=Lax` keeping another site from sending it. The page names the client and repeats the
  code the extension shows, so a user handed someone else's link sees a code their extension does not show.
- **The key.** It carries the user's role and project access, like any key; it has no expiry and no narrower scope
  (keys have no scopes today). It is listed with the user's other keys, named after the browser, and revoked there.
  Revoking it disconnects that browser at its next request.
- **The extension.** Only the settings page and the background worker talk to the instance; a content script never
  does and never sees the key's use. The instance origin stays an optional host permission requested in a click.

## URL patterns in the extension

The extension reads `GET /api/extension/url-patterns` when it connects and each time the settings page opens, and
caches the answer in its connection settings. `resolveActiveProject` decides in this order:

1. the popup's **Active project** choice for the session;
2. the patterns kept in this browser (**This browser only**), first match wins;
3. the instance's patterns, in project order then pattern order, first match wins.

A local pattern is therefore an override for one browser, and a team shares everything else. The settings page lists
both, each marked with where it comes from. When the current tab matches nothing, the popup offers **Add this site**,
which opens the settings with the site's pattern filled in; there, a user whose role edits the project adds it to the
instance (or keeps it in this browser).

The settings editor in the dashboard (project **Settings** → **Browser extension URLs**) suggests one `https://host/**`
pattern per origin the project's suite visited: the Playwright `baseURL` of its recent runs, the URL of each page
node of the Test Map, and each absolute page its locators ran on.

## What freezes at 1.0

The connect endpoints and their JSON, the URL-pattern endpoints and their JSON, and the pattern syntax (already the
extension's). Recorded as D21 in [`1.0-stabilization.md`](../proposals/1.0-stabilization.md).

## Not in this change

- Scoped keys (read-only, one project). Keys have no scopes; adding them is its own decision for every key.
- Pushing pattern changes to a connected extension. It reads them when its settings page opens.
- MCP tools and CLI commands for patterns: neither convention asks for a tool per endpoint, and nothing an agent does
  needs them yet.
