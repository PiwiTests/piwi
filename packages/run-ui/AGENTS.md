# Run UI layer: agent guide

Rules for working inside `packages/run-ui/` (`@piwitests/run-ui`, a Nuxt layer). The dashboard (`apps/application`)
extends it with its server render, and Piwi Runner's window (`apps/runner`) extends it with `ssr: false`. Read
[`../../AGENTS.md`](../../AGENTS.md) first for the repository-wide conventions.
[`ARCHITECTURE.md`](ARCHITECTURE.md) lists what the layer holds.

## Rules

- **Shared code moves here; it is never copied.** A component, composable or helper both hosts need lives in this
  layer, and each host uses it by auto-import. A second copy in a host is a bug.
- **The layer knows no host.** It imports nothing from `apps/*`, `~/` or `#shared/`. What only a host can do reaches
  the layer as an event (the modal's `start`), a slot or a prop (the app's name), and what a host frames stays in the
  host.
- **It builds with and without a server render.** A component renders on the server and hydrates, or mounts in a
  single-page app, so browser-only globals are read in `onMounted` or behind `tauriCore()`. `tests/layer.test.ts` loads
  the layer as a host extends it, both ways.
- **The logic is not here.** The held requests, the reconnect key and the checks live in `@piwitests/editor`
  (`request-host.ts`, `run-target.ts`), and the runs' hub in its `shell-runs.ts`; the layer renders the views they
  send and calls the host's `/api/desktop/run-target/*` and `/api/desktop/runs/*` routes. The layer does not decide the
  guard.
- **What only one host can do reaches the live view through `RUN_VIEW_HOST`** (`app/utils/run-view-host.ts`): the
  dashboard provides a worker's own window, its Open in editor link and a lane's **Inspect** (its view and what it
  heard, `apps/application/app/plugins/run-view-host.ts`), and Piwi Runner provides nothing, so its window offers none.
  `useDesktopRunHub` carries only Inspect's open lanes, the `inspect` command and its refusals; what is heard is the
  host's.
- **Auto-imports are the layer's interface.** A name is unique across the layer, every host and the repository's other
  exports, since a file in `app/components/`, `app/composables/` or `app/utils/` is imported by name. `npm run knip`
  reads each host's `.nuxt/imports.d.ts` and counts an export of the same name elsewhere as unused.

## Commands

```bash
npm run run-ui:test          # unit tests (vitest)
npm run run-ui:typecheck     # the TypeScript modules; components and composables are checked by each host's typecheck
npm run run-ui:lint
npm run run-ui:format:check
```
