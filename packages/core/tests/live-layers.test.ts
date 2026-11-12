import { describe, expect, test } from 'vitest';
import {
  LANE_LAYERS,
  MAX_LANE_TEXT,
  MAX_LANE_THUMB,
  MAX_PAGE_EVENT_TEXT,
  ariaTreeText,
  isLaneThumbBytes,
  isLaneThumbData,
  readLaneLayers,
  readLaneText,
  readLaneThumb,
  readPageEvent,
} from '../src/live-layers';
import { HIDDEN_VALUE, ariaMaskProblem, isSecretFieldName, looksLikeCardNumber, maskAriaSnapshot } from '../src/mask';
import {
  encodeLiveMessage,
  encodeLiveViewerMessage,
  liveThumbHeader,
  parseInstanceToWorker,
  readLiveViewerMessage,
  readLiveWorkerPost,
  readWorkerToInstance,
  createLiveMessageReader,
  MAX_LIVE_FRAME,
} from '../src/live-view';
import { parseHubToRun, parseRunToHub, RUN_FEATURES } from '../src/run-channel';
import { HUB_FEATURES, parseHubCommand, parseHubMessage } from '../src/run-hub';

const AT = 1_800_000_000_000;
/** A JPEG's first bytes, as a filmstrip image starts. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const JPEG_BASE64 = Buffer.from(JPEG).toString('base64');

/** What Playwright 1.64 writes into an ARIA snapshot of a payment form, values and all. */
const PAYMENT_FORM = [
  '- generic [ref=e2]:',
  '  - text: Password',
  '  - textbox "Password" [ref=e4]: S3cr3t!Pw',
  '  - textbox "Card number" [ref=e6]: 4111 1111 1111 1111',
  '  - textbox "Code" [ref=e8]: "123456"',
  '  - textbox "Verification code" [ref=e9]: "987654"',
  '  - textbox "Name" [ref=e12]: Ada',
  '  - textbox "Promo code" [ref=e13]: SUMMER',
  '  - textbox "Search" [ref=e14]: shoes',
  '  - text: 5500 0000 0000 0004',
  '  - combobox "Country" [ref=e15]:',
  '    - option "France" [selected]',
  '  - checkbox "Agree" [checked] [ref=e16]',
].join('\n');

