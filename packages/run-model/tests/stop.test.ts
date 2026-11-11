import { describe, expect, it } from 'vitest';
import {
  heldUntilWatched,
  laneFrameNow,
  laneWatchOf,
  pagePoint,
  runFile,
  runName,
  stopError,
  stopIntents,
  stopPlace,
  stopSaid,
  testName,
} from '../src/stop';
import { englishRunSpeaker } from '../src/words';
import { stop, worker } from './fixtures';

describe('where a test stands, as text', () => {
  it('names a file relative to the run’s folder, with the 1-based line', () => {
    expect(stopPlace({ uri: 'file:///home/me/shop/tests/pages/cart.page.ts', line: 12 }, '/home/me/shop')).toBe(
      'tests/pages/cart.page.ts:13',
    );
    expect(runFile('file:///home/me/other/a%20b.ts', '/home/me/shop')).toBe('/home/me/other/a b.ts');
    expect(runFile('file:///home/me/shop2/a.ts', '/home/me/shop')).toBe('/home/me/shop2/a.ts');
  });

  it('reads a Windows file, whatever the case of its drive', () => {
    expect(runFile('file:///c%3A/Shop/tests/cart.spec.ts', 'C:\\Shop')).toBe('tests/cart.spec.ts');
    expect(runFile('file:///C:/Shop/tests/cart.spec.ts', null)).toBe('C:/Shop/tests/cart.spec.ts');
  });

  it('leaves anything but a file URI as it is', () => {
    expect(runFile('untitled:Untitled-1', '/home')).toBe('untitled:Untitled-1');
  });

  it('names a test by its describe blocks, then its title', () => {
    expect(testName({ title: ['cart', 'coupons', 'applies WELCOME10'] })).toBe('cart › coupons › applies WELCOME10');
  });

  it('names a run by its project, else its folder, else as a run', () => {
    expect(runName({ project: 'Shop', label: 'shop' }, englishRunSpeaker)).toBe('Shop');
    expect(runName({ project: null, label: 'shop' }, englishRunSpeaker)).toBe('shop');
    expect(runName({ project: null, label: null }, englishRunSpeaker)).toBe('Run');
  });

  it('says a stop as it comes: the test, else the run, and where it failed or stopped', () => {
    const session = { project: 'Shop', label: 'shop', root: '/home/me/shop' };
    const at = { uri: 'file:///home/me/shop/tests/cart.spec.ts', line: 11 };
    const test = { test: { title: ['cart', 'applies WELCOME10'] } } as Parameters<typeof stopSaid>[1];
    expect(stopSaid(session, test, { ...at, reason: 'pause' }, englishRunSpeaker)).toBe(
      'cart › applies WELCOME10 stopped at tests/cart.spec.ts:12.',
    );
    expect(stopSaid(session, test, { ...at, reason: 'failure' }, englishRunSpeaker)).toBe(
      'cart › applies WELCOME10 failed at tests/cart.spec.ts:12.',
    );
    expect(stopSaid(session, { test: null }, { ...at, reason: 'pause' }, englishRunSpeaker)).toBe(
      'Shop stopped at tests/cart.spec.ts:12.',
    );
  });

  it('names the error a failure stopped at, as its stop says it, else as an older one titles it', () => {
    const title = 'Failed: Error: expect(locator).toBeVisible() failed';
    expect(stopError({ title, error: "Error: the cart's own message\nLocator: getByTestId('cart')" })).toBe(
      "Error: the cart's own message\nLocator: getByTestId('cart')",
    );
    expect(stopError({ title })).toBe('expect(locator).toBeVisible() failed');
    expect(stopError({ title: 'Failed: Test timeout of 5000ms exceeded.' })).toBe('Test timeout of 5000ms exceeded.');
  });
});

describe('what a stop takes from the window', () => {
  const at = { ...stop('s1'), intents: undefined };

  it('is what the hub says it takes from this connection, when it says it', () => {
    expect(stopIntents(worker({ intents: ['pick', 'mock', 'view'] }), { ...at, intents: ['view', 'pick-at'] })).toEqual(
      ['view', 'pick-at'],
    );
    expect(stopIntents(worker({ intents: ['pick'] }), { ...at, intents: [] })).toEqual([]);
  });

  it('is, from an older service, what the reporter takes where the pause bar shows, and Mock a request anywhere', () => {
    const takes = worker({
      intents: ['pick', 'record', 'assert', 'assert-region', 'mock', 'view', 'input', 'pick-at'],
    });
    expect(stopIntents(takes, { ...at, bar: true })).toEqual(['pick', 'record', 'assert', 'assert-region', 'mock']);
    expect(stopIntents(takes, { ...at, bar: false })).toEqual(['mock']);
  });
});

