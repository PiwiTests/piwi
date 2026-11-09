import type { MaybeRefOrGetter } from 'vue';

/**
 * The one place a failure cluster is marked resolved or reopened: the status
 * PATCH, the success / error toast and the caller's refresh. Both failure pages
 * (through the next-step line) and `ClusterStateLine` (its reconcile action)
 * share it, so the wording and the request live once.
 *
 * A status change sends no note: the server keeps the note as it is stored,
 * with the lines Piwi added since the page loaded.
 */
export function useClusterTriage(
  clusterId: MaybeRefOrGetter<number | null | undefined>,
  opts?: { onSaved?: () => void | Promise<void> },
) {
  const toast = useToast();

  async function setClusterStatus(status: 'open' | 'resolved') {
    const id = toValue(clusterId);
    if (id == null) return;
    try {
      await $fetch(`/api/failure-clusters/${id}/status`, { method: 'PATCH', body: { status } });
      toast.add({
        title: status === 'resolved' ? 'Cluster marked resolved' : 'Cluster reopened',
        color: 'success',
      });
      await opts?.onSaved?.();
    } catch {
      toast.add({ title: 'Could not update the cluster', color: 'error' });
    }
  }

  return { setClusterStatus };
}
