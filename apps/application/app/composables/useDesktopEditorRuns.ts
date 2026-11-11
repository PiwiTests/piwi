import type { DesktopEditorRun } from '#shared/desktop-runs';

/**
 * Desktop shell only: the editors' live runs, as the server observes them (`editor-runs` on `/api/desktop/events`,
 * which `desktop-run-progress.client.ts` keeps here). The window shows them and steers none of them. Empty outside the
 * shell.
 */
export function useDesktopEditorRuns() {
  return useState<DesktopEditorRun[]>('desktop-editor-runs', () => []);
}
