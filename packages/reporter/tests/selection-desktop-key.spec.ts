import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTokenProof } from '@piwitests/core/desktop-proof';
import { resolveSelection } from '../src/public/selection.js';

describe('resolveSelection with the desktop app key', () => {
  let server: http.Server;
  let port: number;
  let seen: Array<{ url: string; key: string | undefined }>;
  let prove: boolean;

  beforeEach(async () => {
    seen = [];
    prove = true;
    server = http.createServer(async (req, res) => {
      const challenge = req.headers['x-piwi-desktop-challenge'] as string | undefined;
      seen.push({ url: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (req.url === '/api/health' && challenge && prove) {
        headers['x-piwi-desktop-proof'] = await desktopTokenProof('pd_desktop', port, challenge);
      }
      res.writeHead(200, headers);
      res.end(
        JSON.stringify({
          key: 'smoke',
          version: 1,
          resolvedHash: 'h',
          estimate: { count: 2 },
          materialization: { format: 'grep', args: ['--grep', 'smoke'], command: '' },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((resolve) => server.close(resolve));
  });

  const run = () => ({
    PIWI_DASHBOARD_URL: `http://127.0.0.1:${port}`,
    PIWI_API_KEY: 'pd_desktop',
    PIWI_DESKTOP_KEY: '1',
    PIWI_DESKTOP_APP: 'off',
    PIWI_PROJECT_NAME: '7',
    PIWI_SELECTION: 'smoke',
  });

  it('sends the key the desktop app set to no server that does not prove it', async () => {
    prove = false;
    await expect(resolveSelection({ env: run(), strict: true })).rejects.toThrow(/token is not sent/);
    expect(seen.map((r) => r.url)).toEqual(['/api/health']);
    expect(seen.every((r) => r.key === undefined)).toBe(true);
  });

  it('sends that key to a server that proves it', async () => {
    const result = await resolveSelection({ env: run(), strict: true });
    expect(result?.grep).toBe('smoke');
    expect(seen.map((r) => [r.url.split('?')[0], r.key])).toEqual([
      ['/api/health', undefined],
      ['/api/projects/7/selections/smoke/resolve', 'pd_desktop'],
    ]);
  });

  it('sends a key the person chose without a check', async () => {
    prove = false;
    const env = { ...run(), PIWI_DESKTOP_KEY: undefined, PIWI_API_KEY: 'pd_mine' };
    await resolveSelection({ env, strict: true });
    expect(seen.map((r) => [r.url.split('?')[0], r.key])).toEqual([
      ['/api/projects/7/selections/smoke/resolve', 'pd_mine'],
    ]);
  });
});