describe('the ARIA snapshot masker', () => {
  const masked = maskAriaSnapshot(PAYMENT_FORM);

  test('hides a password field’s value, read from its name alone', () => {
    expect(masked).toContain(`- textbox "Password" [ref=e4]: ${HIDDEN_VALUE}`);
    expect(masked).not.toContain('S3cr3t!Pw');
  });

  test('hides a card’s number, by the field’s name and by the value’s own shape, whatever its node', () => {
    expect(masked).toContain(`- textbox "Card number" [ref=e6]: ${HIDDEN_VALUE}`);
    expect(masked).toContain(`- text: ${HIDDEN_VALUE}`);
    expect(masked).not.toContain('4111');
    expect(masked).not.toContain('5500');
  });

  test('hides a short code a field named for one holds, quoted as YAML quotes a number', () => {
    expect(masked).toContain(`- textbox "Code" [ref=e8]: ${HIDDEN_VALUE}`);
    expect(masked).toContain(`- textbox "Verification code" [ref=e9]: ${HIDDEN_VALUE}`);
    expect(masked).not.toContain('123456');
    expect(masked).not.toContain('987654');
  });

  test('keeps every other value, name and node as Playwright wrote it', () => {
    expect(masked).toContain('- textbox "Name" [ref=e12]: Ada');
    expect(masked).toContain('- textbox "Promo code" [ref=e13]: SUMMER');
    expect(masked).toContain('- textbox "Search" [ref=e14]: shoes');
    expect(masked).toContain('    - option "France" [selected]');
    expect(masked).toContain('- checkbox "Agree" [checked] [ref=e16]');
    expect(masked.split('\n')).toHaveLength(PAYMENT_FORM.split('\n').length);
  });

  test('hides a value the page’s secret fields hold now, whatever the field is named, and a long one anywhere', () => {
    const snapshot =
      '- textbox "Enter it": hunter2\n- paragraph: You typed correct horse battery\n- textbox "Other": 42';
    const hidden = maskAriaSnapshot(snapshot, { secrets: ['hunter2', 'correct horse battery'] });
    expect(hidden).toBe(
      `- textbox "Enter it": ${HIDDEN_VALUE}\n- paragraph: You typed ${HIDDEN_VALUE}\n- textbox "Other": 42`,
    );
  });

  test('hides what a project’s masked element shows, by its label or its role and name, and all inside it', () => {
    const snapshot = [
      '- textbox "IBAN": DE89370400440532013000',
      '- region "Balance":',
      '  - heading "Your balance" [level=2]',
      '  - text: 1,234.00 EUR',
      '  - link "Statement":',
      '    - /url: /statements/77',
      '- textbox "Name": Ada',
    ].join('\n');
    const hidden = maskAriaSnapshot(snapshot, {
      masks: ["getByLabel('IBAN')", "getByRole('region', { name: 'Balance' })"],
    });
    expect(hidden.split('\n')).toEqual([
      `- textbox "IBAN": ${HIDDEN_VALUE}`,
      '- region "Balance":',
      `  - heading "${HIDDEN_VALUE}" [level=2]`,
      `  - text: ${HIDDEN_VALUE}`,
      `  - link "${HIDDEN_VALUE}":`,
      `    - /url: ${HIDDEN_VALUE}`,
      '- textbox "Name": Ada',
    ]);
  });

  test('matches a mask’s name as Playwright does: anywhere in any case, whole and in case when exact', () => {
    expect(maskAriaSnapshot('- textbox "Your iban here": X1', { masks: ["getByLabel('IBAN')"] })).toContain(
      HIDDEN_VALUE,
    );
    expect(
      maskAriaSnapshot('- textbox "Your iban here": X1', { masks: ["getByLabel('IBAN', { exact: true })"] }),
    ).not.toContain(HIDDEN_VALUE);
    expect(maskAriaSnapshot('- textbox "Account 7": X1', { masks: ['getByPlaceholder(/account \\d/i)'] })).toContain(
      HIDDEN_VALUE,
    );
  });

  test('says why a mask cannot be found in the page’s text, and finds those named by their accessible name', () => {
    expect(ariaMaskProblem("getByLabel('IBAN')")).toBeNull();
    expect(ariaMaskProblem("getByRole('textbox', { name: 'IBAN' })")).toBeNull();
    expect(ariaMaskProblem("getByPlaceholder('Card')")).toBeNull();
    expect(ariaMaskProblem("locator('#iban')")).toMatch(/accessible name/);
    expect(ariaMaskProblem("getByTestId('balance')")).toMatch(/accessible name/);
    expect(ariaMaskProblem("getByRole('textbox')")).toMatch(/accessible name/);
  });

  test('reads the names of secret fields and the shapes of card numbers', () => {
    for (const name of [
      'Password',
      'PIN',
      'Code',
      'One-time code',
      'CVC',
      'Card number',
      'Credit card no',
      'Mot de passe',
    ]) {
      expect(isSecretFieldName(name), name).toBe(true);
    }
    for (const name of ['Name', 'Email', 'Search', 'Promo code', 'Card holder', '']) {
      expect(isSecretFieldName(name), name).toBe(false);
    }
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('4111-1111-1111-1111')).toBe(true);
    expect(looksLikeCardNumber('4111 1111 1111 1112')).toBe(false);
    expect(looksLikeCardNumber('123456')).toBe(false);
  });
});

describe('the trace’s ARIA tree as text', () => {
  test('writes the trace’s nodes in Playwright’s text form, which the masker then reads', () => {
    const tree = [
      { role: 'heading', name: 'Pay', level: 2, box: { x: 8, y: 8, width: 100, height: 27 } },
      { role: 'list', children: [{ role: 'listitem', text: 'One' }] },
      { role: 'text', text: 'Password' },
      { role: 'textbox', name: 'Password', text: 'S3cr3t!Pw' },
      { role: 'textbox', name: 'Code', text: '123456' },
      { role: 'checkbox', name: 'Agree', checked: true },
      { role: 'combobox', name: 'Country', children: [{ role: 'option', name: 'France', selected: true }] },
      { role: 'link', name: 'Link', url: '/x' },
    ];
    const rendered = ariaTreeText(tree);
    expect(rendered).toEqual({
      text: [
        '- heading "Pay" [level=2]',
        '- list:',
        '  - listitem: One',
        '- text: Password',
        '- textbox "Password": S3cr3t!Pw',
        '- textbox "Code": "123456"',
        '- checkbox "Agree" [checked]',
        '- combobox "Country":',
        '  - option "France" [selected]',
        '- link "Link":',
        '  - /url: /x',
      ].join('\n'),
      cut: false,
    });
    const hidden = maskAriaSnapshot(rendered!.text);
    expect(hidden).not.toContain('S3cr3t!Pw');
    expect(hidden).not.toContain('123456');
  });

  test('stops at its length and says it cut, and reads nothing but a list', () => {
    const tree = Array.from({ length: 100 }, (_, i) => ({ role: 'listitem', text: `Item ${i}` }));
    const rendered = ariaTreeText(tree, 200)!;
    expect(rendered.cut).toBe(true);
    expect(rendered.text.length).toBeLessThanOrEqual(200);
    expect(ariaTreeText({ role: 'list' })).toBeNull();
  });
});

