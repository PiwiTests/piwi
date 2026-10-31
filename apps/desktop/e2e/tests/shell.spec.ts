import { test, expect } from '../fixtures';
import type { TauriPage } from '@srsholmes/tauri-playwright';

/**
 * Smoke test for the shell integration, driving the real webview.
 *
 * The dashboard runs at the loopback (remote) origin, and Tauri rejects custom
 * command invokes from remote origins unless a capability grants them. That
 * rejection is exactly what silently broke external links, downloads, and
 * notifications — and it is invisible to compile-time and unit checks. Driving
 * the real app and calling a command end to end is the only thing that proves
 * the ACL grant is actually in place.
 *
 * Everything lives in ONE test on purpose: the shell is single-instance and
 * binds a fixed loopback port, so the per-test fixture can't launch a second
 * app instance — a relaunch just focuses the first window and never stands up
 * its own control socket. One launch, both assertions.
 *
 * `evaluate()` runs its argument as `await (<script>)`, so each script must be a
 * single expression; the plugin awaits it and hands back the resolved value.
 */
test('the dashboard can reach the shell IPC commands', async ({ tauriPage: fixturePage }) => {
  // Only the real-app ("tauri") project runs (see fixtures.ts), so the fixture is
  // always a TauriPage. Narrow the declared `TauriPage | BrowserPageAdapter` union
  // so the window helper below is reachable; the rest of the test uses it through
  // the same `tauriPage` name.
  const tauriPage = fixturePage as TauriPage;

  // The control socket accepts commands as soon as the plugin binds it, which can
  // be a beat before the shell's `main` window is created (the heavy startup work
  // — picking a port, spawning the Node sidecar, building the tray — runs on the
  // main thread first). Every eval-based command only retries window resolution
  // for ~2s, so gate on the window's existence up front (`list_windows` tolerates
  // an empty list) instead of letting the first probe race that budget.
  await tauriPage.waitForWindow((w) => w.label === 'main', { timeout: 60_000 });

  // The shell boots the sidecar server then navigates the window to it; wait for
  // the app shell to render before probing.
  await tauriPage.waitForSelector('#__nuxt, [data-nuxt-root], body *', 60_000);

  const hasBridge = await tauriPage.evaluate(
    `typeof window.__TAURI__ !== 'undefined' && typeof window.__TAURI__.core?.invoke === 'function'`,
  );
  expect(hasBridge, 'window.__TAURI__.core.invoke must exist in the desktop webview').toBe(true);

  // A single awaited expression: invoke the command and resolve to a plain object
  // the plugin can serialize back. If the ACL rejected it we'd get `ok: false`.
  const result = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_get_service_settings')
      .then((s) => ({ ok: true, keys: Object.keys(s || {}) }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  `)) as { ok: boolean; error?: string; keys?: string[] };

  expect(result.ok, `invoke was rejected: ${result.error ?? 'unknown'}`).toBe(true);
  expect(result.keys).toEqual(expect.arrayContaining(['run_in_background', 'start_on_login']));

  // The local-runner commands are granted too: an unknown project resolves to
  // null (not an ACL rejection)…
  const link = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_get_project_link', { projectId: '999999999' })
      .then((l) => ({ ok: true, link: l ?? null }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  `)) as { ok: boolean; error?: string; link?: unknown };
  expect(link.ok, `desktop_get_project_link rejected: ${link.error ?? 'unknown'}`).toBe(true);
  expect(link.link).toBeNull();

  // …and a relative path is refused by the command's own validation, proving
  // the call went through the ACL and into the handler.
  const rejected = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_set_project_link', { projectId: '999999999', path: 'not/absolute' })
      .then(() => ({ rejected: false, error: '' }))
      .catch((e) => ({ rejected: true, error: String((e && e.message) || e) }))
  `)) as { rejected: boolean; error: string };
  expect(rejected.rejected).toBe(true);
  expect(rejected.error).toContain('absolute');

  // The folder inspector is granted, and refuses a relative path from inside
  // the handler rather than at the ACL.
  const inspect = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_inspect_folder', { path: 'not/absolute' })
      .then(() => ({ rejected: false, error: '' }))
      .catch((e) => ({ rejected: true, error: String((e && e.message) || e) }))
  `)) as { rejected: boolean; error: string };
  expect(inspect.rejected).toBe(true);
  expect(inspect.error).toContain('absolute');

  // The spec pre-flight is granted too, and refuses an unlinked project from
  // inside the handler rather than at the ACL.
  const specs = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_check_local_specs', { projectId: '999999999', files: ['tests/a.spec.ts'] })
      .then(() => ({ rejected: false, error: '' }))
      .catch((e) => ({ rejected: true, error: String((e && e.message) || e) }))
  `)) as { rejected: boolean; error: string };
  expect(specs.rejected).toBe(true);
  expect(specs.error).toContain('linked');

  // The MCP configurator command is granted and reports every known client.
  const mcp = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_mcp_clients')
      .then((list) => ({ ok: true, ids: (list || []).map((c) => c.id) }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  `)) as { ok: boolean; error?: string; ids?: string[] };
  expect(mcp.ok, `desktop_mcp_clients rejected: ${mcp.error ?? 'unknown'}`).toBe(true);
  expect(mcp.ids).toEqual(
    expect.arrayContaining(['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf', 'gemini-cli']),
  );

  // Dev builds carry no updater config, so the update check must degrade to
  // "unsupported" — not reject through the ACL and not error.
  const update = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_check_update')
      .then((s) => ({ ok: true, state: s && s.state }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  `)) as { ok: boolean; error?: string; state?: string };
  expect(update.ok, `desktop_check_update rejected: ${update.error ?? 'unknown'}`).toBe(true);
  expect(update.state).toBe('unsupported');

  // The update settings are granted too, and a dev build reports itself unable
  // to update, which hides the startup-notification checkbox.
  const updateSettings = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_get_update_settings')
      .then((s) => ({ ok: true, supported: s && s.supported, pending: s && s.pending }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  `)) as { ok: boolean; error?: string; supported?: boolean; pending?: unknown };
  expect(updateSettings.ok, `desktop_get_update_settings rejected: ${updateSettings.error ?? 'unknown'}`).toBe(true);
  expect(updateSettings.supported).toBe(false);
  expect(updateSettings.pending).toBeNull();

  // The ambient badge/tooltip command is granted and accepts a set + clear.
  const activity = (await tauriPage.evaluate(`
    window.__TAURI__.core.invoke('desktop_set_activity', { count: 2, status: 'e2e' })
      .then(() => window.__TAURI__.core.invoke('desktop_set_activity', { count: 0, status: null }))
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  `)) as { ok: boolean; error?: string };
  expect(activity.ok, `desktop_set_activity rejected: ${activity.error ?? 'unknown'}`).toBe(true);

  // A run's output opens in a window of its own on the dashboard's run output page, which the dashboard window feeds
  // over a BroadcastChannel: the page says it is ready, then shows the state it is sent (its title becomes the
  // window's). The shell closes the window by its name and says when it is gone; an unknown name is refused. Each
  // step is a short evaluation in the main window, polled from here: with another window open, an unscoped one can
  // run in it, and one that waits across the opening of a window may never answer.
  const main = tauriPage.window('main');
  const onDashboard = `!!document.getElementById('__nuxt') && !document.getElementById('splash-status')`;
  await expect.poll(() => main.evaluate(onDashboard).catch(() => false), { timeout: 60_000 }).toBe(true);
  await main.evaluate(`
    (() => {
      const channel = new BroadcastChannel('piwi:run-output');
      window.__piwiE2eChannel = channel;
      window.__piwiE2eHeard = [];
      channel.onmessage = (event) => window.__piwiE2eHeard.push(event.data);
      window.__piwiE2eClosed = [];
      window.__TAURI__.event.listen('piwi:output-window-closed', (event) => window.__piwiE2eClosed.push(event.payload));
      return true;
    })()
  `);
  const opened = (await main.evaluate(`
    window.__TAURI__.core.invoke('desktop_open_output_window', { name: 'piwi-e2e-output' })
      .then((label) => ({ ok: true, label }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  `)) as { ok: boolean; label?: string; error?: string };
  expect(opened.ok, `desktop_open_output_window rejected: ${opened.error ?? 'unknown'}`).toBe(true);
  expect(opened.label).toMatch(/^output-piwi-e2e-output_\d+$/);
  const heardReady = `window.__piwiE2eHeard.some((m) => m.type === 'ready' && m.name === 'piwi-e2e-output')`;
  await expect
    .poll(() => main.evaluate(heardReady), {
      message: 'the run output page must say it is ready over the BroadcastChannel',
      timeout: 30_000,
    })
    .toBe(true);

  await main.evaluate(`
    (window.__piwiE2eChannel.postMessage({
      type: 'state', name: 'piwi-e2e-output', title: 'Piwi e2e run', status: { label: 'Passed', color: 'success' },
      detail: 'e2e', startedAt: Date.now(), finishedAt: Date.now(), running: false, stopRequested: false,
      lines: [{ id: 1, text: 'rendered by the dashboard', error: false }],
    }), true)
  `);
  await tauriPage.waitForWindow((w) => w.label === opened.label && w.title === 'Piwi e2e run · Piwi Dashboard', {
    timeout: 15_000,
  });

  const refused = (await main.evaluate(`
    window.__TAURI__.core.invoke('desktop_open_output_window', { name: '../main' })
      .then(() => ({ rejected: false, error: '' }))
      .catch((e) => ({ rejected: true, error: String((e && e.message) || e) }))
  `)) as { rejected: boolean; error: string };
  expect(refused.rejected).toBe(true);
  expect(refused.error).toContain('invalid');

  const closed = (await main.evaluate(`
    window.__TAURI__.core.invoke('desktop_close_output_window', { name: 'piwi-e2e-output' })
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  `)) as { ok: boolean; error?: string };
  expect(closed.ok, `desktop_close_output_window rejected: ${closed.error ?? 'unknown'}`).toBe(true);
  await expect.poll(() => main.evaluate(`window.__piwiE2eClosed`), { timeout: 15_000 }).toEqual([opened.label]);
  await expect
    .poll(async () => (await tauriPage.listWindows()).filter((w) => w.label.startsWith('output-')).length)
    .toBe(0);
});
