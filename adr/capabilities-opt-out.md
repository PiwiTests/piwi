# Capabilities you can say no to

- Status: superseded
- Superseded by: [backend-logs-evidence.md](backend-logs-evidence.md), which replaces the `backend-logs` applicability
  rule (§4, its example in D4 and the last sentence of D7); the other decisions stand
- Date: 2026-09-22

**Status:** shipped 2026-09-22 in #601 (foundation), #603 and #605 (MCP modules, wizard step), #604 (surfaces); the open remainder is the fixtures-free demo project described in section 9 · **Scope:** every place the dashboard shows or offers an optional capability a team has not switched on: evidence tabs, empty panels, settings navigation, sidebar, project actions, the Setup ladder, the MCP tool list · **Builds on:** [`failure-experience-audit.md`](failure-experience-audit.md) §10 and [`ui-simplification.md`](ui-simplification.md) rule 9

**Goal:** an instance shows only the capabilities it uses or has chosen. Every unused optional capability can be declined once, at project or instance level, and the dashboard remembers the answer everywhere: UI, Setup, MCP, the model's context.

Not every team will use every feature. A team that has decided against one keeps meeting it on every page, and a regular user can go months without knowing a capability exists. Both are the same defect: the product has no memory of what a team wants from it. The previous direction made every empty card explain itself and link to Setup. That fixed "is this broken?" and created "why does every page sell me something?". This record keeps the honesty and removes the selling.

The three things every instance uses, run history with traces, failure clustering and flaky scoring, are the core and are never gated.

---

## 1. Vocabulary

One name per concept, used as is in code, copy and docs.

| Term | Meaning |
|---|---|
| **Capability** | An optional feature a team can switch on: capture fixtures, backend logs, AI diagnosis, notifications, … Listed once in the registry (§3). |
| **Evidence** | Data proving a capability is in use, detected with a `limit(1)` probe (existing `shared/handlers/setup-status.ts`). Per project for project-level capabilities, instance-wide otherwise. |
| **Decision** | A stored answer: `declined` at instance level, `declined` or `enabled` at project level (`enabled` overrides an instance decline for one project). Nothing stored means undecided. |
| **State** | The resolved answer for one capability in one context: `active`, `available`, `declined`, `not-applicable` or `undecided` (§4). |
| **Module** | A named preset grouping capabilities: `core`, `workflow`, `healing`, `agents`. Declining a module writes a decline for each of its capabilities. **A module has no stored state of its own.** |
| **Decline control** | Any control that writes a decision: *Not for this project*, *Not for this instance*, *Reconsider*, the module presets. |

---

## 2. What the code audit found (2026-09-19, re-checked 2026-09-21)

Everything in the plan's audit table exists as described: the twelve detection ids, the copy ladder in `app/utils/setup-capabilities.ts`, the three-state resolver in `shared/evidence-state.ts`, the `ciRerun` JSON column as the per-project settings precedent, the flat MCP list (46 shared tools plus 3 desktop-only), the always-listed settings pages, sidebar link and project bell.

Four facts the plan did not have, and which shape the design:

1. **Detection is instance-wide.** `getSetupStatus` probes with no project filter, and `fixturesActive` is computed per execution in `EvidenceTabs.vue` and `server/utils/ai-context.ts`. A per-project answer to "has this project ever captured fixtures" does not exist yet.
2. **`/api/setup-status` is administrator-only**, and `app/middleware/auth.global.ts` redirects non-admins away from `/setup`. Every surface below is also read by `USER`-role people, so the effective state needs its own read endpoints.
3. **There is no project editor role.** `project_assignments` carries no role; the project PATCH endpoint and `canManage` on the project page are administrator-only. Project-level decisions are therefore administrator-only too.
4. **The locator-fix section advertises an empty panel.** `LocatorHealingPanel.vue` hides itself without data, but both `test-run-cases/[id].vue` and `failure-clusters/[id].vue` push `locator-fix` into the Toolbox whenever the failure is locator-shaped, so the reader gets a folded "Locator fix · Ranked replacement locators from the failing page" row that opens to nothing.

Two more things worth knowing: `tests/mcp.spec.ts` asserts the tool count and `tests/unit/docs-drift.test.ts` pins every "N tools" sentence in the docs to `MCP_TOOL_DEFS.length`; and the `SubscribeBell` drives browser notifications from a cookie when auth is off, with no channel, so it is not pure advertising in that case.

---

## 3. The registry

`shared/capabilities.ts` declares every optional capability once. It stays free of server-only imports (the demo and the browser import it). Detection queries stay in `shared/handlers/`.

