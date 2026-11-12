/**
 * Desktop shell: a run an agent asked the desktop app to start (`run_start` on `/mcp`, `agent-run` on the desktop event
 * stream), as the main window starts it: a person's run of the spec from the Local runs tray, with the project's own
 * options, the browser shown or not and Hold failures as the agent asked, under the title that names the agent.
 */
import type { DesktopAgentRun } from '#shared/desktop-agent-runs';
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
