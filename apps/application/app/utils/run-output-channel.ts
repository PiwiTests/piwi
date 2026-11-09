/**
 * The messages between the dashboard window and the window a local run's output shows in
 * (`pages/desktop/run-output.vue`), over a `BroadcastChannel` of the dashboard's origin, so the output window holds
 * no IPC grant. The output window says it is `ready` and asks to `stop` the run; the dashboard window answers with
 * the run's `state`: its header, and the lines the window does not have yet.
 */
import type { LocalRunLine } from '~/composables/useDesktopLocalRuns';
import type { BadgeColor } from '~/utils';

export const RUN_OUTPUT_CHANNEL = 'piwi:run-output';

/** The run's header and its newest lines, as the output window shows them. */
export interface RunOutputState {
  type: 'state';
  name: string;
  title: string;
  status: { label: string; color: BadgeColor };
  detail: string;
  startedAt: number;
  finishedAt: number | null;
  running: boolean;
  stopRequested: boolean;
  /** Its lines the window does not have yet: all those it keeps after `ready`, the new ones since after that. */
  lines: LocalRunLine[];
}

export type RunOutputMessage = RunOutputState | { type: 'ready' | 'stop'; name: string };

/** The output window's name for the run of key `key`, as the shell takes one: lowercase letters, digits and dashes. */
export function runOutputWindowName(key: number): string {
  return `piwi-run-output-${key}`;
}

/**
 * The lines the output window shows once `state` arrives, from the `held` ones it has: `state.lines` added after them
 * when they follow on, in their place otherwise; the last `max` of them.
 */
export function mergeRunOutputLines(held: LocalRunLine[], state: RunOutputState, max: number): LocalRunLine[] {
  const follows = held.length > 0 && state.lines.length > 0 && state.lines[0]!.id === held.at(-1)!.id + 1;
  const lines = follows ? [...held, ...state.lines] : state.lines.length > 0 ? state.lines : held;
  return lines.length > max ? lines.slice(lines.length - max) : lines;
}
