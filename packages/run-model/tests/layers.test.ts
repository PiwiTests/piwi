import { describe, expect, it } from 'vitest';
import { MAX_FILMSTRIP, type LaneThumb, type PageEvent } from '@piwitests/core/live-layers';
import type { LiveCallLog } from '@piwitests/core/live-view';
import {
  LANE_LOG_LINES,
  MAX_LANE_EVENTS,
  asksLaneTextAgain,
  callWait,
  englishSeconds,
  laneEventSaid,
  laneLayersAsked,
  laneTextSource,
  noLaneLayers,
  takeLaneLayer,
  type HeardLaneLayer,
  type LaneLayers,
} from '../src/layers';
import { englishRunSpeaker as en } from '../src/words';

const AT = 1_800_000_000_000;
/** The shortest JPEG in base64 a filmstrip takes. */
const JPEG = '/9j/4AAQSkZJRg==';

const log = (over: Partial<LiveCallLog> = {}): LiveCallLog => ({
  id: 'call@4',
  call: { title: "Click getByRole('button', { name: 'Pay' })", file: 'tests/shop.spec.ts', line: 12 },
  status: 'running',
  lines: [],
  point: null,
  target: null,
  viewport: null,
  ms: 3400,
  error: null,
  ...over,
});

const thumb = (call: string, index: number): LaneThumb => ({
  call,
  title: call,
  index,
  width: 320,
  height: 200,
  at: AT,
});

/** The layers after each of `heard`, from none, of worker 0 running test `t1` unless one says otherwise. */
function taken(...heard: Array<Partial<HeardLaneLayer> & Pick<HeardLaneLayer, 'layer'>>): LaneLayers {
  return heard.reduce(
    (layers, one) => takeLaneLayer(layers, { worker: 0, test: 't1', ...one } as HeardLaneLayer),
    noLaneLayers(),
  );
}

const event = (e: PageEvent, at = AT) => ({ layer: 'events' as const, event: e, at });

describe('the layers a surface asks of a lane it watches', () => {
  it('asks for every layer, the page’s text once the person asked for it', () => {
    expect(laneLayersAsked(false)).toEqual(['calls', 'events', 'filmstrip']);
    expect(laneLayersAsked(true)).toEqual(['calls', 'events', 'text', 'filmstrip']);
  });
});

describe('a lane’s layers as they come', () => {
  it('keeps the latest call log, and starts afresh for another test or another worker', () => {
    const first = taken({ layer: 'calls', log: log() }, event({ kind: 'console', text: 'boom' }));
    expect(first).toMatchObject({ worker: 0, test: 't1', log: { id: 'call@4' } });
    expect(first.events).toHaveLength(1);
    const next = takeLaneLayer(first, { worker: 0, test: 't2', layer: 'calls', log: log({ id: 'call@9' }) });
    expect(next).toMatchObject({ test: 't2', log: { id: 'call@9' }, events: [] });
    const replaced = takeLaneLayer(next, { worker: 1, test: 't2', layer: 'calls', log: log() });
    expect(replaced.worker).toBe(1);
    // The ones given are left as they were.
    expect(first.events).toHaveLength(1);
  });

  it('asks for the page’s text again as the lane’s next test begins, the text it starts with aside', () => {
    const first = taken({ layer: 'calls', log: log() });
    const text = { call: null, source: 'snapshot' as const, text: '- button "Pay"', cut: false, at: AT };
    expect(asksLaneTextAgain(noLaneLayers(), { worker: 0, test: 't1', layer: 'calls', log: log() })).toBe(false);
    expect(asksLaneTextAgain(first, { worker: 0, test: 't1', layer: 'calls', log: log() })).toBe(false);
    expect(asksLaneTextAgain(first, { worker: 0, test: null, layer: 'text', text })).toBe(false);
    expect(asksLaneTextAgain(first, { worker: 0, test: 't2', layer: 'calls', log: log() })).toBe(true);
    expect(asksLaneTextAgain(first, { worker: 1, test: 't1', ...event({ kind: 'console', text: 'boom' }) })).toBe(true);
    expect(asksLaneTextAgain(first, { worker: 0, test: 't2', layer: 'text', text })).toBe(false);
  });

  it('keeps the text of a page no test shows beside the rest', () => {
    const before = taken({ layer: 'calls', log: log() });
    const text = { call: null, source: 'snapshot' as const, text: '- button "Pay"', cut: false, at: AT };
    const after = takeLaneLayer(before, { worker: 0, test: null, layer: 'text', text });
    expect(after).toMatchObject({ test: 't1', log: { id: 'call@4' }, text, textRefused: null });
    const refused = takeLaneLayer(after, { worker: 0, test: null, layer: 'text', refused: 'No page to read.' });
    expect(refused).toMatchObject({ text, textRefused: 'No page to read.' });
  });

  it('lists events newest first, a pending request one entry whose time grows, the latest few alone', () => {
    const pending = (ms: number, done: boolean): PageEvent => ({
      kind: 'request-pending',
      id: 7,
      method: 'POST',
      url: 'http://shop.test/api/checkout',
      ms,
      done,
    });
    const layers = taken(
      event(pending(5000, false)),
      event({ kind: 'console', text: 'cart broke' }),
      event(pending(10_000, false)),
      event(pending(12_300, true)),
    );
    expect(layers.events.map((entry) => entry.event.kind)).toEqual(['console', 'request-pending']);
    expect(layers.events[1]!.event).toMatchObject({ ms: 12_300, done: true });
    expect(new Set(layers.events.map((entry) => entry.key)).size).toBe(2);
    const many = taken(
      ...Array.from({ length: MAX_LANE_EVENTS + 5 }, (_, i) => event({ kind: 'console', text: `${i}` })),
    );
    expect(many.events).toHaveLength(MAX_LANE_EVENTS);
    expect(many.events[0]!.event).toEqual({ kind: 'console', text: `${MAX_LANE_EVENTS + 4}` });
  });

  it('keeps one image a call of the filmstrip, by its place in the strip, the latest alone', () => {
    const layers = taken(
      { layer: 'filmstrip', thumb: thumb('c2', 2), data: JPEG },
      { layer: 'filmstrip', thumb: thumb('c1', 1), data: JPEG },
      // Sent again to a viewer that came later: it takes its own place again.
      { layer: 'filmstrip', thumb: thumb('c2', 2), data: JPEG },
      // Data that is no JPEG in base64 is left out.
      { layer: 'filmstrip', thumb: thumb('c3', 3), data: 'PHN2Zz4=' },
    );
    expect(layers.film.map((entry) => entry.thumb.call)).toEqual(['c1', 'c2']);
    const full = taken(
      ...Array.from({ length: MAX_FILMSTRIP + 3 }, (_, i) => ({
        layer: 'filmstrip' as const,
        thumb: thumb(`c${i + 1}`, i + 1),
        data: JPEG,
      })),
    );
    expect(full.film).toHaveLength(MAX_FILMSTRIP);
    expect(full.film[0]!.thumb.index).toBe(4);
  });
});

