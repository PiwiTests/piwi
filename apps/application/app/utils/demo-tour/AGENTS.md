# Guided tour: agent guide

Rules for the live demo's guided tour (`app/utils/demo-tour/`, `useDemoTour`, `app/components/demo/`). Read
[`../../../AGENTS.md`](../../../AGENTS.md) first; the tour points at guide anchors, whose rules are in
[`shared/guide-anchors/AGENTS.md`](../../../shared/guide-anchors/AGENTS.md).

## What it is

The demo offers one tour per role (Developer, QA engineer, Product owner, DevOps / platform). A toast asks a first-time
visitor what they do: a role starts its tour, **Later** asks again on a visit a day later, **×** never again, and the
banner's **Guided tour** button reopens it. A tour opens that role's seeded screens one by one, with a driver.js
popover on one element per screen that links its docs page. It speaks English, French, Spanish and German (the
browser's language, or the one picked in the toast); the dashboard stays in English.

`app/utils/demo-tour/` holds the data, all pure: `profiles.ts` (`TOUR_PROFILES`, each stop's `route`, `expect`,
`anchor`, `side`, `align`, `doc`), `copy.<code>.ts` registered in `copy.ts` (`TOUR_COPY`, every word the tour says,
one file per language), `languages.ts` (`TOUR_LANGUAGES`, `TOUR_LANGUAGE_INFO`, `pickTourLanguage`), `types.ts` and
`prompt-state.ts` (what a browser decided, stored under `localStorage['piwi-demo-tour']`, and when to ask again).
`app/composables/useDemoTour.ts` holds the prompt's state and the language, stores the decision, and starts a role's
tour as a guide (`GuideRun`, its stops with their copy) that the guide engine runs (`useGuide`);
`app/components/demo/` has `DemoTour` (host, auto-prompt), `DemoTourPrompt` (the toast) and `DemoTourButton`
(banner).

- **The switch is `runtimeConfig.public.demoTour`**, on in the demo build and off in every other, and `app.vue`
  mounts the tour only when it is on. `NUXT_PUBLIC_DEMO_TOUR=true` turns it on for a dev server, which is what the
  screenshot harness's `tour` mode does.
- **A stop points at a guide anchor**: its `anchor` is the id of an entry of `shared/guide-anchors/`, whose reveal
  opens what holds it (a tab through the URL, a folded section). `tests/unit/demo-tour.test.ts` fails naming a stop
  whose anchor is not in the registry, or whose route is none of its anchor's pages.
- **A stop's `route` opens a seeded screen, and its `expect` names the entity it shows**, in the demo examples'
  vocabulary; `tests/unit/demo-seed-consistency.test.ts` checks it against the generated seed like a demo example. A
  seed change that moves the entity updates the stop, never the check. A stop with no `route` stays on the current
  page (a banner control); the first stop always has one. Every stop has a `doc`, which `docs-drift.test.ts` resolves
  like every in-app docs link.
- **Copy**: `copy.en.ts` is the source, and every other copy file has exactly its keys. A change to the English copy
  updates every language file in the same commit, and adding, renaming or removing a stop touches `profiles.ts` and
  every copy file: the compiler refuses a missing or extra key, `demo-tour.test.ts` an empty string, an untranslated
  body and a stop with no copy. A dashboard label is `**bold**` and stays in English exactly as the screen spells it;
  the test checks that every language names the same bold labels as the English, in order. `**bold**` is the only
  markup (`app/utils/guide/markup.ts`), and a translation keeps the English's placeholders. The voice is the docs'
  ([`apps/docs/AGENTS.md`](../../../../docs/AGENTS.md#voice)): informative, specific, never promotional. 4–7 stops a tour; a
  title ≤ 60 characters and a body ≤ 360 in every language. French says _vous_, German _Sie_, Spanish _tú_; product
  names are never translated.
- **A change to a toured screen updates the tour in the same commit**, its copy in every language included, exactly
  like the docs and the demo: moving or renaming an anchored element, renaming a label a stop quotes in bold, a seed
  change under a stop. A new feature that serves a role may replace a stop; it never grows a tour past 7.
- **Adding a language** works like a quality report language: its code in `TOUR_LANGUAGES` and its
  `TOUR_LANGUAGE_INFO` entry, then a `copy.<code>.ts` (copy `copy.fr.ts`) registered in `TOUR_COPY` — the compiler asks
  for the file, then for every key — and its English name in the _Live demo_ paragraph of
  `apps/docs/features/ui-overview.md`, which `docs-drift.test.ts` checks for every role and language.
- Verify with `npm run app:generate:demo && npm run app:check:demo:runtime`: it walks every tour in the built demo
  (the prompt, **Later**, the banner button, each stop's anchor highlighted, one tour in French, one at phone width).

## Adding a stop or a role

- **A stop**: its entry in `TOUR_PROFILES` (`profiles.ts`), its title and body under its id in every `copy.<code>.ts`,
  and the guide anchor it points at.
- **A role**: its id in `TourProfileId` (`types.ts`), its `TOUR_PROFILES` entry, and its label, hint and stops in every
  copy file. A new role is also named in the _Live demo_ paragraph of `apps/docs/features/ui-overview.md`.
