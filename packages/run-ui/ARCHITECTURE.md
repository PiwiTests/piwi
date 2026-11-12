# Run UI layer architecture

What the Nuxt layer in `packages/run-ui/` holds. The rules are in [`AGENTS.md`](AGENTS.md). This file is reference
material: open it when you need to understand the code.

## What it holds

| Path                                                   | What                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `app/components/DesktopTeamRunRequestModal.vue`        | The confirmation of a run request a team instance sent; emits `start` when **Run** wins                                     |
| `app/components/DesktopTeamInstance.vue`               | Connecting to a team instance (the device flow), its status, its linked folders; `appName` names the app                    |
| `app/components/CodeBlock.vue`                         | A code block with a copy button                                                                                             |
| `app/composables/useDesktopTeamRequests.ts`            | The connection and the queue of requests the confirmation shows                                                             |
| `app/composables/useTauri.ts`, `useCopy.ts`            | The Tauri bridge (`tauriCore`, `tauriEvent`, `tauriWindowLabel`) and the clipboard                                          |
| `app/utils/run-target-words.ts`, `text.ts`             | The words of the connection and the request, `errorMessage`, `copyPreview`                                                  |
| `app/utils/desktop-events.ts`                          | The one shared `EventSource` on `/api/desktop/events` (`subscribeDesktopEvents`)                                            |
| `app/plugins/desktop-team-requests.client.ts`          | Feeds the host's run-request queue from that stream inside the shell's main window                                          |
| `src/highlight.ts` (`@piwitests/run-ui/highlight`)     | The one syntax-highlighting setup, also used by the server's exports and notifications                                      |
| `app/composables/useDesktopRunHub.ts`                  | The window's side of the runs' hub: the stream of `/api/desktop/runs/events` and the commands                               |
| `app/components/DesktopRun*.vue`                       | The live view of a run: its workers (`DesktopRunSession`, `DesktopRunWorker`), a stop's and a lane's page, the code to copy |
| `app/utils/run-view.ts` (`@piwitests/run-ui/run-view`) | The live view's pure half: keys, the run model's English words and icons, Share live, the items to copy                     |
| `app/utils/run-view-host.ts`                           | What a host adds to the live view (`RUN_VIEW_HOST`): a worker's own window, the link to a stop's file                       |
| `app/components/ErrorText.vue`, `LocatorCode.vue`      | An error with its ANSI colors (`@piwitests/run-ui/ansi`), a locator highlighted                                             |
| `app/utils/status-palette.ts`, `ui-classes.ts`         | The outcome colors (`STATUS_PALETTE`) and the neutral classes the shared marks take                                         |
| `src/fold-text.ts` (`@piwitests/run-ui/fold-text`)     | The search fold every list compares with, accents and case ignored                                                          |