```ts
export type CapabilityId =
  | 'fixtures' | 'green-samples' | 'locator-healing' | 'backend-logs' | 'scm'
  | 'ai' | 'mcp' | 'notifications' | 'pr-feedback' | 'auto-heal' | 'integrations'
  | 'quarantine' | 'tags' | 'markers';

export type CapabilityModule = 'core' | 'workflow' | 'healing' | 'agents';
export type CapabilityLevel = 'instance' | 'project';

export interface CapabilityDef {
  id: CapabilityId;
  module: CapabilityModule;
  /** Where a decision may be stored. Project-level capabilities accept both. */
  levels: CapabilityLevel[];
  /** Prerequisites, reusing the feature catalog's vocabulary. */
  needs: FeatureNeed[];
  /** Detection id in `setup-status.ts`, when evidence exists for it. */
  detection: SetupCapabilityId | null;
  /** A capability that is declined whenever this one is (rides on it). */
  follows?: CapabilityId;
  /** Release that introduced it; the Setup ladder marks entries newer than the instance's first run. */
  since: string;
  doc: string;
}
```

| id | module | levels | needs | detection | follows | Surfaces it owns |
|---|---|---|---|---|---|---|
| `fixtures` | core | instance, project | fixtures | `fixtures` | | Network, Console, State, Performance tabs; slow endpoints (project and analytics); green-samples and locator-healing follow it |
| `green-samples` | core | project | fixtures | `green-samples` | `fixtures` | Setup ladder row only |
| `locator-healing` | healing | instance, project | fixtures | `locator-healing` | `fixtures` | Toolbox `locator-fix` section |
| `backend-logs` | core | instance, project | fixtures, backend | `backend-logs` | | Backend logs inside the Network tab; `serverLogs` clue citations |
| `scm` | core | instance, project | scm | `scm` | | Token fields on the project form and the AI settings page; commit facts |
| `ai` | agents | instance | llm | `ai` | | Settings → AI diagnosis; diagnosis panels' "AI is not configured" line |
| `mcp` | core | instance | | none (always available) | | Sidebar *MCP server* link; `/mcp` page |
| `notifications` | workflow | instance | | `notifications` | | Settings → Notifications; `SubscribeBell` |
| `pr-feedback` | workflow | instance | scm | settings row | | Settings → Pull requests |
| `auto-heal` | healing | instance | scm, llm | settings row | | Settings → Auto-heal |
| `integrations` | workflow | instance | | `integration_connections` rows | | Settings → Integrations; *Create issue* actions |
| `quarantine` | workflow | instance, project | | `quarantine` | | Project → Quarantine tab; quarantine actions |
| `tags` | core | instance | | `tags` | | Settings → Tags |
| `markers` | core | project | admin | `markers` | | *Add marker* on the Timeline tab |

`reporter` and `clustering` stay on the Setup ladder as core rows with no decline control.

Module presets: `core` is every capability above with `module: 'core'`, and a preset never declines a core capability; `workflow`, `healing` and `agents` are the sets listed in the table. The Home wizard and the Setup page ask the same question with the same component ("What do you want Piwi for?": *see why tests fail* is always on; *triage as a team* = workflow; *fix faster* = healing; *let agents in* = agents). Unchecked modules write declines for their capabilities; nothing else is stored.

---

## 4. The resolver

One pure function, `resolveCapability(def, input)`, used by every surface. Input is gathered by the shared handler, never by a component.

```ts
interface CapabilityInput {
  evidence: boolean;                       // data exists (project-scoped where the level allows)
  configured?: boolean;                    // set up but no evidence yet: AI key, SCM token, a channel
  applicable?: boolean;                    // default true; false → not-applicable
  instanceDecision?: 'declined';
  projectDecision?: 'declined' | 'enabled';
  followedState?: CapabilityState;         // resolved state of `def.follows`
}
```

Order of precedence:

1. `evidence` → **`active`**. Data always wins: hiding real data is never right. A declined capability that starts receiving data reads active, and the Setup ladder shows the stored decision next to it so an administrator can clear it.
2. `projectDecision === 'declined'` → **`declined`**.
3. `projectDecision === 'enabled'` → skip the instance decision and the followed capability, continue at 6.
4. `instanceDecision === 'declined'` or `followedState === 'declined'` → **`declined`**.
5. `applicable === false` → **`not-applicable`**.
6. `configured` → **`available`**, else **`undecided`**.

`backend-logs` is `applicable` only when the project has at least one server trace, so it is hidden everywhere except the Setup ladder until a backend package sends one. The ladder row reads "needs a backend package in the app under test; available today for Nitro and ASP.NET Core", never "Not active yet".

