import { EventEmitter } from 'node:events';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * What the admin activity route answers: the runs of every project not ended yet, by their last activity, the requests
 * counted as receiving a run's results or files or ending a run, the answers being written, and the event streams the
 * two stream helpers hold open.
 */

delete process.env.PIWI_DATABASE_URL;
const { getRunsInProgress } = await import('../../shared/handlers/admin-activity');
const { eventStreams, isRunRequest, runRequests } = await import('../../server/utils/instance-activity');
const { createSSEEndpoint } = await import('../../server/utils/sse');
const { openEventStream } = await import('../../server/utils/event-stream');
const { assistantAnswersInProgress, endAssistantAnswer, startAssistantAnswer } =
  await import('../../server/utils/assistant/running');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'activity-one' },
    { id: 2, name: 'activity-two' },
  ]);
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 23, 12, minute));

describe('getRunsInProgress', () => {
  test('lists the runs of every project not ended yet, most recently active first', async () => {
    await db.insert(schema.testRuns).values([
      { projectId: 1, status: 'running', startTime: at(0), createdAt: at(0), updatedAt: at(5) },
      { projectId: 2, status: 'finalizing', startTime: at(0), createdAt: at(0), updatedAt: at(9) },
      { projectId: 1, status: 'initializing', startTime: at(0), createdAt: at(7), updatedAt: null },
      { projectId: 1, status: 'passed', startTime: at(0), createdAt: at(0), updatedAt: at(10) },
      { projectId: 2, status: 'interrupted', startTime: at(0), createdAt: at(0), updatedAt: at(10) },
    ]);

    expect(await getRunsInProgress(db as never)).toEqual([
      { status: 'finalizing', lastActivityAt: at(9) },
      { status: 'initializing', lastActivityAt: at(7) },
      { status: 'running', lastActivityAt: at(5) },
    ]);
  });

  test('is empty when every run has ended', async () => {
    await db.insert(schema.testRuns).values({ projectId: 1, status: 'failed', startTime: at(0) });
    expect(await getRunsInProgress(db as never)).toEqual([]);
  });
});

describe('isRunRequest', () => {
  test.each([
    ['POST', '/api/test-runs/submit'],
    ['POST', '/api/test-runs/upload'],
    ['POST', '/api/test-runs/upload/results'],
    ['POST', '/api/test-runs/import?project=shop'],
    ['POST', '/api/test-runs/12/case-files/'],
    ['PUT', '/api/test-runs/12/coverage'],
    ['POST', '/api/test-runs/12/finish'],
    ['POST', '/api/desktop/import-local'],
    ['POST', '/api/desktop/import-bug-report'],
    ['POST', '/api/projects/3/coverage-reports'],
    ['POST', '/api/projects/3/bug-reports'],
  ])('counts %s %s', (method, path) => {
    expect(isRunRequest(method, path)).toBe(true);
  });

  test.each([
    ['GET', '/api/test-runs/upload'],
    ['POST', '/api/test-runs/12/events'],
    ['POST', '/api/test-runs/12/heartbeat'],
    ['POST', '/api/test-runs/import/check'],
    ['GET', '/api/projects/3/coverage-reports'],
  ])('leaves %s %s out', (method, path) => {
    expect(isRunRequest(method, path)).toBe(false);
  });
});

test('a request counts until its close, once', () => {
  const before = runRequests.value;
  const close = runRequests.open();
  expect(runRequests.value).toBe(before + 1);
  close();
  close();
  expect(runRequests.value).toBe(before);
});

test('an answer counts while the assistant writes it', () => {
  const before = assistantAnswersInProgress();
  const controller = startAssistantAnswer(9001)!;
  expect(assistantAnswersInProgress()).toBe(before + 1);
  endAssistantAnswer(9001, controller);
  expect(assistantAnswersInProgress()).toBe(before);
});

/** The request and response of an event whose client is still there. */
function nodeEvent() {
  const req = Object.assign(new EventEmitter(), { destroyed: false });
  const res = Object.assign(new EventEmitter(), {
    closed: false,
    writableLength: 0,
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  });
  return { node: { req, res } } as never as Parameters<typeof createSSEEndpoint>[0] & {
    node: { req: EventEmitter; res: EventEmitter };
  };
}

describe('open event streams', () => {
  test('a server-sent event stream counts from its subscription until its client leaves', async () => {
    const before = eventStreams.value;
    const event = nodeEvent();
    createSSEEndpoint(event, () => () => {});
    expect(eventStreams.value).toBe(before + 1);
    event.node.req.emit('close');
    expect(eventStreams.value).toBe(before);
  });

  test('a stream written to the response counts until it closes, from either side', () => {
    const before = eventStreams.value;
    const leaving = nodeEvent();
    openEventStream(leaving);
    expect(eventStreams.value).toBe(before + 1);
    leaving.node.res.emit('close');
    expect(eventStreams.value).toBe(before);

    const sink = openEventStream(nodeEvent());
    expect(eventStreams.value).toBe(before + 1);
    sink.close();
    sink.close();
    expect(eventStreams.value).toBe(before);
  });
});