describe('the layers’ readers', () => {
  test('reads the layers a message lists, those it knows, each once', () => {
    expect(readLaneLayers(['text', 'calls', 'calls', 'video'])).toEqual(['calls', 'text']);
    expect(readLaneLayers('calls')).toBeNull();
    expect(readLaneLayers(Array.from({ length: 17 }, () => 'calls'))).toEqual([]);
    expect(LANE_LAYERS).toEqual(['calls', 'events', 'text', 'filmstrip']);
  });

  test('reads each page event field by field, its credentials hidden again and its texts cut', () => {
    expect(readPageEvent({ kind: 'console', text: 'x'.repeat(5000) })).toEqual({
      kind: 'console',
      text: 'x'.repeat(MAX_PAGE_EVENT_TEXT),
    });
    expect(
      readPageEvent({
        kind: 'request-pending',
        id: 3,
        method: 'post',
        url: 'https://shop.test/api/checkout?token=abc123def456',
        ms: 17_000,
        done: false,
      }),
    ).toEqual({
      kind: 'request-pending',
      id: 3,
      method: 'POST',
      url: 'https://shop.test/api/checkout?token=<hidden>',
      ms: 17_000,
      done: false,
    });
    expect(
      readPageEvent({
        kind: 'backend',
        method: 'POST',
        url: '/api/save',
        status: 500,
        level: 'error',
        text: 'NullReferenceException at Save()',
      }),
    ).toMatchObject({ kind: 'backend', status: 500, level: 'error' });
    expect(
      readPageEvent({ kind: 'api', method: 'GET', url: '/api/items', status: null, ms: 12, failure: 'ECONNREFUSED' }),
    ).toMatchObject({
      kind: 'api',
      status: null,
      failure: 'ECONNREFUSED',
    });
    expect(
      readPageEvent({ kind: 'request-failed', method: 'GET', url: 'a\nb', status: null, failure: null }),
    ).toBeNull();
    expect(
      readPageEvent({ kind: 'backend', method: 'GET', url: '/x', status: 500, level: 'info', text: 'x' }),
    ).toBeNull();
    expect(readPageEvent({ kind: 'request-pending', id: 0, method: 'GET', url: '/x', ms: 1, done: false })).toBeNull();
    expect(readPageEvent({ kind: 'navigation', url: '/x' })).toBeNull();
  });

  test('reads a page’s text, masks it again from what it shows, and cuts it at its bound', () => {
    const text = readLaneText({ call: 'pw:api@12', source: 'trace', text: PAYMENT_FORM, cut: false, at: AT })!;
    expect(text.text).not.toContain('S3cr3t!Pw');
    expect(text.text).not.toContain('4111');
    expect(text).toMatchObject({ call: 'pw:api@12', source: 'trace', cut: false, at: AT });
    const long = readLaneText({
      call: null,
      source: 'snapshot',
      text: `- text: ${'a'.repeat(MAX_LANE_TEXT)}`,
      cut: false,
      at: AT,
    })!;
    expect(long.cut).toBe(true);
    expect(long.text.length).toBe(MAX_LANE_TEXT);
    expect(readLaneText({ call: 'a b', source: 'trace', text: 'x', cut: false, at: AT })).toBeNull();
    expect(readLaneText({ call: null, source: 'video', text: 'x', cut: false, at: AT })).toBeNull();
  });

  test('reads an image of a filmstrip, its title’s typed text hidden, and its JPEG within its bound', () => {
    expect(
      readLaneThumb({
        call: 'pw:api@4',
        title: 'Fill "S3cr3t" getByLabel(\'Password\')',
        index: 2,
        width: 320,
        height: 200,
        at: AT,
      }),
    ).toEqual({
      call: 'pw:api@4',
      title: 'Fill "<hidden>" getByLabel(\'Password\')',
      index: 2,
      width: 320,
      height: 200,
      at: AT,
    });
    expect(readLaneThumb({ call: 'pw:api@4', title: 'Click', index: 0, width: 320, height: 200, at: AT })).toBeNull();
    expect(isLaneThumbData(JPEG_BASE64)).toBe(true);
    expect(isLaneThumbData(Buffer.from('not a jpeg').toString('base64'))).toBe(false);
    expect(isLaneThumbBytes(JPEG)).toBe(true);
    expect(isLaneThumbBytes(new Uint8Array(MAX_LANE_THUMB + 1).fill(0xff))).toBe(false);
  });
});

