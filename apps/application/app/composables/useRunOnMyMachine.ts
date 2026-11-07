import type { RunRequestOptions } from '@piwitests/core/run-request';
import type { RunRequestView } from '#shared/handlers/run-requests';
import type { ConnectedApp, ConnectedAppsResponse } from '~~/types/api';

/** What a request runs, as `POST /api/run-requests` takes it: the instance resolves the tests from it. */
export type RunRequestSourceChoice =
  | { executionId: number }
  | { runId: number; tests: 'failed' | 'all' }
  | { runId: number; filePath: string };

/** One thing a page can send, as its menu lists it. */
export interface RunOnMyMachineChoice {
  label: string;
  /** How many tests it names, as the page counts them. */
  count: number;
  source: RunRequestSourceChoice;
}

/** A connected app that takes run requests. */
export type RunTargetApp = ConnectedApp & { target: NonNullable<ConnectedApp['target']> };

/**
 * **Run on my machine** on one project's pages: whether it shows (sign-in on, the capability on for the project, and
 * the person holds `run:request` there; never in the desktop window, which runs tests itself), the person's apps that
 * take requests, and sending one. The apps load in the browser, when the menu opens.
 */
export async function useRunOnMyMachine(projectId: number) {
  const config = useRuntimeConfig();
  const { can, authState } = useAuth();
  const { isHidden } = await useProjectCapabilities(projectId);

  const shown = computed(() => config.public.authEnabled && !isHidden('machine-runs') && can('run:request', projectId));

  const apps = ref<RunTargetApp[]>([]);
  const appsLoaded = ref(false);
  async function loadApps() {
    const userId = authState.value.user?.id;
    if (!userId) return;
    try {
      const { items } = await $fetch<ConnectedAppsResponse>(`/api/users/${userId}/connected-apps`);
      apps.value = items.filter((app): app is RunTargetApp => app.target !== null);
    } catch {
      apps.value = [];
    } finally {
      appsLoaded.value = true;
    }
  }

  async function send(
    source: RunRequestSourceChoice,
    options: RunRequestOptions,
    targetId: number | null,
  ): Promise<RunRequestView & { skipped: number }> {
    return $fetch<RunRequestView & { skipped: number }>('/api/run-requests', {
      method: 'POST',
      body: { source, options, ...(targetId != null ? { targetId } : {}) },
    });
  }

  return { shown, apps, appsLoaded, loadApps, send };
}

/** Follow one request every 2 seconds until it ends; `stop` asks for its end. */
export function useRunRequestProgress() {
  const request = ref<RunRequestView | null>(null);
  const error = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  async function poll() {
    clear();
    const current = request.value;
    if (!current || runRequestIsFinal(current)) return;
    try {
      request.value = await $fetch<RunRequestView>(`/api/run-requests/${current.id}`);
      error.value = null;
    } catch (e) {
      error.value = errorMessage(e);
    }
    if (request.value && !runRequestIsFinal(request.value)) timer = setTimeout(poll, 2000);
  }

  function follow(view: RunRequestView) {
    request.value = view;
    error.value = null;
    timer = setTimeout(poll, 2000);
  }

  async function stop() {
    const current = request.value;
    if (!current) return;
    try {
      request.value = await $fetch<RunRequestView>(`/api/run-requests/${current.id}/stop`, { method: 'POST' });
      error.value = null;
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  function reset() {
    clear();
    request.value = null;
    error.value = null;
  }

  onScopeDispose(clear);
  return { request, error, follow, stop, reset };
}
