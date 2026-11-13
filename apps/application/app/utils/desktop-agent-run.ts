/**
 * Desktop shell: a run an agent asked the desktop app to start (`run_start` on `/mcp`, `agent-run` on the desktop event
 * stream), as the main window starts it: a person's run of the spec from the Local runs tray, with the project's own
 * options but those that make a run nobody attends (each test once, never in UI mode), the browser shown or not and Hold
 * failures as the agent asked, under the title that names the agent.
 */
import type { DesktopAgentRun } from '#shared/desktop-agent-runs';
import type { LocalRunKind } from '~/composables/useDesktopLocalRuns';
import type { RetryCase } from '#shared/retry-command';
import { UNATTENDED_RUN_SUFFIX } from '#shared/desktop-runs';
import type { LocalRunOptions } from '~/utils/local-run-args';
import { desktopArgsAttended, desktopRunRef } from '~/utils/desktop-run-view';

/** What the tray's `startRun` takes for an agent's run: one case, the spec or the test at its line. */
export function desktopAgentRunInput(run: DesktopAgentRun): {
  projectId: number;
  cases: RetryCase[];
  title: string;
  options: LocalRunOptions;
} {
  return {
    projectId: run.projectId,
    cases: [{ filePath: run.file, title: '', line: run.line }],
    title: run.title,
    options: {
      mode: run.line === null ? 'file' : 'file-line',
      runMode: run.headed ? 'headed' : 'normal',
      holdFailures: run.hold,
      repeatEach: 1,
    },
  };
}

/**
 * The name the hub knows a run the shell started by (`desktop-<id>`), marked when nobody attends it, as the shell
 * marks it from its arguments (`hub_env.rs`).
 */
export function desktopAgentRunRef(shellId: number, args: readonly string[]): string {
  const ref = desktopRunRef(shellId);
  return desktopArgsAttended(args) ? ref : `${ref}${UNATTENDED_RUN_SUFFIX}`;
}

/** Where the window keeps the agents' runs it took, for the page a reload opens. */
const TAKEN_STORAGE_KEY = 'piwi-agent-runs-taken';

/** The ids of agents' runs a window keeps as taken, the latest. */
const MAX_TAKEN = 50;

/** The agents' runs this page took, when its storage is unavailable. */
const takenHere = new Set<string>();

/**
 * Whether the window takes the agent's run `id` now: the first time it hears it, never again in this page nor in the
 * page a reload opens, as the server sends a run still waiting again to a window that (re)connects.
 */
export function takeAgentRun(
  id: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.sessionStorage ?? null,
): boolean {
  if (takenHere.has(id)) return false;
  let taken: string[] = [];
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(TAKEN_STORAGE_KEY) ?? '[]');
    if (Array.isArray(parsed)) taken = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    // Unavailable or unreadable storage: this page alone remembers.
  }
  if (taken.includes(id)) return false;
  takenHere.add(id);
  try {
    storage?.setItem(TAKEN_STORAGE_KEY, JSON.stringify([...taken, id].slice(-MAX_TAKEN)));
  } catch {
    // Unavailable storage: this page alone remembers.
  }
  return true;
}

/**
 * What the window tells the server of a test run of the tray that ended (`POST /api/desktop/runs/ended`): each process
 * of its steps ended, with the run's exit code, so an agent's run whose workers never connected ends too.
 */
export function desktopRunEnds(run: {
  kind: LocalRunKind;
  hubRefs: readonly string[];
  exitCode: number | null;
}): Array<{ ref: string; exitCode: number | null }> {
  return run.kind === 'tests' ? run.hubRefs.map((ref) => ({ ref, exitCode: run.exitCode })) : [];
}
