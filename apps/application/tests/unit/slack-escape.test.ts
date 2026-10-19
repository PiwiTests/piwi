import { describe, test, expect, beforeAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { slackEscape, slackLink } from '../../server/utils/notifications/slack';

/**
 * Slack messages escape every value they interpolate: a branch, a test title or
 * an error excerpt that holds `<!channel>` or `<https://…|label>` is shown as
 * text, never as a mention or a link.
 */

const posted = vi.hoisted(() => ({ bodies: [] as string[] }));

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(async (_url: string, init: { body: string }) => {
    posted.bodies.push(init.body);
    return new Response(null, { status: 200 });
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const { sweepOutbox } = await import('../../server/utils/notifications/dispatch');

const HOSTILE = '<!channel> <https://evil.example|Piwi login> & more';

describe('slackEscape and slackLink', () => {
  test('escape the three characters Slack decodes', () => {
    expect(slackEscape(HOSTILE)).toBe('&lt;!channel&gt; &lt;https://evil.example|Piwi login&gt; &amp; more');
  });

  test('a link keeps its URL whole and its label as text', () => {
    expect(slackLink('https://piwi.example/a?b=1&c=2|x', '<!here>')).toBe(
      '<https://piwi.example/a?b=1&amp;c=2%7Cx|&lt;!here&gt;>',
    );
  });
});

describe('a run.failed message to a Slack channel', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    vi.stubEnv('PIWI_SITE_URL', 'https://piwi.example.test');
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    const [channel] = await db
      .insert(schema.notificationChannels)
      .values({ name: 'Team', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/T/B/1' } })
      .returning({ id: schema.notificationChannels.id });
    await db.insert(schema.notificationDeliveries).values({
      channelId: channel!.id,
      event: 'run.failed',
      payload: {
        runId: 1,
        projectId: 1,
        projectName: 'shop <!here>',
        status: 'failed',
        branch: HOSTILE,
        totalTests: 1,
        failedTests: 1,
        passedTests: 0,
        flakyTests: 0,
        topFailures: [{ title: HOSTILE, headline: HOSTILE, errorExcerpt: HOSTILE, executionId: 5 }],
      },
      dedupeKey: 'run.failed:1',
      status: 'pending',
      scheduledFor: new Date(Date.now() - 1000),
    });
  });

  test('carries no mention and no link but its own', async () => {
    await sweepOutbox(db as never);
    expect(posted.bodies).toHaveLength(1);
    const body = posted.bodies[0]!;
    expect(body).not.toContain('<!channel>');
    expect(body).not.toContain('<!here>');
    expect(body).not.toContain('<https://evil.example');
    const links = [...body.matchAll(/<(https?:[^|>]+)\|/g)].map((m) => m[1]);
    expect(links).toEqual(['https://piwi.example.test/test-run-cases/5']);
  });
});
