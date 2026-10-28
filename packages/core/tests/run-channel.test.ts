import { describe, expect, test } from 'vitest';
import { RECORD_CHANNEL_ENV } from '../src/ide-recorder';
import { MAX_VIEW_EVENTS, MAX_VIEW_FRAME_BASE64 } from '../src/run-view';
import {
  MAX_KEPT_BODY,
  MAX_KEPT_RESPONSES,
  MAX_REGION_SNAPSHOT,
  MAX_ACT_VALUE,
  MAX_AGENT_SNAPSHOT,
  MAX_ELEMENT_TEXT,
  MAX_RUN_EVENT_TEXT,
  MAX_SNAPSHOT_DEPTH,
  MAX_STOP_ERROR,
  RUN_ACT_ACTIONS,
  RUN_CHANNEL_ENV,
  RUN_HOLDS,
  RUN_TAKES,
  parseHubToRun,
  isSnapshotRef,
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
        'agent',
        'events',
        'bind',
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
      // An editor service released before `agent` reads a list of more than 16 as none: the list stays within it.
      expect(RUN_TAKES.length).toBeLessThanOrEqual(16);
      expect(parseRunToHub(line({ ...attach, takes: 'pick' }))).toMatchObject({ takes: [] });
      // A longer list a newer reporter sends is read for the names this side knows, up to 64 of them.
      const longer = [...RUN_TAKES, ...Array.from({ length: 40 }, (_, i) => `later-${i}`)];
      expect(parseRunToHub(line({ ...attach, takes: longer }))).toMatchObject({ takes: RUN_TAKES });
      expect(parseRunToHub(line({ ...attach, takes: [...longer, ...longer] }))).toMatchObject({ takes: [] });
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

  describe('what an agent asks of a stopped page', () => {
    test('takes a snapshot to a depth, with or without its image, and refuses a depth out of range', () => {
      const asked = {
        type: 'request',
        request: 7,
        what: 'snapshot',
        stop: 2,
        depth: 3,
        image: true,
      } satisfies HubToRun;
      expect(parseHubToRun(line(asked))).toEqual(asked);
      expect(parseHubToRun(line({ ...asked, depth: null, image: false }))).toEqual({
        ...asked,
        depth: null,
        image: false,
      });
      for (const broken of [
        { ...asked, depth: 0 },
        { ...asked, depth: MAX_SNAPSHOT_DEPTH + 1 },
        { ...asked, depth: 2.5 },
        { ...asked, depth: undefined },
        { ...asked, image: 'yes' },
        { ...asked, stop: 0 },
      ]) {
        expect(parseHubToRun(line(broken)), JSON.stringify(broken)).toBeNull();
      }
    });

    test('reads a snapshot answered, the page’s address, title, snapshot and image, and refuses one too long', () => {
      const answer = {
        type: 'answer',
        request: 7,
        what: 'snapshot',
        value: {
          ok: true,
          message: 'The stopped page.',
          url: 'http://shop.test/cart',
          title: 'Cart',
          snapshot: '- button "Pay" [ref=e5]',
          cut: false,
          image: { mime: 'image/jpeg', data: '/9j/', width: 800, height: 600 },
        },
      } satisfies RunToHub;
      expect(parseRunToHub(line(answer))).toEqual(answer);
      const none = { ...answer, value: { ...answer.value, ok: false, snapshot: null, image: null } };
      expect(parseRunToHub(line(none))).toEqual(none);
      expect(parseRunToHub(line({ ...answer, value: { ...answer.value, title: 'x'.repeat(2000) } }))).toMatchObject({
        value: { title: 'x'.repeat(1000) },
      });
      for (const value of [
        { ...answer.value, snapshot: 'x'.repeat(MAX_AGENT_SNAPSHOT + 1) },
        { ...answer.value, url: 'http://a\nb' },
        { ...answer.value, cut: 'no' },
        { ...answer.value, image: { mime: 'image/png', data: '/9j/' } },
        { ...answer.value, image: undefined },
        { ...answer.value, message: undefined },
      ]) {
        expect(parseRunToHub(line({ ...answer, value })), JSON.stringify(value).slice(0, 80)).toBeNull();
      }
    });

    test('acts by a ref with a value only where the action takes one, and refuses any other action or key', () => {
      const act = (action: string, value: unknown) =>
        parseHubToRun(line({ type: 'request', request: 8, what: 'act', stop: 2, ref: 'e5', action, value }));
      expect(act('click', null)).toEqual({
        type: 'request',
        request: 8,
        what: 'act',
        stop: 2,
        ref: 'e5',
        action: 'click',
        value: null,
      });
      expect(act('fill', 'dev@example.com')).toMatchObject({ action: 'fill', value: 'dev@example.com' });
      expect(act('fill', '')).toMatchObject({ action: 'fill', value: '' });
      expect(act('press', 'Shift+Tab')).toMatchObject({ action: 'press', value: 'Shift+Tab' });
      expect(act('select', 'France')).toMatchObject({ action: 'select', value: 'France' });
      const values: Record<string, string | null> = { fill: 'x', press: 'Enter', select: 'x' };
      for (const action of RUN_ACT_ACTIONS) expect(act(action, values[action] ?? null), action).not.toBeNull();
      for (const [action, value] of [
        ['click', 'x'],
        ['check', 'x'],
        ['fill', 'x'.repeat(MAX_ACT_VALUE + 1)],
        ['fill', null],
        ['press', 'Hyper+Q'],
        ['press', 'Enter; rm -rf'],
        ['select', 'a\nb'],
        ['evaluate', '1'],
        ['dblclick', null],
      ] as const) {
        expect(act(action, value), `${action} ${String(value).slice(0, 20)}`).toBeNull();
      }
      for (const ref of ['', 'e', '5', 'e5 ', 'f1', 'f1e2x', 'button', 'e1234567890']) {
        expect(isSnapshotRef(ref), ref).toBe(false);
      }
      expect(isSnapshotRef('f12e340')).toBe(true);
    });

    test('reads an element’s ranked locators, and never a password field’s value', () => {
      const element = {
        tagName: 'button',
        role: 'button',
        name: 'Pay',
        testId: 'pay',
        text: 'Pay',
        textCut: false,
        value: null,
        valueCut: false,
        checked: null,
        secret: false,
      };
      const answer = {
        type: 'answer',
        request: 9,
        what: 'ref-locator',
        value: {
          ok: true,
          message: '2 locators.',
          element,
          locators: [
            { locator: "getByTestId('pay')", method: 'getByTestId', score: 100, unique: true },
            { locator: "getByRole('button', { name: 'Pay' })", method: 'getByRole', score: 90, unique: false },
          ],
        },
      } satisfies RunToHub;
      expect(parseRunToHub(line(answer))).toEqual(answer);
      expect(parseRunToHub(line({ ...answer, what: 'act' }))).toEqual({ ...answer, what: 'act' });
      // An action the page did not answer in time may still be played: said so, on a refusal alone.
      const late = { ok: false, message: 'Late.', element: null, locators: [], late: true };
      expect(parseRunToHub(line({ ...answer, what: 'act', value: late }))).toMatchObject({ value: { late: true } });
      expect(parseRunToHub(line({ ...answer, what: 'act', value: { ...answer.value, late: true } }))).toEqual({
        ...answer,
        what: 'act',
      });
      expect(parseRunToHub(line({ ...answer, value: late }))).not.toHaveProperty('value.late');
      const secret = { ...element, tagName: 'input', role: 'textbox', value: 'hunter2', secret: true };
      expect(parseRunToHub(line({ ...answer, value: { ...answer.value, element: secret } }))).toMatchObject({
        value: { element: { value: null, valueCut: false, secret: true } },
      });
      // A text or a value longer than this side reads is cut, and says so; one the worker cut says so too.
      const long = { ...element, text: 'a'.repeat(MAX_ELEMENT_TEXT + 5), value: 'b'.repeat(MAX_ACT_VALUE + 5) };
      expect(parseRunToHub(line({ ...answer, value: { ...answer.value, element: long } }))).toMatchObject({
        value: {
          element: {
            text: 'a'.repeat(MAX_ELEMENT_TEXT),
            textCut: true,
            value: 'b'.repeat(MAX_ACT_VALUE),
            valueCut: true,
          },
        },
      });
      const cut = { ...element, textCut: true };
      expect(parseRunToHub(line({ ...answer, value: { ...answer.value, element: cut } }))).toMatchObject({
        value: { element: { textCut: true } },
      });
      for (const value of [
        { ...answer.value, element: { ...element, tagName: 'a b' } },
        { ...answer.value, element: { ...element, checked: 'yes' } },
        { ...answer.value, element: { ...element, secret: undefined } },
        { ...answer.value, locators: [{ locator: 'a\nb', method: 'locator', score: 1, unique: true }] },
        { ...answer.value, locators: Array(17).fill(answer.value.locators[0]) },
        { ...answer.value, locators: undefined },
      ]) {
        expect(parseRunToHub(line({ ...answer, value })), JSON.stringify(value).slice(0, 80)).toBeNull();
      }
    });

    test('binds and unbinds the browser at a stop, and reads the name and endpoint it was bound under', () => {
      const asked = { type: 'request', request: 10, what: 'bind', stop: 2, on: true } satisfies HubToRun;
      expect(parseHubToRun(line(asked))).toEqual(asked);
      expect(parseHubToRun(line({ ...asked, on: 'yes' }))).toBeNull();
      const bound = {
        type: 'answer',
        request: 10,
        what: 'bind',
        value: { ok: true, message: 'Bound.', name: 'piwi-ed-1-w0', endpoint: '/tmp/pw/browser.sock' },
      } satisfies RunToHub;
      expect(parseRunToHub(line(bound))).toEqual(bound);
      const unbound = { ...bound, value: { ok: true, message: 'Unbound.', name: null, endpoint: null } };
      expect(parseRunToHub(line(unbound))).toEqual(unbound);
      expect(parseRunToHub(line({ ...bound, value: { ...bound.value, name: 'a b' } }))).toBeNull();
    });

    test('turns the events on and off, and reads each event, its texts cut short', () => {
      expect(parseHubToRun(line({ type: 'events', on: true }))).toEqual({ type: 'events', on: true });
      expect(parseHubToRun(line({ type: 'events', on: 1 }))).toBeNull();
      const event = (e: unknown) => parseRunToHub(line({ type: 'event', event: e }));
      const call = {
        kind: 'call',
        title: 'locator.click',
        place: { file: 'tests/cart.spec.ts', line: 4, column: 9 },
        ok: false,
        error: 'Timeout 5000ms exceeded.',
        ms: 5003.4,
      };
      expect(event(call)).toEqual({ type: 'event', event: { ...call, ms: 5003 } });
      expect(event({ ...call, place: null, error: null })).toMatchObject({ event: { place: null, error: null } });
      expect(event({ kind: 'navigation', url: 'http://shop.test/' })).toEqual({
        type: 'event',
        event: { kind: 'navigation', url: 'http://shop.test/' },
      });
      expect(event({ kind: 'console', level: 'error', text: 'x'.repeat(5000) })).toMatchObject({
        event: { text: 'x'.repeat(MAX_RUN_EVENT_TEXT) },
      });
      expect(event({ kind: 'page-error', text: 'boom' })).toMatchObject({ event: { kind: 'page-error' } });
      expect(
        event({ kind: 'request-failed', method: 'get', url: 'http://shop.test/api', status: 500, failure: null }),
      ).toMatchObject({ event: { method: 'GET', status: 500 } });
      expect(event({ kind: 'dropped', count: 3 })).toMatchObject({ event: { count: 3 } });
      for (const broken of [
        { ...call, title: '' },
        { ...call, ms: -1 },
        { ...call, place: { file: '', line: 1 } },
        { kind: 'console', level: 'info', text: 'x' },
        { kind: 'navigation', url: 'a\nb' },
        { kind: 'request-failed', method: 'GET', url: 'http://a', status: 99, failure: null },
        { kind: 'dropped', count: 0 },
        { kind: 'evaluate', code: '1' },
      ]) {
        expect(event(broken), JSON.stringify(broken)).toBeNull();
      }
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
