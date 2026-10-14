/**
 * Screenshot selection for a test-run case, so the AI context, MCP tools,
 * visual diff and exports all agree on what counts as a screenshot.
 *
 * The row predicate itself lives in `#shared/file-classify` — the demo and the
 * export renderer classify the same rows without reaching into `server/`.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { files } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { failurePageFirst, isScreenshotFileRow } from '#shared/file-classify';

export { isScreenshotFileRow };

export interface ScreenshotFileRow {
  id: number;
  type: string;
  subtype: string | null;
  label: string | null;
  path: string;
}

/**
 * Screenshot files for one execution: the page the test failed on first when
 * it is known (see {@link failurePageFirst}), then the others newest first.
 */
export async function selectCaseScreenshots(
  db: DrizzleDB,
  testRunsCaseId: number,
  limit?: number,
): Promise<ScreenshotFileRow[]> {
  const rows = await db
    .select({ id: files.id, type: files.type, subtype: files.subtype, label: files.label, path: files.path })
    .from(files)
    .where(and(eq(files.testRunsCaseId, testRunsCaseId), inArray(files.type, ['screenshot', 'attachment'])))
    .orderBy(desc(files.id));

  const shots = failurePageFirst(
    rows.filter((r: ScreenshotFileRow) => isScreenshotFileRow(r)),
    (r) => r.subtype,
  );
  return limit != null ? shots.slice(0, limit) : shots;
}
