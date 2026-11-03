import { describe, test, expect, vi } from 'vitest';
import type { H3Event } from 'h3';

/**
 * Password hashes and checks run two at a time across the process, the next
 * thirty-two wait their turn in order, and one more is refused with 503 and a
 * Retry-After header. scrypt is replaced by calls the test finishes by hand.
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

/** A request whose response headers the test reads. */
function request() {
  const headers: Record<string, unknown> = {};
  const event = {
    context: {},
    node: { req: { headers: {} }, res: { setHeader: (name: string, value: unknown) => (headers[name] = value) } },
  } as unknown as H3Event;
  return { event, headers };
}

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
    const check = verifyPassword(request().event, 'c', `scrypt$17$8$1$${'0'.repeat(32)}$${'ab'.repeat(64)}`);
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
});
