---
name: plan-management
description: Update, archive, and track implementation plans and the roadmap. Use when the user asks to update a plan, check plan progress, archive a completed plan, or sync the roadmap with shipped/planned work.
---

# Plan Management

This skill covers the end-to-end workflow for managing implementation plans in the Piwi Dashboard project. Plans live
in `plans/` (local, gitignored). `plans/README.md` describes the layout; `plans/roadmap.md` is the single source of
truth for internal priorities; the committed `ROADMAP.md` is the public direction, the committed `proposals/` hold
design records that often ship without touching `plans/`, and the committed `adr/` holds the ones that have shipped.

## Layout

| Path | Role |
|------|------|
| `plans/roadmap.md` | Ranked **Build next** table · **Quick fixes** · **Active plans** / **Parked plans** tables · **Later** (one-liners by theme) · **Strategy notes** |
| `plans/shipped.md` | The shipped ledger (newest block first) + the **Archived plans** index |
| `plans/exploration-findings.md` | **Open** findings (re-verified each audit) + **Resolved** log |
| `plans/rejected-ideas.md` | Ideas set aside on purpose, each with the reason |
| `plans/active/` | Plans with open work that is next |
| `plans/later/` | Parked plans |
| `plans/research/` | Benchmarks / audits whose sections serve as specs until a plan is opened |
| `plans/archive/` | Shipped or closed plans; each starts with an "Archived <date>" note naming where any remainder went |
| `proposals/` (committed) | Design records for work proposed or being built — **always check them during an audit**; mirror their status into `plans/`; move a shipped one to `adr/` |
| `adr/` (committed) | Architecture decision records for shipped work; rules and the move from `proposals/` in `adr/AGENTS.md` |

## When to Use

- User asks to "update the X plan" or "check progress on X plan"
- User asks to "archive" or "mark as shipped" a plan
- User asks to update the roadmap, or "what should we build next"
- User asks to add/remove items from a plan's checklist
- After implementing features from a plan — sync its status

## Workflow

### 1. Read the plan and assess its state

Read `plans/active/<name>.md` (or `later/`). If the plan mirrors a proposal, read the proposal's **Status** paragraph
too. If the plan has a "File-by-file checklist" or numbered checklist sections, those are the items to check.

For each checklist item, search the codebase to determine whether it's been implemented:

```bash
# Check if specified files exist
Test-Path "<path>"
# Search for key symbols introduced by the plan
rg "<symbol>" --include "*.ts" --include "*.vue" apps/application/ packages/reporter/
# Check type definitions, schema, API handlers, UI components, demo mirror, tests
```

Do NOT use `Get-ChildItem` for file existence — use `Test-Path` or `glob`/`grep` tools. Also read `CHANGELOG.md` for
the releases since the plan's last dated status — features often land from a proposal or a fix without a plan edit.

### 2. Determine plan status

A plan is **fully shipped** when ALL checklist items are confirmed implemented (or the remainder is deliberately
dropped). A plan is **partially shipped** when some sections are done and others remain.

### 3. If fully shipped — archive it

```powershell
Move-Item -LiteralPath "plans\active\<name>.md" -Destination "plans\archive\<name>.md"
```

Then:

1. Prepend an `> **Archived YYYY-MM-DD.**` blockquote under the title that names where any remainder now lives
   (roadmap quick fix, another plan, or `rejected-ideas.md`), and fix relative links (`../active/...`,
   `../rejected-ideas.md`, same-folder archive links).
2. `plans/shipped.md` → add a row in the newest block **and** a row in "Archived plans".
3. `plans/roadmap.md` → remove the row from *Active plans* / *Parked plans*; drop or update its *Build next* entry.
4. Anything dropped on purpose → a numbered entry in `plans/rejected-ideas.md` with the reason.
5. If the plan mirrors a proposal and the proposal's plan has shipped too, move the proposal to `adr/`: the criterion
   and the steps are in `adr/AGENTS.md` ("When a proposal has shipped", "Moving a proposal to `adr/`"). Unlike the
   archive move, this one is committed.

### 4. If partially shipped — update the plan in place