describe('the layers on the run channel', () => {
  test('a worker says it sends them, and reads the layers and the text it is asked', () => {
    expect(RUN_FEATURES).toContain('layers');
    expect(parseHubToRun(JSON.stringify({ type: 'layers', layers: ['events', 'filmstrip', 'nope'] }))).toEqual({
      type: 'layers',
      layers: ['events', 'filmstrip'],
    });
    expect(parseHubToRun(JSON.stringify({ type: 'layers', layers: 'events' }))).toBeNull();
    expect(parseHubToRun(JSON.stringify({ type: 'request', request: 4, what: 'text' }))).toEqual({
      type: 'request',
      request: 4,
      what: 'text',
    });
  });

  test('the hub reads each layer a worker sends, checked as its reader checks it', () => {
    const log = {
      id: 'pw:api@9',
      call: { title: "Click getByRole('button')", file: 'tests/a.spec.ts', line: 4 },
      status: 'running',
      lines: ["waiting for getByRole('button')"],
      point: null,
      target: { count: 0, box: null, enabled: null },
      viewport: { width: 1280, height: 720 },
      ms: 3200,
      error: null,
    };
    expect(parseRunToHub(JSON.stringify({ type: 'lane-layer', test: 't1', layer: 'calls', log }))).toMatchObject({
      type: 'lane-layer',
      test: 't1',
      layer: 'calls',
      log: { id: 'pw:api@9', status: 'running', target: { count: 0 } },
    });
    expect(
      parseRunToHub(
        JSON.stringify({
          type: 'lane-layer',
          test: 't1',
          layer: 'events',
          event: { kind: 'page-error', text: 'boom' },
          at: AT,
        }),
      ),
    ).toEqual({ type: 'lane-layer', test: 't1', layer: 'events', event: { kind: 'page-error', text: 'boom' }, at: AT });
    expect(
      parseRunToHub(JSON.stringify({ type: 'lane-layer', test: null, layer: 'text', refused: 'No page shows.' })),
    ).toEqual({ type: 'lane-layer', test: null, layer: 'text', refused: 'No page shows.' });
    const thumb = { call: 'pw:api@9', title: 'Click', index: 1, width: 8, height: 8, at: AT };
    expect(
      parseRunToHub(JSON.stringify({ type: 'lane-layer', test: 't1', layer: 'filmstrip', thumb, data: JPEG_BASE64 })),
    ).toEqual({ type: 'lane-layer', test: 't1', layer: 'filmstrip', thumb, data: JPEG_BASE64 });
    expect(
      parseRunToHub(JSON.stringify({ type: 'lane-layer', test: 't1', layer: 'filmstrip', thumb, data: 'aGVsbG8=' })),
    ).toBeNull();
    expect(parseRunToHub(JSON.stringify({ type: 'lane-layer', test: 't1', layer: 'video' }))).toBeNull();
    expect(
      parseRunToHub(
        JSON.stringify({ type: 'answer', request: 4, what: 'text', value: { ok: true, message: 'On its way.' } }),
      ),
    ).toEqual({
      type: 'answer',
      request: 4,
      what: 'text',
      value: { ok: true, message: 'On its way.' },
    });
  });
});

