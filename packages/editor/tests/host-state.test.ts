import { describe, expect, test } from 'vitest';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { LANGUAGE_KEY, MAX_EVENTS, RECORDING_KEY, RecorderHost } from '../src/recorder/host-state';

const language = { code: 'fr', messages: { record_stop: { message: 'Arrêter' } } };
const settings = { file: 'checkout.spec.ts', testIdAttribute: 'data-test' };

function host() {
  const events: RawCaptureEvent[] = [];
  const pauses: boolean[] = [];
  let stopped = 0;
  const h = new RecorderHost({
    language,
    settings,
    startedAt: 1_000,
    onEvent: (event) => events.push(event),
    onStopped: () => stopped++,
    onPaused: (paused) => pauses.push(paused),
  });
  const message = (m: unknown) => h.handle({ kind: 'message', message: m });
  return { h, events, pauses, stopped: () => stopped, message };
}

const click = (overrides: Record<string, unknown> = {}) => ({
  kind: 'click',
  target: {
    tagName: 'button',
    role: 'button',
    accessibleName: 'Pay',
    testId: null,
    text: 'Pay',
    alternatives: [{ locator: "getByRole('button', { name: 'Pay' })", method: 'getByRole', score: 90 }],
  },
  value: null,
  checked: null,
  inputType: null,
  isPasswordField: false,
  pageUrl: 'http://127.0.0.1:4173/cart',
  timestamp: 2_000,
  ...overrides,
});

