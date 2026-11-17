# Piwi Runner in five languages

A plan to translate Piwi Runner into French, German, Spanish and Brazilian Portuguese, with English as the source: the
same five languages as Piwi Picker ([`extension-localization.md`](../adr/extension-localization.md)). Runner is the app
a tester installs to run, on their own machine, the tests a team instance asks for. It is often the first Piwi tool
they meet, through a page of the instance, and the people Picker was translated for are the same people.

**Status.** Proposed 2026-11-17, its open questions settled the same day (D9 to D11), and built the same day on one
branch: the machinery and the layer's catalog (PR 1), the codes from the host (PR 2), the language from the shell with
the Language setting and the window in French (PR 3), the shell's texts (PR 4), and German, Spanish and Brazilian
Portuguese as drafts with the docs section (PR 5). Two things remain. The macOS app menu's standard items and the
folder picker are still to be checked in French on a Mac (D9). Runner's own hub sentences (`RUNNER_RUNS_WORDS`: where
a locator picked on the image and a code made at a stop wait to be copied) stay in English: they wrap the editor's
English words for the code (`what`), so wording them needs the editor's stop actions to say their parts by code
first. Decisions made while building are listed at the end.

**Summary.** Runner's window holds few texts of its own: most of what it shows comes from the Nuxt layer it shares
with the dashboard (`packages/run-ui`), from the sentences its Node host writes (`@piwitests/editor`), and from the
Tauri shell (the tray, the startup screen, the native dialogs). Each of those is made translatable without changing
what the dashboard shows. The layer takes its words from its host and speaks English when none is given, so the
dashboard, which is not translated, is unchanged. The run model's words (`@piwitests/run-model`) are already
translated in Picker's catalogs and are reused as they are. The host's sentences gain a code the window words in its
language. The shell reads its texts from Runner's catalog, embedded in the binary. The shell decides the language: the
Language setting, else the system's. The work is estimated at 8 to 10 days for one developer, in five pull requests,
the first two with no visible change.

## What changes for the reader

A French tester opens Runner and reads:

```
Piwi Runner
Lance sur cette machine les tests que demande une instance d’équipe.

Exécuter sur ma machine
Connecté : les demandes de vos pages arrivent ici
```

A request from the instance opens the confirmation:

```
Exécuter sur cette machine ?
✓ Dossier lié : /home/dana/shop
✓ Playwright est installé.
⚠ Votre dossier a des modifications non commitées.
npx playwright test tests/cart.spec.ts:12 --headed
```

The tray reads **Ouvrir Piwi Runner**, **Rechercher des mises à jour…**, **Quitter Piwi Runner**, and a stopped
worker reads **Arrêté à un point d’arrêt** with **Reprendre** and **Pas suivant**, the words Picker's Runs window
already uses. The folder, the command, the test titles and Playwright's output stay as they are.

## Languages

The five languages of Picker, with the same status: English is the source and the fallback, French is reviewed by the
team before the release that ships it, German, Spanish and Brazilian Portuguese ship as drafts until a native reader
has reviewed them. Picker's glossaries (`apps/extension/i18n/glossary.<code>.md`) apply as they are: *run* is
*exécution*, *locator* stays *locator*, *instance* is *instance*. A term Runner needs and the glossary lacks (*team
instance*, *linked folder*, *run request*) is added to the glossary, so both tools say it the same way.

## What is translated, and what never is

