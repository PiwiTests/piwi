/**
 * The desktop shell's Tauri bridge, mocked in the browser: the screenshot
 * harness's `desktop` mode and the runtime check's `--desktop` pass inject it
 * into pages of a dev server started with `NUXT_PUBLIC_DESKTOP=true`.
 */

/** What the mocked `desktop_inspect_folder` reports unless told otherwise. */
export const READY_INSPECTION = {
  path: '/home/dev/code/acme-checkout',
  exists: true,
  packageName: '@acme/checkout',
  suggestedName: 'checkout-web',
  playwrightConfig: 'playwright.config.ts',
  playwrightInstalled: true,
  reporterInstalled: true,
  reporterConfigured: true,
  configuredProjectName: 'checkout-web',
};

/**
 * The mocked Tauri IPC bridge, as an init script for a page of a server
 * started with `NUXT_PUBLIC_DESKTOP=true`, so the desktop UI renders with no
 * shell build. Mirrors the real shell's commands. `shape` sets what the mock
 * answers: `link` (`desktop_get_project_link`, else no linked folder),
 * `inspection` (`desktop_inspect_folder`, else `READY_INSPECTION`),
 * `requestFolders` (`desktop_request_folders`, the folders linked to a team
 * instance's projects by project id, else none),
 * `importableRuns` and `pickedFiles` (the archives the folder holds and the
 * native import picker returns, else none), `localRunId` (the shell's id of a
 * local run `desktop_run_local_tests` starts, which then goes on until the
 * scene ends; a list gives each start the next id of it, the last one again
 * once they are used; else none starts), and `serverPort` and `activePort` (the port
 * the settings name and the one the server listens on, else both 3000), and
 * `update` (`{ check, releaseNotes }`: the update the startup check found and
 * the release notes `desktop_get_release_notes` answers; else the build has
 * no update channel).
 * `window.__emitTauri(name, payload)` plays an event of the shell, such as a
 * `piwi:local-run` output line, `window.__outputWindowName` is the name of
 * the last run output window opened, and `window.__runArgs` what the last
 * local run was started with (its `originRef`, which links it to the Piwi run
 * it reports).
 */
export function bridgeScript(shape = {}) {
  const inspection = shape.inspection ?? READY_INSPECTION;
  const link = shape.link ?? null;
  const importableRuns = shape.importableRuns ?? [];
  const pickedFiles = shape.pickedFiles ?? [];
  const localRunIds = [shape.localRunId ?? null].flat();
  const requestFolders = shape.requestFolders ?? {};
  const serverPort = shape.serverPort ?? 3000;
  const activePort = shape.activePort ?? serverPort;
  const update = shape.update ?? null;
  return `
    window.__mockLink = ${JSON.stringify(link)};
    const localRunIds = ${JSON.stringify(localRunIds)};
    let localRunsStarted = 0;
    const listeners = {};
    window.__emitTauri = (name, payload) => {
      for (const cb of listeners[name] ?? []) cb({ payload });
    };
    window.__TAURI__ = {
      core: {
        invoke: (cmd, args) => {
          switch (cmd) {
            case 'desktop_pick_folder':
              return Promise.resolve(${JSON.stringify(inspection.path)});
            case 'desktop_inspect_folder':
              return Promise.resolve({ ...${JSON.stringify(inspection)}, path: args.path });
            case 'desktop_find_importable_runs':
              return Promise.resolve(${JSON.stringify(importableRuns)});
            case 'desktop_pick_import_files':
              return Promise.resolve(${JSON.stringify(pickedFiles)});
            case 'desktop_get_project_link':
              return Promise.resolve(window.__mockLink);
            case 'desktop_set_project_link':
              window.__mockLink = args.path ? { path: args.path, exists: true } : null;
              return Promise.resolve(null);
            case 'desktop_open_window':
              return Promise.resolve(null);
            case 'desktop_save_download':
              return Promise.resolve('~/Downloads/' + (args?.filename ?? 'download'));
            case 'desktop_get_service_settings':
              return Promise.resolve({
                run_in_background: false,
                start_on_login: false,
                server_port: ${serverPort},
                active_port: ${activePort},
              });
            case 'desktop_set_server_port':
              return Promise.resolve(null);
            case 'desktop_check_update':
              return Promise.resolve(${JSON.stringify(update?.check ?? { state: 'unsupported' })});
            case 'desktop_get_update_settings':
              return Promise.resolve(${JSON.stringify(
                update ? { supported: true, notify_on_startup: true, pending: update.check } : null,
              )});
            case 'desktop_get_release_notes':
              return ${update ? `Promise.resolve(${JSON.stringify(update.releaseNotes)})` : `Promise.reject('no update found, run a check first')`};
            case 'desktop_request_folders':
              return Promise.resolve(${JSON.stringify(requestFolders)});
            case 'desktop_mcp_clients':
              return Promise.resolve([]);
            case 'desktop_run_local_tests':
              window.__runArgs = args;
              return Promise.resolve(localRunIds[Math.min(localRunsStarted++, localRunIds.length - 1)]);
            case 'desktop_open_output_window':
              window.__outputWindowName = args.name;
              return Promise.resolve('output-' + args.name + '_0');
            default:
              return Promise.resolve(null);
          }
        },
      },
      event: {
        listen: (name, cb) => {
          (listeners[name] ??= []).push(cb);
          return Promise.resolve(() => {});
        },
      },
      window: { getCurrentWindow: () => ({ label: 'main' }) },
    };
  `;
}
