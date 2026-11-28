import type { CiDispatchView } from '#shared/ci-dispatches';
import type { CiDispatchSourceInput, CiOffered } from '#shared/ci-dispatch-request';

/** A place's CI re-run as the failure pages read it: whether its default action can be sent, and its last dispatch. */
export interface RerunInfo {
  available: boolean;
  reason: string | null;
  /** The CI action a dispatch would run, or null when none can. */
  action: { id: string; name: string } | null;
  /** The last dispatch the provider took, with the run that answered it. */
  lastDispatch: CiDispatchView | null;
}

/** A place that dispatches to CI: its project and its source, as `POST /api/projects/:id/ci-dispatches` takes it. */
export interface CiRerunPlace {
  projectId: number;
  source: CiDispatchSourceInput;
}

/** The `RerunInfo` of what a place is offered: its default action's readiness, and its last dispatch. */
export function rerunInfoFromOffered(offered: CiOffered): RerunInfo {
  const action = offered.actions.find((a) => a.id === offered.defaultActionId) ?? null;
  return {
    available: offered.enabled && Boolean(action?.available),
    reason: action?.reason ?? null,
    action: action ? { id: action.id, name: action.name } : null,
    lastDispatch: offered.lastDispatch,
  };
}

/**
 * A place's `RerunInfo`. A viewer who may dispatch (`run:control`) reads what
 * the place is offered; any other reads only its cluster's last dispatch the
 * provider took (`state=taken`), from the project's dispatches.
 */
export async function loadRerunInfo(
  /** `$fetch`, or the `useRequestFetch()` that carries the request's cookies on the server. */
  fetcher: typeof $fetch,
  place: RerunInfoPlace,
): Promise<RerunInfo> {
  if (place.mayDispatch) {
    const offered = await fetcher<CiOffered>(`/api/projects/${place.projectId}/ci-actions/offered`, {
      query: place.source,
    });
    return rerunInfoFromOffered(offered);
  }
  const unavailable = { available: false, reason: null, action: null };
  if (place.clusterId == null) return { ...unavailable, lastDispatch: null };
  const { items } = await fetcher<{ items: CiDispatchView[] }>(`/api/projects/${place.projectId}/ci-dispatches`, {
    query: { clusterId: place.clusterId, state: 'taken', limit: 1 },
  });
  return { ...unavailable, lastDispatch: items[0] ?? null };
}

/** A place whose `RerunInfo` a page reads: its project and source, its cluster, and whether the viewer may dispatch. */
export type RerunInfoPlace = CiRerunPlace & { clusterId: number | null; mayDispatch: boolean };

/**
 * A place's `RerunInfo`, loaded with the page under `key` (through
 * `useRequestFetch`, so the server render carries the request's cookies),
 * null when the place is not known yet or cannot be read.
 */
export async function useRerunInfo(key: string, place: () => RerunInfoPlace | null) {
  const requestFetch = useRequestFetch();
  const { data, refresh } = await useAsyncData<RerunInfo | null>(
    key,
    () => {
      const target = place();
      return target ? loadRerunInfo(requestFetch, target).catch(() => null) : Promise.resolve(null);
    },
    { default: (): RerunInfo | null => null },
  );
  return { rerunInfo: data, refreshRerun: refresh };
}
