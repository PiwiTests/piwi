import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

/**
 * A Slack channel posting through the Web API: `chat.postMessage` with the bot
 * token and the channel ID, Slack's `ok: false` refusals and 429 waits turned
 * into errors that never carry the token, and the outbox retrying a
 * rate-limited delivery after the wait Slack asked for.
 */

const TOKEN = 'xoxb-1111-2222-secret';
const CHANNEL_ID = 'C0123456789';

const slack = vi.hoisted(() => ({
  calls: [] as { url: string; headers: Record<string, string>; body: Record<string, unknown> }[],
  answer: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
}));

const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
  slack.calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
  return slack.answer();
});

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(async () => {
    throw new Error('the Web API path never goes through the webhook fetch');
  }),
}));

delete process.env.PIWI_DATABASE_URL;
vi.stubEnv('PIWI_SECRET_KEY', 'slack-api-test-key');
const { postSlackApiMessage, storedSlackDestination, slackRetryAfterMs, SlackRateLimitError } =
  await import('../../server/utils/notifications/slack-api');
const { deliverChannelTest, unsavedTestTarget, rememberTestedDestination, wasDestinationTested } =
  await import('../../server/utils/notifications/channel-test');
const { sweepOutbox } = await import('../../server/utils/notifications/dispatch');
const { encryptSecret } = await import('../../server/utils/crypto');

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  slack.answer = () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
}

beforeAll(() => vi.stubGlobal('fetch', fetchMock));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  slack.calls.length = 0;
  answer(200, { ok: true });
});

