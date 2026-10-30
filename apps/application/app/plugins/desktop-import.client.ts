/**
 * Desktop shell: collect archives the OS hands to the app and surface the
 * import dialog.
 *
 * Two delivery paths, both carrying file *paths* (the webview never sees the
 * bytes — the desktop-only import route reads them from disk server-side):
 *   - `tauri://drag-drop` — files dropped anywhere on the window; and
 *   - `piwi:open-files` — a poke from the shell after "Open with", a dock
 *     drop, or a second launch with file arguments. The shell only queues and
 *     pokes; draining over IPC means a poke fired before this plugin ran is
 *     never lost — the initial drain below picks those up.
 *
 * Gated on the IPC bridge (not the desktop flag): the bridge exists exactly
 * where these events can occur, and only the main window imports.
 */
export default defineNuxtPlugin(() => {
  const core = tauriCore();
  const events = tauriEvent();
  if (!core || !events || tauriWindowLabel() !== 'main') return;

  const { addFiles } = useDesktopImportQueue();

  async function drain() {
    try {
      const pending = await core!.invoke<string[]>('desktop_take_pending_open_files');
      if (pending?.length) addFiles(pending);
    } catch {
      // An older shell without the command — drag & drop still works.
    }
  }

  void events.listen('piwi:open-files', () => void drain());
  void events.listen<{ paths?: string[] }>('tauri://drag-drop', ({ payload }) => {
    if (payload?.paths?.length) addFiles(payload.paths);
  });
  void drain();
});
