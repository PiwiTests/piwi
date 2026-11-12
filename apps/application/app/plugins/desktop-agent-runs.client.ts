/**
 * Desktop shell: the main window starts the runs agents ask the desktop app for (`run_start` on `/mcp`), each heard on
 * the desktop event stream (`agent-run`), as a person's run from its Local runs tray (`useDesktopLocalRuns().startRun`),
 * which opens to show it. Once the shell started the run, the window answers with the name the hub knows it by, or
 * why it did not start (`POST /api/desktop/runs/agent-started`), and the agent's `run_start` answers with it. Another
 * window starts none, and the main window takes each run once (`takeAgentRun`), a reload included, so a run starts
 * once; a run whose answer the server no longer waits for is stopped. Each test run of the tray that ends is said to
 * the server (`POST /api/desktop/runs/ended`), so an agent's run whose workers never connected ends too.
 */
import { desktopAgentRunOf } from '#shared/desktop-agent-runs';
import { desktopAgentRunInput, desktopAgentRunRef, desktopRunEnds, takeAgentRun } from '~/utils/desktop-agent-run';
import type { LocalRun } from '~/composables/useDesktopLocalRuns';
import type { ApiResponse } from '~~/types/api';

export default defineNuxtPlugin(() => {
  const label = tauriWindowLabel();
  if (!tauriCore() || (label !== null && label !== 'main')) return;
  const store = useDesktopLocalRuns();

  /** The ref of the run once the shell started it, or why it did not start. */
  function started(local: LocalRun | null): Promise<{ ref: string } | { error: string }> {
    if (!local) return Promise.resolve({ error: 'The desktop app could not build a run of the spec.' });
    return new Promise((resolve) => {
      const stop = watch(
        () => [local.shellId, local.status] as const,
        ([shellId, status]) => {
          if (shellId !== null) {
            resolve({ ref: desktopAgentRunRef(shellId, local.steps[local.stepIndex]?.args ?? []) });
          } else if (status !== 'running') {
            const said = local.lines.findLast((line) => line.error)?.text;
            resolve({ error: said ? `The run did not start: ${said}` : 'The run did not start.' });
          } else {
            return;
          }
          queueMicrotask(() => stop());
        },
        { immediate: true },
      );
    });
  }

  subscribeDesktopEvents((message) => {
    if (message.type !== 'agent-run') return;
    const run = desktopAgentRunOf(message.run);
    if (!run || !takeAgentRun(run.id)) return;
    const local = store.startRun(desktopAgentRunInput(run));
    void started(local).then((answer) =>
      $fetch<ApiResponse<typeof import('~~/server/api/desktop/runs/agent-started.post').default>>(
        '/api/desktop/runs/agent-started',
        { method: 'POST', body: { id: run.id, ...answer } },
      ).catch(() => {
        // The server no longer waits for this run (its agent heard it did not start): nobody follows it.
        if (local && 'ref' in answer && local.status === 'running' && !local.stopRequested) void store.stopRun(local);
      }),
    );
  });

  store.onRunEnded((run) => {
    for (const body of desktopRunEnds(run)) {
      void $fetch<ApiResponse<typeof import('~~/server/api/desktop/runs/ended.post').default>>(
        '/api/desktop/runs/ended',
        { method: 'POST', body },
      ).catch(() => {});
    }
  });
});