describe('the layers in a surface’s words', () => {
  it('says why a call waits: how long, what its locator matches, and its log’s latest lines', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `line ${i}`);
    const wait = callWait(log({ lines, target: { count: 1, box: null, enabled: false } }), en, englishSeconds);
    expect(wait).toMatchObject({
      title: "Click getByRole('button', { name: 'Pay' })",
      place: 'tests/shop.spec.ts:12',
      tone: 'running',
      state: 'Running for 3.4s',
      target: '1 element matches its locator · Its element is not enabled',
    });
    expect(wait.lines).toEqual(lines.slice(-LANE_LOG_LINES));
    expect(callWait(log({ target: { count: 0, box: null, enabled: null } }), en, englishSeconds).target).toBe(
      'No element matches its locator yet',
    );
    expect(callWait(log({ target: { count: 3, box: null, enabled: true } }), en, englishSeconds).target).toBe(
      '3 elements match its locator',
    );
    // A call that ended says how, and nothing of its locator.
    const done = callWait(
      log({ status: 'failed', ms: 30_000, error: 'Timeout', target: { count: 0, box: null, enabled: null } }),
      en,
      englishSeconds,
    );
    expect(done).toMatchObject({ state: 'Failed after 30s', target: null, error: 'Timeout', tone: 'failed' });
    expect(
      callWait(log({ status: 'passed', call: { title: 'Goto', file: null, line: null } }), en, englishSeconds),
    ).toMatchObject({ state: 'Done in 3.4s', place: null });
  });

  it('says each event of the page, with how it reads at a glance', () => {
    const say = (e: PageEvent) => laneEventSaid(e, en, englishSeconds);
    expect(say({ kind: 'console', text: 'cart broke' })).toEqual({
      label: 'Console error',
      text: 'cart broke',
      tone: 'error',
    });
    expect(say({ kind: 'page-error', text: 'boom' })).toMatchObject({ label: 'Uncaught error', tone: 'error' });
    expect(say({ kind: 'request-failed', method: 'GET', url: '/a', status: 500, failure: null }).text).toBe(
      'GET /a answered 500',
    );
    expect(say({ kind: 'request-failed', method: 'GET', url: '/a', status: null, failure: 'net::ERR' }).text).toBe(
      'GET /a failed: net::ERR',
    );
    expect(say({ kind: 'request-failed', method: 'GET', url: '/a', status: null, failure: null }).text).toBe(
      'GET /a got no answer',
    );
    expect(say({ kind: 'request-pending', id: 1, method: 'POST', url: '/pay', ms: 17_000, done: false })).toEqual({
      label: 'Pending request',
      text: 'POST /pay pending for 17s',
      tone: 'waiting',
    });
    expect(say({ kind: 'request-pending', id: 1, method: 'POST', url: '/pay', ms: 18_400, done: true })).toEqual({
      label: 'Slow request',
      text: 'POST /pay answered after 18s',
      tone: 'warning',
    });
    expect(
      say({ kind: 'backend', method: 'GET', url: '/a', status: 500, level: 'warning', text: 'Slow query' }),
    ).toEqual({ label: 'Backend warning', text: 'GET /a: Slow query', tone: 'warning' });
    expect(say({ kind: 'api', method: 'GET', url: '/items', status: 200, ms: 120, failure: null })).toEqual({
      label: 'API call',
      text: 'GET /items answered 200 in 0.1s',
      tone: 'info',
    });
    expect(say({ kind: 'api', method: 'GET', url: '/items', status: 404, ms: 80, failure: null }).tone).toBe('error');
    expect(say({ kind: 'dropped', count: 3 })).toEqual({ label: '3 more events left out', text: '', tone: 'info' });
  });

  it('says where the page’s text came from, and when it was cut', () => {
    const text = { call: 'call@4', source: 'trace' as const, text: '- main', cut: false, at: AT };
    expect(laneTextSource(text, en)).toBe('From the test’s trace');
    expect(laneTextSource({ ...text, source: 'snapshot', cut: true }, en)).toBe(
      'Taken as you asked · Cut short: the page’s text is longer',
    );
  });
});
