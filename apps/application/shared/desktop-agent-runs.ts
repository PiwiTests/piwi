/**
 * Desktop build: a run an agent asks the desktop app to start (`run_start` on `/mcp`), which the server hands its
 * window on the desktop event stream (`agent-run`), and the window's answer once the shell started it, or why not
 * (`POST /api/desktop/runs/agent-started`). The server checked the spec and built what the run is
 * (`ShellRunStart` of `@piwitests/editor/shell-runs`); the window starts it as a person's run of that spec.
 */

/** The id the server names an agent's run by until the window answers: 32 lowercase hex characters. */
const AGENT_RUN_ID = /^[0-9a-f]{32}$/;

/** A ref the shell gives a run it starts (`desktop-<id>`), marked when nobody attends it. */
const SHELL_RUN_REF = /^desktop-\d{1,10}(?:-unattended)?$/;

/** The longest spec path, title and refusal an agent's run carries, in characters. */
const MAX_TEXT = 4096;

/**
 * What the window starts for an agent: the project whose linked folder holds the spec, the spec relative to that
 * folder, the line of the test to run (from 1; the whole spec when null), whether the browser shows, whether a failure
 * waits at its line (**Hold failures**), and the run's title in the tray ("Started by Claude Code").
 */
export interface DesktopAgentRun {
  id: string;
  projectId: number;
  file: string;
  line: number | null;
  headed: boolean;
  hold: boolean;
  title: string;
}

/** The window's answer to an agent's run: the ref the shell gave it, or why it did not start. */
export type DesktopAgentRunAnswer = { id: string; ref: string } | { id: string; error: string };

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
}

/** An agent's run as the event stream carries it, checked field by field; null when it is not one. */
export function desktopAgentRunOf(value: unknown): DesktopAgentRun | null {
  if (typeof value !== 'object' || value === null) return null;
  const run = value as Record<string, unknown>;
  const { id, projectId, file, line, headed, hold, title } = run;
  if (typeof id !== 'string' || !AGENT_RUN_ID.test(id)) return null;
  if (!Number.isInteger(projectId) || (projectId as number) < 1) return null;
  if (!text(file) || file.startsWith('-') || !text(title)) return null;
  if (line !== null && (!Number.isInteger(line) || (line as number) < 1)) return null;
  if (typeof headed !== 'boolean' || typeof hold !== 'boolean') return null;
  return { id, projectId: projectId as number, file, line: line as number | null, headed, hold, title };
}

/** The window's answer, checked field by field; null when it is not one. */
export function desktopAgentRunAnswerOf(value: unknown): DesktopAgentRunAnswer | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, ref, error } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !AGENT_RUN_ID.test(id)) return null;
  if (typeof ref === 'string' && SHELL_RUN_REF.test(ref) && error === undefined) return { id, ref };
  if (text(error) && ref === undefined) return { id, error };
  return null;
}