describe('postSlackApiMessage', () => {
  test('posts the message to chat.postMessage with the bot token and the channel ID', async () => {
    await postSlackApiMessage(TOKEN, CHANNEL_ID, { text: 'hello', blocks: [{ type: 'divider' }] });
    const call = slack.calls[0]!;
    expect(call.url).toBe('https://slack.com/api/chat.postMessage');
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toEqual({ text: 'hello', blocks: [{ type: 'divider' }], channel: CHANNEL_ID });
  });

  test('an ok: false answer throws with Slack’s error code and never the token', async () => {
    answer(200, { ok: false, error: 'not_in_channel' });
    const err = await postSlackApiMessage(TOKEN, CHANNEL_ID, { text: 'x' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Slack API refused the message: not_in_channel');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  test('a 429 throws a rate-limit error carrying Retry-After', async () => {
    answer(429, { ok: false, error: 'ratelimited' }, { 'Retry-After': '30' });
    const err = await postSlackApiMessage(TOKEN, CHANNEL_ID, { text: 'x' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SlackRateLimitError);
    expect((err as InstanceType<typeof SlackRateLimitError>).retryAfterSeconds).toBe(30);
    expect(slackRetryAfterMs(err)).toBe(30_000);
    expect((err as Error).message).toBe('Slack API rate limit reached: retry in 30 s');
  });

  test('a 429 without a usable Retry-After waits a minute', async () => {
    answer(429, '', { 'Retry-After': 'soon' });
    const err = await postSlackApiMessage(TOKEN, CHANNEL_ID, { text: 'x' }).catch((e: Error) => e);
    expect(slackRetryAfterMs(err)).toBe(60_000);
  });

  test('an answer that is not Slack JSON throws with its status', async () => {
    answer(503, '<html>upstream</html>');
    await expect(postSlackApiMessage(TOKEN, CHANNEL_ID, { text: 'x' })).rejects.toThrow('Slack API returned 503');
  });

  test('only a rate limit asks for a wait', () => {
    expect(slackRetryAfterMs(new Error('Slack API refused the message: invalid_auth'))).toBeNull();
  });
});

describe('storedSlackDestination', () => {
  test('decrypts the bot token of a Web API channel', () => {
    const config = { token: encryptSecret(TOKEN, 'slack-api-test-key'), channelId: ` ${CHANNEL_ID} ` };
    expect(storedSlackDestination(config)).toEqual({ token: TOKEN, channelId: CHANNEL_ID });
  });

  test('keeps a webhook channel’s URL', () => {
    expect(storedSlackDestination({ webhookUrl: 'https://hooks.slack.com/services/T/B/1' })).toEqual({
      webhookUrl: 'https://hooks.slack.com/services/T/B/1',
    });
  });

  test('says what is missing, and when the key no longer opens the token', () => {
    expect(() => storedSlackDestination({ channelId: CHANNEL_ID })).toThrow('No Slack bot token configured');
    expect(() => storedSlackDestination({})).toThrow('No Slack webhook URL configured');
    const config = { token: encryptSecret(TOKEN, 'another-key'), channelId: CHANNEL_ID };
    expect(() => storedSlackDestination(config)).toThrow(/PIWI_SECRET_KEY changed/);
  });
});

describe('a test message through the Web API', () => {
  test('an unsaved channel’s token is its plain-text secret', () => {
    const target = unsavedTestTarget('slack', { token: ` ${TOKEN} `, channelId: CHANNEL_ID });
    expect(target.secret).toBe(TOKEN);
    expect(unsavedTestTarget('slack', { webhookUrl: 'https://hooks.slack.com/services/T/B/1' }).secret).toBeNull();
  });

  test('posts the test text to the channel', async () => {
    await deliverChannelTest(unsavedTestTarget('slack', { token: TOKEN, channelId: CHANNEL_ID }));
    expect(slack.calls[0]!.body).toEqual({
      text: ':bell: Test notification from Piwi Dashboard',
      channel: CHANNEL_ID,
    });
  });

  test('a tested channel counts only with the same token and channel', () => {
    const target = unsavedTestTarget('slack', { token: TOKEN, channelId: CHANNEL_ID });
    rememberTestedDestination('4', target);
    expect(wasDestinationTested('4', target)).toBe(true);
    expect(wasDestinationTested('4', { ...target, secret: 'xoxb-other' })).toBe(false);
    expect(wasDestinationTested('4', unsavedTestTarget('slack', { token: TOKEN, channelId: 'C0999999999' }))).toBe(
      false,
    );
  });
});

describe('the outbox delivering to a Web API channel', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let channelId = 0;
  let seq = 0;

  async function enqueue(): Promise<number> {
    seq++;
    const [row] = await db
      .insert(schema.notificationDeliveries)
      .values({
        channelId,
        event: 'cluster.new',
        payload: { clusterId: seq, projectId: 1, projectName: 'shop', signature: 'TimeoutError', affectedCases: 2 },
        dedupeKey: `cluster.new:${seq}`,
        status: 'pending',
        scheduledFor: new Date(Date.now() - 1000),
      })
      .returning({ id: schema.notificationDeliveries.id });
    return row!.id;
  }

  async function delivery(id: number) {
    const [row] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, id));
    return row!;
  }

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    const [channel] = await db
      .insert(schema.notificationChannels)
      .values({
        name: 'Team',
        type: 'slack',
        config: { token: encryptSecret(TOKEN, 'slack-api-test-key'), channelId: CHANNEL_ID },
      })
      .returning({ id: schema.notificationChannels.id });
    channelId = channel!.id;
  });

  test('sends the same blocks the webhook would, to the channel', async () => {
    const id = await enqueue();
    await sweepOutbox(db as never);
    expect((await delivery(id)).status).toBe('sent');
    const call = slack.calls[0]!;
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body.channel).toBe(CHANNEL_ID);
    expect(call.body.text).toContain(':bug:');
    expect(Array.isArray(call.body.blocks)).toBe(true);
  });

  test('a rate-limited delivery retries after the wait Slack asked for', async () => {
    answer(429, { ok: false, error: 'ratelimited' }, { 'Retry-After': '120' });
    const id = await enqueue();
    const before = Date.now();
    await sweepOutbox(db as never);
    const row = await delivery(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.error).toBe('Slack API rate limit reached: retry in 120 s');
    const wait = row.scheduledFor!.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(119_000);
    expect(wait).toBeLessThanOrEqual(125_000);
  });

  test('a refused delivery records Slack’s error code, never the token', async () => {
    answer(200, { ok: false, error: 'channel_not_found' });
    const id = await enqueue();
    await sweepOutbox(db as never);
    const row = await delivery(id);
    expect(row.status).toBe('pending');
    expect(row.error).toBe('Slack API refused the message: channel_not_found');
    expect(row.error).not.toContain(TOKEN);
  });
});
