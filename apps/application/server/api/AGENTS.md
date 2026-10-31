# Dashboard API routes: agent guide

Rules for the Nitro routes (`server/api/`, `server/routes/`) and the authorization helpers they call. Read
[`../../AGENTS.md`](../../AGENTS.md) first. Run ingestion (`server/api/test-runs/`) has its own guide:
[`test-runs/AGENTS.md`](test-runs/AGENTS.md).

## Adding an endpoint

- A file under `server/api/` with an `eventHandler()` that gets the database from `getDatabase()`, a
  `defineRouteMeta` block ([OpenAPI annotations](#openapi-annotations)) that declares its `x-required-permission`, and
  the access helper the [authorization rules](#per-route-permissions-are-declared-once-in-the-route-meta) call for.
- **No address the browser requests may contain `analytics`** (in a route path, a query key or a value): uBlock Origin
  and other blockers refuse such requests, and the page then shows nothing. The analytics routes live under
  `/api/widgets`, `/api/dashboards` and `/api/rollups`; `tests/unit/blocked-request-words.test.ts` checks the routes
  and the app's requests.
- **An endpoint the demo serves too gets its demo handler**; `npm run app:check:demo` compares the route patterns. See
  [`app/demo/AGENTS.md`](../../app/demo/AGENTS.md).
- **A settings route returns whether a secret is set, never its value** (an API key, an SCM token, the SMTP password):
  the AI settings answer "API key presence", the SMTP settings `configured`.
- On the desktop app, every `/api` and `/mcp` request also needs the desktop token
  (`server/middleware/desktop-guard.ts`); its open routes: [`apps/desktop/AGENTS.md`](../../../desktop/AGENTS.md).

## Authentication & authorization

The authorization model is described in [`ARCHITECTURE.md`](../../ARCHITECTURE.md#shared-types-and-core); its design
record is `proposals/roles-and-groups.md`.

- **Authentication is optional**, turned on by `PIWI_AUTH_ENABLED=true`. When it is off, `requireAuth()` returns a
  virtual administrator (`ADMIN_ACCESS`), so every endpoint keeps working and the UI allows everything.
- **With authentication on, a request signs in with a session cookie (the browser) or an API key** (`pd_` prefix, as a
  Bearer token or in `X-API-Key`). An API key carries its owner's access (instance role and project roles), nothing
  more and nothing less.
- **`/mcp` also takes an OAuth access token** (`pdo_` prefix), from the authorization server MCP clients sign in
  through (`server/utils/mcp-oauth.ts`, the `/.well-known/*` and `/oauth/*` routes, design record `adr/mcp-oauth.md`).
  Only `requireMcpAuth` accepts it, never `requireAuth`, so the REST API refuses it: keep it that way. Each grant owns
  an `api_keys` row named after the client, whose value is never handed out: the row carries the access, the write log
  names it, and deleting it ends the grant (foreign-key cascade). Every 401 from `/mcp` carries the `WWW-Authenticate`
  challenge from which clients discover the authorization server.
- **The authorize endpoint never redirects an error to the client's redirect URI.** Registration is open, so that would
  make the instance an open redirector: every refusal lands on the consent page, and only the user's Allow or Deny
  sends the browser to the client.
- **Permissions only add up.** A role binding (`role_bindings`) gives a user or a group (exactly one of `user_id` and
  `group_id`) one project role on one project, or on all projects, present and future (`project_id` null). A user's
  permissions on a project are the union of every role they hold there, directly or through their groups: there are no
  deny rules, groups do not nest, and a group never carries the instance role (`users.role`).
- **Code names roles and permissions through `#shared/permissions`** (`InstanceRole`, `ProjectRole`, `Permission`,
  `ROLE_PERMISSIONS`), never as raw string literals; route meta is the one exception (below). The UI's labels and
  one-line descriptions are `INSTANCE_ROLE_LABELS`, `PROJECT_ROLE_LABELS` and `PROJECT_ROLE_DESCRIPTIONS`.

### Per-route permissions are declared once, in the route meta

A route's `defineRouteMeta` declares what it needs in `openAPI['x-required-permission']`. That one literal drives
**both** the `/docs` display and the enforcement: `requireAuth(event)` reads it from the compiled route metas
(`server/utils/route-required-permission.ts`, matched with rou3 exactly as Nitro dispatches).

```typescript
defineRouteMeta({ openAPI: { tags: ['Failure Clusters'], summary: '…', 'x-required-permission': 'triage:write' } });

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'failure cluster ID');
  // requireAuth runs inside; the route's permission is checked on the cluster's project
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');
});
```

- **Values:** one permission (`'triage:write'`); an inline array, where any one suffices; or `'signed-in'` for a route
  any signed-in user may call (their profile, API keys, dashboards, channels, subscriptions). Omit the field only for a
  public route or one authenticated by a token of its own (the reporter's streaming routes, see
  [`test-runs/AGENTS.md`](test-runs/AGENTS.md#stream-tokens)).
- **It MUST be inline string literals.** Nitro's meta extractor folds only inline `ObjectExpression`,
  `ArrayExpression` and `Literal` nodes, so a variable, a function call or an imported constant is silently dropped.
- **`requireAuth(event)` makes only the early check, never the per-project decision.** It identifies the user, loads
  their `AccessSummary` into `event.context.access` (instance role, project roles own and through groups) and applies
  `passesEarlyCheck`: `signed-in` and `project:read` pass for any signed-in user, an instance permission needs an
  administrator, and any other project permission needs that permission on at least one project. It refuses with 403
  before the handler's own work.
- **`requireAuth(event, permission)` overrides the meta** for a handler whose permission depends on the request
  (`integrations/actions.get.ts` needs `connections:manage` for a connection's activity, `project:read` for a
  project's); the meta then documents the usual case.
- **No response carries `test_runs.stream_token`**: a handler returning run rows selects `publicRunColumns()`
  (`shared/handlers/public-run.ts`).
- **No CORS, and no cross-site writes.** `server/middleware/cross-site.ts` refuses any state-changing request whose
  `Sec-Fetch-Site` is `cross-site` or `same-site` (browser extensions excepted), and no route sends
  `Access-Control-Allow-Origin` except the trace archives the hosted trace viewer reads. Browser clients are
  same-origin pages or Piwi Picker's background worker; every other client (reporter, CLI, MCP, IDE clients) sends no
  browser metadata.

### Project-level permissions

The early check only proves the user holds the permission _somewhere_. The project helpers of
`server/utils/project-access.ts` make the real decision, with the route's permission:

- **A route whose `:id` is the project id** calls `requireRouteId(event, 'id', label)`, then
  `requireProjectAccess(event, projectId)`.
- **A route scoped by a child entity** (run, case, cluster, execution, diagnosis) calls
  `requireResolvedProjectAccess(event, id, resolveXProjectId, notFoundLabel)`. It authenticates, resolves the project,
  answers 404 for a missing entity, then authorizes, and returns `{ db, projectId, user }`.
- **Authenticate before any lookup by a request's id**, so a caller without credentials gets 401 whether the id exists
  or not. A handler that loads the row itself calls `requireAuth(event)`, then `requireProjectPermission(event,
  projectId)` (`tests/unit/request-access.test.ts`, `tests/unit/route-permissions.test.ts`).
- Both refuse with 403: "No access to this project" when the user cannot read the project, "Insufficient permissions"
  when they read it without the route's permission.
- **A list handler takes the user's project scope**: `getProjectScope(db, user, permission = 'project:read')` returns
  `'all'` or the `Set<number>` of projects where the user holds `permission` (`listProjects(db, scope)`,
  `getProjectMenu`, `getRecentTestRuns`, `searchProjectsTestRunsCases`). An empty set returns `[]` at once.
- **A write route that authorizes through a scope MUST pass its permission**:
  `getProjectScope(db, user, 'triage:write')`, then `scopeAllows(scope, projectId)`. The default scope is every readable
  project, so someone who reads project A and triages project B could otherwise triage A. Creating a project on first
  submission needs `run:submit` on all projects (`scope === 'all'`).
- `tests/unit/route-permissions.test.ts` checks every route's meta value and these calls.
- Plain `requireAuth` is only for routes with no project scoping (instance permissions, `signed-in`).
- **The UI asks `useAuth().can(permission, projectId?)` or `canAnywhere(permission)`**, built on the `AccessSummary`
  that `/api/auth/me` returns. It only hides or disables a control: the server decides. With authentication off,
  everything is allowed.
- **The last administrator can be neither demoted nor deleted.**
- **A Project admin edits role bindings only on projects where they hold `project:members`**, never on all projects
  (that takes `users:manage`, an administrator's).
- **A Project admin's user list holds only the users who can open a project they can open** (`listUserSummaries`):
  anyone else is found by their whole username (`lookup`), never listed. `tests/unit/access-management-routes.test.ts`.
- **A project's issues are filed only through the connection its binding names**: `POST /api/integrations/issues`
  refuses any other before building anything, and the draft proposes no other. `tests/unit/issue-create-routes.test.ts`.
- **A notification addressed to one user (`targetUserId`) still needs their access to every project it is about**:
  `notifyFixAuthor` checks it before the email (`tests/unit/fix-author.test.ts`), the stream before delivering
  (`tests/unit/notification-stream.test.ts`).
- **Changing a user's instance role, or signing out, bumps `sessionEpoch`** and so ends their sessions. Project role
  and group changes need no such step: access is loaded on every request.

### OpenAPI annotations

Every endpoint gets a `defineRouteMeta({ openAPI: … })` block: it feeds `/_openapi.json` and `/docs`, and it is the
only place endpoint documentation is written. A public endpoint declares `security: []`; every other one inherits the
root-level `security: [{ bearerAuth: [] }, { sessionCookie: [] }]` of `nuxt.config.ts` (whose `meta` is cast `as any`
on purpose, to allow those fields).
