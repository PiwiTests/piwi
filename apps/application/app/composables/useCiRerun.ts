import type { MaybeRefOrGetter } from 'vue';

/** A CI re-run's availability and last dispatch, from a cluster's or an execution's `/rerun`. */
export interface RerunInfo {
  available: boolean;
  reason: string | null;
  provider: string | null;
  enabled: boolean;
  hasToken: boolean;
  lastDispatch: { provider: string; url: string; args: string; at: number; byName: string | null } | null;
}

/**
 * Dispatch a CI re-run through a `/rerun` route (a cluster's affected tests, or
 * one execution's test). The failure pages fetch the `RerunInfo` themselves
 * (their SSR strategies differ) but share this POST and its toasts, which say
 * what re-runs (`started`, one sentence) and link to the provider's runs; the
 * caller refreshes the info afterwards.
 */
export function useCiRerun(
  endpoint: MaybeRefOrGetter<string | null | undefined>,
  refreshRerun: () => unknown,
  started: MaybeRefOrGetter<string> = 'The affected tests are re-running in CI.',
) {
  const toast = useToast();
  const rerunning = ref(false);

  async function triggerRerun() {
    const url = toValue(endpoint);
    if (!url || rerunning.value) return;
    rerunning.value = true;
    try {
      const res = await $fetch<{ ok: boolean; message?: string; dispatch?: { url: string } }>(url, {
        method: 'POST',
      });
      if (res.ok && res.dispatch) {
        toast.add({
          title: 'CI re-run dispatched',
          description: toValue(started),
          color: 'success',
          actions: [{ label: 'Watch it', to: res.dispatch.url, target: '_blank' }],
        });
        await refreshRerun();
      } else {
        toast.add({ title: 'CI re-run not started', description: res.message ?? 'Not available.', color: 'warning' });
      }
    } catch (e: unknown) {
      const message = (e as { data?: { message?: string }; message?: string })?.data?.message ?? 'Dispatch failed.';
      toast.add({ title: 'CI re-run failed', description: message, color: 'error' });
    } finally {
      rerunning.value = false;
    }
  }

  return { rerunning, triggerRerun };
}