Effective state for a project = the resolver over the project's evidence, the project's decision and the instance's decision. Effective state for the instance (settings nav, sidebar, MCP) = the resolver over instance-wide evidence and the instance decision.

---

## 5. Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Two levels of decision, both persisted: instance (`app_settings` key `capabilities`, value `{ decisions: Partial<Record<CapabilityId, 'declined'>> }`) and project (`projects.capabilities` JSON, `Partial<Record<CapabilityId, 'declined' \| 'enabled'>>`, generated migration in both dialects). Project override, then instance default, then undecided. | Fixture and backend decisions are per project (a monorepo instruments one app and not another); AI, notifications and MCP are instance-shaped. |
| **D2** | One registry, one resolver (§3, §4). Every surface reads the resolved state and nothing else. | Today the same fact is computed in `setup-status.ts`, `EvidenceTabs.vue`, `evidence-state.ts`, `ai-context.ts`, three `FeatureUnavailable` call sites and the settings nav. One resolver makes "declined hides it everywhere" a property, not a checklist. |
| **D3** | Undecided and never captured means hidden, with one line. A project with no fixture evidence gets no dimmed evidence tabs. The evidence card footer shows one sentence naming the missing sources ("Network, console, state and performance are not captured for this project"), with *Add fixtures* · *Not for this project* · *Not for this instance* for administrators only. Tabs reappear when data arrives. | Four dimmed tabs per execution is advertising. One line, once, with a way to say no. |
| **D4** | Not-applicable is hidden outright and named honestly on Setup (see `backend-logs` in §4). When the stack of the app under test is known (a later reporter or project field), the ladder can say "no package for FastAPI yet". | A permanent "needs a backend integration" for a stack we do not support cannot be acted on. |
| **D5** | Declined means gone, not greyed: evidence strips, panels, settings nav, sidebar, project actions, MCP tool list. Declined capabilities stay on the Setup ladder in a folded *Declined* group with *Reconsider*. A declined capability's settings page still answers its URL, with one line for administrators: "Declined on Setup · Reconsider". | Half-visible features are what bloat looks like. Setup is the single place to reverse a decision. |
| **D6** | The MCP tool list follows capabilities. Every tool carries a `module` and, when it depends on one, a `capability`. `tools/list` drops tools whose capability is declined at instance level and keeps everything else, undecided included. `?modules=core,healing` on the MCP URL narrows the list to those modules and never re-enables a declined capability. The `/mcp` page shows the full URL and a *core only* variant. | Undecided is not declined (D1, D5): shrinking the default list would silently remove tools from every current MCP client on upgrade. The core-only URL gives the token budget to the clients that want it. |
| **D7** | Nudge once, at the point of pain, administrators only. On a failure whose strongest clue would have used a missing source (a timeout or a network clue with fixtures `undecided`), the headline card shows one line with *Not for this project*. It replaces the D3 footer line on that page; never shown when the capability is declined or not applicable; never more than one per page. Capabilities in `not-applicable` never nudge, so backend logs do not nudge until the stack is known. | Contextual and rare beats permanent and everywhere. |
| **D8** | Modules are presets over the registry (§3), coarse and few. A capability belongs to exactly one module. | Three questions are answerable, fifteen are not. Storing module state next to capability decisions would be the second configuration surface this record wants to avoid. |
| **D9** | No new wizard, one new step. The Home `GetStartedWizard` (shown until the first project exists) gets one optional step, administrators only, mounting the same presets component the Setup page uses. Skipping stores nothing. Later releases never prompt: a new capability lands in its module and shows a *New* marker on the ladder when its `since` is newer than the version recorded at the instance's first run. | A second wizard would itself be bloat; modal release prompts become nags. |
| **D10** | Copy rule. Outside `/setup` and the docs, an undecided capability may be named in one line but never pitched: no benefits paragraph, no feature list. The benefits copy in `setup-capabilities.ts` is for Setup only. The *Optional* badge on the ladder goes: every non-core row has a decline control instead. | Draws the line the previous plan did not. |
| **D11** | Roles. Every decline control renders only when `canSeeAdmin` is true (administrators, and everyone when auth is disabled). Non-administrators see the effects of decisions (hidden tabs, hidden entries) and at most the D3 naming sentence, with no action. The D7 nudge is administrator-only in full. Every write endpoint declares `'x-required-roles': ['administrator']`; the read endpoints are open to any signed-in user with access to the project. | Nobody is asked a question they cannot answer. |
| **D12** | The demo exercises every state through seeded data: one project with fixtures, one without, one declined capability at project level. Decisions persist in the in-browser database like everything else and reset with the demo data. | Screenshots and docs need every state visible; a non-persisting special case buys nothing. |
| **D13** | The model's context follows the same answer. `evidenceAbsenceReason` gains "declined for this project", so the AI never recommends fixtures a team refused. | The humans' cards and the model's coverage map already share one resolver; the decision must reach both. |

