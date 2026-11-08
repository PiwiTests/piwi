# Run UI layer architecture

What the Nuxt layer in `packages/run-ui/` holds. The rules are in [`AGENTS.md`](AGENTS.md). This file is reference
material: open it when you need to understand the code.

## What it holds

| Path                                               | What                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `app/components/DesktopTeamRunRequestModal.vue`    | The confirmation of a run request a team instance sent; emits `start` when **Run** wins                  |
| `app/components/DesktopTeamInstance.vue`           | Connecting to a team instance (the device flow), its status, its linked folders; `appName` names the app |
| `app/components/CodeBlock.vue`                     | A code block with a copy button                                                                          |
| `app/composables/useDesktopTeamRequests.ts`        | The connection and the queue of requests the confirmation shows                                          |
| `app/composables/useTauri.ts`, `useCopy.ts`        | The Tauri bridge (`tauriCore`, `tauriEvent`, `tauriWindowLabel`) and the clipboard                       |
| `app/utils/run-target-words.ts`, `text.ts`         | The words of the connection and the request, `errorMessage`, `copyPreview`                               |
| `app/utils/desktop-events.ts`                      | The one shared `EventSource` on `/api/desktop/events` (`subscribeDesktopEvents`)                         |
| `app/plugins/desktop-team-requests.client.ts`      | Feeds the host's run-request queue from that stream inside the shell's main window                       |
| `src/highlight.ts` (`@piwitests/run-ui/highlight`) | The one syntax-highlighting setup, also used by the server's exports and notifications                   |
