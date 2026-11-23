import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LaneLayers from '../src/internal/capture/lane-layers.js';
import type * as RunChannel from '../src/internal/capture/run-channel.js';

const told = vi.hoisted(() => ({ events: [] as unknown[], positions: [] as unknown[] }));

vi.mock('../src/internal/capture/run-channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RunChannel>()),
  positionsWanted: () => true,
  runEventsWanted: () => true,
  tellEvent: (event: unknown) => told.events.push(event),
  tellPosition: (title: string) => told.positions.push(title),
}));

vi.mock('../src/internal/capture/lane-layers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof LaneLayers>()),
  layersTitleOf: () => {
    throw new Error('the runner changed shape');
  },
}));

const { watchCalls } = await import('../src/internal/capture/run-events.js');

type Listener = { onApiCallBegin?: (zone: object) => void; onApiCallEnd?: (zone: object) => void };

/**
 * A worker's Playwright whose instrumentation calls its listeners as Playwright's client does: in the order they were
 * added, synchronously, none of their throws caught, so a throw fails the user's call.
 */
function fakePlaywright() {
  const listeners: Listener[] = [];
  const instrumentation = {
    addListener: (listener: Listener) => listeners.push(listener),
    onApiCallBegin: (zone: object) => listeners.forEach((l) => l.onApiCallBegin?.(zone)),
    onApiCallEnd: (zone: object) => listeners.forEach((l) => l.onApiCallEnd?.(zone)),
  };
  return { playwright: { _instrumentation: instrumentation }, instrumentation };
}

beforeEach(() => {
  told.events = [];
  told.positions = [];
});

describe('watchCalls, when naming a call throws', () => {
  it('never fails the user’s call, and the runner’s own listener still ends its step', async () => {
    const { playwright, instrumentation } = fakePlaywright();
    expect(watchCalls(playwright)).toBe(true);
    const ended: object[] = [];
    // The runner's listener comes after Piwi's: it names the step as the call begins and ends it as the call ends.
    instrumentation.addListener({
      onApiCallBegin: (zone) => Object.assign(zone, { callId: 'call@1' }),
      onApiCallEnd: (zone) => ended.push(zone),
    });
    const zone = { apiName: 'locator.click', frames: [{ file: `${process.cwd()}/tests/cart.spec.ts`, line: 4 }] };
    expect(() => instrumentation.onApiCallBegin(zone)).not.toThrow();
    await Promise.resolve();
    expect(() => instrumentation.onApiCallEnd(zone)).not.toThrow();
    expect(ended).toEqual([zone]);
    expect(told.positions).toEqual([]);
    expect(told.events).toEqual([]);
  });
});
