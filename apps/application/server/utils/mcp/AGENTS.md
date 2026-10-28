# MCP tools: agent guide

Rules for the MCP server's tools: their definitions (`shared/mcp-tools.ts`), their handlers (`server/utils/mcp/tools.ts`
and its neighbors) and the route (`server/routes/mcp.post.ts`). Read [`../../../AGENTS.md`](../../../AGENTS.md) first.
The in-app assistant calls these tools too: [`../assistant/AGENTS.md`](../assistant/AGENTS.md).

A tool's result is JSON read by an AI coding agent: the same names and shapes everywhere save the agent from guessing.

## Authorization

- **Every handler takes `(db, params, ctx)`.** `ctx` is the `McpContext` the route builds once per request with
  `requestMcpContext` (`server/utils/mcp/catalog.ts`): the user, their `access`, and `scope`, the projects they read
  (`getProjectScope(db, user)`).
- **Every project- or entity-scoped tool enforces the scope**: `assertProject(ctx, projectId)` when an argument _is_ a
  project id, `checkEntityScope(db, ctx, id, resolveXProjectId)` for a run, case, cluster or diagnosis id (it returns
  `'not-found'`, which the handler answers with null or an empty result, and throws when the entity is out of scope).
  A cross-project feed filters by `ctx.scope`.
- **A write tool declares the permission its REST twin declares** (`permission` in its definition, the twin's
  `x-required-permission`), and its handler checks it on the project it acts on, against the `#shared/permissions`
  matrix: `assertPermission(ctx, permission, projectId)`, or the last argument of `checkEntityScope`. Reading a project
  is not enough to write to it.
  `tests/unit/mcp-permissions.test.ts` holds each such tool to its twin (`REST_TWINS`) and fails on a read tool that
  checks a permission. `tools/list` leaves out a tool whose permission the caller holds on no project, and the
  assistant offers only the tools that declare none.

## Conventions

- **Reuse:** prefer a shared handler (`#shared/handlers/*`) to a new query. When a REST endpoint has inline logic a
  tool also needs, extract it into a shared handler and call it from both; never duplicate it.
- **Field names:** `id` only for the top-level entity; `testCaseId` for a test's stable identity; `executionId` for a
  per-run execution record (`testRunsCases.id`), in sub-lists too (`affectedTestCases`, `locatorHealing`); `runId` for
  a run referenced from another entity; always `filePath` (never `file`) and `startedAt` (never `start` or
  `runStart`).
- **Response shape:** list tools and paginated sub-lists return `{ items, nextCursor }` (`PaginatedResponse<T>` in
  `shared/mcp-tools.ts`). `dropNulls()` removes `null`, `''` and `[]` fields before serialization. Error text is cut to
  400 characters with `trunc(msg, 400)`.
- **Validation:** `numericParam(raw, name)` for every numeric argument, `numericCursor(raw)` for a cursor (never an
  inline `Number(cursor)`), `clampPageSize(raw)` (1 to 50, default 10), and `paginatedItems(items, pageSize, getCursor)`
  around a query that fetched `pageSize + 1` rows.
- **`getCursor` reads the field name after the mapping** (`r.executionId`, not the query's `r.caseId`): a renamed field
  gives an `"undefined"` cursor that crashes the next page. A list filtered in memory applies the cursor in memory, on
  the same field as the cursor it emits, or paging loops on page one.

## Descriptions

A description is Markdown written for the agent, built with `md()` in `shared/mcp-tools.ts` (a string per paragraph, an
array of strings per bulleted list), or a plain string when one sentence says it all.

- **The first paragraph is one sentence** saying what the tool returns or does, with no bold and no link:
  `toolSummary` makes it the muted line of the tool's row on the `/mcp` page (the rest and the parameters show once the
  row is opened) and of the generated docs table.
- **Then:** when to use the tool (and what to prefer), the result fields an agent needs to read the answer, and the
  edge cases. Never what the input schema's parameter descriptions already say (paging, defaults, filters).
- **Only the Markdown the page renders**: bold, code, links and lists, so no single-asterisk emphasis. Tool names,
  arguments, fields and values go in backticks.
- **A tool with a `permission` ends with a paragraph naming it**, such as _Requires `triage:write` (Maintainer and
  above on the project)._
- `tests/unit/mcp-tool-descriptions.test.ts` checks the summary, the emphasis, the permission paragraph and that the
  names of other tools are in backticks.

## The desktop app's run tools

**The run tools are the editor service's, not catalog tools.** `run-tools.ts` serves `RunAgent`'s seven tools
(`@piwitests/editor/run-host`) for the runs the desktop shell starts, in the desktop build alone (`desktopRunTools`,
`IS_DESKTOP` in the route), and the route passes their result on as it is: Piwi's JSON, then the page's text in a
page-content block. Change what they do or say in `packages/editor/src/run-agent.ts` and the desktop's words
(`DESKTOP_AGENT_WORDS` in `server/utils/desktop-runs.ts`); never wrap their result with `toContent`.
`tests/unit/mcp-desktop-tools.test.ts` checks the names and the gating.

## Tools about Piwi itself

**`describe_piwi` and `get_release_notes` answer only from what the docs say** (`server/utils/mcp/about-piwi.ts`): the
docs pages and `CHANGELOG.md`, bundled as Nitro server assets (`nitro.serverAssets` in `nuxt.config.ts`; the
Dockerfile copies both in), and the registries the docs site renders. Never write prose for the tool. How this instance
is configured (storage, retention, capability states) is the deployment's shape: like the Setup page, it is shown to
administrators only.