- Mark completed items `[x]` (or ✅) with dates where the plan uses them (e.g. `✅ shipped 2026-07-01`).
- Update the dated **Status** block under the title (bump the date, one bullet per change).
- Update the plan's row in the roadmap's *Active plans* / *Parked plans* table and, if it moved, the *Build next* table.
- If the unshipped remainder should be parked, move the file to `plans/later/` and the row to *Parked plans*.
- If the plan mirrors a proposal, update the proposal's Status paragraph too (committed): what is built, what remains.

### 5. Roadmap conventions (`plans/roadmap.md`)

- **Build next**: a ranked table (`#`, What, Why now, Effort S/M/L, Where the spec is). Keep it to ~8 rows; every row
  links a plan, a proposal, or a `research/` section.
- **Quick fixes**: small verified-open items, each traceable to a finding in `exploration-findings.md`.
- **Active plans** / **Parked plans**: one row per file in `active/` and `later/`; committed proposals with an open
  remainder are listed under *Active plans* in their own table.
- **Later**: one-liners grouped by theme, no checklists. Items graduate to *Build next* by getting a plan or a spec link.
- Never restate counts the code defines (MCP tool count, route count) — point at the registry instead.
- Bump the **Last updated** line and summarize what shipped since, in one paragraph.

### 6. Capture findings

Append bugs, inconsistencies or tech debt found during the assessment to `plans/exploration-findings.md` under
**Open**, using the template at the top of that file; move fixed findings to **Resolved** with the date (one line each).

### 7. Start a plan from a *Build next* item

Create `plans/active/<name>.md` from the linked spec with the structure below, then add its row to *Active plans*.

### 8. No commit needed

Plans are gitignored (`plans/` is in `.gitignore`) — they're local working documents. Do not commit plan changes or the
archive move. Proposal and ADR changes (`proposals/`, `adr/`) are committed. (This skill file and `AGENTS.md` are committed; edit them only when the workflow itself changes.)

## Plan Structure Conventions

- **Goal** at the top (one-line summary) and a dated **Status** block right under the title
- **Current state** (findings/audit of what exists)
- **Decisions** (D1, D2, … table of architectural choices)
- **Workstreams** (numbered, each with sub-items like A1, A2, B1, B2, …)
- **File-by-file checklist** at the end (checkboxes grouped by workstream)
- **Verification steps** (numbered task list for manual QA)
- **Risks & notes**

## Key Code Locations to Check

| Area                     | Where to look                                                  |
|--------------------------|----------------------------------------------------------------|
| DB schema                | `apps/application/server/database/schema.sqlite.ts`, `schema.pg.ts` |
| API endpoints            | `apps/application/server/api/`                                      |
| Shared types             | `apps/application/shared/types.ts`                                  |
| Shared handlers          | `apps/application/shared/handlers/`                                 |
| Frontend types           | `apps/application/types/api.ts`                                     |
| Frontend pages           | `apps/application/app/pages/`                                       |
| Frontend components      | `apps/application/app/components/` (organized by domain subfolder)  |
| Frontend composables     | `apps/application/app/composables/`                                 |
| Settings metadata        | `apps/application/app/utils/settings-metadata.ts`                   |
| Help content             | `apps/application/app/utils/help-content.ts`                        |
| Layout (sidebar, footer) | `apps/application/app/layouts/default.vue`                          |
| Env var registry         | `apps/application/shared/piwi-env-vars.ts`                          |
| Env shim (prebuilt server)  | `packages/server/bin/server-env.mjs`                             |
| Reporter source          | `packages/reporter/src/`                                                |
| Reporter tests           | `packages/reporter/tests/`                                              |
| Integrations (trackers)  | `apps/application/server/utils/integrations/`                       |
| SCM providers            | `apps/application/server/utils/scm/`                                |
| Demo API mirror          | `apps/application/app/demo/api/`                                    |
| Demo simulator           | `apps/application/app/demo/simulator.ts`                            |
| Demo seed script         | `apps/application/scripts/generate-demo-seed.mjs`                   |
| Unit tests               | `apps/application/tests/unit/`                                      |
| E2E tests                | `apps/application/tests/`                                           |
| CI workflows             | `.github/workflows/`                                           |
| Docs                     | `apps/docs/`                                                        |
| MCP tools                | `apps/application/server/utils/mcp/tools.ts`                        |
| MCP tool defs            | `apps/application/shared/mcp-tools.ts`                              |
| Desktop shell            | `apps/desktop/src-tauri/src/`                                       |
