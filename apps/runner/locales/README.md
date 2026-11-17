# Translating Piwi Runner

Piwi Runner's texts come from two catalog sets, in Piwi Picker's shape and held to its rules
([`apps/extension/i18n/README.md`](../../extension/i18n/README.md)), with Piwi Picker's glossaries
(`apps/extension/i18n/glossary.<code>.md`):

- the run layer's, `packages/run-ui/locales/<code>.json` (`runui_`): the connection card, a run request's
  confirmation and the live view of the runs, which the dashboard shows in English only;
- Piwi Runner's own, `apps/runner/locales/<code>.json`: the window's (`runner_`) and the shell's (`shell_`), which the
  desktop crate embeds at build (`apps/desktop/src-tauri/src/shell_words.rs`).

The run model's words are Piwi Picker's, copied into `packages/run-model/src/words/<code>.json` by
`npm run run-model:words`.

## Adding or changing a message

1. Add it to the English catalog, with a `description` saying where it appears, what its placeholders are and how long
   it may be. A text Piwi Picker's Runs window shows too is a run word instead (`packages/run-model/AGENTS.md`).
2. Add the same key, at the same place, to every other catalog, without a description, and draft the translation:
   a check fails on a missing key. Say in the pull request which drafts need a reader.
3. Run `npm run run-ui:test` and `npm run runner:test`, which check the catalogs and fail on text written into a
   template, a toast or an answer; and, after `npm run runner:window`, `npm run runner:e2e`, which shows the window in
   French and German at its smallest size and fails on a text cut.

## Languages and review status

A new language needs its catalogs, its entry in `RUNNER_LANGUAGES` (`app/utils/runner-language.ts`, with
`draft: true` until a native reader has reviewed it) and in the shell's `LANGUAGES`, Piwi Picker's catalog for the run
words, and its line below. Piwi Runner's translations are reviewed on their own schedule, apart from Piwi Picker's.

| Language | Reviewed by | At version |
| --- | --- | --- |
| English (`en`) | the source | |
| French (`fr`) | to be reviewed by the team before the release that ships it | |
| German (`de`) | nobody yet: ships as a draft | |
| Spanish (`es`) | nobody yet: ships as a draft | |
| Brazilian Portuguese (`pt_BR`) | nobody yet: ships as a draft | |