describe('the layers on the hub', () => {
  test('a watch names the layers it takes, and a hub says it sends them', () => {
    expect(HUB_FEATURES).toContain('layers');
    expect(
      parseHubCommand(
        JSON.stringify({ type: 'watch', id: 2, ref: 'ed-1', lane: 0, on: true, layers: ['text', 'calls'] }),
      ),
    ).toEqual({
      type: 'watch',
      id: 2,
      ref: 'ed-1',
      lane: 0,
      on: true,
      layers: ['calls', 'text'],
    });
    expect(parseHubCommand(JSON.stringify({ type: 'watch', id: 2, ref: 'ed-1', lane: 0, on: true }))).toEqual({
      type: 'watch',
      id: 2,
      ref: 'ed-1',
      lane: 0,
      on: true,
    });
    expect(
      parseHubCommand(JSON.stringify({ type: 'watch', id: 2, ref: 'ed-1', lane: 0, on: true, layers: 'text' })),
    ).toMatchObject({
      type: 'invalid',
    });
  });

  test('a client reads a lane’s layer as the hub sends it', () => {
    const event = { kind: 'request-pending', id: 1, method: 'POST', url: '/api/checkout', ms: 17_000, done: false };
    expect(
      parseHubMessage(
        JSON.stringify({
          type: 'lane-layer',
          ref: 'ed-1',
          lane: 1,
          worker: 3,
          test: 't1',
          layer: 'events',
          event,
          at: AT,
        }),
      ),
    ).toEqual({ type: 'lane-layer', ref: 'ed-1', lane: 1, worker: 3, test: 't1', layer: 'events', event, at: AT });
    expect(
      parseHubMessage(
        JSON.stringify({
          type: 'lane-layer',
          ref: 'ed-1',
          lane: -1,
          worker: 3,
          test: 't1',
          layer: 'events',
          event,
          at: AT,
        }),
      ),
    ).toBeNull();
  });
});

describe('the layers on the live view', () => {
  const id = { shard: null, worker: 2, slot: 1 };

  test('a worker hears the layers its full views ask, never the call log apart from `full`, and asks for the text', () => {
    expect(
      parseInstanceToWorker(
        JSON.stringify({
          type: 'view',
          width: 640,
          height: 400,
          fps: 4,
          full: true,
          layers: ['calls', 'events', 'text'],
        }),
      ),
    ).toEqual({
      type: 'view',
      width: 640,
      height: 400,
      fps: 4,
      full: true,
      layers: ['events', 'text'],
    });
    expect(
      parseInstanceToWorker(JSON.stringify({ type: 'view', width: 640, height: 400, fps: 4, full: true })),
    ).toMatchObject({
      layers: [],
    });
    expect(parseInstanceToWorker(JSON.stringify({ type: 'text' }))).toEqual({ type: 'text' });
  });

  test('the instance reads a page event and a text as a worker posts them', () => {
    const event = { kind: 'console', text: 'TypeError: x is undefined' };
    expect(readWorkerToInstance({ type: 'page-event', ...id, event, at: AT, test: 'checkout' })).toEqual({
      type: 'page-event',
      ...id,
      event,
      at: AT,
      test: 'checkout',
    });
    const text = { call: null, source: 'snapshot', text: '- textbox "Password": hunter22', cut: false, at: AT };
    expect(readWorkerToInstance({ type: 'text', ...id, text, test: 'checkout' })).toEqual({
      type: 'text',
      ...id,
      text: { ...text, text: `- textbox "Password": ${HIDDEN_VALUE}` },
      test: 'checkout',
    });
    expect(readWorkerToInstance({ type: 'page-event', ...id, event: { kind: 'nope' }, at: AT })).toMatch(/page event/);
  });

  test('an image of the filmstrip goes as a live message, and the viewer reads it back with its bytes', () => {
    const thumb = { call: 'pw:api@4', title: 'Click', index: 1, width: 8, height: 8, at: AT };
    const posted = readLiveWorkerPost({ header: liveThumbHeader(id, thumb, 'checkout'), data: JPEG });
    expect(posted).toEqual({ type: 'thumb', ...id, thumb, image: JPEG, test: 'checkout' });
    expect(
      readLiveWorkerPost({ header: liveThumbHeader(id, thumb, null), data: new Uint8Array([1, 2, 3, 4]) }),
    ).toMatch(/JPEG/);
    const bytes = encodeLiveViewerMessage({ type: 'thumb', ...id, thumb, image: JPEG, test: 'checkout' });
    const [message] = createLiveMessageReader({ maxData: MAX_LIVE_FRAME })(bytes);
    expect(readLiveViewerMessage(message!)).toEqual({ type: 'thumb', ...id, thumb, image: JPEG, test: 'checkout' });
    const event = { kind: 'page-error', text: 'boom' };
    const read = readLiveViewerMessage({
      header: { type: 'page-event', ...id, event, at: AT, test: null },
      data: null,
    });
    expect(read).toEqual({ type: 'page-event', ...id, event, at: AT, test: null });
    expect(
      readLiveWorkerPost({ header: { type: 'frame', ...id, call: null, test: null }, data: encodeLiveMessage({}) }),
    ).toMatch(/JPEG/);
  });
});
