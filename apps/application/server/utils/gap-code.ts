/**
 * Where a scenario gap meets the code: the repository files behind it. A gap on
 * a file or a route handler is about that file; a gap on a route, about the
 * handlers that serve it (`handled-by` edges). Other gaps (a page, a control, a
 * test) name no file. The coverage of those files is read by
 * `server/utils/coverage-summary.ts`, which matches them to a commit's files.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { itemsOfFile } from '@piwitests/core/locator-break';
import { graphEdges, scenarioGaps } from '../database/schema';
import { subjectFromGapKey } from '#shared/handlers/scenario-gaps';
import { loadMutedDetectors } from '#shared/handlers/detector-precision';
import type { DrizzleDB } from '#shared/handlers/db';

/** The files behind each gap key, for the keys that name any. */
export async function gapFilesByKey(db: DrizzleDB, projectId: number, keys: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const routeKeys = new Map<string, string[]>();
  for (const key of keys) {
    const subject = subjectFromGapKey(key);
    if (subject.kind === 'file' || subject.kind === 'handler') out.set(key, [subject.key]);
    else if (subject.kind === 'route') routeKeys.set(subject.key, [...(routeKeys.get(subject.key) ?? []), key]);
  }
  const routes = [...routeKeys.keys()];
  for (let i = 0; i < routes.length; i += 200) {
    const served = await db
      .select({ route: graphEdges.fromKey, handler: graphEdges.toKey })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.kind, 'handled-by'),
          eq(graphEdges.fromKind, 'route'),
          eq(graphEdges.toKind, 'handler'),
          inArray(graphEdges.fromKey, routes.slice(i, i + 200)),
          isNull(graphEdges.branch),
        ),
      );
    for (const edge of served) {
      for (const key of routeKeys.get(edge.route) ?? []) {
        const files = out.get(key) ?? [];
        if (!files.includes(edge.handler)) out.set(key, [...files, edge.handler]);
      }
    }
  }
  return out;
}

/**
 * The files behind each open gap of the project whose detector is not muted, by
 * gap id: what the coverage tree counts beside each file.
 */
export async function openGapFiles(db: DrizzleDB, projectId: number): Promise<Map<number, string[]>> {
  const muted = await loadMutedDetectors(db, projectId);
  const rows = (
    await db
      .select({ id: scenarioGaps.id, key: scenarioGaps.key, detector: scenarioGaps.detector })
      .from(scenarioGaps)
      .where(and(eq(scenarioGaps.projectId, projectId), eq(scenarioGaps.status, 'open')))
  ).filter((row) => !muted.has(row.detector));
  const files = await gapFilesByKey(
    db,
    projectId,
    rows.map((row) => row.key),
  );
  const out = new Map<number, string[]>();
  for (const row of rows) {
    const of = files.get(row.key);
    if (of?.length) out.set(row.id, of);
  }
  return out;
}

/**
 * The path among a commit's `paths` a gap's file names: the same path, else the
 * one path it is a suffix of or that is a suffix of it, as coverage matches a
 * handler recorded relative to its server's folder. Null when none or several do.
 */
export function coveragePathOf(file: string, paths: readonly string[]): string | null {
  const matches = itemsOfFile(
    paths.map((path) => ({ path })),
    file,
  );
  return matches.length === 1 ? matches[0]!.path : null;
}
