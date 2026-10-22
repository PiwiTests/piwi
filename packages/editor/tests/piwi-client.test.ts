import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { PiwiClient, type ResponseCache } from '../src/piwi-client.js';

describe('the answers clients share', () => {
  let server: http.Server;
  let url = '';
  /** The answers the instance gives, in order; each request takes the next one. */
  let versions: number[] = [];
  let asked = 0;
  /** How long the instance takes to answer a request, by its order. */
  let delays: number[] = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      const n = asked++;
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ run: { id: versions[n] ?? versions[versions.length - 1] }, failures: [{ title: 'pays' }] }),
        );
      }, delays[n] ?? 0);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    versions = [];
    asked = 0;
    delays = [];
  });

  const client = (answers: ResponseCache) => new PiwiClient({ serverUrl: url, apiKey: null, project: 'Shop' }, answers);

  test('a read after a run moved does not join a request asked before', async () => {
    const answers: ResponseCache = new Map();
    versions = [120, 121];
    delays = [150, 0];
    const before = client(answers).branchFailures(7, 'main');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await client(answers).branchFailures(7, 'main', {}, true);
    expect(after.run?.id).toBe(121);
    expect((await before).run?.id).toBe(120);
    expect(asked).toBe(2);
  });

  test('reads after a run moved share one request', async () => {
    const answers: ResponseCache = new Map();
    versions = [121];
    delays = [50];
    const [first, second] = await Promise.all([
      client(answers).branchFailures(7, 'main', {}, true),
      client(answers).branchFailures(7, 'main', {}, true),
    ]);
    expect([first.run?.id, second.run?.id]).toEqual([121, 121]);
    expect(asked).toBe(1);
  });

  test('each client gets its own copy of a shared answer, the first one included', async () => {
    const answers: ResponseCache = new Map();
    versions = [120];
    const first = await client(answers).branchFailures(7, 'main');
    first.failures.length = 0;
    const second = await client(answers).branchFailures(7, 'main');
    expect(second.failures).toHaveLength(1);
    expect(asked).toBe(1);
  });
});
