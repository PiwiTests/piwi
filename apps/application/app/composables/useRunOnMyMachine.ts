import { capabilityHidden } from '#shared/capabilities';
import type { RunRequestOptions } from '@piwitests/core/run-request';
import type { RunRequestView } from '#shared/handlers/run-requests';
import type { ConnectedApp, ConnectedAppsResponse } from '~~/types/api';

/** What a request runs, as `POST /api/run-requests` takes it: the instance resolves the tests from it. */
export type RunRequestSourceChoice =
  | { executionId: number }
  | { runId: number; tests: 'failed' | 'all' }
  | { runId: number; filePath: string };

/** A connected app that takes run requests. */
export type RunTargetApp = ConnectedApp & { target: NonNullable<ConnectedApp['target']> };

/**
 * **Run on my machine** on one project's pages: whether a person's apps are offered (sign-in on, the capability read
 * as on for the project, so a list that failed to load hides it, and the person holds `run:request` there; never in
 * the desktop window, which runs tests itself), the person's apps that take requests, and sending one. The apps load
 * in the browser, when the run dialog or its button's menu opens. A page whose data says whether the capability is on
 * (the run's `machineRuns`) passes it, and the project's capability list is then not loaded.
 */
export async function useRunOnMyMachine(projectId: number, machineRuns?: boolean) {
  const config = useRuntimeConfig();
  const { can, authState } = useAuth();
  const isDesktop = useIsDesktop();
  const capabilities = machineRuns === undefined ? await useProjectCapabilities(projectId) : null;

  const on = computed(() => {
    if (!capabilities) return !!machineRuns && !capabilityHidden('machine-runs', 'available', isDesktop);
    return (
      ['active', 'available'].includes(capabilities.state('machine-runs')) && !capabilities.isHidden('machine-runs')
    );
  });
  const shown = computed(() => config.public.authEnabled && on.value && can('run:request', projectId));

  const apps = ref<RunTargetApp[]>([]);
  const appsLoaded = ref(false);
  async function loadApps() {
    const userId = authState.value.user?.id;
    if (!userId) {
      apps.value = [];
      appsLoaded.value = true;
      return;
    }
    try {
      const { items } = await $fetch<ConnectedAppsResponse>(`/api/users/${userId}/connected-apps`);
      apps.value = items.filter((app): app is RunTargetApp => app.target !== null);
    } catch {
      apps.value = [];
    } finally {
      appsLoaded.value = true;
    }
  }

  /** Sends a request; `environmentId` names the environment of the project the run is for, null for none. */
  async function send(
    source: RunRequestSourceChoice,
    options: RunRequestOptions,
    targetId: number | null,
    environmentId: number | null = null,
  ): Promise<RunRequestView & { skipped: number }> {
    return $fetch<RunRequestView & { skipped: number }>('/api/run-requests', {
      method: 'POST',
      body: {
        source,
        options,
        ...(targetId != null ? { targetId } : {}),
        ...(environmentId != null ? { environmentId } : {}),
      },
    });
  }

  return { shown, apps, appsLoaded, loadApps, send };
}

/** A project's Run on my machine, as `useRunOnMyMachine` answers it. */
export type RunOnMyMachine = Awaited<ReturnType<typeof useRunOnMyMachine>>;
