# Run UI layer: agent guide

Rules for working inside `packages/run-ui/` (`@piwitests/run-ui`, a Nuxt layer). The dashboard (`apps/application`)
extends it with its server render, and Piwi Runner's window (`apps/runner`) extends it with `ssr: false`. Read
[`../../AGENTS.md`](../../AGENTS.md) first for the repository-wide conventions.

## What it holds

| Path                                                | What                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `app/components/DesktopTeamRunRequestModal.vue`     | The confirmation of a run request a team instance sent; emits `start` when **Run** wins  |
| `app/components/DesktopTeamInstance.vue`            | Connecting to a team instance (the device flow), its status, its linked folders          |
| `app/components/CodeBlock.vue`                      | A code block with a copy button                                                          |
| `app/composables/useDesktopTeamRequests.ts`         | The connection and the queue of requests the confirmation shows                          |
| `app/composables/useTauri.ts`, `useCopy.ts`         | The Tauri bridge (`tauriCore`, `tauriEvent`, `tauriWindowLabel`) and the clipboard       |
| `app/utils/run-target-words.ts`, `text.ts`          | The words of the connection and the request, `errorMessage`, `copyPreview`               |
| `src/highlight.ts` (`@piwitests/run-ui/highlight`)  | The one syntax-highlighting setup, also used by the server's exports and notifications   |

## Rules

- **Shared code moves here; it is never copied.** A component, composable or helper both hosts need lives in this
  layer, and each host uses it by auto-import. A second copy in a host is a bug.
- **The layer knows no host.** It imports nothing from `apps/*`, `~/` or `#shared/`. What only a host can do reaches the
  layer as an event (the modal's `start`) or a slot, and what a host frames (the dashboard's `SectionCard`) stays in the
  host.
- **It builds with and without a server render.** A component renders on the server and hydrates, or mounts in a
  single-page app; browser-only globals (`window`, `document`, the Tauri bridge) are read in `onMounted` or behind
  `tauriCore()`. `tests/layer.test.ts` loads the layer as a host extends it, both ways.
- **The logic is not here.** The held requests, the reconnect key and the checks live in `@piwitests/editor`
  (`request-host.ts`, `run-target.ts`); the layer renders the views it sends (`run-target-view.ts`) and calls the host's
  `/api/desktop/run-target/*` routes. The layer does not decide the guard.
- **Auto-imports are the layer's interface.** A file in `app/components/`, `app/composables/` or `app/utils/` is
  imported by name in the hosts, so a name is unique across the layer and every host, and across the repository's other
  exports: `npm run knip` reads each host's `.nuxt/imports.d.ts` and counts an export of the same name elsewhere (the
  extension's) as unused.
- **A host's hosts-only file stays in the host**: the dashboard's `plugins/desktop-team-requests.client.ts`, its
  settings page and its layout.

## Commands

```bash
npm run run-ui:test          # unit tests (vitest)
npm run run-ui:typecheck     # the TypeScript modules; components and composables are checked by each host's typecheck
npm run run-ui:lint
npm run run-ui:format:check
```
