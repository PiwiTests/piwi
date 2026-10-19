/**
 * The weekly gaps digest: the top new gaps per project since a given instant.
 * The selection is pure; the Test Map's new-gaps widget
 * (`getAnalyticsNewGaps`) loads the gaps and runs it.
 */

/** A gap as the digest needs it. */
export interface DigestGap {
  projectId: number;
  projectName: string;
  id: number;
  title: string;
  /** The check that found the gap. */
  detector?: string;
  class: string;
  score: number | null;
  createdAt: number;
}

/** One project's slice of the digest. */
export interface DigestProject {
  projectId: number;
  projectName: string;
  gaps: DigestGap[];
}

/** How many gaps per project the digest lists. */
export const DIGEST_PER_PROJECT = 5;

/**
 * Select the top new gaps per project for the digest: gaps created since the last
 * digest, grouped by project, the highest-scoring {@link DIGEST_PER_PROJECT} in
 * each, projects with at least one new gap only, ordered by their top gap's
 * score. A detector muted on a project (`muted`, per project id) has no gap in
 * its slice. Pure.
 */
export function selectWeeklyDigest(
  gaps: DigestGap[],
  since: number,
  perProject = DIGEST_PER_PROJECT,
  muted: ReadonlyMap<number, ReadonlySet<string>> = new Map(),
): DigestProject[] {
  const byProject = new Map<number, DigestProject>();
  for (const g of gaps) {
    if (g.createdAt <= since) continue;
    if (g.detector && muted.get(g.projectId)?.has(g.detector)) continue;
    const entry = byProject.get(g.projectId) ?? { projectId: g.projectId, projectName: g.projectName, gaps: [] };
    entry.gaps.push(g);
    byProject.set(g.projectId, entry);
  }
  const projects = [...byProject.values()];
  for (const p of projects) {
    p.gaps.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    p.gaps = p.gaps.slice(0, perProject);
  }
  return projects.filter((p) => p.gaps.length > 0).sort((a, b) => (b.gaps[0]?.score ?? 0) - (a.gaps[0]?.score ?? 0));
}
