/**
 * Desktop build: what the app's window reads and sends to follow the Playwright runs the desktop shell starts, which
 * the bundled server is the hub of (`server/utils/desktop-runs.ts`). The stream, the commands and the picks are the
 * editor service's (`@piwitests/editor/shell-run-events`), which Piwi Runner's host serves too; this file adds what
 * the app alone shows: the editors' runs it observes, the runs nobody attends, and **Inspect** of a lane, an event and a
 * command of the app's own that Piwi Runner's host neither sends nor takes.
 */
import { UNATTENDED_REF_SUFFIX, isUnattendedRef } from '@piwitests/core/run-channel';
import type { LiveSnapshotNotice, LiveWorkerId } from '@piwitests/core/live-view';
import type { HubSession } from '@piwitests/core/run-hub';
import type {
  DesktopRunCommand as ShellRunCommand,
  DesktopRunEvent as ShellRunEvent,
} from '@piwitests/editor/shell-run-events';

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

export { DESKTOP_PICKS_PATH, isDesktopRunViewer } from '@piwitests/editor/shell-run-events';

/**
 * A snapshot of a lane's page **Inspect** read from its test's trace, as the window hears of it: its call, title and
 * moment, its page and frame, the lane's worker (no shard), and the test it is of; never its JSON nor a path. The window
 * reads the page rendered (`GET /api/desktop/runs/inspect/page`).
 */
export type DesktopInspectNotice = LiveWorkerId & LiveSnapshotNotice & { type: 'snapshot'; test: string | null };

/**
 * What a window with **Inspect** open on the lane `lane` of the run `ref` hears: the attempt Inspect follows now
 * (`attempt`: Playwright's id of the lane's running test and its retry, `<id>#<retry>`; null between tests), each
 * snapshot read of it (`snapshot`), and why no page of it shows (`refused`).
 */
export type DesktopInspectEvent = { type: 'inspect'; ref: string; lane: number; attempt: string | null } & (
  | { snapshot?: undefined; refused?: undefined }
  | { snapshot: DesktopInspectNotice }
  | { refused: string }
);

/**
 * What a window hears as it opens Inspect on a lane (`GET /api/desktop/runs/inspect/calls`): the attempt Inspect follows,
 * the snapshots read of it so far, the latest `MAX_DESKTOP_INSPECT_LISTED`, and why no page of it shows, if it said.
 */
export interface DesktopInspectCalls {
  attempt: string | null;
  heard: DesktopInspectNotice[];
  refused: string | null;
}

/** The most snapshots a window hears of a lane as it opens Inspect: the latest. */
export const MAX_DESKTOP_INSPECT_LISTED = 600;

/** What the window's stream sends: the hub's events, and what **Inspect** read of a lane the window has it open on. */
export type DesktopRunEvent = ShellRunEvent | DesktopInspectEvent;

/**
 * A command of the window: the hub's (`ShellRunCommand`), or `inspect`, which the app's server alone answers:
 * **Inspect** of the lane `lane` of the run `ref` opens (`on`) or closes for the window, and the server reads the pages
 * of the lane's running test from its own trace while a window has it open, and tells it (`DesktopInspectEvent`).
 */
export type DesktopRunCommand =
  | ShellRunCommand
  | { type: 'inspect'; id: number; ref: string; lane: number; on: boolean; viewer: string };
