import { describe, expect, test } from 'vitest';
import { RECORD_CHANNEL_ENV } from '../src/ide-recorder';
import { MAX_VIEW_EVENTS, MAX_VIEW_FRAME_BASE64 } from '../src/run-view';
import {
  MAX_KEPT_BODY,
  MAX_KEPT_RESPONSES,
  MAX_REGION_SNAPSHOT,
  MAX_STOP_ERROR,
  RUN_CHANNEL_ENV,
  RUN_HOLDS,
  RUN_TAKES,
  parseHubToRun,
  parseRunToHub,
  type HubToRun,
  type KeptRequest,
  type KeptResponse,
  type RunToHub,
} from '../src/run-channel';

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
      takes: [
        'pick',
        'record',
        'assert',
        'assert-region',
        'requests',
        'mock',
        'locator',
        'view',
        'input',
        'input-clicks',
        'pick-at',
      ],
      holds: ['failure'],
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
      expect(parseRunToHub(line({ ...attach, takes: ['dance', 'record'] }))).toMatchObject({ takes: ['record'] });
      expect(parseRunToHub(line({ ...attach, takes: ['mock', 'pick'] }))).toMatchObject({ takes: ['pick', 'mock'] });
      expect(RUN_TAKES).toEqual(attach.takes);
      expect(parseRunToHub(line({ ...attach, takes: 'pick' }))).toMatchObject({ takes: [] });
      // The stops it holds once the service says it shows them: none named by a reporter that predates them.
      expect(parseRunToHub(line({ ...attach, holds: undefined }))).not.toHaveProperty('holds');
      expect(parseRunToHub(line({ ...attach, holds: 'failure' }))).not.toHaveProperty('holds');
      expect(parseRunToHub(line({ ...attach, holds: ['dance', 'failure'] }))).toMatchObject({ holds: ['failure'] });
      expect(parseRunToHub(line({ ...attach, holds: [] }))).toMatchObject({ holds: [] });
      expect(RUN_HOLDS).toEqual(attach.holds);
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
      expect(parseRunToHub(line({ ...stopped, reason: 'failure' }))).toMatchObject({ reason: 'failure' });
      expect(parseRunToHub(line({ ...stopped, reason: 'dance' }))).toMatchObject({ reason: 'other' });
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

    test('reads the error a failure’s stop names, cut short, and no error of another stop', () => {
      const failed = {
        type: 'stopped',
        stop: 4,
        reason: 'failure',
        title: 'Failed: expect(locator).toBeVisible() failed',
        place: { file: 'tests/checkout.spec.ts', line: 12, column: 5 },
        locator: "getByRole('button', { name: 'Pay' })",
        bar: true,
        error: "expect(locator).toBeVisible() failed\nLocator: getByRole('button', { name: 'Pay' })",
      } satisfies RunToHub;
      expect(parseRunToHub(line(failed))).toEqual(failed);
      expect(parseRunToHub(line({ ...failed, error: 'x'.repeat(MAX_STOP_ERROR + 50) }))).toMatchObject({
        error: 'x'.repeat(MAX_STOP_ERROR),
      });
      // A reporter that predates it sends none; one that is no text, or no words, is left out, as is another stop's.
      for (const without of [
        { ...failed, error: undefined },
        { ...failed, error: 5 },
        { ...failed, error: ' \n ' },
        { ...failed, reason: 'breakpoint' },
      ]) {
        const read = parseRunToHub(line(without));
        expect(read, JSON.stringify(without)).toMatchObject({ type: 'stopped', stop: 4 });
        expect(read, JSON.stringify(without)).not.toHaveProperty('error');
      }
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

    test('reads the responses a test kept, each field checked, and refuses a list it cannot read whole', () => {
      const kept = {
        id: 3,
        method: 'POST',
        url: 'https://shop.test/api/cart?id=4',
        status: 201,
        type: 'application/json',
        size: 812,
        time: 1450,
      } satisfies KeptRequest;
      const listed = {
        type: 'answer',
        request: 4,
        what: 'requests',
        value: { ok: true, message: 'The test kept 1 response.', requests: [kept] },
      } satisfies RunToHub;
      expect(parseRunToHub(line(listed))).toEqual(listed);
      expect(
        parseRunToHub(line({ ...listed, value: { ...listed.value, requests: [{ ...kept, method: 'post' }] } })),
      ).toMatchObject({ value: { requests: [{ method: 'POST' }] } });
      // A body that said no size is listed without one.
      const chunked = { ...listed, value: { ...listed.value, requests: [{ ...kept, size: null }] } };
      expect(parseRunToHub(line(chunked))).toEqual(chunked);
      expect(parseRunToHub(line({ ...listed, value: { ok: false, message: 'gone', requests: [] } }))).toMatchObject({
        value: { ok: false, requests: [] },
      });
      for (const broken of [
        { ...kept, id: 0 },
        { ...kept, method: 'GE T' },
        { ...kept, url: '' },
        { ...kept, url: 'https://a.test/\nb' },
        { ...kept, status: 99 },
        { ...kept, status: 600 },
        { ...kept, type: 'application/json; charset=utf-8' },
        { ...kept, size: MAX_KEPT_BODY + 1 },
        { ...kept, size: -1 },
        { ...kept, time: -1 },
      ]) {
        expect(
          parseRunToHub(line({ ...listed, value: { ...listed.value, requests: [kept, broken] } })),
          JSON.stringify(broken),
        ).toBeNull();
      }
      const many = Array.from({ length: MAX_KEPT_RESPONSES + 1 }, (_, i) => ({ ...kept, id: i + 1 }));
      expect(parseRunToHub(line({ ...listed, value: { ...listed.value, requests: many } }))).toBeNull();
      expect(parseRunToHub(line({ ...listed, value: { ok: true, message: 'x' } }))).toBeNull();
    });

    test('reads the one response to mock with its body, or none, and refuses a body past the cap', () => {
      const response = {
        method: 'GET',
        url: 'https://shop.test/api/cart',
        status: 200,
        type: 'application/json',
        body: '{"items":[]}',
      } satisfies KeptResponse;
      const mock = {
        type: 'answer',
        request: 5,
        what: 'mock',
        value: { ok: true, message: 'The response.', response },
      } satisfies RunToHub;
      expect(parseRunToHub(line(mock))).toEqual(mock);
      expect(
        parseRunToHub(
          line({ ...mock, value: { ok: false, message: 'The test kept no such response.', response: null } }),
        ),
      ).toMatchObject({ value: { ok: false, response: null } });
      for (const broken of [
        { ...response, body: 'x'.repeat(MAX_KEPT_BODY + 1) },
        { ...response, body: null },
        { ...response, status: 0 },
        { ...response, url: 'a\rb' },
      ]) {
        expect(parseRunToHub(line({ ...mock, value: { ...mock.value, response: broken } }))).toBeNull();
      }
      expect(parseRunToHub(line({ ...mock, value: { ok: true, message: 'x' } }))).toBeNull();
    });

    test('reads a locator’s count, or none, and a region picked with its ARIA snapshot', () => {
      const counted = {
        type: 'answer',
        request: 6,
        what: 'locator',
        value: { ok: true, message: '2 elements match.', count: 2 },
      } satisfies RunToHub;
      expect(parseRunToHub(line(counted))).toEqual(counted);
      expect(
        parseRunToHub(line({ ...counted, value: { ok: false, message: 'It does not parse.', count: null } })),
      ).toMatchObject({ value: { count: null } });
      expect(parseRunToHub(line({ ...counted, value: { ok: true, message: '', count: -1 } }))).toBeNull();
      expect(parseRunToHub(line({ ...counted, value: { ok: true, message: '' } }))).toBeNull();

      const region = {
        type: 'region',
        stop: 2,
        locator: "getByRole('region', { name: 'Order summary' })",
        snapshot: '- heading "Order summary" [level=2]\n- text: Total €72.00',
      } satisfies RunToHub;
      expect(parseRunToHub(line(region))).toEqual(region);
      // Why the region picked brought no snapshot.
      const refused = { type: 'region', stop: 2, refused: "getByRole('list') finds 3 elements." } satisfies RunToHub;
      expect(parseRunToHub(line(refused))).toEqual(refused);
      expect(parseRunToHub(line({ ...refused, refused: 'x'.repeat(600) }))).toEqual({
        ...refused,
        refused: 'x'.repeat(500),
      });
      expect(parseRunToHub(line({ ...refused, refused: ' ' }))).toBeNull();
      expect(parseRunToHub(line({ ...refused, stop: 0 }))).toBeNull();
      for (const broken of [
        { ...region, stop: 0 },
        { ...region, locator: '' },
        { ...region, locator: "getByRole('a')\n.click()" },
        { ...region, locator: 'x'.repeat(1001) },
        { ...region, snapshot: '  ' },
        { ...region, snapshot: 'x'.repeat(MAX_REGION_SNAPSHOT + 1) },
      ]) {
        expect(parseRunToHub(line(broken)), JSON.stringify(broken).slice(0, 80)).toBeNull();
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
      expect(parseRunToHub(line({ type: 'view', stop: 1 }))).toBeNull();
      expect(parseRunToHub('not json')).toBeNull();
      expect(parseRunToHub('[]')).toBeNull();
    });
  });

  describe('what the editor service sends', () => {
    test('reads the stops it shows, answering a worker that listed the ones it holds', () => {
      expect(parseHubToRun(line({ type: 'attached', holds: ['failure'] }))).toEqual({
        type: 'attached',
        holds: ['failure'],
      });
      expect(parseHubToRun(line({ type: 'attached', holds: ['failure', 'dance'] }))).toEqual({
        type: 'attached',
        holds: ['failure'],
      });
      expect(parseHubToRun(line({ type: 'attached', holds: [] }))).toEqual({ type: 'attached', holds: [] });
      expect(parseHubToRun(line({ type: 'attached' }))).toBeNull();
      expect(parseHubToRun(line({ type: 'attached', holds: 'failure' }))).toBeNull();
    });

    test('reads what the worker’s lines call the service, leaving out a name it could not print', () => {
      expect(parseHubToRun(line({ type: 'attached', holds: ['failure'], host: 'the desktop app' }))).toEqual({
        type: 'attached',
        holds: ['failure'],
        host: 'the desktop app',
      });
      for (const host of ['', 7, 'the\neditor', '\u001b[31mred', 'a'.repeat(65), ' leading space']) {
        expect(parseHubToRun(line({ type: 'attached', holds: [], host }))).toEqual({ type: 'attached', holds: [] });
      }
    });

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

    test('reads a request to start an intent or to answer a query at a stop, which names that stop', () => {
      for (const what of ['pick', 'record', 'assert', 'assert-region', 'requests'] as const) {
        expect(parseHubToRun(line({ type: 'request', request: 6, what, stop: 2 }))).toEqual({
          type: 'request',
          request: 6,
          what,
          stop: 2,
        });
        expect(parseHubToRun(line({ type: 'request', request: 6, what }))).toBeNull();
        expect(parseHubToRun(line({ type: 'request', request: 6, what, stop: 0 }))).toBeNull();
      }
      expect(parseHubToRun(line({ type: 'request', request: 7, what: 'mock', stop: 2, id: 4 }))).toEqual({
        type: 'request',
        request: 7,
        what: 'mock',
        stop: 2,
        id: 4,
      });
      expect(parseHubToRun(line({ type: 'request', request: 7, what: 'mock', stop: 2 }))).toBeNull();
      expect(parseHubToRun(line({ type: 'request', request: 7, what: 'mock', stop: 2, id: 0 }))).toBeNull();
      const locator = { type: 'request', request: 8, what: 'locator', stop: 2, locator: "getByText('Pay')" };
      expect(parseHubToRun(line(locator))).toEqual(locator);
      expect(parseHubToRun(line({ ...locator, locator: null }))).toEqual({ ...locator, locator: null });
      expect(parseHubToRun(line({ ...locator, locator: undefined }))).toBeNull();
      expect(parseHubToRun(line({ ...locator, locator: '' }))).toBeNull();
      expect(parseHubToRun(line({ ...locator, locator: "getByText('a')\ngetByText('b')" }))).toBeNull();
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

  describe('the live view of a stopped page', () => {
    test('reads a frame of a stop, its viewport and its data, and refuses one too long or not base64', () => {
      const frame = { type: 'frame', stop: 2, width: 1280, height: 720, data: '/9j/4AAQ' } satisfies RunToHub;
      expect(parseRunToHub(line(frame))).toEqual(frame);
      expect(parseRunToHub(line({ ...frame, extra: 'x' }))).toEqual(frame);
      expect(parseRunToHub(line({ ...frame, data: 'A'.repeat(MAX_VIEW_FRAME_BASE64) }))).toMatchObject({ stop: 2 });
      for (const broken of [
        { ...frame, stop: 0 },
        { ...frame, width: 0 },
        { ...frame, height: 720.5 },
        { ...frame, width: '1280' },
        { ...frame, data: '' },
        { ...frame, data: 'not base64' },
        { ...frame, data: 'A'.repeat(MAX_VIEW_FRAME_BASE64 + 4) },
        { ...frame, data: undefined },
      ]) {
        expect(parseRunToHub(line(broken)), JSON.stringify(broken).slice(0, 80)).toBeNull();
      }
    });

    test('reads why a view sends no frame of a stop, its sentence cut short', () => {
      const refused = {
        type: 'frame',
        stop: 2,
        refused: 'This page is too heavy for the live view.',
      } satisfies RunToHub;
      expect(parseRunToHub(line(refused))).toEqual(refused);
      expect(parseRunToHub(line({ ...refused, refused: 'x'.repeat(600) }))).toEqual({
        ...refused,
        refused: 'x'.repeat(500),
      });
      for (const broken of [
        { ...refused, stop: 0 },
        { ...refused, refused: ' ' },
        { ...refused, refused: 4 },
      ]) {
        expect(parseRunToHub(line(broken)), JSON.stringify(broken)).toBeNull();
      }
    });

    test('reads the answers to a view, an input and a pick on an image', () => {
      for (const what of ['view', 'input'] as const) {
        const answer = { type: 'answer', request: 3, what, value: { ok: true, message: 'The live view is on.' } };
        expect(parseRunToHub(line(answer))).toEqual(answer);
        expect(parseRunToHub(line({ ...answer, value: { ok: true } }))).toBeNull();
      }
      const picked = {
        type: 'answer',
        request: 4,
        what: 'pick-at',
        value: { ok: true, message: 'sent', locator: "getByRole('button', { name: 'Go' })" },
      } satisfies RunToHub;
      expect(parseRunToHub(line(picked))).toEqual(picked);
      const none = { ...picked, value: { ok: false, message: 'No element there.', locator: null } };
      expect(parseRunToHub(line(none))).toEqual(none);
      for (const locator of [undefined, '', 'a\nb', 'x'.repeat(1001), 5]) {
        expect(parseRunToHub(line({ ...picked, value: { ...picked.value, locator } })), String(locator)).toBeNull();
      }
    });

    test('reads the viewport of an image when it names both of it, and an image without one', () => {
      const image = {
        type: 'answer',
        request: 5,
        what: 'image',
        value: { mime: 'image/jpeg', data: '/9j/', width: 800, height: 600 },
      };
      expect(parseRunToHub(line(image))).toEqual(image);
      expect(parseRunToHub(line({ ...image, value: { mime: 'image/jpeg', data: '/9j/', width: 800 } }))).toEqual({
        ...image,
        value: { mime: 'image/jpeg', data: '/9j/' },
      });
      expect(
        parseRunToHub(line({ ...image, value: { mime: 'image/jpeg', data: '/9j/', width: -1, height: 2 } })),
      ).toEqual({
        ...image,
        value: { mime: 'image/jpeg', data: '/9j/' },
      });
    });

    test('reads a request to start or stop a view, to play input and to pick at a point, each naming its stop', () => {
      expect(parseHubToRun(line({ type: 'request', request: 9, what: 'view', stop: 2, on: true }))).toEqual({
        type: 'request',
        request: 9,
        what: 'view',
        stop: 2,
        on: true,
      });
      expect(parseHubToRun(line({ type: 'request', request: 9, what: 'view', stop: 2, on: 'yes' }))).toBeNull();
      expect(parseHubToRun(line({ type: 'request', request: 9, what: 'view', on: false }))).toBeNull();
      const events = [
        { type: 'mouse', action: 'click', x: 4, y: 5, button: 'left', clickCount: 1 },
        { type: 'key', action: 'press', key: 'Enter' },
      ];
      expect(parseHubToRun(line({ type: 'request', request: 10, what: 'input', stop: 2, events }))).toEqual({
        type: 'request',
        request: 10,
        what: 'input',
        stop: 2,
        events,
      });
      const move = { type: 'mouse', action: 'move', x: 1, y: 1 };
      for (const broken of [
        [],
        Array.from({ length: MAX_VIEW_EVENTS + 1 }, () => move),
        [{ type: 'key', action: 'press', key: 'NotAKey' }],
        [{ type: 'evaluate', code: '1' }],
      ]) {
        expect(
          parseHubToRun(line({ type: 'request', request: 10, what: 'input', stop: 2, events: broken })),
        ).toBeNull();
      }
      expect(parseHubToRun(line({ type: 'request', request: 11, what: 'pick-at', stop: 2, x: 20, y: 90.5 }))).toEqual({
        type: 'request',
        request: 11,
        what: 'pick-at',
        stop: 2,
        x: 20,
        y: 90.5,
      });
      for (const [x, y] of [
        [-1, 0],
        [0, 10_001],
        ['1', 1],
        [null, 1],
      ]) {
        expect(parseHubToRun(line({ type: 'request', request: 11, what: 'pick-at', stop: 2, x, y }))).toBeNull();
      }
    });

    test('reads any line without throwing, every message it takes within its bounds', () => {
      let state = 11;
      const next = () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
      const odd = [
        null,
        undefined,
        0,
        -1,
        1,
        2.5,
        1e9,
        '',
        'x',
        '/9j/',
        'a\0',
        [],
        {},
        true,
        [{ type: 'text', text: 'a' }],
      ];
      const types = ['frame', 'answer', 'request', 'stopped', 'running', 'view'];
      const whats = ['view', 'input', 'pick-at', 'image', 'locator', 'pick'];
      const pick = () => odd[Math.floor(next() * odd.length)];
      for (let i = 0; i < 20_000; i++) {
        const message = {
          type: types[i % types.length],
          what: whats[Math.floor(next() * whats.length)],
          request: pick(),
          stop: next() < 0.5 ? 2 : pick(),
          on: pick(),
          events: pick(),
          x: pick(),
          y: pick(),
          width: next() < 0.5 ? 640 : pick(),
          height: next() < 0.5 ? 480 : pick(),
          data: pick(),
          value:
            next() < 0.5 ? { ok: pick(), message: pick(), locator: pick(), mime: 'image/jpeg', data: pick() } : pick(),
        };
        const toHub = parseRunToHub(line(message));
        if (toHub?.type === 'frame') {
          if ('data' in toHub) expect(toHub.data.length).toBeLessThanOrEqual(MAX_VIEW_FRAME_BASE64);
          else expect(toHub.refused.length).toBeLessThanOrEqual(500);
        }
        const toRun = parseHubToRun(line(message));
        if (toRun?.type === 'request' && toRun.what === 'input') {
          expect(toRun.events.length).toBeGreaterThan(0);
          expect(toRun.events.length).toBeLessThanOrEqual(MAX_VIEW_EVENTS);
        }
      }
    });
  });
});
