import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiwiSteps } from '@piwitests/core/steps';

/**
 * The entries a page hands the worker as it is left: kept for the bug
 * recording or the replay whose token they carry, checked field by field.
 */

let session: Map<string, unknown>;

// Transformed once before the tests, which time themselves.
beforeAll(async () => {
  await import('../../src/background/relay-left');
}, 60_000);

beforeEach(() => {
  vi.resetModules();
  session = new Map();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: async (key: string) => (session.has(key) ? { [key]: structuredClone(session.get(key)) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) session.set(key, structuredClone(value));
        },
        remove: async (key: string) => {
          session.delete(key);
        },
      },
    },
  };
});

const entry = { level: 'error', source: 'console', message: 'Leaving', page: '/cart', time: 1 };

describe('handleRelayLeft', () => {
  it('keeps the entries for the recording whose token they carry, checked as relayed ones are', async () => {
    const { startRecording } = await import('../../src/shared/recording-storage');
    const { getBugEvidence } = await import('../../src/shared/bug-storage');
    const { handleRelayLeft } = await import('../../src/background/relay-left');
    const state = await startRecording('https://shop.test/*');
    const answer = await handleRelayLeft({
      token: state.bugToken,
      entries: { console: [{ ...entry, message: 'x'.repeat(900), extra: 'dropped' }], requests: 'not a list' },
    });
    expect(answer).toEqual({ ok: true });
    const evidence = await getBugEvidence();
    expect(evidence.console).toEqual([{ ...entry, message: 'x'.repeat(500) }]);
    expect(evidence.requests).toEqual([]);
  });

  it('keeps them for the replay whose token they carry', async () => {
    const { newReplayState, setReplayState, getReplayEvidence } = await import('../../src/shared/replay-storage');
    const { handleRelayLeft } = await import('../../src/background/relay-left');
    const replay = newReplayState({ version: 1, steps: [] } as unknown as PiwiSteps, 'https://shop.test', false);
    await setReplayState(replay);
    expect(await handleRelayLeft({ token: replay.evidenceToken, entries: { console: [entry] } })).toEqual({ ok: true });
    expect((await getReplayEvidence(replay.evidenceToken))?.console).toEqual([entry]);
  });

  it('drops entries under any other token', async () => {
    const { startRecording } = await import('../../src/shared/recording-storage');
    const { getBugEvidence } = await import('../../src/shared/bug-storage');
    const { handleRelayLeft } = await import('../../src/background/relay-left');
    await startRecording('https://shop.test/*');
    expect(await handleRelayLeft({ token: 'another', entries: { console: [entry] } })).toEqual({ ok: false });
    expect(await handleRelayLeft({ entries: { console: [entry] } })).toEqual({ ok: false });
    expect((await getBugEvidence()).console).toEqual([]);
  });
});