| Translated | Never translated |
| --- | --- |
| Every label, button, hint, tooltip, `aria-label`, error and empty state of the window | Product names: Piwi, Piwi Runner, Piwi Picker, Playwright |
| The checks of a run request and the states of the connection | Test titles, file and folder paths, the command a request runs |
| The live view of a run: its states, controls, stops and layers | Playwright's output, locators, generated code |
| What the host answers the window (a stop that went on, a pick that was refused) | The instance's own texts (an error it returns, a project's name) |
| The tray menu, its tooltip, the startup screen, the native dialogs | The host's log lines, and what it tells other tools (reporters' workers, agents) |
| | A run's output, the shell's reason it could not start included, which the instance receives too |
| The built-in texts of Nuxt UI components (a close button's label) | The installers, and the documentation site |

## Where the texts come from today

| Source | What | About | How it becomes translatable |
| --- | --- | --- | --- |
| `apps/runner/app` | The window's frame: heading, run list, background settings | 25 texts | Runner's catalog |
| `packages/run-ui` | The connection card, the confirmation, the live view, sharing, the copy list | 200 texts, of which 53 are already run-model keys said through `desktopSay` | The layer's catalog, or a run word when Picker shows the same text |
| `@piwitests/run-model` | The words of the live view both surfaces share (`RUN_WORDS_EN`) | 155 keys, already in Picker's five catalogs | Reused (D4) |
| `@piwitests/editor` | The checks of a request (`request-run.ts`), the connection's errors (`run-target.ts`), Runner's hub sentences (`RUNNER_RUNS_WORDS`) | 14 checks, 5 errors, 9 sentences | A code beside the English sentence (D5) |
| `apps/desktop/src-tauri` | The tray (`runner_app.rs`, `lib.rs`), the startup screen, the quit question, the update dialogs (`updates.rs`), the macOS app menu | 25 texts | Runner's catalog, embedded at build (D8) |

The counts come from a scan of the source and are approximate. The 25 texts of the layer that match a message of
Picker's catalogs word for word, and others close to one, are where the layer and Picker should share a key rather
than add one.

## How it works

### Catalogs

Two catalog sets, one file per language, in the shape of Picker's `messages.json` (`message`, a `description` in the
English catalog only, `$name$` placeholders declared in `placeholders`, `_one` and `_other` for counts):

- `packages/run-ui/locales/<code>.json`: the layer's texts, keys `runui_<name>`.
- `apps/runner/locales/<code>.json`: the window's own texts (`runner_<name>`) and the shell's (`shell_<name>`).

The same shape keeps the glossaries, the review process and the catalog check of Picker. The `$1`, `$2` numbering
that `chrome.i18n` needs is kept too, so the check is the same code for both.

Picker's catalogs are not reused for these texts: they hold what Picker shows, ship in its package and are reviewed
with it, and Runner reading them at build would reach into another workspace by path.

### The layer takes its words from its host

The layer knows no host (`packages/run-ui/AGENTS.md`), so its words come in through an injection key, as
`RUN_VIEW_HOST` brings a host's abilities. `RUN_UI_WORDS` carries the language as a BCP 47 tag, `t()` and `tn()` over
the layer's catalog, and a `RunSpeaker`, the run model's interface for saying its words (`say`, `count`, `number`,
`list`). Without it, the layer uses its English catalog and `englishRunSpeaker`: the dashboard provides nothing and
shows what it shows today.

`desktopSay` and the six files of the layer that import `englishRunSpeaker` (five components and `run-view.ts`) go
through the injected speaker. Runner's plugin
provides the key from the language the shell gives (D6), and a change of language re-renders the window, since the
words are reactive.

### The run model's words in every language

`packages/run-model` gains the four other languages of its words: `RUN_WORDS` by language, written by a script from
Picker's catalogs, and `runSpeakerFor(language)`. `apps/extension/tests/unit/run-words.test.ts`, which holds
`RUN_WORDS_EN` to the English catalog, holds each language to its catalog. The files are generated and committed; the
run model's guide says so, the root guide being at its size limit.

`ANSWER_KEYS` (`apps/extension/src/shared/runs.ts`), which words a hub's answer by its `HubAnswerCode`, moves into
run-model with its `runs_answer*` keys, so the layer words the hub's answers as Picker does.

### Codes from the host

The window cannot translate a sentence. What the host says that the window shows gains a code and its values, beside
the English sentence, which stays for every other reader (the dashboard, agents, logs):

- `RunRequestCheckView` (`@piwitests/editor/run-target-view`) gains `code` and `args`: `folder-missing`,
  `folder-gone`, `folder-linked` with `folder`, `config-missing`, `specs-missing` with `named`, `playwright-missing`,
  `commit-differs` with its values, `uncommitted-changes`, `command-too-long` with `max`, and the rest.
- `RunTargetConnectionView` gains `errorCode` and `errorArgs` for its own sentences (the instance did not answer, the
  sign-in expired, the connection was denied). An error the instance returns, or a network error, has no code and is
  shown as it came.
- Runner's hub sentences (`RUNNER_RUNS_WORDS`: a declined pick, record or assert, a picked locator, a code sent, a
  file outside the linked folders, no window to stop the run) answer with a code, as the hub's answers already do with
  `HubAnswerCode`.

Each change adds a field beside the English sentence, which the dashboard's desktop build keeps reading, and the window
shows the sentence of a code it does not know. The host and the window ship together, so no entry in
[`1.0-stabilization.md`](1.0-stabilization.md) is needed.

### Choosing the language

The shell decides, once, for the tray, the dialogs and the window:

