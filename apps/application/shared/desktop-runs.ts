/**
 * Desktop build: what the app's window reads and sends to follow the Playwright runs the desktop shell starts, which
 * the bundled server is the hub of (`server/utils/desktop-runs.ts`). The stream, the commands and the picks are the
 * editor service's (`@piwitests/editor/shell-run-events`), which Piwi Runner's host serves too; this file adds what
 * the app alone shows: the editors' runs it observes, and the runs nobody attends.
 */
import { UNATTENDED_REF_SUFFIX, isUnattendedRef } from '@piwitests/core/run-channel';
import type { HubSession } from '@piwitests/core/run-hub';

/**
 * What the shell ends the name of a run nobody attends with (`PIWI_RUN_REF`, `hub_env.rs`): a Flake Lab, a bisect, a
 * lab job, a run in UI mode, or one that repeats each test (`--repeat-each` above 1) without stopping at its first
 * failure; the reporter ends so a run started in a terminal and piped elsewhere. The server holds no failure of such a
 * run, whoever watches it.
 */
export const UNATTENDED_RUN_SUFFIX = UNATTENDED_REF_SUFFIX;

/**
 * A live run of an editor of this machine, as the server observes it (`editor-runs` on `/api/desktop/events`): the
 * editor as it names itself, and the run as its hub tells it. The app shows it and steers none of it.
 */
export interface DesktopEditorRun {
  client: string | null;
  session: HubSession;
}

/** The editors' runs of an `editor-runs` message, each that reads as one; none for anything else. */
export function desktopEditorRuns(value: unknown): DesktopEditorRun[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (run): run is DesktopEditorRun =>
      !!run &&
      typeof run === 'object' &&
      (run.client === null || typeof run.client === 'string') &&
      typeof run.session?.ref === 'string' &&
      Array.isArray(run.session.workers),
  );
}

/** Whether the run `ref` names is one nobody attends: none of its failures waits for an answer. */
export function isUnattendedDesktopRun(ref: string): boolean {
  return isUnattendedRef(ref);
}

export {
  DESKTOP_PICKS_PATH,
  MAX_KEPT_STOP_CODES,
  isDesktopRunViewer,
  type DesktopRunCommand,
  type DesktopRunEvent,
  type DesktopRunPick,
} from '@piwitests/editor/shell-run-events';
