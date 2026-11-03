import { afterAll, beforeAll, describe } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { newerPostCases } = await import('./pr-feedback-newer-post.cases');

/** Whether a later run posted on a run's pull request, on SQLite. */
let db: TempDb;
let close: () => Promise<void>;
let nextProject = 1;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
});
afterAll(() => close());

describe('a later post on the pull request of a run, on SQLite', () => {
  newerPostCases(() => ({
    db: db as never,
    insertRuns: async (ids) => {
      const projectId = nextProject++;
      await db.insert(schema.projects).values({ id: projectId, name: `newer-post-${projectId}` });
      await db
        .insert(schema.testRuns)
        .values(ids.map((id) => ({ id, projectId, status: 'passed', startTime: new Date(), isFullRun: 1 })));
      return projectId;
    },
  }));
});
