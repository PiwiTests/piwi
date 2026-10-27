# MCP tools: agent guide

Rules for the MCP server's tools (`server/utils/mcp/`, `shared/mcp-tools.ts`). Read [`../../../AGENTS.md`](../../../AGENTS.md)
first. The in-app assistant calls these tools too: [`../assistant/AGENTS.md`](../assistant/AGENTS.md).

## Conventions

MCP tools (`server/utils/mcp/tools.ts`, route `server/routes/mcp.post.ts`, definitions `shared/mcp-tools.ts`) return
JSON consumed by AI coding agents; consistency saves the agent from guessing.

**Authorization** — every handler is `(db, params, ctx)` with `ctx: McpContext = { user, scope }` (the route resolves
`scope = getProjectScope(db, user)` once, the readable projects). Every project- or entity-scoped tool MUST enforce scope: `assertProject(ctx, projectId)`
when the arg _is_ a project id, or `checkEntityScope(db, ctx, id, resolveXProjectId)` for run/case/cluster/diagnosis ids
(`'not-found'` → return null/empty; out of scope → throws). Cross-project feeds filter by `ctx.scope`. Write/triage
tools MUST also check, on the project they act on, the permission the same REST action declares
(`assertPermission(ctx, permission, projectId)`, from the `#shared/permissions` matrix): reading a project is not
enough to write to it.

**Reuse** — prefer a shared handler (`#shared/handlers/*`) over re-querying. When a REST endpoint has inline logic a
tool also needs, extract it to a shared handler and call it from both. Never duplicate.

**Field naming** — `id` only for the top-level entity; `testCaseId` for stable test-case identity; `executionId` for a
per-run execution record (`testRunsCases.id`), in sub-lists too (`affectedTestCases`, `locatorHealing`);
`runId` for run references in sub-entities; always `filePath` (never `file`) and `startedAt` (never `start`/`runStart`).

**Response shape** — list tools and paginated sub-lists return `{ items, nextCursor }` (`PaginatedResponse<T>` in
`shared/mcp-tools.ts`). `dropNulls()` strips `null`, `''` and `[]` before serialization. Error text truncates to 400
chars via `trunc(msg, 400)`.

**Validation** — `numericParam(raw, name)` for every numeric param; `numericCursor(raw)` for cursors (never
`Number(cursor)` inline); `clampPageSize(raw)` (1–50, default 10); `paginatedItems(items, pageSize, getCursor)` to wrap
a `pageSize + 1` fetch. **`getCursor` must read the POST-map field name** (`r.executionId`, not the pre-map `r.caseId`)
— reading a renamed field yields an `"undefined"` cursor that crashes the next page. In-memory-filtered list paths must
apply the cursor in memory on the same axis as the emitted cursor, or paging loops on page one.

**Descriptions** — Markdown, written for the agent, built with `md()` in `shared/mcp-tools.ts` (a string per
paragraph, a string array per bulleted list) or a plain string when one sentence says it all. The first paragraph is
one sentence, with no bold, saying what the tool returns or does: `toolSummary` makes it the muted line of the `/mcp`
page's row (which shows the rest and the parameters once the row is opened) and of the generated docs table. Then when
to use it (and what to prefer), the result fields an agent must know to read the answer, and the edge cases; never what
the input schema's parameter descriptions already say (paging, defaults, filters). The page renders bold, code, links
and lists only, so no single-asterisk emphasis. Tool names, arguments, fields and values go in backticks, and a tool
with a `permission` ends with a paragraph naming it, such as _Requires `triage:write` (Maintainer and above on the
project)._ `tests/unit/mcp-tool-descriptions.test.ts` checks the summary, the emphasis, the permission paragraph and
that other tools' names are in backticks.

**Tools about Piwi itself** — `describe_piwi` and `get_release_notes` (`server/utils/mcp/about-piwi.ts`) answer from
the docs pages and `CHANGELOG.md` bundled as Nitro server assets (`nitro.serverAssets` in `nuxt.config.ts`; the
Dockerfile copies both in) and from the registries the docs site renders — never from prose written for the tool,
so they cannot say anything the docs do not. How this instance is configured (storage, retention, capability
states) is deployment shape, shown to administrators only, like the Setup page.
