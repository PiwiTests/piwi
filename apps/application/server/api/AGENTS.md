# Dashboard API routes: agent guide

Rules for the Nitro routes (`server/api/`, `server/routes/`) and the authorization helpers they call. Read
[`../../AGENTS.md`](../../AGENTS.md) first. Run ingestion (`server/api/test-runs/`) has its own guide:
[`test-runs/AGENTS.md`](test-runs/AGENTS.md).

## Adding an endpoint

- A file under `server/api/` using `eventHandler()` + `getDatabase()`, with a `defineRouteMeta` `openAPI` block
  (including `x-required-permission`) and the right access helper from the authorization rules below.
- **No address the browser requests may contain `analytics`** (a route path, a query key or value): uBlock Origin and
  other blockers refuse such requests, and the page then shows nothing. The analytics routes live under
  `/api/widgets`, `/api/dashboards` and `/api/rollups`; `tests/unit/blocked-request-words.test.ts` checks it.
- An endpoint the demo serves too gets its demo handler (`npm run app:check:demo` compares the route patterns): see
  [`app/demo/AGENTS.md`](../../app/demo/AGENTS.md).

## Authentication & authorization

- **Auth is optional**, enabled by `PIWI_AUTH_ENABLED=true`. When disabled `requireAuth()` returns a virtual
  administrator (`ADMIN_ACCESS`), so every endpoint keeps working and the UI allows everything.
- Two methods when enabled: session cookie (browser) or API key (Bearer / `X-API-Key`, `pd_` prefix). **An API key
  carries its owner's access** (instance role and project roles), nothing more and nothing less.
- **`/mcp` takes a third: an OAuth access token** (`pdo_`), from the authorization server MCP clients sign in through
  (`server/utils/mcp-oauth.ts`, the `/.well-known/*` and `/oauth/*` routes, design record `adr/mcp-oauth.md`).
  Only `requireMcpAuth` accepts it, never `requireAuth`, so the REST API refuses it; keep it that way. Each grant owns
  an `api_keys` row named after the client, whose value is never handed out: it carries the access, the write log
  names it, and deleting it ends the grant (foreign-key cascade). Every 401 from `/mcp` carries the
  `WWW-Authenticate` challenge clients discover the server from. **The authorize endpoint never redirects an error
  to the client's redirect URI**: registration is open, so that would make the instance an open redirector; every
  refusal lands on the consent page, and only the user's Allow or Deny sends the browser to the client.
- **The model lives in `#shared/permissions`** (pure, shared by the server, the MCP tools, the demo and the UI; design
  record `proposals/roles-and-groups.md`): instance roles `InstanceRole` (`administrator`, `member`; stored in
  `users.role`), project roles `ProjectRole` (`viewer`, `contributor`, `maintainer`, `project_admin`, `uploader`),
  permissions `Permission` (`ProjectPermission` | `InstancePermission`, named `resource:action`) and the matrix
  `ROLE_PERMISSIONS`. Use the enums and types, **never raw string literals** in code; route meta is the one exception
  (below). Labels and one-line descriptions for the UI are `INSTANCE_ROLE_LABELS`, `PROJECT_ROLE_LABELS` and
  `PROJECT_ROLE_DESCRIPTIONS`.
- **Role bindings** (`role_bindings`): a user or a group (exactly one of `user_id` / `group_id`) holds one project role
  on one project, or on all projects, present and future (`project_id` null). Groups (`groups`, `group_members`) do not
  nest and carry project roles only, never the instance role. A user's permissions on a project are the union of every
  role they hold there, directly or through their groups; there are no deny rules. The data layer is
  `shared/handlers/role-bindings.ts` and `shared/handlers/groups.ts`, shared with the demo.

### Per-route permissions are declared once, in the route meta

A route's `defineRouteMeta` declares what it needs in `openAPI['x-required-permission']`, and that single literal drives
**both** the `/docs` display and enforcement: `requireAuth(event)` reads it from the compiled route metas
(`server/utils/route-required-permission.ts`, matched with rou3 exactly as Nitro dispatches).

```typescript
defineRouteMeta({ openAPI: { tags: ['Failure Clusters'], summary: '…', 'x-required-permission': 'triage:write' } });

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'failure cluster ID');
  // requireAuth runs inside; the route's permission is checked on the cluster's project
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');
});
```

