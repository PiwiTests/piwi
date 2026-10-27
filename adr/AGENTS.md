# ADRs: agent guide

Rules for the `adr/` directory: the architecture decision records (ADRs) of work that has shipped. Read
[`../AGENTS.md`](../AGENTS.md) first for the repository-wide conventions.

## What lives here, and what lives in `proposals/`

The two directories split by state, not by topic:

| Directory | Holds | Status |
|-----------|-------|--------|
| [`proposals/`](../proposals/) | Design records for work that is proposed or still being built | proposed / in progress |
| `adr/` | Architecture decision records for decisions that have shipped | accepted |

A proposal becomes an ADR by moving here, under the same filename, once its plan has shipped. Its body is kept as the
detailed record.

## When a proposal has shipped

- **Every deliverable of its delivery plan is on `main`**: each PR, phase, tier, step or milestone it lists. Check the
  code and `git log`, not only the proposal's Status paragraph, which goes stale in both directions.
- **A remainder the proposal itself marks optional, deferred or dropped does not hold it back.** Its Status paragraph
  names what was left out and where it went (`ROADMAP.md`, another proposal, or nowhere).
- **A remainder that is still planned keeps it in `proposals/`**, however much of the plan is built: do not move it
  early.
- **A register other proposals add entries to stays open** until the milestone it serves ships:
  `1.0-stabilization.md` stays in `proposals/` until 1.0.

## Moving a proposal to `adr/`

Move it **in the pull request that ships its last planned piece**, not in a later clean-up: a shipped plan left in
`proposals/` reads as open work to every later audit.

1. While the file is still a proposal, bring its Status paragraph up to date: what was built, what was left out and
   why. After the move it is history (see [Rules](#rules)).
2. `git mv proposals/<name>.md adr/<name>.md`: same filename, so `git log --follow` keeps the history.
3. Add the ADR header under the title (see [Format](#format)).
4. Fix the moved file's own links: a link to a proposal becomes `../proposals/<other>.md`, a link to
   `../adr/<other>.md` becomes `<other>.md`. Links that start with `../` to the rest of the repository are unchanged:
   both directories sit at the root.
5. Fix every link to it. Search the repository for `<name>.md`: the other proposals (`<name>.md` →
   `../adr/<name>.md`), the other ADRs (`../proposals/<name>.md` → `<name>.md`), `ROADMAP.md`, the `AGENTS.md`
   guides, code comments that name the design record, and docs pages that link it by its GitHub URL.
6. When the local `plans/` folder exists, mirror the change there (the `/plan-management` skill).

## Format

Every ADR is one file, named after the decision (the proposal's filename, unchanged). The header is mandatory and sits
directly under the title:

```markdown
# <Title>

- Status: accepted
- Date: <YYYY-MM-DD>

<the proposal body, preserved>
```

- **Status** is `accepted` for a decision that shipped, `superseded` once a later ADR replaces it, and `deprecated`
  when the decision no longer holds. A `proposed` decision is not an ADR yet: it stays in `proposals/`.
- **Date** is the day the last planned piece merged to `main` (`git log --date=short`): not the day of the move, nor
  the day the proposal was written.

The body keeps the proposal's own sections. They map onto the ADR sections a reader expects:

| ADR section | Proposal section |
|-------------|------------------|
| Context | `Summary` / `Problem` |
| Decision | `Decisions` (the D1, D2, … table) |
| Consequences | `Risks` / `Not in this plan` / `Open questions` |

A new ADR written from scratch uses the canonical sections directly, `## Context`, `## Decision` and
`## Consequences`, rather than the proposal section names.

## Rules

- **One file per proposal.** A proposal that records several independent decisions moves as one ADR; do not split it.
- **Never edit a shipped ADR's decisions.** The record says what was decided and why. A later change is a new ADR that
  supersedes the old one (set the old `Status` to `superseded` and link the new one), not an edit to the old body.
- **Keep the filename stable.** The filename is the decision's identity; cross-references and the roadmap link to it.
- **Cross-references stay relative.** A link to another ADR is `[name.md](name.md)`; a link to a still-open proposal is
  `[name.md](../proposals/name.md)`; a link to the roadmap is `[ROADMAP.md](../ROADMAP.md)`.
- **The Status paragraph in the body is history.** The proposal's `**Status.** …` paragraph stays as it is; the
  header's `Status` is the controlled value. When the two disagree, the header wins.
