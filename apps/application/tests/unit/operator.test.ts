/**
 * The operator routes: open only to the token of PIWI_OPERATOR_TOKEN, as a Bearer token, closed (404) while it is
 * unset or too short, and refusing a client network after ten wrong tokens. What they answer is counts only.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { H3Event } from 'h3';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { requireOperator, OPERATOR_TOKEN_MIN_LENGTH } = await import('../../server/utils/operator');
const { resetRateLimit } = await import('../../server/utils/rate-limit');
const { getOperatorUsage } = await import('../../server/utils/operator-usage');

const TOKEN = 'o'.repeat(OPERATOR_TOKEN_MIN_LENGTH);

/** A request from `address` carrying `authorization`, with what the helper reads and writes. */
function request(authorization: string | null, address = '192.0.2.10') {
  const headers: Record<string, string> = authorization === null ? {} : { authorization };
  const setHeader = vi.fn();
  const event = {
    context: {},
    node: { req: { headers, socket: { remoteAddress: address } }, res: { setHeader } },
  } as unknown as H3Event;
  return { event, setHeader };
}

/** The status a call answers: 200 when it passes. */
function status(event: H3Event): number {
  try {
    requireOperator(event);
    return 200;
  } catch (error) {
    return (error as { statusCode: number }).statusCode;
  }
}

describe('requireOperator', () => {
  beforeEach(() => {
    for (const network of ['192.0.2.10', '198.51.100.7']) resetRateLimit(`operator:${network}`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('answers 404 while no token is set, or one too short to be taken', () => {
    vi.stubEnv('PIWI_OPERATOR_TOKEN', '');
    expect(status(request(`Bearer ${TOKEN}`).event)).toBe(404);
    vi.stubEnv('PIWI_OPERATOR_TOKEN', TOKEN.slice(1));
    expect(status(request(`Bearer ${TOKEN.slice(1)}`).event)).toBe(404);
  });

  test('admits the token as a Bearer token, and nothing else', () => {
    vi.stubEnv('PIWI_OPERATOR_TOKEN', TOKEN);
    expect(status(request(`Bearer ${TOKEN}`).event)).toBe(200);
    expect(status(request(`bearer ${TOKEN}`).event)).toBe(200);
    const refused = request(`Bearer ${TOKEN}x`);
    expect(status(refused.event)).toBe(401);
    expect(refused.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    for (const authorization of [null, TOKEN, `Basic ${TOKEN}`, `Bearer pd_${'0'.repeat(64)}`, 'Bearer ']) {
      expect(status(request(authorization).event), String(authorization)).toBe(401);
    }
  });

  test('refuses a client network after ten wrong tokens, while another network and the right token still pass', () => {
    vi.stubEnv('PIWI_OPERATOR_TOKEN', TOKEN);
    for (let attempt = 0; attempt < 20; attempt++) expect(status(request(`Bearer ${TOKEN}`).event)).toBe(200);
    for (let attempt = 0; attempt < 10; attempt++) expect(status(request('Bearer wrong').event)).toBe(401);
    expect(status(request('Bearer wrong').event)).toBe(429);
    expect(status(request(`Bearer ${TOKEN}`).event)).toBe(429);
    expect(status(request(`Bearer ${TOKEN}`, '198.51.100.7').event)).toBe(200);
  });
});

describe('getOperatorUsage', () => {
  let db: TempDb;
  let close: () => Promise<void>;
  const NOW = new Date('2026-11-26T12:00:00Z');
  const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
  });
  afterEach(async () => {
    await close();
  });

  test('counts runs, projects, users, files and reporter versions, and what is in progress, without a name', async () => {
    const [project] = await db.insert(schema.projects).values({ name: 'secret-project-name' }).returning();
    await db.insert(schema.users).values({ username: 'alice', password: 'x', role: 'administrator' });
    const run = (status: string, hoursAgo: number, reporterVersion: string | null, updatedHoursAgo?: number) => ({
      projectId: project!.id,
      status,
      startTime: ago(hoursAgo),
      createdAt: ago(hoursAgo),
      updatedAt: updatedHoursAgo === undefined ? ago(hoursAgo) : ago(updatedHoursAgo),
      reporterVersion,
    });
    const [old] = await db
      .insert(schema.testRuns)
      .values([
        run('passed', 24 * 100, '0.60.0'),
        run('failed', 24 * 10, '0.74.0'),
        run('passed', 2, '0.76.0'),
        run('running', 1, '0.76.0', 0.5),
        run('initializing', 3, null),
      ])
      .returning();
    await db.insert(schema.files).values([
      { testRunId: old!.id, type: 'trace', path: 'a', size: 1000 },
      { testRunId: old!.id, type: 'report', path: 'b', size: null },
    ]);

    const usage = await getOperatorUsage(
      db as never,
      { requestsInProgress: 1, diagnosesInProgress: 0, assistantAnswersInProgress: 2, openEventStreams: 3 },
      NOW,
    );

    expect(usage).toEqual({
      now: {
        runsInProgress: 2,
        lastRunActivityAt: ago(0.5),
        requestsInProgress: 1,
        diagnosesInProgress: 0,
        assistantAnswersInProgress: 2,
        openEventStreams: 3,
      },
      projects: 1,
      users: 1,
      runs: { total: 5, last24Hours: 3, last30Days: 4, lastCreatedAt: ago(1) },
      storage: { files: 2, bytes: 1000 },
      reporterVersions: [
        { version: '0.76.0', runs: 2, lastRunAt: ago(1) },
        { version: '0.74.0', runs: 1, lastRunAt: ago(24 * 10) },
      ],
    });
    expect(JSON.stringify(usage)).not.toContain('secret-project-name');
    expect(JSON.stringify(usage)).not.toContain('alice');
  });

  test('answers zeros and nulls on an empty instance', async () => {
    const usage = await getOperatorUsage(
      db as never,
      { requestsInProgress: 0, diagnosesInProgress: 0, assistantAnswersInProgress: 0, openEventStreams: 0 },
      NOW,
    );
    expect(usage.now).toMatchObject({ runsInProgress: 0, lastRunActivityAt: null });
    expect(usage.runs).toEqual({ total: 0, last24Hours: 0, last30Days: 0, lastCreatedAt: null });
    expect(usage.reporterVersions).toEqual([]);
  });
});
