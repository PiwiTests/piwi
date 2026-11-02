import type { FixedBeforeMatch } from '#shared/fix-plan.types';

/**
 * Copy an earlier resolved cluster's triage note onto the current cluster,
 * prefixed so the history reads as an intentional reuse. It sends the note
 * alone, so the status stays as it is stored — a new cluster is never marked
 * resolved because an old one was. Both failure pages drive
 * `FixedBeforeMatches` through this one handler.
 */
export function useApplyClusterTriage(opts: {
  clusterId: () => number | null | undefined;
  currentNote: () => string | null | undefined;
  onApplied: () => unknown;
}) {
  const toast = useToast();
  const applyingId = ref<number | null>(null);

  async function applyTriage(match: FixedBeforeMatch) {
    const clusterId = opts.clusterId();
    if (clusterId == null || applyingId.value != null) return;
    applyingId.value = match.clusterId;
    const excerpt = (match.triageNote ?? match.diagnosisTitle ?? match.reason)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280);
    const line = `Same as cluster #${match.clusterId}: ${excerpt}`;
    const existing = opts.currentNote()?.trim();
    const triageNote = existing ? `${existing}\n${line}` : line;
    try {
      await $fetch(`/api/failure-clusters/${clusterId}/status`, { method: 'PATCH', body: { triageNote } });
      toast.add({ title: `Applied triage from cluster #${match.clusterId}`, color: 'success' });
      await opts.onApplied();
    } catch {
      toast.add({ title: 'Could not apply the triage', color: 'error' });
    } finally {
      applyingId.value = null;
    }
  }

  return { applyingId, applyTriage };
}
