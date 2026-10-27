---
name: release-notes
description: Use when asked to write, polish, tidy, fix or regenerate the release notes or the changelog of a version or tag (e.g. "make release notes for v0.29.0 like v0.26.0", "the release body is empty/duplicated"). Writes them in the Piwi house style (narrative intro, ✨ Highlights, thematic Features, Bug Fixes, a collapsed tail) from release-please's de-duplicated per-commit entries, and publishes them by tag to both the GitHub release body and CHANGELOG.md.
---

# Release notes

Turn release-please's raw, per-commit changelog into the notes a human reads: the format of
[v0.26.0](https://github.com/PiwiTests/piwi/releases/tag/v0.26.0), which is the gold standard.
The same drafted notes go to two places: the **GitHub release body** (by tag) and the version's
section in **`CHANGELOG.md`**.

`scripts/release-notes.mjs` (repo root) does the mechanical parts: de-duplication, reading the
CHANGELOG section, publishing by tag, splicing the file. Your job is the writing: the narrative
intro, the Highlights, and grouping features by theme. Read
[`reference/format.md`](reference/format.md) before drafting: it is the full style guide and an
annotated breakdown of v0.26.0.

## When to use

- "Write / polish / tidy the release notes for `<tag>`."
- A release body is empty, a raw dump, or full of duplicate lines and should look like v0.26.0.
- Regenerating notes after a release, or repairing an old one.

For a version with only a handful of commits and no duplicates, the deterministic CI job
(`.github/workflows/release-notes.yml`) already keeps the release body clean: the rich format
below is worth it for feature releases, not every patch.

## Workflow

Work from the repo root. Everything keys on a tag like `v0.29.0`.

### 1. Gather the de-duplicated entries

```bash
node scripts/release-notes.mjs raw v0.29.0
```

This prints the version's entries from `CHANGELOG.md` (falling back to the GitHub release body)
with duplicate subjects already collapsed: repeated commits are merged into a single entry whose
`([hash](url))` carries every link. **These entries are your source material: use only them.** Do
not invent, drop, or reword an entry so its meaning changes, and preserve every commit link.

Get the compare link and previous tag from the section header:

```bash
grep -m1 '^## \[0.29.0\]' CHANGELOG.md
# -> ## [0.29.0](https://github.com/PiwiTests/platform/compare/v0.28.0...v0.29.0) (2026-09-13)
```

The `compare/v0.28.0...v0.29.0` URL is the **Full diff** link for the notes.

### 2. Draft the notes

Follow [`reference/format.md`](reference/format.md). In short, in this order:

1. A one-sentence **narrative intro**: what this release lets someone do, present tense, concrete.
2. `**Full diff:** [vPREV…vCUR](compare-url)`
3. `## ✨ Highlights`: the marquee items only, each `- **<emoji> Title** — one sentence.`
4. `## Features`: every feature entry, grouped under thematic `### Subsections` (by theme, not by
   commit scope), each a concise sentence keeping its `([hash](url))` link(s).
5. `## Bug Fixes`: the fixes, same entry style.
6. Optionally wrap a long, low-signal tail (e.g. demo/mock-server parity) in a
   `<details><summary><strong>…</strong></summary>` block so it does not drown the notes.
7. End the file with the marker line `<!-- notes:polished -->` (this is how CI knows never to
   overwrite your notes with the raw dump).

Author headings at **release-body level** (`##` for Highlights/Features/Bug Fixes, `###` for the
thematic subsections), exactly like v0.26.0. When the notes are written into `CHANGELOG.md` the
script demotes every heading one level automatically so they nest under the `## [version]` header;
do not pre-demote them yourself.

Write the draft to a file outside the repository, such as your scratchpad: `<notes>` below. A
draft inside the checkout is not gitignored, so it would show up in the next commit.

### 3. Preview, then publish

```bash
# See exactly what would change, writing nothing:
node scripts/release-notes.mjs apply v0.29.0 --notes <notes> --dry-run

# Publish to both the GitHub release body and CHANGELOG.md:
node scripts/release-notes.mjs apply v0.29.0 --notes <notes>
```

`apply` updates the GitHub release body for the tag (via `gh release edit`) **and** replaces the
version's section body in `CHANGELOG.md`, keeping the release-please header line. Useful flags:

- `--release-only` / `--changelog-only` (or `--no-changelog` / `--no-release`): do just one target.
- `--dry-run`: print intended actions and write a `CHANGELOG.md` preview to a temp file.
- `--force`: replace a polished release body with notes that are not polished (normally refused).

The command **refuses to write empty notes**, and **never replaces a polished release body** (one
with the marker or a Highlights heading) **with notes that are not polished** unless you pass
`--force`. Polished notes replace a polished body without it.

### 4. Verify

- Open the release page and confirm the body renders (Highlights list, working commit links, the
  `<details>` block collapses).
- `git diff CHANGELOG.md`: only the target version's section changed; the header line and every
  other version are untouched.

## Requirements & notes

- **`gh` authenticated** for writing the release body (`gh auth status`). Without `gh` installed,
  `apply` still updates `CHANGELOG.md`, prints the exact `gh release edit` command to run by hand,
  and exits 1. With `gh` installed but not authenticated, the release edit fails and stops `apply`
  before it writes `CHANGELOG.md`: pass `--changelog-only`.
- **`apply` reads the current body with `gh release view`.** When that call fails (in a Claude Code
  cloud session, gh's GraphQL calls are refused), `apply` cannot see the current body, so the
  polished-body guard above does not apply: check the release page before you publish.
- **CHANGELOG.md is release-please-managed.** Editing a *past* version's section is safe:
  release-please prepends new sections and never rewrites historical ones. Do not touch the header
  line or the manifest.
- **Duplicates** come from squash + cherry-pick landing the same subject on several commits; the
  `raw` command already merges them. If you spot a semantic near-duplicate the tool did not catch
  (different wording, same change), merge it by hand when drafting and keep both links.
- **Voice:** informative, specific, honest, never promotional (see the positioning rules in the
  root [`AGENTS.md`](../../../AGENTS.md) and `apps/docs/AGENTS.md#voice`).

## The release body and CHANGELOG.md stay in step

`CHANGELOG.md` is the source of truth. The `Tidy release notes` CI job runs on every published
release and on demand. It builds the body with `release-body <tag>` from the version's
`CHANGELOG.md` section (falling back to the current release body), and publishes it with
`apply --no-changelog`: **polished** when the section is polished (headings promoted back to
release-body level), **de-duplicated raw** otherwise. So once a version's polished notes are in
`CHANGELOG.md`, the release body is one dispatch away: no re-typing, and the two never drift.

## Republishing a release body from CHANGELOG.md

To restore an emptied or stale release body from its `CHANGELOG.md` section:

- **From CI:** Actions → *Tidy release notes* → *Run workflow* → enter the tag. It reads the
  section from `CHANGELOG.md` and writes it to the release.
- **Locally:** `node scripts/release-notes.mjs release-body <tag> > <notes>` then
  `node scripts/release-notes.mjs apply <tag> --notes <notes> --release-only` (needs `gh`).
