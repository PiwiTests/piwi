import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDesktopSettings,
  getDesktopSettings,
  moveLegacyDesktopSettings,
  setDesktopSettings,
} from '../../src/shared/desktop-settings.js';
import { memoryLocalStorage, memorySecretArea } from './memory-secret-area.js';

const PAIRED = { url: 'http://127.0.0.1:4318', token: 'pd_desktop' };

let local: ReturnType<typeof memoryLocalStorage>;
let area: ReturnType<typeof memorySecretArea>;

beforeEach(() => {
  local = memoryLocalStorage();
  area = memorySecretArea();
  (globalThis as any).chrome = { storage: { local: local.local } };
});

describe('the desktop app pairing', () => {
  it('is kept in the secret area, address and token together, never in chrome.storage.local', async () => {
    await setDesktopSettings(PAIRED, area);
    // Only the time it changed, for the worker to hear it: nothing of the pairing.
    expect(Object.keys(local.store)).toEqual(['piwiDesktopPairedAt']);
    expect(local.store.piwiDesktopPairedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(local.store)).not.toContain(PAIRED.token);
    expect(JSON.stringify(local.store)).not.toContain(PAIRED.url);
    expect(await getDesktopSettings(area)).toEqual(PAIRED);
    await clearDesktopSettings(area);
    expect(await getDesktopSettings(area)).toBeNull();
    expect(Object.keys(local.store)).toEqual(['piwiDesktopPairedAt']);
  });

  it('a pairing left in chrome.storage.local moves to the secret area', async () => {
    local.store.piwiDesktop = { ...PAIRED };
    expect(await getDesktopSettings(area)).toEqual(PAIRED);
    expect(local.store).not.toHaveProperty('piwiDesktop');
    expect(area.data.get('desktop')).toEqual(PAIRED);
  });

  it('a move cut short before the pairing is written leaves it where it was', async () => {
    local.store.piwiDesktop = { ...PAIRED };
    area.failNextSet = true;
    await expect(moveLegacyDesktopSettings(area)).rejects.toThrow();
    expect(local.store.piwiDesktop).toEqual(PAIRED);
    await moveLegacyDesktopSettings(area);
    expect(await getDesktopSettings(area)).toEqual(PAIRED);
    expect(local.store).not.toHaveProperty('piwiDesktop');
  });

  it('a pairing written into chrome.storage.local later never replaces the one kept', async () => {
    await setDesktopSettings(PAIRED, area);
    local.store.piwiDesktop = { url: 'http://127.0.0.1:9999', token: 'planted' };
    expect(await getDesktopSettings(area)).toEqual(PAIRED);
    expect(local.store).not.toHaveProperty('piwiDesktop');
  });
});
