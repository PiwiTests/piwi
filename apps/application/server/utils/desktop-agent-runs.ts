/**
 * Desktop build: the runs agents ask the desktop app to start (`run_start` on `/mcp`), handed to its window, which
 * starts each as a person's run from its Local runs tray, through the shell. Each open window listens on the desktop
 * event stream (`/api/desktop/events`), which registers it here; the main window starts the run and answers with the
 * ref the shell gave it (`POST /api/desktop/runs/agent-started`), or why it did not. The hub of those runs
 * (`desktop-runs.ts`) checked the spec first.
 */
import { randomBytes } from 'node:crypto';
import type { ShellRunStart } from '@piwitests/editor/shell-runs';
import type { DesktopAgentRun, DesktopAgentRunAnswer } from '#shared/desktop-agent-runs';

/** How long the window has to start a run once asked, in milliseconds. */
export const AGENT_RUN_WAIT_MS = 30_000;

/** The runs asked of the window at once that wait for its answer: one more is refused. */
const MAX_WAITING = 8;

type AgentRunListener = (run: DesktopAgentRun) => void;

const listeners = new Set<AgentRunListener>();
const waiting = new Map<string, (answer: { ref: string } | { refused: string }) => void>();

/** Hears each run an agent asks the window to start; returns the unsubscribe. */
export function subscribeAgentRuns(listener: AgentRunListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Asks the windows to start `start` as a person's run: the ref the shell gave it once the window answers, or why not:
 * no window is open, the window refused it, or it did not answer within `waitMs`.
 */
export function askWindowToStart(
  start: ShellRunStart,
  waitMs = AGENT_RUN_WAIT_MS,
): Promise<{ ref: string } | { refused: string }> {
  if (!listeners.size) {
    return Promise.resolve({
      refused: "No window of the desktop app is open: open the app's window, then start the run again.",
    });
  }
  if (waiting.size >= MAX_WAITING) {
    return Promise.resolve({ refused: "The desktop app's window has not answered the runs asked before: ask again." });
  }
  const id = randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({
        refused: "The desktop app's window did not start the run: open its main window, then start the run again.",
      });
    }, waitMs);
    timer.unref?.();
    waiting.set(id, (answer) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(answer);
    });
    const run: DesktopAgentRun = { id, ...start };
    for (const listener of listeners) listener(run);
  });
}

/** The window's answer to a run it was asked to start: false for a run no longer waiting. */
export function answerAgentRun(answer: DesktopAgentRunAnswer): boolean {
  const resolve = waiting.get(answer.id);
  if (!resolve) return false;
  resolve('ref' in answer ? { ref: answer.ref } : { refused: answer.error });
  return true;
}