describe('a point on an image of a stopped page', () => {
  it('maps to CSS pixels of the viewport the image names, whatever size it is shown at', () => {
    expect(pagePoint({ x: 194, y: 60.625 }, { width: 388, height: 242.5 }, { width: 1280, height: 800 })).toEqual({
      x: 640,
      y: 200,
    });
    expect(pagePoint({ x: 10, y: 10 }, { width: 100, height: 50 }, { width: 400, height: 200 })).toEqual({
      x: 40,
      y: 40,
    });
  });

  it('stays within the viewport, and maps nothing from an image shown at no size', () => {
    expect(pagePoint({ x: -5, y: 900 }, { width: 100, height: 50 }, { width: 400, height: 200 })).toEqual({
      x: 0,
      y: 199.99,
    });
    expect(pagePoint({ x: 1, y: 1 }, { width: 0, height: 50 }, { width: 400, height: 200 })).toBeNull();
  });
});

describe('a lane watched while it runs', () => {
  it('can be at a hub that shows lanes, for a reporter that lists watch; an older reporter is told to update', () => {
    expect(laneWatchOf({ lanes: true }, worker({ intents: ['view', 'watch'] }))).toBe('watch');
    expect(laneWatchOf({ lanes: true }, worker({ intents: ['view'] }))).toBe('outdated');
    // A hub that predates it: a stop's own view alone, and nothing said.
    expect(laneWatchOf({ lanes: false }, worker({ intents: ['view', 'watch'] }))).toBeNull();
    expect(laneWatchOf(undefined, worker({ intents: ['watch'] }))).toBeNull();
  });

  it('shows where its worker stands now: the stop it stands at, else its running test, from that worker alone', () => {
    const test = { id: 't1', title: ['pays'], uri: 'file:///x.ts', line: 0, project: '', retry: 0, cannotPause: null };
    const running = worker({ worker: 3, test });
    const frame = (over: Partial<{ worker: number; test: string | null; since: string | null }> = {}) => ({
      worker: 3,
      test: 't1',
      since: null,
      ...over,
    });
    expect(laneFrameNow(frame(), running)).toBe(true);
    // Taken at a stop the test went on from, or in the test before it.
    expect(laneFrameNow(frame({ since: 's1' }), running)).toBe(false);
    expect(laneFrameNow(frame({ test: 't0' }), running)).toBe(false);
    // A newer service's state reads as running.
    expect(laneFrameNow(frame(), { ...running, state: 'other' })).toBe(true);
    // Between two tests, none does.
    expect(laneFrameNow(frame(), { ...running, state: 'between', test: null })).toBe(false);
    // At a stop, a frame of that stop alone.
    const stopped = { ...running, state: 'stopped' as const, stop: stop('s2') };
    expect(laneFrameNow(frame({ since: 's2' }), stopped)).toBe(true);
    expect(laneFrameNow(frame({ since: 's1' }), stopped)).toBe(false);
    expect(laneFrameNow(frame(), stopped)).toBe(false);
    // The worker Playwright started in the lane in place of the one that sent it.
    expect(laneFrameNow(frame(), { ...running, worker: 4 })).toBe(false);
    expect(laneFrameNow(frame(), undefined)).toBe(false);
  });

  it('holds the actions in the test’s window at a headless stop the window does not watch, saying to watch first', () => {
    const takes = worker({ intents: ['pick', 'record', 'assert', 'mock', 'view', 'input', 'pick-at', 'watch'] });
    const unwatched = { ...stop('s1'), intents: ['mock' as const, 'view' as const, 'pick-at' as const] };
    expect(heldUntilWatched(takes, unwatched, true)).toEqual(['pick', 'record', 'assert']);
    // Watched, the stop takes them; a stop the bar shows takes them anyway.
    expect(
      heldUntilWatched(takes, { ...unwatched, intents: [...unwatched.intents, 'pick', 'record', 'assert'] }, true),
    ).toEqual([]);
    expect(heldUntilWatched(takes, { ...unwatched, bar: true }, true)).toEqual([]);
    // Nothing to watch, a reporter that takes none of them, or a service that predates stop.intents: none held.
    expect(heldUntilWatched(takes, unwatched, false)).toEqual([]);
    expect(heldUntilWatched(worker({ intents: ['mock', 'view'] }), unwatched, true)).toEqual([]);
    expect(heldUntilWatched(takes, stop('s1'), true)).toEqual([]);
  });
});
