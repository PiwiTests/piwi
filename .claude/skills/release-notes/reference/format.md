# Release-notes format

The house style, distilled from [v0.26.0](https://github.com/PiwiTests/piwi/releases/tag/v0.26.0)
— the reference release. Match its shape, tone, and density.

## Structure

A release body has these parts, in order. Skip a part only when there is genuinely nothing for it
(a patch release may be just an intro + Bug Fixes).

1. **Narrative intro** — one sentence, no heading. What the release lets someone *do*, present
   tense, concrete and specific. Lead with the theme that ties the release together.
   > This release turns Piwi's run history into decisions: run only the tests your change touches,
   > order the flaky ones first, let the platform open a PR when a locator breaks, and watch every
   > step stream live as it happens.

2. **Full diff link** — one line:
   > `**Full diff:** [v0.25.0…v0.26.0](https://github.com/PiwiTests/piwi/compare/v0.25.0...v0.26.0)`

   Use the `…` (ellipsis) in the label and `...` (three dots) in the URL. The compare URL is already
   in the `CHANGELOG.md` section header — copy it from there.

3. **`## ✨ Highlights`** — the marquee items only, roughly 6–12 bullets. Each bullet is:
   > `- **<emoji> Short title** — One or two sentences on what it is and why it matters.`

   Highlights are curated, not exhaustive — pick the changes a reader should not miss and describe
   them in product terms, not commit terms. No commit links here (they live in Features/Fixes).

4. **`## Features`** — *every* feature entry, grouped under thematic `### Subsections`. Group by
   **theme** (what the work is about), not by commit scope: "Branches & selections", "Impact &
   fail-fast", "Auto-heal broken locators", "Live runs", "Sharing, notifications & AI", "API surface
   & UI". Each bullet is one concise sentence that keeps its commit link(s). Keep the `**scope:**`
   prefix where it aids clarity; drop it when the sentence already reads well.

5. **`## Bug Fixes`** — the fixes as a flat list (or lightly grouped), same entry style, `**scope:**`
   prefixes retained.

6. **Collapsed tail** (optional) — when one category is long and low-signal (v0.26.0 used it for
   demo / mock-server parity fixes), wrap it so it does not dominate:
   ```html
   <details>
   <summary><strong>Demo / mock-server parity fixes</strong> — bringing the in-browser demo up to the real server's behavior</summary>

   - **demo:** … ([hash](url))
   …
   </details>
   ```

7. **Marker** — end the file with `<!-- notes:polished -->` so the CI tidy job never overwrites the
   notes with the raw dump.

## Heading levels

Author at **release-body level**: `##` for Highlights / Features / Bug Fixes, `###` for the thematic
subsections — exactly as shown above and in v0.26.0.

When `apply` writes the notes into `CHANGELOG.md`, it demotes every heading one level so they nest
under the `## [version]` header (`## Features` → `### Features`, `### Live runs` → `#### Live runs`).
Do **not** demote them yourself — write one version and let the script place it correctly in both.

## Entry rules

- **Source of truth:** use only the entries `node scripts/release-notes.mjs raw <tag>` prints. Do
  not invent, drop, or reword an entry so its meaning changes.
- **Preserve every commit link.** An entry's `([hash](url))` must survive. When several commits
  belong to one entry, list them together: `([hash1](url1), [hash2](url2))`. The `raw` command
  already merges exact-duplicate subjects this way.
- **Duplicates:** squash + cherry-pick land the same subject on several commits. `raw` collapses
  identical subjects. Merge a semantic near-duplicate (same change, different wording) by hand while
  drafting, keeping both links.
- **Opaque titles:** if an entry's text is a branch slug rather than a description, title it from the
  descriptive words in the slug and keep its link.
- **One sentence per entry**, imperative or descriptive, sentence case, no trailing period on short
  fragments (match v0.26.0).
- **Combine** closely related commits into a single richer sentence when it reads better, e.g.
  *"return a consistent `{ items }` envelope from list routes — projects ([a](u)), run listings
  ([b](u)), …"*.

## Emoji for Highlights

Pick a glyph that fits the change; keep them varied and legible. Ones v0.26.0 used:
🌿 branch/VCS · 🎯 selection/targeting · 🔍 search/impact · ⚡ speed/perf · 🩹 healing/fix ·
📡 live/streaming · 🚦 gating/status · 🔗 links/sharing · 🔔 notifications · 🧱 API/structure ·
📊 charts/data · 🤖 AI. The section heading itself is `## ✨ Highlights`.

## Voice

Informative, specific, honest — **never promotional** (this is the project-wide rule; see the root
`AGENTS.md` positioning section and `apps/docs/AGENTS.md#voice`). Describe what shipped and what it
does. No superlatives, no marketing ("blazing", "seamless", "game-changing"). American English.
Wrap code, flags, env vars and identifiers in backticks (`piwi run --fail-fast`,
`PIWI_FAIL_ON_FLAKY_TESTS`, `{ items }`).

## Minimal skeleton

```markdown
<One-sentence narrative intro.>

**Full diff:** [vPREV…vCUR](https://github.com/PiwiTests/piwi/compare/vPREV...vCUR)

## ✨ Highlights

- **🎯 Title** — What it is and why it matters.
- **⚡ Title** — …

## Features

### Theme A
- **scope:** concise sentence ([hash](url))
- concise sentence ([hash](url), [hash](url))

### Theme B
- **scope:** concise sentence ([hash](url))

## Bug Fixes

- **scope:** concise sentence ([hash](url))

<details>
<summary><strong>Low-signal category</strong> — one line on what it is</summary>

- **scope:** … ([hash](url))

</details>

<!-- notes:polished -->
```
