import { describe, expect, test } from 'vitest';
import {
  checkDemoConnection,
  createDemoConnection,
  demoTrackerStatus,
  getDemoConnection,
  listDemoConnections,
  testDemoConnection,
  updateDemoConnection,
} from '../../app/demo/api/integrations';

/**
 * The demo holds a canned Zephyr Scale connection beside the Jira one, and answers its check, test, create and edit
 * from constants the way the server answers a region provider: the base URL comes from the region, never from the
 * body.
 */
describe('demo Zephyr Scale connection', () => {
  test('is listed beside the Jira connection, with no token in it', () => {
    const { connections } = listDemoConnections();
    expect(connections.map((c) => c.provider)).toEqual(['jira', 'zephyr-scale']);
    const zephyr = connections.find((c) => c.provider === 'zephyr-scale')!;
    expect(zephyr.hasCredentials).toBe(true);
    expect(zephyr.config).toEqual({ region: 'us' });
    expect(zephyr.credentialValues).toEqual({});
    expect(getDemoConnection(zephyr.id)?.connection.provider).toBe('zephyr-scale');
  });

  test('is not offered as an issue tracker', () => {
    expect(demoTrackerStatus().trackers.map((t) => t.provider)).toEqual(['jira']);
  });

  test('the test answers ok for it, without a Jira token kind', () => {
    const zephyr = listDemoConnections().connections.find((c) => c.provider === 'zephyr-scale')!;
    const result = testDemoConnection(zephyr.id);
    expect(result.ok).toBe(true);
    expect(result.account?.displayName).toContain('Zephyr Scale Cloud');
    expect(result.tokenKind).toBeUndefined();
  });

  test('the check signs in on the chosen region and lists canned projects', () => {
    const result = checkDemoConnection({ provider: 'zephyr-scale', region: 'eu' });
    expect(result?.baseUrl).toBe('https://eu.api.zephyrscale.smartbear.com/v2');
    expect(result?.auth?.ok).toBe(true);
    expect(result?.projects).toMatchObject({ ok: true, count: 3 });
  });

  test('the check refuses an unknown region and ignores a typed address', () => {
    expect(() => checkDemoConnection({ provider: 'zephyr-scale', region: 'moon' })).toThrow();
    const result = checkDemoConnection({ provider: 'zephyr-scale', region: 'us', baseUrl: 'https://evil.example' });
    expect(result?.baseUrl).toBe('https://api.zephyrscale.smartbear.com/v2');
  });

  test('create derives the base URL from the region', () => {
    const { connection } = createDemoConnection({
      provider: 'zephyr-scale',
      name: 'Zephyr',
      region: 'de',
      baseUrl: 'https://evil.example',
      credentials: { apiToken: 'secret' },
    });
    expect(connection.baseUrl).toBe('https://de.api.zephyrscale.smartbear.com/v2');
    expect(connection.config).toEqual({ region: 'de' });
    expect(connection.credentialValues).toEqual({});
  });

  test('edit moves the region, and keeps it when none is sent', () => {
    const zephyr = listDemoConnections().connections.find((c) => c.provider === 'zephyr-scale')!;
    expect(updateDemoConnection(zephyr.id, { region: 'au' }).connection).toMatchObject({
      baseUrl: 'https://au.api.zephyrscale.smartbear.com/v2',
      config: { region: 'au' },
    });
    expect(updateDemoConnection(zephyr.id, { name: 'Renamed' }).connection).toMatchObject({
      name: 'Renamed',
      baseUrl: zephyr.baseUrl,
      config: { region: 'us' },
    });
  });
});