1. the Language setting, when set;
2. else the system's language, read with the `sys-locale` crate (a new dependency of the desktop crate);
3. matched to a shipped catalog by its language (`fr-CA` reads French), Portuguese for `pt-BR` alone, else English:
   a system set to `pt-PT` reads English, as Picker does.

The window asks the shell for it through a command, beside `desktop_get_service_settings`, and does not read
`navigator.language`: the tray and the startup screen need the language before the window loads, and one answer keeps
the tray and the window in the same language.

The Language setting sits in the window's settings card (`RunnerBackgroundSettings`), stored by the shell with Run in
background and Start on login. It lists "Same as the system (Français)" and each language by its own name
(`Intl.DisplayNames`), as Picker's settings do, and shows Picker's draft note, with its link to the translation issue
template, while a draft language is on screen. Many developers run an English system, the reason Picker has the same
setting.

### The shell's texts

The shell's texts are `shell_` messages of Runner's catalog, read at build by the crate (`include_str!` and
`serde_json`, under the `runner` feature) and filled with the same `$name$` rules. The functions `lib.rs` and
`updates.rs` share with the desktop app (the quit question, the background toggles of the tray, the update dialogs)
take their words as arguments, and the desktop app keeps passing its English ones. A change of language rebuilds the
tray menu, as the shell already does when the runs change. The quit question gets plural forms in the process: it
reads "1 local test run(s) are still running" today.

On macOS, Runner builds its app menu with `Menu::default`, whose standard items (Edit, Copy, Paste) carry English
labels, and the folder picker is a native panel. Runner's bundle declares its five languages (`CFBundleLocalizations`
in its `Info.plist`), so macOS can show its own panels in the system's language. PR 4 checks the menu and the picker
in French on a Mac; a standard item that stays English then gets its text from the catalog.

### Formatting

Numbers, counts and times follow the language through `Intl` (`RunSpeaker.number`, `toLocaleTimeString(language)` for
the time a request ends unanswered). Nuxt UI's own texts follow through `<UApp :locale>`, with Nuxt UI's `fr`, `de`,
`es` and `pt_br`. The window sets `<html lang>`.

## Decisions

| # | Decision |
| --- | --- |
| D1 | The five languages of Picker, with its review status: French reviewed by the team, the three others ship as drafts. |
| D2 | Runner's texts live in two catalog sets in Picker's shape: the layer's (`packages/run-ui/locales/`) and Runner's (`apps/runner/locales/`), the shell's texts included. |
| D3 | The layer takes its words from its host through `RUN_UI_WORDS`, and speaks English without it: the dashboard is unchanged. |
| D4 | The run model's words are translated once, in Picker's catalogs, and copied into `packages/run-model` by a script, held equal by `run-words.test.ts`. A text Picker and the layer both show becomes a run word. |
| D5 | The host's sentences the window shows gain an optional code and its values; a sentence without a code the window knows is shown as it came. |
| D6 | The shell decides the language: the Language setting, else the system's, matched to a shipped catalog, else English. |
| D7 | A Language setting in the window's settings card, stored by the shell, with Picker's draft note. |
| D8 | The shell's texts are embedded in the binary from Runner's catalog; the shared Rust functions take their words as arguments. |
| D9 | Runner's macOS bundle declares its five languages (`CFBundleLocalizations`); a standard menu item that still shows English gets its text from the catalog. |
| D10 | The catalog check's rules live in one module in the root `shared/` folder, which Picker's test and Runner's import by relative path. |
| D11 | Runner has its own review table, beside its catalogs: its French is reviewed on its own schedule, independently of Picker's. |

## Checks and tests

- **The catalog check.** The rules of `apps/extension/tests/unit/locales.test.ts` (same keys as English, same
  placeholders, the plural forms each language needs, no `<`, a `description` on every English entry, the French
  no-break spaces) move into one module in the root `shared/` folder, beside the base lint and format configs, which
  Picker's test and Runner's both import by relative path, rather than a second copy.
- **No text in code.** A scan of `packages/run-ui/app` and `apps/runner/app`, as Picker's
  `no-hardcoded-text.test.ts` does, reading the templates of `.vue` files with Vue's compiler. A list of files not
  yet migrated keeps it green while PR 1 moves the texts, and the list only shrinks.
- **The run words.** `run-words.test.ts` holds the generated words of each language to Picker's catalog.
- **The codes.** An editor test holds the English sentence of each code to the English catalog's message, as
  `run-hub.test.ts` does for `ANSWER_SENTENCES`.