describe('RecorderHost', () => {
  test('seeds the language, the settings and an active recording', () => {
    const { h } = host();
    expect(h.local).toEqual({ [LANGUAGE_KEY]: language, piwiIdeSettings: settings });
    expect(h.session).toEqual({
      [RECORDING_KEY]: {
        active: true,
        events: [],
        startedAt: 1_000,
        grantedOriginPattern: null,
        paused: false,
      },
    });
  });

  test('chrome.storage.local: get by key, keys, defaults or all; set; remove', () => {
    const { h } = host();
    expect(h.handle({ kind: 'local-get', keys: 'piwiIdeSettings' })).toEqual({ piwiIdeSettings: settings });
    expect(h.handle({ kind: 'local-get', keys: ['piwiIdeSettings', 'missing'] })).toEqual({
      piwiIdeSettings: settings,
    });
    expect(h.handle({ kind: 'local-get', keys: { missing: 3, piwiIdeSettings: null } })).toEqual({
      missing: 3,
      piwiIdeSettings: settings,
    });
    expect(h.handle({ kind: 'local-set', items: { theme: 'dark' } })).toBeNull();
    expect(h.handle({ kind: 'local-get', keys: null })).toEqual({ ...h.local });
    expect(h.handle({ kind: 'local-remove', keys: ['theme', LANGUAGE_KEY] })).toBeNull();
    expect(Object.keys(h.local)).toEqual(['piwiIdeSettings']);
  });

  test('answers a ping and the zoom, and refuses anything else', () => {
    const { message } = host();
    expect(message({ type: 'piwi-ping' })).toEqual({ ok: true });
    expect(message({ type: 'piwi-tab-zoom' })).toEqual({ zoom: 1 });
    const refused = { ok: false, error: 'Not available in a recording started from the editor.' };
    expect(message({ type: 'piwi-open-options' })).toEqual(refused);
    expect(message('piwi-ping')).toEqual(refused);
    expect(message(null)).toEqual(refused);
  });

  test('the session area through messages: get, set, remove', () => {
    const { h, message } = host();
    expect(message({ type: 'piwi-session-storage', op: 'get', key: RECORDING_KEY })).toEqual({
      ok: true,
      items: { [RECORDING_KEY]: h.session[RECORDING_KEY] },
    });
    expect(message({ type: 'piwi-session-storage', op: 'get', key: 'piwiBugEvidence' })).toEqual({
      ok: true,
      items: {},
    });
    expect(message({ type: 'piwi-session-storage', op: 'set', items: { piwiBugEvidence: { console: [] } } })).toEqual({
      ok: true,
    });
    expect(h.session.piwiBugEvidence).toEqual({ console: [] });
    expect(message({ type: 'piwi-session-storage', op: 'remove', key: 'piwiBugEvidence' })).toEqual({ ok: true });
    expect('piwiBugEvidence' in h.session).toBe(false);
    expect(message({ type: 'piwi-session-storage', op: 'drop' })).toEqual({
      ok: false,
      error: 'Malformed session-storage request.',
    });
  });

  test('appends an event that parses, tells the launcher, and answers with the recording', () => {
    const { events, message } = host();
    const answer = message({ type: 'piwi-append-recording-event', event: click({ extra: 'dropped' }) }) as {
      ok: boolean;
      state: { events: RawCaptureEvent[] };
    };
    expect(answer.ok).toBe(true);
    expect(answer.state.events).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('extra');
    expect(events[0]!.target!.accessibleName).toBe('Pay');
  });

  test('refuses an event that does not parse', () => {
    const { events, message } = host();
    expect(message({ type: 'piwi-append-recording-event', event: click({ kind: 'teleport' }) })).toEqual({
      ok: false,
      error: 'Malformed recording event.',
    });
    expect(message({ type: 'piwi-append-recording-event', event: { kind: 'click' } })).toMatchObject({ ok: false });
    expect(events).toEqual([]);
  });

  test('passes on at most MAX_EVENTS events, whatever the page writes into the recording', () => {
    const { h, events, message } = host();
    for (let i = 0; i < MAX_EVENTS; i++) message({ type: 'piwi-append-recording-event', event: click() });
    const stored = h.session[RECORDING_KEY] as { events: unknown[] };
    message({ type: 'piwi-session-storage', op: 'set', items: { [RECORDING_KEY]: { ...stored, events: [] } } });
    expect(message({ type: 'piwi-append-recording-event', event: click() })).toEqual({
      ok: false,
      error: 'The recording is full: stop it to keep its steps.',
    });
    expect(events).toHaveLength(MAX_EVENTS);
  });

  test('Pause in the browser is kept for every page and passed on, and nothing is appended until Resume', () => {
    const { h, events, pauses, message } = host();
    expect(message({ type: 'piwi-recording-paused', paused: true })).toEqual({ ok: true });
    expect(pauses).toEqual([true]);
    expect(h.recording().paused).toBe(true);
    expect(message({ type: 'piwi-append-recording-event', event: click() })).toMatchObject({ ok: true });
    expect(events).toEqual([]);
    expect(message({ type: 'piwi-recording-paused', paused: 'yes' })).toMatchObject({ ok: false });
    message({ type: 'piwi-recording-paused', paused: false });
    message({ type: 'piwi-append-recording-event', event: click() });
    expect(pauses).toEqual([true, false]);
    expect(events).toHaveLength(1);
  });

  test('a pause from the editor is kept for the recorder and not passed back', () => {
    const { h, pauses, message } = host();
    h.setPaused(true);
    const answer = message({ type: 'piwi-session-storage', op: 'get', key: RECORDING_KEY }) as {
      items: Record<string, { paused: boolean }>;
    };
    expect(answer.items[RECORDING_KEY]!.paused).toBe(true);
    expect(pauses).toEqual([]);
  });

  test('appends nothing once the recorder stopped the recording', () => {
    const { h, events, message } = host();
    const stored = h.session[RECORDING_KEY] as { events: unknown[] };
    message({ type: 'piwi-session-storage', op: 'set', items: { [RECORDING_KEY]: { ...stored, active: false } } });
    const answer = message({ type: 'piwi-append-recording-event', event: click() }) as { ok: boolean; state: unknown };
    expect(answer).toEqual({ ok: true, state: { ...stored, active: false } });
    expect(events).toEqual([]);
    // A recording the page replaced with something else reads as one that is off.
    message({ type: 'piwi-session-storage', op: 'set', items: { [RECORDING_KEY]: 'on' } });
    expect(message({ type: 'piwi-append-recording-event', event: click() })).toMatchObject({
      ok: true,
      state: { active: false, events: [] },
    });
    expect(events).toEqual([]);
  });

  test('a Stop in the browser is answered and passed on', () => {
    const { stopped, message } = host();
    expect(message({ type: 'piwi-recording-stopped' })).toEqual({ ok: true });
    expect(stopped()).toBe(1);
  });

  test('a call from outside the recording reads the local area and an empty session area, and changes nothing', () => {
    const { h, events, pauses, stopped } = host();
    const outside = (m: unknown) => h.handleOutside({ kind: 'message', message: m });
    const local = { ...h.local };
    const session = structuredClone(h.session);
    expect(h.handleOutside({ kind: 'local-get', keys: 'piwiIdeSettings' })).toEqual({ piwiIdeSettings: settings });
    expect(h.handleOutside({ kind: 'local-set', items: { theme: 'dark' } })).toBeNull();
    expect(h.handleOutside({ kind: 'local-remove', keys: [LANGUAGE_KEY] })).toBeNull();
    expect(outside({ type: 'piwi-session-storage', op: 'get', key: RECORDING_KEY })).toEqual({ ok: true, items: {} });
    expect(
      outside({ type: 'piwi-session-storage', op: 'set', items: { [RECORDING_KEY]: { active: true, events: [] } } }),
    ).toEqual({ ok: true });
    expect(outside({ type: 'piwi-session-storage', op: 'remove', key: RECORDING_KEY })).toEqual({ ok: true });
    const refused = { ok: false, error: 'Only the page the recording opened is recorded.' };
    expect(outside({ type: 'piwi-append-recording-event', event: click() })).toEqual(refused);
    expect(outside({ type: 'piwi-recording-stopped' })).toEqual(refused);
    expect(outside({ type: 'piwi-recording-paused', paused: true })).toEqual(refused);
    expect(outside({ type: 'piwi-ping' })).toEqual({ ok: true });
    expect(outside({ type: 'piwi-tab-zoom' })).toEqual({ zoom: 1 });
    expect(outside({ type: 'piwi-open-options' })).toEqual({
      ok: false,
      error: 'Not available in a recording started from the editor.',
    });
    expect(h.handleOutside(undefined)).toBeNull();
    expect(h.local).toEqual(local);
    expect(h.session).toEqual(session);
    expect(events).toEqual([]);
    expect(stopped()).toBe(0);
    expect(pauses).toEqual([]);
  });

  test('a call that is not a request gets null', () => {
    const { h } = host();
    expect(h.handle(undefined)).toBeNull();
    expect(h.handle({ kind: 'eval', code: '1' })).toBeNull();
    expect(h.handle({ kind: 'local-set', items: 'x' })).toBeNull();
  });
});
