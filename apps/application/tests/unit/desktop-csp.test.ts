import { describe, expect, test } from 'vitest';
import { desktopContentSecurityPolicy } from '../../server/utils/desktop-csp';

describe('desktopContentSecurityPolicy', () => {
  const directive = (name: string, platform: NodeJS.Platform = 'linux') =>
    desktopContentSecurityPolicy('abc', platform)
      .split('; ')
      .find((d) => d.startsWith(`${name} `))
      ?.split(' ')
      .slice(1);

  test('runs only the nonced script', () => {
    expect(directive('script-src')).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
  });

  test("connects to the page's origin, Tauri's IPC endpoint and a JetBrains IDE's built-in server on loopback, nothing else", () => {
    const sources = directive('connect-src') ?? [];
    expect(sources.slice(0, 2)).toEqual(["'self'", 'ipc:']);
    const ide = sources.slice(2);
    expect(ide).toHaveLength(40);
    expect(ide).toContain('http://127.0.0.1:63342');
    expect(ide).toContain('http://localhost:63361');
    expect(ide.every((s) => /^http:\/\/(127\.0\.0\.1|localhost):633[4-6]\d$/.test(s))).toBe(true);
    expect(ide).not.toContain('http://127.0.0.1:63362');
  });

  test.each([
    ['win32', 'http://ipc.localhost'],
    ['linux', 'ipc:'],
    ['darwin', 'ipc:'],
  ] as const)("reaches Tauri's IPC endpoint on %s at %s, and no other form of it", (platform, origin) => {
    const ipc = (directive('connect-src', platform) ?? []).filter((s) => s.startsWith('ipc') || s.includes('ipc.'));
    expect(ipc).toEqual([origin]);
  });
});
