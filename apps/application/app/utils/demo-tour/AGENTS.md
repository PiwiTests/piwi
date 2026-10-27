# Guided tour: agent guide

Rules for the live demo's guided tour (`app/utils/demo-tour/`, `useDemoTour`, `app/components/demo/`). Read
[`../../../AGENTS.md`](../../../AGENTS.md) first; the tour points at guide anchors, whose rules are in
[`shared/guide-anchors/AGENTS.md`](../../../shared/guide-anchors/AGENTS.md).

The demo offers one tour per role, each a series of stops on seeded screens, in English, French, Spanish and German
(the dashboard itself stays in English). Its data is pure: `profiles.ts` (`TOUR_PROFILES`: each stop's `route`,
`expect`, `anchor`, `side`, `align`, `doc`), one `copy.<code>.ts` per language registered in `TOUR_COPY` (`copy.ts`),
`languages.ts` (`TOUR_LANGUAGES`, `TOUR_LANGUAGE_INFO`, `pickTourLanguage`), `types.ts` and `prompt-state.ts` (the
prompt's decision, stored under `localStorage['piwi-demo-tour']`). `useDemoTour` hands a role's tour to the guide
engine (`useGuide`) as a `GuideRun`; `app/components/demo/` holds `DemoTour`, `DemoTourPrompt` (the toast) and
`DemoTourButton` (the banner's **Guided tour** button).

## Rules

- **The tour mounts only when `runtimeConfig.public.demoTour` is on** (`app.vue`): on in the demo build, off in every
  other. `NUXT_PUBLIC_DEMO_TOUR=true` turns it on for a dev server, as the screenshot harness's `tour` mode does.
- **Every stop points at a guide anchor**: its `anchor` is the id of an entry of `shared/guide-anchors/`, whose reveal
  opens what holds it (a tab through the URL, a folded section). `tests/unit/demo-tour.test.ts` names a stop whose
  anchor is not in the registry, or whose route is none of its anchor's pages.
- **A stop's `route` opens a seeded screen, and its `expect` names the entity it shows** in the demo examples'
  vocabulary; `tests/unit/demo-seed-consistency.test.ts` checks it against the generated seed. A seed change that moves
  the entity updates the stop, never the check.
- **A stop with no `route` stays on the current page** (a banner control); the first stop always has one, and a stop
  never changes only the query of the page before it (a page reads its `?tab=` when it opens). Every stop has a `doc`,
  which `docs-drift.test.ts` resolves like every in-app docs link.
- **`copy.en.ts` is the source, and every other copy file has exactly its keys.** A change to the English copy updates
  every language file in the same commit; adding, renaming or removing a stop touches `profiles.ts` and every copy
  file. The compiler refuses a missing or extra key, and `demo-tour.test.ts` an empty string, an untranslated body and
  a stop with no copy.
- **A dashboard label is `**bold**` and stays in English, spelled as the screen shows it**: the test checks that every
  language names the same bold labels as the English, in order. `**bold**` is the only markup
  (`app/utils/guide/markup.ts`), and a translation keeps the English's placeholders.
- **Write in the docs' voice** ([`apps/docs/AGENTS.md`](../../../../docs/AGENTS.md#voice)): informative, specific,
  never promotional. 4–7 stops a tour; a title ≤ 60 characters and a body ≤ 360 in every language. French says
  _vous_, German _Sie_, Spanish _tú_; product names are never translated.
- **A stop that explains several parts of its anchor numbers them**: its `points` lists 2–5 part ids of the anchor's
  `parts`, in reading order, and its copy has a `points` entry keyed by each part id in every language, one sentence of
  ≤ 160 characters each, under the same bold-label rule; the body then introduces them. `demo-tour.test.ts` checks the
  part ids against the registry and the keys of every language.
- **A change to a toured screen updates the tour in the same commit**, its copy in every language included, as for the
  docs and the demo: moving or renaming an anchored element, renaming a label a stop quotes in bold, a seed change
  under a stop. A new feature that serves a role may replace a stop; it never grows a tour past 7.
- **Verify in the built demo**: `npm run app:generate:demo && npm run app:check:demo:runtime` walks every tour (the
  prompt, **Later**, **×**, the banner button, each stop's anchor highlighted with its line saying where it is and a
  number on the page for each point, one tour in French, one at phone width).

## Adding a stop, a role or a language

- **A stop**: its entry in `TOUR_PROFILES` (`profiles.ts`), its title and body under its id in every
  `copy.<code>.ts`, and the guide anchor it points at.
- **A role**: its id in `TourProfileId` (`types.ts`), its `TOUR_PROFILES` entry, its label, hint and stops in every
  copy file, and its name in the _Live demo_ paragraph of `apps/docs/features/ui-overview.md`, which
  `docs-drift.test.ts` checks for every role and language. `checkGuidedTour` in `scripts/check-demo-runtime.mjs`
  counts the roles and walks each by id: add the new one there.
- **A language**: its code in `TOUR_LANGUAGES` and its `TOUR_LANGUAGE_INFO` entry, then a `copy.<code>.ts` (copy
  `copy.fr.ts`) registered in `TOUR_COPY` (the compiler asks for the file, then for every key), and its English name in
  the same _Live demo_ paragraph.
