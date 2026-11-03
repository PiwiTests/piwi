import { computed, reactive } from 'vue';
import {
  DEMO_SCENARIOS,
  DEMO_SIMULATOR_INSTANCE_ID,
  DEMO_PROJECT_ID,
  runSimulation,
  type DemoScenario,
  type SimulationController,
} from '~/demo/simulator';

/**
 * Shared state for the demo run simulator (see app/demo/simulator.ts).
 *
 * Module-level singleton so the simulation keeps streaming while the visitor
 * navigates around the SPA, and every DemoSimulator instance renders the same
 * progress.
 */

interface DemoSimulatorState {
  status: 'idle' | 'running' | 'stopping';
  scenario: DemoScenario | null;
  runId: number | null;
  projectId: number | null;
  completed: number;
  failed: number;
  total: number;
}

const state = reactive<DemoSimulatorState>({
  status: 'idle',
  scenario: null,
  runId: null,
  projectId: null,
  completed: 0,
  failed: 0,
  total: 0,
});

let controller: SimulationController | null = null;
let staleRunsCancelled = false;

/** A simulated run's page, on the tab its scenario is about. */
function runPath(runId: number, scenario: DemoScenario | null): string {
  return scenario?.tab ? `/test-runs/${runId}?tab=${scenario.tab}` : `/test-runs/${runId}`;
}

export function useDemoSimulator() {
  const toast = useToast();
  // Simulated runs are uploads to the demo's e2e-checkout project, so they take
  // `run:submit` there (Maintainer, Project admin or Uploader), as the demo
  // router checks.
  const { can } = useAuth();
  const canSimulate = computed(() => can('run:submit', DEMO_PROJECT_ID));

  /**
   * Cancel runs orphaned by a page reload mid-simulation (their reporter
   * loop died with the page, so they would stay 'running' forever).
   */
  async function cancelStaleRuns(): Promise<void> {
    if (staleRunsCancelled) return;
    staleRunsCancelled = true;
    try {
      await $fetch('/api/demo/cancel-stale-runs', {
        method: 'POST',
        body: { instanceId: DEMO_SIMULATOR_INSTANCE_ID },
      });
    } catch {
      // Non-critical cleanup — ignore
    }
  }

  async function start(scenario: DemoScenario): Promise<void> {
    if (state.status !== 'idle') return;

    // Refuse up front, with the reason, rather than starting a run the demo
    // router would refuse.
    if (!canSimulate.value) {
      toast.add({
        title: 'Cannot upload runs to this project',
        description:
          'Simulated runs are uploaded to the “e2e-checkout” project, which takes the Maintainer, Project admin or Uploader role there. Switch to a user who holds one (e.g. the admin) to run a simulation.',
        color: 'warning',
        icon: 'i-lucide-lock',
      });
      return;
    }

    state.status = 'running';
    state.scenario = scenario;
    state.runId = null;
    state.projectId = null;
    state.completed = 0;
    state.failed = 0;
    state.total = 0;
    const ctl: SimulationController = { stopped: false };
    controller = ctl;

    try {
      const { runId, status } = await runSimulation(
        scenario,
        {
          onRunCreated: (runId, projectId) => {
            state.runId = runId;
            state.projectId = projectId;
            // Bring the visitor to the run page so they watch it arrive live
            navigateTo(runPath(runId, scenario));
          },
          onProgress: (completed, failed, total) => {
            state.completed = completed;
            state.failed = failed;
            state.total = total;
          },
        },
        ctl,
      );

      // A run stopped from the banner says nothing of what its scenario shows.
      const result = ctl.stopped ? undefined : scenario.result;
      const link = result?.link;
      const to = link ? await link.to(runId) : null;
      toast.add({
        title: `Simulated run #${runId} ${status}`,
        description: result?.text ?? 'Sent by an emulated Piwi reporter, straight into the in-browser database.',
        color: status === 'passed' ? 'success' : status === 'failed' ? 'error' : 'warning',
        icon: scenario.icon,
        actions: link && to ? [{ label: link.label, to, color: 'neutral', variant: 'outline' }] : undefined,
      });
    } catch (error) {
      console.error('[Demo simulator] simulation failed', error);
      toast.add({ title: 'Simulation failed', description: 'See the browser console for details.', color: 'error' });
    } finally {
      state.status = 'idle';
      state.scenario = null;
      controller = null;
    }
  }

  function stop(): void {
    if (controller && state.status === 'running') {
      controller.stopped = true;
      state.status = 'stopping';
    }
  }

  return { state, scenarios: DEMO_SCENARIOS, canSimulate, start, stop, cancelStaleRuns, runPath };
}
