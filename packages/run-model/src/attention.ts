/**
 * What the runs ask of the person, in one state for every corner of the screen: Piwi Picker's toolbar badge, Runs tile
 * and Runs window title, and the desktop app's taskbar, Dock, title and tray dot.
 */

/**
 * What a run asks of the person now, the same in every corner of the screen (a status bar, the Runs window's title and
 * the toolbar's badge, the desktop app's taskbar, Dock and tray): a test of it waits at a stop for them (`waiting`: a
 * breakpoint, a Pause, a failure held at its line, but a stop an agent drives), else a test of it failed (`failing`),
 * else it runs (`running`). With it, how many tests wait (`waiting`), how many of those are failures held at their line
 * (`heldFailures`), and how many failed so far (`failed`).
 */
export interface RunAttention {
  state: 'waiting' | 'failing' | 'running';
  waiting: number;
  heldFailures: number;
  failed: number;
}

/** A run as its attention reads it: a hub's session, or the editor service's run session. */
export interface AttentionRun {
  ended: boolean;
  workers: ReadonlyArray<{
    state: string;
    stop?: { reason: string; driver?: { kind: string } | null } | null;
  }>;
  progress?: { failed: number } | null;
}

/** Whether a worker waits at a stop for the person: stopped there, at a stop no agent drives. */
function waitsForPerson(worker: AttentionRun['workers'][number]): boolean {
  return worker.state === 'stopped' && !!worker.stop && worker.stop.driver?.kind !== 'agent';
}

/** What a run asks of the person now (`RunAttention`); null once it ended. */
export function runAttention(run: AttentionRun): RunAttention | null {
  if (run.ended) return null;
  const stops = run.workers.flatMap((worker) => (waitsForPerson(worker) && worker.stop ? [worker.stop] : []));
  const failed = run.progress?.failed ?? 0;
  return {
    state: stops.length > 0 ? 'waiting' : failed > 0 ? 'failing' : 'running',
    waiting: stops.length,
    heldFailures: stops.filter((stop) => stop.reason === 'failure').length,
    failed,
  };
}

/**
 * What the live runs ask of the person together: the most pressing state of any (`waiting`, then `failing`, then
 * `running`), each count summed; null while none is live.
 */
export function runsAttention(runs: readonly AttentionRun[]): RunAttention | null {
  const each = runs.map(runAttention).filter((attention): attention is RunAttention => attention !== null);
  if (each.length === 0) return null;
  const sum = (count: (attention: RunAttention) => number) => each.reduce((total, a) => total + count(a), 0);
  const waiting = sum((a) => a.waiting);
  const failed = sum((a) => a.failed);
  return {
    state: waiting > 0 ? 'waiting' : failed > 0 ? 'failing' : 'running',
    waiting,
    heldFailures: sum((a) => a.heldFailures),
    failed,
  };
}

/**
 * The first test of the live runs that waits at a stop for the person, as `runAttention` counts them: its run and its
 * worker, in the order of the runs, then of their workers; null while none waits.
 */
export function firstWaiting<R extends AttentionRun>(
  runs: readonly R[],
): { run: R; worker: R['workers'][number] } | null {
  for (const run of runs) {
    if (run.ended) continue;
    const worker = run.workers.find(waitsForPerson);
    if (worker) return { run, worker };
  }
  return null;
}
