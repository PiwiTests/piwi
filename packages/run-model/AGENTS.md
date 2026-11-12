# Run model: agent guide

Rules for working inside `packages/run-model/` (`@piwitests/run-model`): the decisions Piwi Picker's Runs window
(`apps/extension/src/runs/main.ts`) and the desktop app's Local runs tray (`apps/application/app/components/desktop/`)
share about a run they follow. Its modules: `attention` (what the runs ask of the person), `stop` (what a stop takes,
its place, its error), `status` (a worker's status and tab), `controls`, `outcome` (how a run came out beyond its
status: its tests ended at a stop), `presence` (who has a run open, watches or drives), `tabs` (the worker shown),
`layers` (a watched lane's layers under its page: why it waits, its events, its text, its filmstrip), `view-input`
(the live view's input, also the VS Code paused page's) and `words`. Read
[`../../AGENTS.md`](../../AGENTS.md) first.

## Rules

- **Framework-free.** No DOM, no Vue, no `chrome.*`, no editor API: the source imports its own modules and
  `@piwitests/core` alone, and each surface renders what it returns (`tests/boundary.test.ts`). Timers are fine.
- **Shared logic moves here, never copied.** Each surface imports it by name (`@piwitests/run-model/<module>`), never
  through a relative path into another workspace; a second copy in a surface is a bug.
- **Words go through a `RunSpeaker`.** A function returns a `RunMessage` (a key and its args) or takes the speaker,
  never an English sentence. A key is a key of Piwi Picker's catalogs: a new one goes into its five catalogs
  (`apps/extension/AGENTS.md`, Text and translations) and into `RUN_WORDS_EN` in the same change, a message that
  counts as its `_one` and `_other` keys, said through `RunSpeaker.count`.
- **`RUN_WORDS_EN` is the extension's English catalog:** `apps/extension/tests/unit/run-words.test.ts` fails on a
  message or a placeholder that differs, or a key a catalog lacks. That test is what keeps the English words a surface
  without the catalogs says (`englishRunSpeaker`) the window's.
- **Icons are names by meaning (`WorkerIcon`, `ControlIcon`),** the Runs window's own `IconName`s; another surface
  maps each to its set. A new one needs its entry in the extension's `ICONS`.
- **FSL-1.1-MIT, and never moved into `@piwitests/core`,** which is MIT: code moves from the MIT parts into this
  package, never the other way.

## Commands

```bash
npm run run-model:test          # unit tests (vitest)
npm run run-model:typecheck     # the source, then the tests
npm run run-model:lint
npm run run-model:format:check
```
