import { isLabOrInvestigationOrigin, runLauncherRef, runOrigin, runOriginRef } from '#shared/run-eligibility';

/**
 * What the desktop window reads of a run on its event stream (`GET /api/desktop/events`) beside its status and
 * counts: what launched it and for what (`origin`, `originRef`), the name its launcher gave it (`name`,
 * `PIWI_RUN_REF`), and whether it is a step of a job (`job`): a reproduction, a bisect step, a Flake Lab or probe run,
 * whose failures its job's verdict judges (`isLabOrInvestigationOrigin`). The window finds the runs of one of its own
 * processes by the first three, as `GET /api/projects/:id/latest-run` does.
 */
export interface DesktopRunFacts {
  origin: string;
  originRef: string | null;
  name: string | null;
  job: boolean;
}

/** A run's facts, read from its metadata. */
export function desktopRunFacts(metadata: unknown): DesktopRunFacts {
  const origin = runOrigin(metadata);
  return {
    origin,
    originRef: runOriginRef(metadata),
    name: runLauncherRef(metadata),
    job: isLabOrInvestigationOrigin(origin),
  };
}

/** A run as the reader reads it: its status and its metadata; undefined for a run that does not exist. */
export type DesktopRunRow = { status: string; metadata: unknown } | undefined;

/** How many runs' facts one reader keeps, the latest read. */
const MAX_KEPT_RUNS = 200;

/**
 * Reads each run's facts once, for one stream: every message of a run waits on the same read, so they keep their
 * order. A run still initializing, or one whose reporter never wrote its metadata (it never began), names nothing,
 * and neither does a read that failed or found no run: none is kept, so the run's next message reads again.
 */
export function desktopRunFactsReader(
  read: (runId: number) => Promise<DesktopRunRow>,
): (runId: number) => Promise<DesktopRunFacts | null> {
  const kept = new Map<number, Promise<DesktopRunFacts | null>>();
  return (runId) => {
    const known = kept.get(runId);
    if (known) return known;
    const facts = read(runId).then(
      (row) => {
        if (!row || row.status === 'initializing' || row.metadata == null) {
          kept.delete(runId);
          return null;
        }
        return desktopRunFacts(row.metadata);
      },
      () => {
        kept.delete(runId);
        return null;
      },
    );
    kept.set(runId, facts);
    if (kept.size > MAX_KEPT_RUNS) kept.delete(kept.keys().next().value!);
    return facts;
  };
}
