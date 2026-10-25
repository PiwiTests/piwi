import { describe, expect, test } from 'vitest';
import { RECORD_CHANNEL_ENV } from '../src/ide-recorder';
import { RUN_CHANNEL_ENV, parseHubToRun, parseRunToHub, type HubToRun, type RunToHub } from '../src/run-channel';

const line = (message: unknown) => JSON.stringify(message);

describe('the run channel', () => {
  test('is named apart from the record channel', () => {
    expect(RUN_CHANNEL_ENV).toBe('PIWI_RUN_CHANNEL');
    expect(RUN_CHANNEL_ENV).not.toBe(RECORD_CHANNEL_ENV);
  });

  describe('what a worker sends', () => {
    const attach = {
      type: 'run-attach',
      token: 't'.repeat(32),
      ref: 'ed-0a1b2c3d',
      cwd: '/work/shop',
      workerIndex: 2,
      parallelIndex: 0,
      pid: 4242,
      playwright: '1.64.1',
      reporter: '0.60.0',
      takes: ['pick', 'record'],
    } satisfies RunToHub;

    test('reads its attach, and refuses one without a ref, a folder or a worker', () => {
      expect(parseRunToHub(line(attach))).toEqual(attach);
      expect(parseRunToHub(line({ ...attach, playwright: 3, reporter: undefined }))).toEqual({
        ...attach,
        playwright: '',
        reporter: '',
      });
      // A reporter that predates the intents lists none; one names only those this side knows.
      expect(parseRunToHub(line({ ...attach, takes: undefined }))).toEqual({ ...attach, takes: [] });
      expect(parseRunToHub(line({ ...attach, takes: ['assert', 'record'] }))).toMatchObject({ takes: ['record'] });
      expect(parseRunToHub(line({ ...attach, takes: 'pick' }))).toMatchObject({ takes: [] });
      for (const broken of [
        { ...attach, ref: '' },
        { ...attach, ref: 'ed 1' },
        { ...attach, ref: undefined },
        { ...attach, token: 5 },
        { ...attach, cwd: '' },
        { ...attach, cwd: '/a\0b' },
        { ...attach, workerIndex: -1 },
        { ...attach, parallelIndex: 1.5 },
        { ...attach, pid: '4242' },
      ]) {
        expect(parseRunToHub(line(broken)), JSON.stringify(broken)).toBeNull();
      }
    });

    test('reads a test that begins and ends', () => {
      const begin = {
        type: 'test-begin',
        testId: 'abc-123',
        title: ['checkout', 'pays with a coupon'],
        file: 'tests/checkout.spec.ts',
        line: 12,
        project: 'chromium',
        retry: 1,
        cannotPause: null,
      } satisfies RunToHub;
      expect(parseRunToHub(line(begin))).toEqual(begin);
      expect(parseRunToHub(line({ ...begin, cannotPause: 'running under CI' }))).toMatchObject({
        cannotPause: 'running under CI',
      });
      expect(parseRunToHub(line({ ...begin, title: [] }))).toBeNull();
      expect(parseRunToHub(line({ ...begin, title: ['a', 1] }))).toBeNull();
      expect(parseRunToHub(line({ ...begin, line: 0 }))).toBeNull();
      expect(parseRunToHub(line({ ...begin, retry: -1 }))).toBeNull();
      expect(parseRunToHub(line({ ...begin, cannotPause: false }))).toBeNull();

      const end = { type: 'test-end', testId: 'abc-123', status: 'passed', pausedMs: 4012 } satisfies RunToHub;
      expect(parseRunToHub(line(end))).toEqual(end);
      expect(parseRunToHub(line({ ...end, status: 'pass ed' }))).toBeNull();
      expect(parseRunToHub(line({ ...end, pausedMs: -1 }))).toBeNull();
      expect(parseRunToHub(line({ ...end, pausedMs: null }))).toBeNull();
    });

    test('reads a stop and its end, a reason it does not know as a plain stop', () => {
      const stopped = {
        type: 'stopped',
        stop: 3,
        reason: 'run-to',
        title: "Click getByRole('button', { name: 'Pay' })",
        place: { file: 'tests/pages/checkout.page.ts', line: 30, column: 5 },
        locator: "getByRole('button', { name: 'Pay' })",
        bar: false,
      } satisfies RunToHub;
      expect(parseRunToHub(line(stopped))).toEqual(stopped);
      expect(parseRunToHub(line({ ...stopped, reason: 'failure' }))).toMatchObject({ reason: 'other' });
      expect(parseRunToHub(line({ ...stopped, place: { file: '../shared/a.ts', line: 2 } }))).toMatchObject({
        place: { file: '../shared/a.ts', line: 2 },
      });
      for (const broken of [
        { ...stopped, stop: 0 },
        { ...stopped, reason: '' },
        { ...stopped, reason: 7 },
        { ...stopped, place: null },
        { ...stopped, place: { file: '', line: 3 } },
        { ...stopped, place: { file: 'a.ts', line: 3, column: 0 } },
        { ...stopped, locator: 5 },
        { ...stopped, bar: 'yes' },
      ]) {
        expect(parseRunToHub(line(broken)), JSON.stringify(broken)).toBeNull();
      }
      expect(parseRunToHub(line({ type: 'running', stop: 3 }))).toEqual({ type: 'running', stop: 3 });
      expect(parseRunToHub(line({ type: 'running' }))).toBeNull();
    });

    test('reads an image of the stopped page, or none, and refuses anything else', () => {
      const image = { mime: 'image/jpeg', data: '/9j/4AAQSkZJRg==' };
      expect(parseRunToHub(line({ type: 'answer', request: 1, what: 'image', value: image }))).toEqual({
        type: 'answer',
        request: 1,
        what: 'image',
        value: image,
      });
      expect(parseRunToHub(line({ type: 'answer', request: 2, what: 'image', value: null }))).toMatchObject({
        value: null,
      });
      expect(
        parseRunToHub(line({ type: 'answer', request: 2, what: 'image', value: { ...image, mime: 'text/html' } })),
      ).toBeNull();
      expect(
        parseRunToHub(line({ type: 'answer', request: 2, what: 'image', value: { ...image, data: '<svg>' } })),
      ).toBeNull();
      expect(parseRunToHub(line({ type: 'answer', request: 2, what: 'aria', value: null }))).toBeNull();
      expect(parseRunToHub(line({ type: 'answer', request: 0, what: 'image', value: null }))).toBeNull();
    });

    test('reads whether an intent started in the test’s window, and refuses an answer without both fields', () => {
      const started = { type: 'answer', request: 3, what: 'pick', value: { ok: true, message: 'Pick an element.' } };
      expect(parseRunToHub(line(started))).toEqual(started);
      expect(
        parseRunToHub(line({ ...started, what: 'record', value: { ok: false, message: 'x'.repeat(600) } })),
      ).toEqual({ ...started, what: 'record', value: { ok: false, message: 'x'.repeat(500) } });
      for (const value of [null, { ok: true }, { ok: 'yes', message: '' }, { message: 'x' }]) {
        expect(parseRunToHub(line({ ...started, value })), JSON.stringify(value)).toBeNull();
      }
    });

    test('reads a notice, cut short, and ignores what it does not know', () => {
      expect(parseRunToHub(line({ type: 'notice', message: 'x'.repeat(600) }))).toEqual({
        type: 'notice',
        message: 'x'.repeat(500),
      });
      expect(parseRunToHub(line({ type: 'notice' }))).toBeNull();
      expect(parseRunToHub(line({ type: 'attach', token: 'x' }))).toBeNull();
      expect(parseRunToHub(line({ type: 'frame' }))).toBeNull();
      expect(parseRunToHub('not json')).toBeNull();
      expect(parseRunToHub('[]')).toBeNull();
    });
  });

  describe('what the editor service sends', () => {
    test('reads the breakpoints, all of them or none', () => {
      const breakpoints = {
        type: 'breakpoints',
        places: [
          { file: 'tests/a.spec.ts', line: 4 },
          { file: 'tests/pages/b.page.ts', line: 9, column: 3 },
        ],
      } satisfies HubToRun;
      expect(parseHubToRun(line(breakpoints))).toEqual(breakpoints);
      expect(parseHubToRun(line({ type: 'breakpoints', places: [] }))).toEqual({ type: 'breakpoints', places: [] });
      expect(
        parseHubToRun(line({ type: 'breakpoints', places: [...breakpoints.places, { file: 'c.ts' }] })),
      ).toBeNull();
      expect(parseHubToRun(line({ type: 'breakpoints' }))).toBeNull();
    });

    test('reads the controls, each answering a stop but Pause', () => {
      expect(parseHubToRun(line({ type: 'control', action: 'pause' }))).toEqual({ type: 'control', action: 'pause' });
      for (const action of ['step', 'resume', 'finish'] as const) {
        expect(parseHubToRun(line({ type: 'control', action, stop: 2 }))).toEqual({ type: 'control', action, stop: 2 });
        expect(parseHubToRun(line({ type: 'control', action }))).toBeNull();
      }
      expect(parseHubToRun(line({ type: 'run-to', stop: 2, place: { file: 'tests/a.spec.ts', line: 7 } }))).toEqual({
        type: 'run-to',
        stop: 2,
        place: { file: 'tests/a.spec.ts', line: 7 },
      });
      expect(parseHubToRun(line({ type: 'run-to', stop: 2, place: { file: 'tests/a.spec.ts' } }))).toBeNull();
      expect(parseHubToRun(line({ type: 'control', action: 7 }))).toBeNull();
    });

    test('reads a request for an image of the stopped page', () => {
      expect(parseHubToRun(line({ type: 'request', request: 4, what: 'image' }))).toEqual({
        type: 'request',
        request: 4,
        what: 'image',
      });
      expect(parseHubToRun(line({ type: 'request', request: 0, what: 'image' }))).toBeNull();
    });

    test('reads a request to pick or record at a stop, which names that stop', () => {
      for (const what of ['pick', 'record'] as const) {
        expect(parseHubToRun(line({ type: 'request', request: 6, what, stop: 2 }))).toEqual({
          type: 'request',
          request: 6,
          what,
          stop: 2,
        });
        expect(parseHubToRun(line({ type: 'request', request: 6, what }))).toBeNull();
        expect(parseHubToRun(line({ type: 'request', request: 6, what, stop: 0 }))).toBeNull();
      }
    });

    test('names what a newer service sends that this version does not know, and refuses what is malformed', () => {
      expect(parseHubToRun(line({ type: 'control', action: 'end', stop: 2 }))).toEqual({
        type: 'unknown',
        what: 'control end',
      });
      expect(parseHubToRun(line({ type: 'request', request: 5, what: 'aria' }))).toEqual({
        type: 'unknown',
        what: 'request aria',
      });
      expect(parseHubToRun(line({ type: 'frame-on' }))).toEqual({ type: 'unknown', what: 'frame-on' });
      expect(parseHubToRun(line({ type: '' }))).toBeNull();
      expect(parseHubToRun(line({ kind: 'control' }))).toBeNull();
      expect(parseHubToRun('{')).toBeNull();
    });
  });
});
