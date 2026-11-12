/**
 * The desktop app window's view of the Playwright runs its shell starts, the half the app alone has: which run of the
 * Local runs tray a hub session is (`desktopRunRef`, `desktopRunOf`), which runs hold their failures, which live runs
 * report a run's page and which worker runs each running row of it (`desktopSessionsOfRun`, `desktopRowWorker`), and
 * where a stop's file opens. The half Piwi Runner's window shares is the layer's (`@piwitests/run-ui/run-view`).
 */
import type { HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import { runFile } from '@piwitests/run-model/stop';
import { UNATTENDED_RUN_SUFFIX, isUnattendedDesktopRun } from '#shared/desktop-runs';
import { parseLocation } from '#shared/parse-location';
import type { LocalRunKind } from '~/composables/useDesktopLocalRuns';
import { localRunOriginKind } from '~/utils/desktop-job';

/** The name a run the shell started gives the bundled server on its run channel (`PIWI_RUN_REF`, `hub_env.rs`). */
export function desktopRunRef(shellId: number): string {
  return `desktop-${shellId}`;
}

/**
 * The name the window knows a hub's run by (`desktopRunRef`): its own, the mark of a run nobody attends left out (a
 * Flake Lab's `desktop-7-unattended` is the tray's `desktop-7`).
 */
export function desktopRunOf(ref: string): string {
  return isUnattendedDesktopRun(ref) ? ref.slice(0, -UNATTENDED_RUN_SUFFIX.length) : ref;
}

/** The shell's id of the run a hub's run names (`desktopRunRef`), null for a name the shell did not give. */
export function desktopShellIdOf(ref: string): number | null {
  const match = /^desktop-(\d+)$/.exec(desktopRunOf(ref));
  return match ? Number(match[1]) : null;
}

/**
 * Whether a person attends a `playwright test` run with these arguments, as the shell reads them (`attended_args`,
 * `hub_env.rs`): not one in UI mode (`--ui`), nor one that repeats each test (`--repeat-each` above 1) unless it ends
 * at its first failure (`--max-failures=1`).
 */
export function desktopArgsAttended(args: readonly string[]): boolean {
  let repeats = false;
  let stopsAtFirstFailure = false;
  for (const [index, arg] of args.entries()) {
    if (arg === '--ui' || arg.startsWith('--ui=')) return false;
    const repeat = optionValue(args, index, '--repeat-each');
    if (repeat !== undefined && !(/^\d+$/.test(repeat) && Number(repeat) <= 1)) repeats = true;
    if (optionValue(args, index, '--max-failures') === '1') stopsAtFirstFailure = true;
  }
  return !repeats || stopsAtFirstFailure;
}

/** The value of `--name` at `args[index]`, given as `--name=value` or `--name value`; undefined for another arg. */
function optionValue(args: readonly string[], index: number, name: string): string | undefined {
  const arg = args[index]!;
  if (arg === name) return args[index + 1] ?? '';
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
}

/** A run of the Local runs tray, as far as holding its failures goes: what it is and what its steps run. */
export interface DesktopHoldRun {
  kind: LocalRunKind;
  steps: ReadonlyArray<{ args: readonly string[] }>;
  /** How the run was started: with **Hold failures** on, or not. */
  options?: { holdFailures?: boolean };
}

/**
 * Why a run of the tray holds no failure whatever the person chooses, as the shell names it one nobody attends (a
 * bisect, a Flake Lab run or lab job, a run that repeats its tests or runs in UI mode); null for one that can.
 */
export function desktopHoldRefusal(run: DesktopHoldRun): string | null {
  if (run.kind === 'bisect') return 'A bisect goes on past each failure.';
  if (run.kind === 'flake') return 'A Flake Lab run goes on past each failure.';
  if (run.steps.some((step) => step.args.some((arg) => arg === '--ui' || arg.startsWith('--ui=')))) {
    return 'UI mode goes on past each failure.';
  }
  if (!run.steps.every((step) => desktopArgsAttended(step.args))) {
    return 'A run that repeats its tests goes on past each failure, unless it stops at the first one.';
  }
  return null;
}

/**
 * Whether a run holds its failures until the person says otherwise (**Hold failures** on from its start): a
 * reproduction, which runs to see its failure at its line, and a run started with the option on; every other run
 * starts with it off.
 */
export function desktopHoldsByDefault(run: Pick<DesktopHoldRun, 'kind' | 'options'>): boolean {
  return run.kind === 'reproduce' || !!run.options?.holdFailures;
}

/** A run of the tray, as far as showing it live goes: its hold, its state and its steps' names on the hub. */
export interface DesktopShownRun extends DesktopHoldRun {
  key: number;
  status: string;
  hubRefs: readonly string[];
}

/**
 * Why a run of the tray holds no failure whatever the person chooses: one nobody attends, by its kind
 * (`desktopHoldRefusal`) or as the hub names its steps (`sessions`, the hub's live runs); null for one that can.
 */
export function desktopRunHoldRefusal(run: DesktopShownRun, sessions: readonly HubSession[]): string | null {
  const refused = desktopHoldRefusal(run);
  if (refused) return refused;
  const unattended = sessions.some(
    (session) => isUnattendedDesktopRun(session.ref) && run.hubRefs.includes(desktopRunOf(session.ref)),
  );
  return unattended ? 'Nobody attends a run of this kind: it goes on past each failure.' : null;
}

/** Whether the person has a run of the tray hold its failures: their choice (`chosen`), else its kind's, when it can. */
export function desktopRunChosenHolds(
  run: DesktopShownRun,
  chosen: boolean | undefined,
  sessions: readonly HubSession[],
): boolean {
  return !desktopRunHoldRefusal(run, sessions) && (chosen ?? desktopHoldsByDefault(run));
}

/**
 * Whether a run of the tray holds its failures, as its switch shows it: the run's own Hold failures as its latest live
 * step says it (whoever set it: this window, Piwi Picker or an agent), else the person's choice, when it can.
 */
export function desktopRunHolds(
  run: DesktopShownRun,
  chosen: boolean | undefined,
  sessions: readonly HubSession[],
): boolean {
  if (desktopRunHoldRefusal(run, sessions)) return false;
  const held = desktopHeldSessions(run, sessions);
  const latest = held[held.length - 1];
  return latest?.hold ? latest.hold.on : desktopRunChosenHolds(run, chosen, sessions);
}

/** The live hub sessions of a run of the tray that have a Hold failures, in the hub's order. */
export function desktopHeldSessions(run: DesktopShownRun, sessions: readonly HubSession[]): HubSession[] {
  return sessions.filter((session) => !!session.hold && run.hubRefs.includes(desktopRunOf(session.ref)));
}

/**
 * The runs the window shows live, so a failure no pause bar shows is held in them: the running ones whose Hold
 * failures the person has on (`holds`, each run's choice by its key), by each step's name as the step starts, before its workers
 * connect, so a failure right after they do waits too. Opening or closing the tray, or a run's part of it, changes
 * nothing.
 */
export function desktopShownRefs(
  runs: readonly DesktopShownRun[],
  holds: Readonly<Record<number, boolean>>,
  sessions: readonly HubSession[],
): string[] {
  const held = runs.filter((run) => run.status === 'running' && desktopRunChosenHolds(run, holds[run.key], sessions));
  return [...new Set(held.flatMap((run) => run.hubRefs))].sort();
}

/** A Local runs entry, as far as finding the runs it reports goes. */
interface DesktopLinkedRun {
  kind: LocalRunKind;
  status: string;
  originRef: string | null;
  /** The Piwi run it was linked to first (**Open run #N**). */
  piwiRunId: number | null;
  /** Its steps' names on the hub. */
  hubRefs: readonly string[];
}

/** A Piwi run, as far as finding the Local runs entry that reports it goes: its id and the origin its metadata records. */
interface DesktopReportedRun {
  id: number;
  kind: string;
  ref: string | null;
}

/**
 * The live runs of the running Local runs entry that reports the Piwi run `run`, by the origin the shell stamps on each
 * run of an entry (`PIWI_ORIGIN`, `PIWI_ORIGIN_REF`): each step of a Re-run in several Playwright projects and each step
 * of a bisect reports a run of its own under it. Of several running entries under one origin (two reproductions of one
 * cluster), the one linked to the run alone, and none until it is linked. None for a run whose origin names no
 * reference.
 */
export function desktopSessionsOfRun(
  run: DesktopReportedRun | null,
  runs: readonly DesktopLinkedRun[],
  sessions: readonly HubSession[],
): HubSession[] {
  if (!run?.ref) return [];
  const running = runs.filter(
    (entry) => entry.status === 'running' && entry.originRef === run.ref && localRunOriginKind(entry.kind) === run.kind,
  );
  const entry = running.find((one) => one.piwiRunId === run.id) ?? (running.length === 1 ? running[0] : undefined);
  if (!entry) return [];
  return sessions.filter((session) => entry.hubRefs.includes(desktopRunOf(session.ref)));
}

/** The names of this machine's loopback interface, one server whatever name its address takes. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Whether an editor's run reports to the run `runId` of the server at `origin`: its page (`HubSession.page`) is that
 * run's on that server, under any name of the loopback interface, never a run of the same number on the team instance.
 */
export function desktopEditorRunOf(
  session: Pick<HubSession, 'page' | 'ended'>,
  runId: number,
  origin: string,
): boolean {
  if (session.ended || session.page?.id !== runId) return false;
  try {
    const page = new URL(session.page.url);
    const here = new URL(origin);
    if (page.origin === here.origin) return true;
    return (
      page.protocol === here.protocol &&
      page.port === here.port &&
      LOOPBACK_NAMES.has(page.hostname) &&
      LOOPBACK_NAMES.has(here.hostname)
    );
  } catch {
    return false;
  }
}

/** A running row of a run's page, as far as finding the worker that runs its test goes. */
interface DesktopRunRow {
  status: string;
  /** The test's own title. */
  title: string;
  /** `file:line:column` of its `test(…)` call, the file relative to its Playwright config's folder. */
  location?: string | null;
  /** Playwright's worker index. */
  workerIndex?: number | null;
}

/** A worker of a live run, with its run. */
export interface DesktopRowWorker {
  session: HubSession;
  worker: HubWorker;
}

/**
 * The worker that runs a running row's test now, among the live runs that report to the row's run: the one the row
 * names (Playwright's worker index), whose test is the row's by its own title, its spec and the line of its
 * `test(…)` call. Null for a row that does not run, or whose worker runs another test now (its next one, before the
 * row's end came).
 */
export function desktopRowWorker(sessions: readonly HubSession[], row: DesktopRunRow): DesktopRowWorker | null {
  if (row.status !== 'running' || row.workerIndex == null || !row.location) return null;
  const { filePath, line } = parseLocation(row.location);
  if (line === null) return null;
  // A spec outside the config's folder comes as `../tests/…`: it is matched by its path below that folder's parents.
  const below = filePath.replace(/^(?:\.\.?\/)+/, '');
  for (const session of sessions) {
    for (const worker of session.workers) {
      const test = worker.test;
      if (worker.worker !== row.workerIndex || !test) continue;
      if (test.title.at(-1) !== row.title || test.line + 1 !== line) continue;
      if (runFile(test.uri, null).endsWith(`/${below}`)) return { session, worker };
    }
  }
  return null;
}

/**
 * A stop's file, relative to the run's folder, and its 1-based line, for a link that opens it in the editor; null for
 * a run with no folder of its own (a reproduction or a bisect step, in a throwaway worktree) or a file outside its
 * folder, whose place shows as text (`stopPlace`).
 */
export function desktopStopLink(
  stop: Pick<HubStop, 'uri' | 'line'>,
  root: string | null,
): { file: string; line: number } | null {
  if (!root) return null;
  const file = runFile(stop.uri, root);
  return /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(file) ? null : { file, line: stop.line + 1 };
}
