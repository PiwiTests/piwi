import { describe, test, expect, vi } from 'vitest';
import type { H3Event } from 'h3';

/**
 * Password hashes and checks run two at a time across the process, the next
 * thirty-two wait their turn in order, and one more is refused with 503 and a
 * Retry-After header. One client (an address, an IPv6 one by its /64 network)
 * holds at most four of those places. scrypt is replaced by calls the test
 * finishes by hand.
 */

const scrypt = vi.hoisted(() => ({
  /** The scrypt calls that started, in order: the password each hashes, and how to finish it. */
  started: [] as { password: string; finish: (error?: Error) => void }[],
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  scrypt: (
    password: string,
    _salt: string,
    keyLength: number,
    _options: unknown,
    callback: (error: Error | null, key?: Buffer) => void,
  ) => {
    scrypt.started.push({
      password,
      finish: (error) => (error ? callback(error) : callback(null, Buffer.alloc(keyLength))),
    });
  },
}));

delete process.env.PIWI_DATABASE_URL;
const { hashPassword, verifyPassword } = await import('../../server/utils/auth');

let nextAddress = 0;

/** A request from `remoteAddress` (by default an address no other request has) whose response headers the test reads. */
function request(remoteAddress = `10.0.${nextAddress >> 8}.${nextAddress++ & 0xff}`) {
  const headers: Record<string, unknown> = {};
  const event = {
    context: {},
    node: {
      req: { headers: {}, socket: { remoteAddress } },
      res: { setHeader: (name: string, value: unknown) => (headers[name] = value) },
    },
  } as unknown as H3Event;
  return { event, headers };
}

/** A stored hash at the current cost, which no test password matches. */
const STORED_HASH = `scrypt$17$8$1$${'0'.repeat(32)}$${'ab'.repeat(64)}`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Finish every scrypt call, those that start meanwhile included. */
async function finishAll() {
  for (let i = 0; i < scrypt.started.length; i++) {
    scrypt.started[i]!.finish();
    await settle();
  }
  scrypt.started.length = 0;
}

describe('password hashing limit', () => {
  test('runs two at a time, queues the next thirty-two in order, and refuses the thirty-fifth', async () => {
    const queued = Array.from({ length: 34 }, (_, i) => hashPassword(request().event, `pw-${i}`));
    await settle();
    // The third waits for a running one to end.
    expect(scrypt.started.map((call) => call.password)).toEqual(['pw-0', 'pw-1']);

    const refused = request();
    await expect(hashPassword(refused.event, 'pw-34')).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('Try again'),
    });
    expect(refused.headers['Retry-After']).toBe(5);

    scrypt.started[0]!.finish();
    await settle();
    expect(scrypt.started.map((call) => call.password)).toEqual(['pw-0', 'pw-1', 'pw-2']);

    await finishAll();
    expect(await Promise.all(queued)).toHaveLength(34);
  });

  test('a password check waits behind running hashes, and a failed hash frees its slot', async () => {
    const hashes = [hashPassword(request().event, 'a'), hashPassword(request().event, 'b')];
    const check = verifyPassword(request().event, 'c', STORED_HASH);
    await settle();
    expect(scrypt.started.map((call) => call.password)).toEqual(['a', 'b']);

    scrypt.started[0]!.finish(new Error('out of memory'));
    await expect(hashes[0]).rejects.toThrow('out of memory');
    await settle();
    expect(scrypt.started.map((call) => call.password)).toEqual(['a', 'b', 'c']);

    await finishAll();
    await hashes[1];
    expect(await check).toBe(false);
  });

  test('refuses a fifth hash from one client at once, while another client still gets in', async () => {
    const own = Array.from({ length: 4 }, (_, i) => hashPassword(request('203.0.113.7').event, `own-${i}`));
    await settle();

    const refused = request('203.0.113.7');
    await expect(hashPassword(refused.event, 'own-4')).rejects.toMatchObject({ statusCode: 503 });
    expect(refused.headers['Retry-After']).toBe(5);
    await expect(verifyPassword(request('203.0.113.7').event, 'own-5', STORED_HASH)).rejects.toMatchObject({
      statusCode: 503,
    });

    const other = hashPassword(request('203.0.113.8').event, 'other');
    await finishAll();
    expect(await Promise.all(own)).toHaveLength(4);
    expect(await other).toMatch(/^scrypt\$/);
    expect(scrypt.started).toHaveLength(0);
  });

  test('two IPv6 addresses of one /64 network share one share, another network has its own', async () => {
    const own = Array.from({ length: 4 }, (_, i) => hashPassword(request(`2001:db8:0:1::${i + 1}`).event, `v6-${i}`));
    await settle();

    await expect(hashPassword(request('2001:db8:0:1:ffff:ffff:ffff:ffff').event, 'v6-4')).rejects.toMatchObject({
      statusCode: 503,
    });
    const otherNetwork = hashPassword(request('2001:db8:0:2::1').event, 'other');
    // IPv4 clients reached through an IPv6 socket are each a client of their own.
    const mapped = Array.from({ length: 5 }, (_, i) =>
      hashPassword(request(`::ffff:198.51.100.${i}`).event, `v4-${i}`),
    );
    await finishAll();
    expect(await Promise.all(own)).toHaveLength(4);
    expect(await otherNetwork).toMatch(/^scrypt\$/);
    expect(await Promise.all(mapped)).toHaveLength(5);
  });

  test("a client's places come back when its hashes succeed, fail or are refused", async () => {
    const first = Array.from({ length: 4 }, (_, i) => hashPassword(request('192.0.2.1').event, `a-${i}`));
    await settle();
    await expect(hashPassword(request('192.0.2.1').event, 'refused')).rejects.toMatchObject({ statusCode: 503 });

    scrypt.started[0]!.finish(new Error('out of memory'));
    await expect(first[0]).rejects.toThrow('out of memory');
    await finishAll();
    await Promise.all(first.slice(1));

    const again = Array.from({ length: 4 }, (_, i) => hashPassword(request('192.0.2.1').event, `b-${i}`));
    await finishAll();
    expect(await Promise.all(again)).toHaveLength(4);
  });
});
