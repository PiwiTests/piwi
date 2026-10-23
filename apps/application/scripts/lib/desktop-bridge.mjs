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
 * `importableRuns` and `pickedFiles` (the archives the folder holds and the
 * native import picker returns, else none).
 */
export function bridgeScript(shape = {}) {
  const inspection = shape.inspection ?? READY_INSPECTION;
  const link = shape.link ?? null;
  const importableRuns = shape.importableRuns ?? [];
  const pickedFiles = shape.pickedFiles ?? [];
  return `
    window.__mockLink = ${JSON.stringify(link)};
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
              return Promise.resolve({ run_in_background: false, start_on_login: false });
            case 'desktop_check_update':
              return Promise.resolve({ state: 'unsupported' });
            case 'desktop_mcp_clients':
              return Promise.resolve([]);
            default:
              return Promise.resolve(null);
          }
        },
      },
      event: { listen: () => Promise.resolve(() => {}) },
      window: { getCurrentWindow: () => ({ label: 'main' }) },
    };
  `;
}
