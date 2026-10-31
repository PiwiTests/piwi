import { describe, test, expect, vi, afterEach } from 'vitest';
import { ref } from 'vue';
import { DEFAULT_SUBSCRIPTION_EVENTS, isDesktopAppRunEvent } from '#shared/notification-events';

/**
 * The project bell's per-browser choices. The composable keeps its cookie in
 * module state, so each case loads a fresh copy of the module, with the Nuxt
 * auto-imports it calls stubbed as globals.
 */
async function load(desktop: boolean) {
  vi.resetModules();
  vi.stubGlobal('useCookie', () => ref(''));
  vi.stubGlobal('useIsDesktop', () => desktop);
  const { useBrowserNotificationCookie } = await import('../../app/composables/useBrowserNotificationCookie');
  return useBrowserNotificationCookie();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isDesktopAppRunEvent', () => {
  test('leaves the run events of the runs the desktop app started to the app', () => {
    expect(isDesktopAppRunEvent('run.failed', 'desktop')).toBe(true);
    expect(isDesktopAppRunEvent('run.finished', 'desktop')).toBe(true);
  });

  test('keeps the run events of other runs, and every other event', () => {
    expect(isDesktopAppRunEvent('run.failed', 'local')).toBe(false);
    expect(isDesktopAppRunEvent('run.failed', 'ci')).toBe(false);
    expect(isDesktopAppRunEvent('run.failed', undefined)).toBe(false);
    expect(isDesktopAppRunEvent('environment.incident', 'desktop')).toBe(false);
    expect(isDesktopAppRunEvent('cluster.new', 'desktop')).toBe(false);
  });
});

describe('useBrowserNotificationCookie', () => {
  test('in a browser, a project nobody chose events for notifies on none', async () => {
    const cookie = await load(false);
    expect(cookie.getProject(1).events).toEqual([]);
    expect(cookie.isSubscribed(1)).toBe(false);
  });

  test('in the desktop app, a project nobody chose events for notifies on the default events', async () => {
    const cookie = await load(true);
    expect(cookie.getProject(1).events).toEqual(DEFAULT_SUBSCRIPTION_EVENTS);
    expect(cookie.isEventSubscribed(1, 'run.failed')).toBe(true);
    expect(cookie.isEventSubscribed(1, 'cluster.new')).toBe(false);
  });

  test('in the desktop app, turning every event off keeps the project silent', async () => {
    const cookie = await load(true);
    for (const event of DEFAULT_SUBSCRIPTION_EVENTS) cookie.toggleEvent(1, event);
    expect(cookie.getProject(1).events).toEqual([]);
    expect(cookie.isEventSubscribed(1, 'run.failed')).toBe(false);
    expect(cookie.getProject(2).events).toEqual(DEFAULT_SUBSCRIPTION_EVENTS);
  });

  test('a chosen event adds to the default events of the desktop app', async () => {
    const cookie = await load(true);
    cookie.toggleEvent(1, 'cluster.new');
    expect(cookie.getProject(1).events).toEqual([...DEFAULT_SUBSCRIPTION_EVENTS, 'cluster.new']);
  });
});
