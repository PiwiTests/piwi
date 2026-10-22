import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRecordingState,
  startRecording,
  stopRecording,
  discardRecording,
  appendRecordingEvent,
  setRecordIntent,
  getRecordIntent,
  clearRecordIntent,
  decideRecordIntent,
  serveAppendRecordingEvent,
  updateRecording,
  RECORD_INTENT_TTL_MS,
  type RecordIntent,
} from '../../src/shared/recording-storage.js';
import type { RawCaptureEvent } from '@piwitests/core/recording';

function fakeChromeStorage() {
  const store: Record<string, unknown> = {};
  return {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  };
}

beforeEach(() => {
  (globalThis as any).chrome = fakeChromeStorage();
});

const clickEvent: RawCaptureEvent = {
  kind: 'click',
  target: null,
  value: null,
  checked: null,
  inputType: null,
  isPasswordField: false,
  pageUrl: 'https://x.test/',
  timestamp: 1,
};

describe('recording state', () => {
  it('updateRecording changes the recording’s own fields behind the appends already queued', async () => {
    await startRecording('https://x.test/*');
    const append = appendRecordingEvent(clickEvent);
    const paused = updateRecording({ paused: true, title: 'Checkout' });
    await Promise.all([append, paused]);
    const state = await getRecordingState();
    expect(state.events).toHaveLength(1);
    expect(state).toMatchObject({ active: true, paused: true, title: 'Checkout' });
  });

  it('starts inactive with no events', async () => {
    const state = await getRecordingState();
    expect(state.active).toBe(false);
    expect(state.events).toEqual([]);
  });

  it('startRecording activates and records the granted origin pattern', async () => {
    const state = await startRecording('https://x.test/*');
    expect(state.active).toBe(true);
    expect(state.grantedOriginPattern).toBe('https://x.test/*');
    expect(state.startedAt).not.toBeNull();
    expect(state.mode).toBe('actions');
    expect(state.bugToken).toBeNull();
  });

  it('a bug recording gets a fresh token each time', async () => {
    const first = await startRecording('https://x.test/*', 'bug');
    const second = await startRecording('https://x.test/*', 'bug');
    expect(first.mode).toBe('bug');
    expect(first.bugToken).toMatch(/^[0-9a-f]{32}$/);
    expect(second.bugToken).not.toBe(first.bugToken);
  });

  it('appendRecordingEvent is a no-op when not recording', async () => {
    const state = await appendRecordingEvent(clickEvent);
    expect(state.events).toEqual([]);
  });

  it('appendRecordingEvent accumulates events once active', async () => {
    await startRecording('https://x.test/*');
    await appendRecordingEvent(clickEvent);
    await appendRecordingEvent({ ...clickEvent, timestamp: 2 });
    const state = await getRecordingState();
    expect(state.events).toHaveLength(2);
  });

  it('concurrent appends all survive, in order', async () => {
    // A slow write is what exposes the race the queue exists to close: with the
    // read and the write unserialized, every caller reads the same array and the
    // last one to finish discards the others' events. Real capture hits this
    // whenever two listeners fire together — a click beside a change, a keydown
    // beside a pending input.
    const chromeApi = fakeChromeStorage();
    const write = chromeApi.storage.session.set;
    chromeApi.storage.session.set = async (values: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await write(values);
    };
    (globalThis as any).chrome = chromeApi;

    await startRecording('https://x.test/*');
    await Promise.all([
      appendRecordingEvent(clickEvent),
      appendRecordingEvent({ ...clickEvent, timestamp: 2 }),
      appendRecordingEvent({ ...clickEvent, timestamp: 3 }),
    ]);

    const state = await getRecordingState();
    expect(state.events.map((e) => e.timestamp)).toEqual([1, 2, 3]);
  });

  it('a failed write rejects to its caller, and later appends still work', async () => {
    const chromeApi = fakeChromeStorage();
    const write = chromeApi.storage.session.set;
    let failNext = false;
    chromeApi.storage.session.set = async (values: Record<string, unknown>) => {
      if (failNext) {
        failNext = false;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      await write(values);
    };
    (globalThis as any).chrome = chromeApi;

    await startRecording('https://x.test/*');
    failNext = true;
    // Surfaced rather than swallowed: a silent failure here is a recording that
    // looks healthy and exports short.
    await expect(appendRecordingEvent(clickEvent)).rejects.toThrow(/quota/i);
    // And one bad write must not poison the queue for everything after it.
    await appendRecordingEvent({ ...clickEvent, timestamp: 2 });
    const state = await getRecordingState();
    expect(state.events.map((e) => e.timestamp)).toEqual([2]);
  });

  it('in a Firefox content script, each append is one message, sent without waiting for the last', async () => {
    // No session storage in this context: the background does the whole
    // read-modify-write. Sending at once is what keeps a click that navigates
    // away from being lost — the page may unload before an earlier append settles.
    const sent: unknown[] = [];
    const answers: Array<() => void> = [];
    (globalThis as any).chrome = {
      storage: { local: {} },
      runtime: {
        sendMessage: (msg: unknown) => {
          sent.push(msg);
          return new Promise((resolve) => answers.push(() => resolve({ ok: true, state: { active: true } })));
        },
      },
    };

    const appends = [appendRecordingEvent(clickEvent), appendRecordingEvent({ ...clickEvent, timestamp: 2 })];
    await Promise.resolve();
    expect(sent).toEqual([
      { type: 'piwi-append-recording-event', event: clickEvent },
      { type: 'piwi-append-recording-event', event: { ...clickEvent, timestamp: 2 } },
    ]);
    answers.forEach((answer) => answer());
    expect((await Promise.all(appends)).map((state) => state.active)).toEqual([true, true]);
  });

  it('in a Firefox content script, a failed append rejects to its caller', async () => {
    (globalThis as any).chrome = {
      storage: { local: {} },
      runtime: { sendMessage: async () => ({ ok: false, error: 'QUOTA_BYTES quota exceeded' }) },
    };
    await expect(appendRecordingEvent(clickEvent)).rejects.toThrow(/quota/i);
  });

  it('the background serves appends from content scripts in order, and refuses a malformed one', async () => {
    await startRecording('https://x.test/*');
    const answers = await Promise.all([
      serveAppendRecordingEvent(clickEvent),
      serveAppendRecordingEvent({ ...clickEvent, timestamp: 2 }),
    ]);
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect((await getRecordingState()).events.map((e) => e.timestamp)).toEqual([1, 2]);
    expect(await serveAppendRecordingEvent(null)).toEqual({ ok: false, error: 'Malformed recording event.' });
  });

  it('stopRecording flips active to false but keeps events', async () => {
    await startRecording('https://x.test/*');
    await appendRecordingEvent(clickEvent);
    const stopped = await stopRecording();
    expect(stopped.active).toBe(false);
    expect(stopped.events).toHaveLength(1);
  });

  it('discardRecording clears everything', async () => {
    await startRecording('https://x.test/*');
    await appendRecordingEvent(clickEvent);
    await discardRecording();
    const state = await getRecordingState();
    expect(state.active).toBe(false);
    expect(state.events).toEqual([]);
  });
});

describe('record intent', () => {
  it('round-trips the origin pattern and tab, stamping a creation time', async () => {
    const before = Date.now();
    await setRecordIntent({ originPattern: 'https://x.test/*', tabId: 7, mode: 'bug' });
    const intent = await getRecordIntent();
    expect(intent).not.toBeNull();
    expect(intent!.originPattern).toBe('https://x.test/*');
    expect(intent!.tabId).toBe(7);
    expect(intent!.mode).toBe('bug');
    expect(intent!.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('reads back null when nothing is parked', async () => {
    expect(await getRecordIntent()).toBeNull();
  });

  it('reads back null for a malformed intent rather than a half-populated one', async () => {
    (globalThis as any).chrome.storage.session.set({ piwiRecordIntent: { originPattern: 'https://x.test/*' } });
    expect(await getRecordIntent()).toBeNull();
  });

  it('clearRecordIntent removes it', async () => {
    await setRecordIntent({ originPattern: 'https://x.test/*', tabId: 7, mode: 'bug' });
    await clearRecordIntent();
    expect(await getRecordIntent()).toBeNull();
  });
});

describe('decideRecordIntent', () => {
  const intent: RecordIntent = { originPattern: 'https://x.test/*', tabId: 7, mode: 'actions', createdAt: 1_000 };

  it('ignores a grant when nothing is parked', () => {
    expect(decideRecordIntent(null, ['https://x.test/*'], 1_000)).toEqual({ action: 'ignore' });
  });

  it('ignores a grant for some other origin — the options page granting the instance origin fires the same event', () => {
    expect(decideRecordIntent(intent, ['https://piwi.test/*'], 1_000)).toEqual({ action: 'ignore' });
  });

  it('starts the recording when a fresh intent matches the granted origin', () => {
    expect(decideRecordIntent(intent, ['https://x.test/*'], 1_500)).toEqual({
      action: 'start',
      originPattern: 'https://x.test/*',
      tabId: 7,
      mode: 'actions',
    });
  });

  it('starts when the granted set includes the origin among others', () => {
    expect(decideRecordIntent(intent, ['https://other.test/*', 'https://x.test/*'], 1_500).action).toBe('start');
  });

  it('clears a stale intent instead of reviving a recording on a much later grant', () => {
    expect(decideRecordIntent(intent, ['https://x.test/*'], 1_000 + RECORD_INTENT_TTL_MS + 1)).toEqual({
      action: 'clear',
    });
  });

  it('still starts right at the TTL boundary', () => {
    expect(decideRecordIntent(intent, ['https://x.test/*'], 1_000 + RECORD_INTENT_TTL_MS).action).toBe('start');
  });

  it('takes a grant 45 seconds after the prompt for some other flow’s', () => {
    expect(decideRecordIntent(intent, ['https://x.test/*'], 1_000 + 45_000)).toEqual({ action: 'clear' });
  });

  it('ignores a grant of a wider pattern for the site, as Save login asks for', () => {
    expect(decideRecordIntent(intent, ['*://x.test/*', '*://test/*'], 1_500)).toEqual({ action: 'ignore' });
  });
});
