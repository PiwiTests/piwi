# Translating Piwi Picker

Every text the extension shows comes from a catalog, one per language, in
`public/_locales/<code>/messages.json`: the files the browser already reads for the manifest. English (`en`) is the
source and the fallback. The code reads them only through `src/shared/i18n.ts`.

What is never translated: texts read from the page (names, values, URLs), locators, test ids, `steps.json`, the
generated specs, Playwright names written as code (`toHaveText`, `expect(…)`), product names (Piwi, Piwi Picker,
Playwright) and the popup's single-key shortcuts.

## Adding or changing a message

1. Add it to `public/_locales/en/messages.json`, with a `description` saying where it appears, what its placeholders
   are and how long it may be.
2. Add the same key, at the same place, to every other catalog. Draft the translation yourself if you have to: a check
   fails on a missing key, so no language quietly falls back to English. Say in the pull request which drafts need a
   reader.
3. Use it: `t('popup_pick')`, `t('popup_stopRecording', { count })`, `tn('options_saved', n)`. In `popup.html` and
   `options.html`, keep the English in the markup and name the key: `data-i18n="popup_pick"` for the text, and
   `data-i18n-title`, `data-i18n-placeholder` or `data-i18n-aria-label` for those attributes. A `<kbd>` or `<code>`
   inside the text fills a placeholder: `<kbd data-i18n-slot="first">1</kbd>` for `$first$`.
4. Run `npm run extension:test`: `locales.test.ts` checks the catalogs, and `no-hardcoded-text.test.ts` fails on text
   written straight into the UI.

To change an English text, change it in every catalog in the same pull request, or remove the other languages'
message and draft it again.

## The rules the check enforces

- **Keys** are `<surface>_<name>`: `popup_`, `options_`, `badge_`, `common_` (words and errors several surfaces show),
  and for the in-page tools `pick_` (the pick results), `console_`, `multipick_`, `lint_`, `assert_`, `session_`,
  `agent_`, `functions_` (Test functions), `record_`, `bug_`, `replay_` and `coverage_` (Tested elements), `devtools_`
  for the DevTools pages, `view_` (Playwright view), `login_` (Save login for tests), `runs_` (the Runs window, and the
  run shortcut's name in the manifest), and
  `stability_` and `codegen_` for core's stability rules and converter warnings, by their code. ASCII letters, digits
  and `_` only; the browser ignores case, so `bug_Title` and `bug_title` collide. `extDescription` and
  `pickElementCommand`, the manifest's, keep their names.
- **Placeholders** are `$name$` in the message, declared in `placeholders` with `"content": "$1"`, `"$2"`, … numbered
  in the alphabetical order of their names (`t()` passes named values in that order). At most nine. Every language has
  the same ones as English and uses each; `$$` writes a dollar sign, and any other `$` is an error.
- **Counts** use one key per plural form: `options_saved_one`, `options_saved_other`, and `_few` or `_many` where the
  language needs them for counts up to 999,999 (Polish needs `_few` and `_many`; French does not need `_many`).
  `tn()` picks the form with `Intl.PluralRules` and formats the count. Every form uses `$count$`.
- **Text only**: no `<` in a message, and no empty message. A message reaches the page as text, never as HTML.
- **Badges** (`badge_`) are four characters at most.
- **French** puts a no-break space (U+00A0) before `:` and a narrow no-break space (U+202F) before `;`, `!` and `?`,
  as the dashboard's French reports do. French uses `’` for the apostrophe.
- `common_languageTag` holds the catalog's own language code. It is not shown: leave it as it is.

## Choosing another language than the browser's

Settings → **Language** lists "Same as the browser" and every shipped language by its own name. The background worker
copies the chosen catalog from the package into `chrome.storage.local` (`piwiLanguage`), refreshes it on every install
and update, and every page reads it once at startup. A new language needs its entry in `src/shared/languages.ts`
(with `draft: true` until a native reader has reviewed it) as well as its catalog.

## Checking a build

`npm run extension:build -- --pseudo` replaces the English catalog in `dist/` with a pseudo-localized one:
`[Ƥîçķ åñ éļéɱéñţ ·····]`. Load that build: plain English left on screen bypasses `t()`, and a label cut off will clip
in a longer language. Never ship it.

The end-to-end specs run the browser in French with `test.use({ browserLanguage: 'fr' })` (see `tests/e2e/fixtures.ts`).
A spec that runs a bundle with a stubbed `chrome` adds `chrome.i18n` with `stubChromeI18n` (`tests/e2e/i18n-stub.ts`),
and unit tests get it from `tests/unit/setup-i18n.ts`, English unless a test calls `setBrowserLanguage`.

## Glossaries

One per language, `glossary.<code>.md`: the words a translation of that language must use for the recurring terms.

## Review status

| Language | Catalog | Reviewed by | At version |
| --- | --- | --- | --- |
| English (`en`) | the source | — | — |
| French (`fr`) | all surfaces: the popup, the settings, the in-page tools, badges and messages from the background | to be reviewed by the team before the release that ships it | — |
| German (`de`) | all surfaces | nobody yet: ships as a draft | — |
| Spanish (`es`) | all surfaces | nobody yet: ships as a draft | — |
| Brazilian Portuguese (`pt_BR`) | all surfaces | nobody yet: ships as a draft | — |

A draft is marked in three places, all driven by `draft: true` in `src/shared/languages.ts`: a note under Language in
the settings while the interface is in that language, with a link to the form for translation fixes
(`.github/ISSUE_TEMPLATE/translation.yml`); the first paragraph of its store description, which
`store-listing.test.ts` checks; and this table. A reviewer's pass is one pull request: the corrections,
`draft: false`, the note removed from the store description, and their name here.
