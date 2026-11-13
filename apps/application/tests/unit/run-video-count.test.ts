import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/** `getTestRun().videoCount`: the Video tab's count, one number that agrees with the tab's own list. */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getTestRun } = await import('../../shared/handlers/test-runs');
const { countRunVideos, getRunVideos } = await import('../../shared/handlers/run-videos');

let db: TempDb;
let close: () => Promise<void>;

const T0 = 1_700_000_000_000;

/** An attachment of an execution; a video unless told otherwise. */
const attachment = (
  id: number,
  testRunId: number,
  testRunsCaseId: number,
  label = 'video/webm',
  type: 'attachment' | 'screenshot' = 'attachment',
) => ({
  id,
  testRunId,
  testRunsCaseId,
  type,
  subtype: label.startsWith('video/') ? 'video' : 'screenshot',
  label,
  path: `p/${id}`,
});

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'one' },
    { id: 2, projectId: 1, filePath: 'tests/a.spec.ts', title: 'two' },
    { id: 3, projectId: 1, filePath: 'tests/b.spec.ts', title: 'three' },
    { id: 4, projectId: 1, filePath: 'tests/b.spec.ts', title: 'four' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'passed', startTime: new Date(T0), totalTests: 4 },
    { id: 2, projectId: 1, status: 'passed', startTime: new Date(T0), totalTests: 1 },
  ]);
});

afterEach(async () => {
  await close();
});

const videoCountOf = async (runId: number) => (await getTestRun(db as any, runId))?.videoCount;

describe('getTestRun videoCount', () => {
  test('is 0 for a run with no videos, and 0 for a run with no executions', async () => {
    expect(await videoCountOf(1)).toBe(0);
    await db.insert(schema.testRunsCases).values({ id: 10, testRunId: 1, testCaseId: 1, status: 'passed' });
    await db.insert(schema.files).values(attachment(1, 1, 10, 'image/png'));
    expect(await videoCountOf(1)).toBe(0);
  });

  test('counts the final attempts with a video, once each', async () => {
    await db.insert(schema.testRunsCases).values([
      { id: 10, testRunId: 1, testCaseId: 1, status: 'passed' },
      { id: 11, testRunId: 1, testCaseId: 2, status: 'failed' },
      { id: 12, testRunId: 1, testCaseId: 3, status: 'passed' },
      { id: 13, testRunId: 1, testCaseId: 4, status: 'passed' },
    ]);
    await db.insert(schema.files).values([
      attachment(1, 1, 10),
      // Two videos on one execution count once.
      attachment(2, 1, 11),
      attachment(3, 1, 11, 'video/mp4'),
      // Other attachments do not count: a screenshot, a trace, a non-attachment file.
      attachment(4, 1, 12, 'image/png'),
      attachment(5, 1, 12, 'application/zip'),
      attachment(6, 1, 13, 'video/webm', 'screenshot'),
    ]);
    expect(await videoCountOf(1)).toBe(2);
  });

  test('leaves out the videos of earlier attempts and of other runs', async () => {
    await db.insert(schema.testRunsCases).values([
      // A retried test: only the last attempt is final.
      { id: 10, testRunId: 1, testCaseId: 1, status: 'failed', retries: 0, finalAttempt: false },
      { id: 11, testRunId: 1, testCaseId: 1, status: 'passed', retries: 1, passedAfterFailure: true },
      // Its earlier attempt has the video, the final one has none.
      { id: 12, testRunId: 1, testCaseId: 2, status: 'failed', retries: 0, finalAttempt: false },
      { id: 13, testRunId: 1, testCaseId: 2, status: 'failed', retries: 1 },
      { id: 20, testRunId: 2, testCaseId: 3, status: 'passed' },
    ]);
    await db
      .insert(schema.files)
      .values([attachment(1, 1, 10), attachment(2, 1, 11), attachment(3, 1, 12), attachment(4, 2, 20)]);
    expect(await videoCountOf(1)).toBe(1);
    expect(await videoCountOf(2)).toBe(1);
  });

  test('is the same number the Video tab lists, and is not capped by the tab', async () => {
    await db.insert(schema.testRunsCases).values([
      { id: 10, testRunId: 1, testCaseId: 1, status: 'passed' },
      { id: 11, testRunId: 1, testCaseId: 2, status: 'passed' },
      { id: 12, testRunId: 1, testCaseId: 3, status: 'failed', retries: 0, finalAttempt: false },
      { id: 13, testRunId: 1, testCaseId: 3, status: 'passed', retries: 1 },
    ]);
    await db
      .insert(schema.files)
      .values([attachment(1, 1, 10), attachment(2, 1, 10, 'video/mp4'), attachment(3, 1, 12), attachment(4, 1, 13)]);
    const listed = await getRunVideos(db as any, 1);
    expect(await countRunVideos(db as any, 1)).toBe(listed.videoCount);
    expect(await videoCountOf(1)).toBe(2);
  });
});