---

## 6. Workstreams

Three pull requests. A lands first; B and C start from A's branch and run in parallel.

### A. Foundation (no visible UI change)

- **A1** `shared/capabilities.ts`: registry, modules, presets, `resolveCapability`, types.
- **A2** Evidence per scope: extend `shared/handlers/setup-status.ts` with `getCapabilityEvidence(db, projectId?)`, project-filtered `limit(1)` probes through `test_runs.project_id` (network requests, server traces, locator snapshots through `test_cases`, green samples, quarantine, markers, project SCM token). `getSetupStatus` keeps its shape and adds `state` and `decision` per row.
- **A3** Storage: `projects.capabilities` JSON column in `schema.sqlite.ts` and `schema.pg.ts`, then `npm run db:generate && npm run db:generate:pg`; instance decisions through `getAppSetting` / `setAppSetting` under the key `capabilities`.
- **A4** `shared/handlers/capabilities.ts`: `getInstanceCapabilities(db)`, `getProjectCapabilities(db, projectId)`, `setInstanceDecisions(db, decisions)`, `setProjectDecisions(db, projectId, decisions)`. Server and demo both import it.
- **A5** Endpoints with `defineRouteMeta`: `GET /api/capabilities` (any signed-in user; `{ items: [{ id, module, state }] }`), `PATCH /api/capabilities` (administrator; `{ decisions }`, `null` clears), `GET /api/projects/:id/capabilities` (`requireProjectAccess`), `PATCH /api/projects/:id/capabilities` (administrator). Demo mirrors in `app/demo/api/router.ts`.
- **A6** `shared/evidence-state.ts`: a `capability` input and a `declined` outcome; `evidenceAbsenceReason` returns "declined for this project"; `server/utils/ai-context.ts` passes the project's resolved fixtures and backend-logs states.
- **A7** Composables `useInstanceCapabilities()` and `useProjectCapabilities(projectId)`: one cached fetch per scope, `state(id)`, `isHidden(id)` (declined or not-applicable), `canDecide` from `canSeeAdmin`, `decide(id, decision)`.
- **A8** `CapabilityPresets.vue`: the three-checkbox presets component (§3) writing declines through `PATCH /api/capabilities`. Built and tested here, mounted by B (Setup) and C (wizard). Renders nothing when `canSeeAdmin` is false.
- **A9** Demo seed: `scripts/generate-demo-seed.mjs` seeds `projects.capabilities` for one project (one capability declined) and leaves one project without fixture evidence; `npm run app:seed:demo`.
- **A10** Tests: resolver precedence; registry consistency (every non-core `SetupCapabilityId` has a registry entry, every registry id has ladder copy, every id belongs to one module, `follows` targets exist); handler tests following `tests/unit/setup-status.test.ts`; endpoint E2E (a `USER` key reads, a `USER` PATCH gets 403, project override beats instance decline).

### B. Surfaces

- **B1** `EvidenceTabs.vue`: tabs filtered by resolved state (only `present` and `nothing-happened` render); the D3 footer sentence with administrator-only controls; the D7 nudge in `TestCaseHeadlineCard.vue`, replacing the footer line on that page.
- **B2** Backend logs hidden unless applicable; ladder copy per §4.
- **B3** `ProjectSlowEndpoints.vue` and `SlowEndpointsTable.vue`: declined at the relevant level → block hidden; undecided → one naming line (D10), no benefits paragraph.
- **B4** `locator-fix` Toolbox section only when healing data exists (the panel reports `hasData` to the page); never when `locator-healing` is declined.
- **B5** `buildSettingsNavSections` takes the set of declined capabilities and drops their pages; each such page shows the D5 reconsider line to administrators.
- **B6** Sidebar *MCP server* link follows `mcp`; `/mcp` page shows the reconsider line when declined.
- **B7** Project page: `SubscribeBell` hidden when `notifications` is declined; Quarantine tab follows `quarantine`; *Add marker* follows `markers`.
- **B8** Setup ladder: groups *Active* / *Available* / *Not set up* / *Declined* (folded, *Reconsider*); *Not for this instance* on every non-core row; the stored decision shown next to an `active` row; *New* marker (D9); mounts `CapabilityPresets`; `Optional` badge removed.
- **B9** `ProjectFormFields.vue`: a *Capabilities* group with a tri-state per project-level capability (instance default / declined / enabled).
- **B10** Copy sweep for D10 across the surfaces above; `HELP_TOPICS` entries for the new controls.
- **B11** Docs: a section on declining capabilities in the Setup guide and in `features/evidence.md`; screenshot scenes for the ladder and the evidence footer, before and after, wide and narrow.
- **B12** Tests: nav builder with declines; E2E for decline → hidden tabs and hidden footer, reconsider → restored, non-admin sees no control.

