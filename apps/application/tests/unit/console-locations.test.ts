import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { InstanceRole, ADMIN_ACCESS } from '#shared/permissions';
import { shownConsoleLocation, withShownConsoleLocations } from '#shared/console-entries';
import { pageErrorStackPlace } from '#shared/error-text';
import { consoleLogsFromTrace } from '../../server/utils/import-evidence';
import { parseTraceTexts } from '../../server/utils/trace-events';
import type { User } from '../../server/database/schema';
import { migrateToLatest } from './temp-db';

/**
 * A console entry's or a page error's location is stored 0-based, as Playwright places a console message, and read
 * 1-based, as an editor counts lines and columns: on the console card and from the MCP tools.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db, getDialect: () => 'sqlite' }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  isAuthEnabled: () => false,
}));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));

interface RouteEvent {
  params?: Record<string, string>;
  body: Record<string, unknown>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'console-locations';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
});

describe('shownConsoleLocation', () => {
  test('reads a stored place 1-based', () => {
    expect(shownConsoleLocation('https://shop.test/assets/cart.js:1:8')).toBe('https://shop.test/assets/cart.js:2:9');
    expect(shownConsoleLocation('http://localhost:5173/src/main.ts?t=1:0:12')).toBe(
      'http://localhost:5173/src/main.ts?t=1:1:13',
    );
  });

  test('reads a place Playwright could not give as the URL alone, and anything else as it is', () => {
    expect(shownConsoleLocation('https://shop.test/api/me:0:0')).toBe('https://shop.test/api/me');
    expect(shownConsoleLocation('https://shop.test/api/me')).toBe('https://shop.test/api/me');
    expect(shownConsoleLocation('http://localhost:5173')).toBe('http://localhost:5173');
  });

  test('reads a place with an empty URL, an inline script’s, 1-based too', () => {
    expect(shownConsoleLocation(':1:8')).toBe(':2:9');
    expect(shownConsoleLocation(':0:0')).toBe('');
    expect(withShownConsoleLocations([{ type: 'error', text: 'a', timestamp: 1, location: ':0:0' }])).toEqual([
      { type: 'error', text: 'a', timestamp: 1, location: null },
    ]);
  });

  test('gives back the stack frame a page error was stored from', () => {
    const stack = 'TypeError: cart is undefined\n    at renderCart (https://shop.test/assets/cart.js:12:5)';
    const stored = pageErrorStackPlace(stack)!;
    expect(stored).toBe('https://shop.test/assets/cart.js:11:4');
    expect(shownConsoleLocation(stored)).toBe('https://shop.test/assets/cart.js:12:5');
  });

  test('reads a console entry recovered from a trace 1-based', () => {
    const trace = JSON.stringify({
      type: 'console',
      messageType: 'error',
      text: 'boom',
      time: 1_700_000_005_000,
      location: { url: 'https://app/x.js', lineNumber: 3, columnNumber: 8 },
    });
    const [entry] = consoleLogsFromTrace(parseTraceTexts([trace]), null)!;
    expect(entry!.location).toBe('https://app/x.js:3:8');
    expect(shownConsoleLocation(entry!.location!)).toBe('https://app/x.js:4:9');
  });
});

describe('withShownConsoleLocations', () => {
  test('reads each entry’s location 1-based and leaves the rest alone', () => {
    expect(
      withShownConsoleLocations([
        { type: 'error', text: 'a', timestamp: 1, location: 'https://app/x.js:0:4' },
        { type: 'warning', text: 'b', timestamp: 2, location: null },
        { type: 'error', text: 'c', timestamp: 3 },
      ]),
    ).toEqual([
      { type: 'error', text: 'a', timestamp: 1, location: 'https://app/x.js:1:5' },
      { type: 'warning', text: 'b', timestamp: 2, location: null },
      { type: 'error', text: 'c', timestamp: 3 },
    ]);
    expect(withShownConsoleLocations(null)).toBeNull();
  });

  test('is what get_test_run_case gives an agent, while the execution keeps the stored place', async () => {
    const { runId } = await submit({
      body: {
        projectName: PROJECT,
        status: 'failed',
        startTime: '2026-11-01T10:00:00.000Z',
        duration: 1000,
        totalTests: 1,
        failedTests: 1,
        testCases: [
          {
            title: 'pays',
            location: 'tests/pays.spec.ts:3:1',
            status: 'failed',
            duration: 10,
            consoleLogs: [
              {
                type: 'pageerror',
                text: 'TypeError: cart is undefined',
                timestamp: 1,
                location: 'https://shop.test/cart.js:1:8',
              },
            ],
          },
        ],
      },
    });
    const [pays] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
    expect((pays!.consoleLogs as Array<{ location: string }>)[0]!.location).toBe('https://shop.test/cart.js:1:8');

    const getCase = MCP_TOOLS.find((tool) => tool.name === 'get_test_run_case')!.handler;
    const ctx = {
      user: { id: 0, role: InstanceRole.ADMINISTRATOR } as User,
      access: ADMIN_ACCESS,
      scope: 'all' as const,
    };
    const read = (await getCase(db as never, { executionId: pays!.id, include: ['console'] }, ctx)) as {
      consoleLogs: Array<{ location: string }>;
    };
    expect(read.consoleLogs[0]!.location).toBe('https://shop.test/cart.js:2:9');
  });
});