- **The shell.** The crate fails to build on a `shell_` key a catalog lacks; a Rust test checks the quit question in
  French and its plural forms.
- **The window.** A Playwright spec in `apps/runner/tests/` opens the generated window with a faked Tauri bridge and a
  host stream played by the spec, as `apps/application/tests/desktop-run-view.spec.ts` does for the dashboard. In
  French and in German, it shows a request's confirmation and a stopped worker, checks `lang`, and fails when a text
  element's `scrollWidth` exceeds its `clientWidth`.
- **The dashboard.** Its desktop specs run unchanged, in English: they show that the layer's default holds.

## Plan

**PR 1: the layer's machinery, in English.** No visible change. About 4 days.

- [x] `RUN_UI_WORDS`, `t()`, `tn()` and the English default in `packages/run-ui`; `desktopSay` and the
      `englishRunSpeaker` imports through it.
- [x] The layer's texts and Runner's window texts in their English catalogs; texts Picker already shows become run
      words.
- [x] The catalog check's rules moved into `shared/`, the text scan with its not-yet-migrated list ending empty.

**PR 2: codes from the host.** No visible change. About 1.5 days.

- [x] `code` and `args` on the request's checks, `errorCode` on the connection.
- [ ] Codes on Runner's hub sentences (see the Status paragraph).
- [x] `ANSWER_KEYS` moved into run-model; the layer words the hub's answers by code.

**PR 3: French in the window.** About 1.5 days.

- [x] The language from the shell (`sys-locale`, the command), the Language setting.
- [x] `RUN_WORDS` by language, its script and test; the French catalogs; Nuxt UI's locale; `<html lang>`.
- [x] The window spec in French; the glossary terms Runner adds.

**PR 4: the shell's texts.** About 1 day.

- [x] The tray, its tooltip, the startup screen, the quit question with its plural forms, the update dialogs, from the
      embedded catalog; the shared functions take their words as arguments.
- [x] The tray rebuilt on a change of language.
- [x] `CFBundleLocalizations` in Runner's `Info.plist` (`macos/runner-info.plist`).
- [ ] The app menu and the folder picker checked in French on a Mac, and a standard item that stays English given its
      text from the catalog.

**PR 5: German, Spanish, Brazilian Portuguese.** About 1 day.

- [x] Their catalogs, as drafts; the window spec in German.
- [x] A **Languages** section in `apps/docs/features/piwi-runner.md`; Runner's review table in
      `apps/runner/locales/README.md`, covering the layer's catalogs and Runner's.

## Not in this plan

- **The dashboard**, its desktop build included: it keeps English, the layer's default. The layer's catalogs are ready
  for it the day it is translated.
- **The installers.** The NSIS and MSI installers and the messages of `runner-installer-hooks.nsh` stay in English.
  Tauri's NSIS bundler can show several languages; that is a later change to `runner.conf.json`.
- **The documentation site** stays in English, as for Picker.
- **Other languages.** Adding one afterwards is its catalogs, its run words and its glossary.

## Decisions made while building

- **The desktop app's shell reads Runner's English catalog.** The functions both apps share (the tray's background
  rows, the question before quitting, updating or restarting, the update dialogs) read `shell_words(app)`; the desktop
  app keeps no language, so they stay English there, and the question lost its "run(s)" in both apps.
- **An English window shows the hub's own sentences.** The layer words a coded answer (`RUN_ANSWER_KEYS`) only in
  another language, so the dashboard's English stays the hub's, character for character.
- **The catalogs load on demand.** The layer's (`loadRunUiCatalog`), Runner's and the run words'
  (`@piwitests/run-model/speakers`) load when a language is first shown, so the dashboard ships none but English.
  Runner's window waits for the shell's answer before it shows, so it never shows English first.
- **The Language setting is a card of its own**, under In the background, and lists each language by its own name.
- **The start screen keeps the language Runner started in**, until it starts again: the shell makes its three lines
  once per launch.
- **The window's spec runs in CI's Piwi Runner job** (`npm run runner:e2e`, after the window's build), in French and in
  German, at the window's smallest size (640 × 480).
- **What stays in the language it was said in.** A run card's title, made as its request starts, and a hub's answer
  shown under a control keep the language they were said in after a change of language; the next ones follow it.
- **Counts are written as the language writes numbers**, so the dashboard's English now groups a count past a
  thousand (`1,500 tests`).
- **The words chosen for the terms Runner adds** are in each glossary's new rows (*team instance*, *run
  request*, *linked folder*, *tray*, *local host*); a reviewer should check those first.