- **Values:** one permission (`'triage:write'`); an inline array, where any one suffices; or `'signed-in'` for routes
  any signed-in user may call (their profile, API keys, dashboards, channels, subscriptions). Omit the field only for
  public or token-authenticated routes.
- **It MUST be inline string literals.** Nitro's meta extractor only folds inline `ObjectExpression` /
  `ArrayExpression` / `Literal` nodes, so a variable, a function call or an imported constant is silently dropped.
- **`requireAuth(event)`** identifies the user, loads their `AccessSummary` once per request (`event.context.access`:
  instance role, roles on all projects, roles per project, own and through groups) and applies the early check
  (`passesEarlyCheck`): `signed-in` and `project:read` pass for any signed-in user, an instance permission needs an
  administrator, any other project permission needs that permission on at least one project. It refuses with 403
  before any database work; it is never the per-project decision.
- `requireAuth(event, permission)` is an **explicit override** for handlers computing their own authorization (e.g.
  `users/[id].patch.ts` self-or-admin); the meta then documents but does not drive it.
- Streaming endpoints (`start`, `events`, `finish`, `case-files`) keep **stream-token** auth instead of `requireAuth`.
  A run stores its main stream or setup token only as a digest (`streamTokenDigest`, checked with `matchesStreamToken`),
  and no response carries `test_runs.stream_token`: a handler returning run rows selects `publicRunColumns()`.
- **No CORS, and no cross-site writes.** `server/middleware/cross-site.ts` refuses any state-changing request whose
  `Sec-Fetch-Site` is `cross-site` or `same-site` (browser extensions excepted), and no route sends
  `Access-Control-Allow-Origin` except trace archives for the hosted trace viewer. Browser clients are same-origin
  pages or Piwi Picker's background worker; everything else (reporter, CLI, MCP, IDE clients) sends no browser metadata.

### Project-level permissions

The early check only says the user holds the permission _somewhere_. The project helpers in
`server/utils/project-access.ts` make the real decision, with the route's permission:

- `requireProjectAccess(event, projectId)` and `requireResolvedProjectAccess(event, id, resolve, label)`: a project
  the user cannot even read → 403 "No access to this project"; readable without the route's permission → 403
  "Insufficient permissions".
- **Route `:id` is the project id** → `requireRouteId(event, 'id', label)` then `requireProjectAccess`.
- **Scoped by a child entity** (run, case, cluster, test-run-case, diagnosis) →
  `requireResolvedProjectAccess(event, id, resolveXProjectId, notFoundLabel)`. It resolves the project, 404s a missing
  entity, then authorizes, and returns `{ db, projectId, user }` so no second `getDatabase()` is needed.
- **`getProjectScope(db, user, permission = 'project:read')`** → `'all' | Set<number>`, the projects where the user
  holds `permission`. List handlers take it (`listProjects(db, scope)`, `getProjectMenu`, `getRecentTestRuns`,
  `searchProjectsTestRunsCases`); an empty set returns `[]` immediately.
- **A write route that authorizes through a scope MUST pass its permission**:
  `getProjectScope(db, user, 'triage:write')`, then `scopeAllows(scope, projectId)`. The default scope is every
  readable project, so someone who reads project A and triages project B could otherwise triage A. Creating a project
  on first submission needs `run:submit` on all projects (`scope === 'all'`).
- `tests/unit/route-permissions.test.ts` checks every route's meta value and these calls.
- Plain `requireAuth` is only for routes with no project scoping (instance permissions, `signed-in`).
- **The UI asks `useAuth().can(permission, projectId?)` or `canAnywhere(permission)`**, built on the `AccessSummary`
  that `/api/auth/me` returns. It is an affordance only (hide or disable a control); the server decides. With
  authentication off everything is allowed (virtual administrator).
- **Safety rules:** the last administrator cannot be demoted; a Project admin edits role bindings only on projects
  where they hold `project:members`, never on all projects; changing a user's instance role or signing out bumps
  `sessionEpoch`, while project role and group changes take effect on the next request since access is loaded per
  request.

### OpenAPI annotations

Every endpoint gets a `defineRouteMeta({ openAPI: … })` block — non-negotiable, it is what feeds `/_openapi.json` and
`/docs`. Public endpoints declare `security: []`; everything else inherits the root-level
`security: [{ bearerAuth: [] }, { sessionCookie: [] }]` from `nuxt.config.ts` (whose `meta` is cast `as any` to allow
those fields — intentional).
