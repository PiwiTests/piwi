import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiwiSteps } from '@piwitests/core/steps';
import type * as StepViews from '../../src/shared/step-views';

/**
 * The worker's step screenshots as it starts: a browser session that ended
 * took the recording and the replay with it, without telling anyone, and their
 * screenshots go too.
 */

const views = vi.hoisted(() => ({
  clearRecordingViews: vi.fn(async () => undefined),
  setReplayViews: vi.fn(async (_views: unknown[]) => undefined),
}));

vi.mock('../../src/shared/step-views', async (importOriginal) => ({
  ...(await importOriginal<typeof StepViews>()),
  clearRecordingViews: views.clearRecordingViews,
  setReplayViews: views.setReplayViews,
}));

let session: Map<string, unknown>;

// Transformed once before the tests, which time themselves.
beforeAll(async () => {
  await import('../../src/background/step-views');
}, 60_000);

beforeEach(() => {
  vi.resetModules();
  views.clearRecordingViews.mockClear();
  views.setReplayViews.mockClear();
  session = new Map();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) session.set(key, structuredClone(value));
        },
        remove: async (key: string) => {
          session.delete(key);
        },
      },
      onChanged: { addListener: () => undefined },
    },
  };
});

describe('clearStaleViews', () => {
  it('clears the recording’s and the replay’s screenshots when neither is kept any more', async () => {
    const { clearStaleViews } = await import('../../src/background/step-views');
    await clearStaleViews();
    expect(views.clearRecordingViews).toHaveBeenCalledOnce();
    expect(views.setReplayViews).toHaveBeenCalledWith([]);
  });

  it('keeps them while the recording and the replay are kept', async () => {
    const { startRecording, stopRecording } = await import('../../src/shared/recording-storage');
    const { newReplayState, setReplayState } = await import('../../src/shared/replay-storage');
    await startRecording('https://shop.test/*');
    await stopRecording();
    await setReplayState(newReplayState({ version: 1, steps: [] } as unknown as PiwiSteps, 'https://shop.test', false));
    const { clearStaleViews } = await import('../../src/background/step-views');
    await clearStaleViews();
    expect(views.clearRecordingViews).not.toHaveBeenCalled();
    expect(views.setReplayViews).not.toHaveBeenCalled();
  });
});