### C. MCP modules and the wizard step

- **C1** `shared/mcp-tools.ts`: `module` on every tool and `capability` where one applies (diagnosis tools → `ai`; `get_locator_healing`, `apply_locator_fix` → `locator-healing`; `create_issue` → `integrations`; `get_repo_commits`, `get_repo_diff` → `scm`; `get_network_requests`, `get_slow_tests`, `get_performance_trend` → `fixtures`; selections, catalog and test-function tools → `workflow`). A unit test asserts every tool has a module.
- **C2** `server/routes/mcp.post.ts`: `tools/list` filtering per D6 from the instance's resolved states; `?modules=` parsing with unknown values ignored; `initialize.instructions` names the modules; a filtered tool is "Unknown tool" on `tools/call`.
- **C3** `app/pages/mcp.vue`: catalog grouped by module, a *core only* URL variant; `tests/mcp.spec.ts` asserts against `MCP_TOOL_DEFS.length` and the module filter; `apps/docs/features/mcp.md` and the other two "N tools" sentences reworded so `docs-drift.test.ts` still passes (the core count is not written as "N tools").
- **C4** `GetStartedWizard.vue`: the optional presets step, administrators only, mounting `CapabilityPresets`.

---

## 7. Verification

1. Fresh instance, auth off: Home wizard shows the presets step; skipping stores nothing; every optional capability is undecided on Setup.
2. Project with no fixture data: execution page shows Timeline, Screen, Source only, plus one footer sentence with three controls; *Not for this project* hides the sentence; Setup lists the capability under *Declined*; *Reconsider* brings the sentence back.
3. Same as 2 with a `USER` API key and auth on: the sentence has no controls, `PATCH` returns 403.
4. Decline `notifications` at instance level: the settings page disappears from the nav, the bell from the project page, `/settings/notifications` shows the reconsider line to an administrator.
5. Decline `ai`: `tools/list` no longer lists the diagnosis tools; `?modules=core` narrows further; the count on `/mcp` matches.
6. Send network requests to a project whose `fixtures` is declined: the tabs come back, the ladder row reads active with the decision shown.
7. Demo: one project with fixtures, one without, one declined capability; every state screenshotted.
8. 375 px: the footer sentence and its controls wrap without horizontal scroll.

## 8. Risks and notes

- Per-project probes run on the execution page. They are `limit(1)` through indexed columns; the composable caches one fetch per project per page session. Measure on the seeded instance before adding a server-side cache.
- `tests/unit/docs-drift.test.ts` pins every "N tools" claim to the full catalog; C3 must keep the core count out of that regex.
- The stack of the app under test is unknown today; D4's per-stack copy waits for a reporter or project field.

## 9. Deviations during implementation

- **A9 demo seed.** The seed now declines a capability at project level (`markers` on `mobile-safari`, a capability with no evidence there, so it resolves to `declined`). The "one project without fixture evidence" half is deferred to B: every seeded project carries network evidence through the shared `failure-stories.mjs` fixtures (the flagship story on `mobile-safari` adds requests through `failingNetwork`), so removing fixture evidence from one project would mean editing those drift-guarded fixtures and stripping that project's slow-endpoint and performance demo data. B owns the demo screenshot scenes and can add a fixtures-free project alongside them.
- **B11 demo seed, 2026-09-21.** The fixtures-free demo project (A9's tail, for D12's "one project without fixtures") is deferred again. A sixth project must be added in lockstep across the drift-guarded seed lookup tables (`DEMO_PROJECTS` and `SCM_REPOS` in `shared/demo/failure-stories.mjs`, plus `PROJECT_CONFIGS`, `RUN_GREPS` in `scripts/generate-demo-seed.mjs`) with its own cases, suites, browsers and commits, for a state the unit and E2E tests, the docs and the self-seeding screenshot scenes already cover. The demo still exercises `declined` through `markers` on `mobile-safari`. The B surfaces themselves are complete; only this demo data is outstanding.
