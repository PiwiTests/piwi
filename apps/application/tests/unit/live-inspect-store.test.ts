import { describe, expect, test } from 'vitest';
import type { LiveSnapshot, SnapshotPhase } from '@piwitests/core/live-inspect';
import {
  MAX_RUN_RESOURCES,
  MAX_RUN_SNAPSHOTS,
  MAX_WORKER_SNAPSHOTS,
  RunInspect,
  SNAPSHOT_GONE,
  SNAPSHOT_MASKED_GONE,
  SNAPSHOT_MISSING,
  SNAPSHOT_TEST_ENDED,
  SNAPSHOT_TOO_LARGE,
  SNAPSHOT_UNREADABLE,
  SNAPSHOT_UNSENT,
  INSTANCE_INSPECT_WORDS,
  InspectBudget,
  MAX_RUN_RESOURCE_COUNT,
  MAX_RUN_SNAPSHOT_COUNT,
  MAX_WORKER_SNAPSHOT_COUNT,
} from '../../server/utils/live-inspect';

/**
 * What the live view keeps for Inspect, for one run: each worker's snapshots of its pages' main frames, read as chains
 * from their last full one, the same one kept once and a full one starting its frame's chain again; the resources they
 * name; each within its bound, the oldest snapshots and the least recently used resources going first; and a page
 * rendered as the stored trace's snapshot view renders one, sanitized, its resources inlined, or refused (404 for a
 * moment never sent, 410 for one, or one it refers to, let go).
 */

const PAGE = 'page@1';
const FRAME = 'frame@1';
const AT = Date.now();

/** A snapshot of the main frame of `PAGE`, its JSON the `html` given, taken at 1280 by 800 on `https://shop.test/`. */
function snapshot(
  call: string,
  phase: SnapshotPhase,
  html: unknown,
  options: Partial<LiveSnapshot> & { test?: string | null } = {},
): LiveSnapshot & { data: Uint8Array; test: string | null } {
  const json = {
    callId: call,
    phase,
    frameId: options.frame ?? FRAME,
    pageId: PAGE,
    frameUrl: 'https://shop.test/checkout',
    html,
    viewport: { width: 1280, height: 800 },
    isMainFrame: options.main ?? true,
  };
  return {
    call,
    title: `Click ${call}`,
    phase,
    page: PAGE,
    frame: FRAME,
    main: true,
    full: true,
    index: 0,
    at: AT,
    resources: [],
    test: 'pays',
    ...options,
    data: new TextEncoder().encode(JSON.stringify(json)),
  };
}

/** A snapshot whose JSON holds `bytes` characters of text, for the bounds. */
function heavy(call: string, bytes: number): LiveSnapshot & { data: Uint8Array; test: string | null } {
  return snapshot(call, 'after', ['HTML', {}, ['BODY', {}, 'x'.repeat(bytes)]]);
}

const MB = 1024 * 1024;

describe('Inspect’s store of a run', () => {
  test('renders a page from its chain, each later snapshot referring to the nodes of the ones before', async () => {
    const store = new RunInspect();
    const first = ['HTML', {}, ['HEAD', {}], ['BODY', {}, ['H1', {}, 'Checkout'], ['P', {}, 'Paying…']]];
    expect(store.addSnapshot('w', snapshot('call@1', 'before', first))).toBe('kept');
    // The head and the heading as they were; the paragraph changed.
    const later = ['HTML', {}, [[1, 0]], ['BODY', {}, [[1, 2]], ['P', {}, 'Paid']]];
    expect(store.addSnapshot('w', snapshot('call@1', 'after', later, { full: false, index: 1 }))).toBe('kept');
    const page = await store.render('w', 'call@1', 'after');
    expect(page).toEqual({
      html: '<html><head></head><body><h1>Checkout</h1><p>Paid</p></body></html>',
      viewport: { width: 1280, height: 800 },
    });
    expect(store.viewport('w', 'call@1', 'after')).toEqual({ width: 1280, height: 800 });
    expect(store.heard('w').map((s) => `${s.phase}@${s.call}`)).toEqual(['before@call@1', 'after@call@1']);
  });

  test('renders no script, no inline handler and no script URL the snapshot holds', async () => {
    const store = new RunInspect();
    const html = [
      'HTML',
      {},
      [
        'BODY',
        { onload: 'steal()' },
        ['SCRIPT', { src: 'https://evil.test/x.js' }, 'document.cookie'],
        ['svg', {}, ['script', {}, 'parent.postMessage(1, "*")']],
        ['A', { href: 'javascript:steal()', onclick: 'steal()' }, 'Pay'],
        ['IMG', { src: 'x.png', onerror: 'steal()' }],
      ],
    ];
    store.addSnapshot('w', snapshot('call@1', 'action', html));
    const page = await store.render('w', 'call@1', 'action');
    if ('status' in page) throw new Error(page.message);
    expect(page.html).not.toMatch(/steal|document\.cookie|postMessage|evil\.test|javascript:/);
    expect(page.html).toContain('<a>Pay</a>');
  });

  test('inlines the stylesheets, fonts and images it holds, by the addresses the chain names', async () => {
    const store = new RunInspect();
    const css = '.logo{background:url(/img/logo.png)}@font-face{font-family:F;src:url(f.woff2)}';
    store.addResource({ sha1: `${'a'.repeat(40)}.css`, contentType: 'text/css', data: Buffer.from(css) });
    store.addResource({ sha1: `${'b'.repeat(40)}.png`, contentType: 'image/png', data: Buffer.from('PNG') });
    store.addResource({ sha1: `${'c'.repeat(40)}.woff2`, contentType: 'font/woff2', data: Buffer.from('WOFF') });
    const head = ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: '/app.css' }]];
    store.addSnapshot(
      'w',
      snapshot('call@1', 'before', ['HTML', {}, head, ['BODY', {}, ['IMG', { src: '/img/logo.png' }]]], {
        resources: [
          { url: 'https://shop.test/app.css', sha1: `${'a'.repeat(40)}.css` },
          { url: 'https://shop.test/img/logo.png', sha1: `${'b'.repeat(40)}.png` },
        ],
      }),
    );
    // A later snapshot names the font; the earlier ones' addresses hold for it.
    store.addSnapshot(
      'w',
      snapshot('call@1', 'after', ['HTML', {}, [[1, 1]], [[1, 3]]], {
        full: false,
        index: 1,
        resources: [{ url: 'https://shop.test/f.woff2', sha1: `${'c'.repeat(40)}.woff2` }],
      }),
    );
    const page = await store.render('w', 'call@1', 'after');
    if ('status' in page) throw new Error(page.message);
    expect(page.html).not.toContain('<link');
    expect(page.html).toContain(`url("data:image/png;base64,${Buffer.from('PNG').toString('base64')}")`);
    expect(page.html).toContain(`url("data:font/woff2;base64,${Buffer.from('WOFF').toString('base64')}")`);
    expect(page.html).toContain(`<img src="data:image/png;base64,${Buffer.from('PNG').toString('base64')}">`);
  });

  test('finds a resource by its address as the worker names it: no fragment, a hidden token written as an address', async () => {
    const store = new RunInspect();
    const sha1 = (c: string, ext: string) => `${c.repeat(40)}.${ext}`;
    const css =
      '@font-face{font-family:Old;src:url(old.eot?#iefix) format("embedded-opentype")}.i{background:url(i.svg#a)}';
    store.addResource({ sha1: sha1('a', 'css'), contentType: 'text/css', data: Buffer.from(css) });
    store.addResource({
      sha1: sha1('b', 'eot'),
      contentType: 'application/vnd.ms-fontobject',
      data: Buffer.from('EOT'),
    });
    store.addResource({ sha1: sha1('c', 'svg'), contentType: 'image/svg+xml', data: Buffer.from('<svg/>') });
    // The worker hid the stylesheet's token in its link, and names it by the address a browser reads that as.
    const head = ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: '/app.css?token=<hidden>' }]];
    store.addSnapshot(
      'w',
      snapshot('call@1', 'before', ['HTML', {}, head, ['BODY', {}]], {
        resources: [
          { url: 'https://shop.test/app.css?token=%3Chidden%3E', sha1: sha1('a', 'css') },
          { url: 'https://shop.test/old.eot?', sha1: sha1('b', 'eot') },
          { url: 'https://shop.test/i.svg', sha1: sha1('c', 'svg') },
        ],
      }),
    );
    const page = await store.render('w', 'call@1', 'before');
    if ('status' in page) throw new Error(page.message);
    expect(page.html).toContain('font-family:Old');
    expect(page.html).toContain(
      `url("data:application/vnd.ms-fontobject;base64,${Buffer.from('EOT').toString('base64')}")`,
    );
    // An SVG addressed by a fragment is not inlined: a data: address cannot name the element it shows.
    expect(page.html).not.toContain('image/svg+xml');
  });

  test('refuses a page it cannot read whole, saying so', async () => {
    const store = new RunInspect();
    let deep: unknown = 'x';
    for (let i = 0; i < 600; i++) deep = ['DIV', {}, deep];
    store.addSnapshot('w', snapshot('call@1', 'after', ['HTML', {}, ['BODY', {}, deep]]));
    expect(await store.render('w', 'call@1', 'after')).toEqual({ status: 410, message: SNAPSHOT_UNREADABLE });
  });

  test('masks what a stored trace’s page masks: a token in its text and its attributes, a secret in its stylesheet', async () => {
    const store = new RunInspect();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqbyJ9.c2lnbmF0dXJlLXNlY3JldA';
    const hex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    store.addResource({
      sha1: `${'e'.repeat(40)}.css`,
      contentType: 'text/css',
      data: Buffer.from(`.k{--token:"${hex}"}`),
    });
    const html = [
      'HTML',
      {},
      ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: '/k.css' }]],
      ['BODY', { 'data-session': hex }, ['P', {}, `Bearer ${jwt}`], ['INPUT', { type: 'password', value: 'hunter2' }]],
    ];
    store.addSnapshot(
      'w',
      snapshot('call@1', 'after', html, {
        resources: [{ url: 'https://shop.test/k.css', sha1: `${'e'.repeat(40)}.css` }],
      }),
    );
    const page = await store.render('w', 'call@1', 'after');
    if ('status' in page) throw new Error(page.message);
    expect(page.html).not.toContain(jwt);
    expect(page.html).not.toContain(hex);
    expect(page.html).not.toContain('hunter2');
    expect(page.html).toContain('--token:"[masked-hex]"');
  });

  test('marks the action’s target as the trace names it, by its call’s id where an older Playwright does', async () => {
    const store = new RunInspect();
    // Playwright 1.59 writes `snapshotName` with no phase, and the target's mark holds the call's id.
    const html = [
      'HTML',
      {},
      ['BODY', {}, ['BUTTON', { __playwright_target__: 'call@8' }, 'Pay'], ['A', { __playwright_target__: 'call@2' }]],
    ];
    const old = snapshot('call@8', 'action', html);
    const json = JSON.parse(new TextDecoder().decode(old.data)) as Record<string, unknown>;
    delete json.phase;
    delete json.callId;
    json.snapshotName = 'input@call@8';
    store.addSnapshot('w', { ...old, data: new TextEncoder().encode(JSON.stringify(json)) });
    const page = await store.render('w', 'call@8', 'action');
    if ('status' in page) throw new Error(page.message);
    expect(page.html).toBe('<html><body><button data-piwi-target="">Pay</button><a></a></body></html>');
  });

  test('keeps a page’s main frame alone, and the same moment once', () => {
    const store = new RunInspect();
    const html = ['HTML', {}];
    expect(store.addSnapshot('w', snapshot('call@1', 'before', html, { main: false, frame: 'frame@2' }))).toBe(
      'ignored',
    );
    expect(store.addSnapshot('w', snapshot('call@1', 'before', html))).toBe('kept');
    expect(store.addSnapshot('w', snapshot('call@1', 'before', html))).toBe('held');
    expect(store.heard('w')).toHaveLength(1);
    expect(store.heard('w')[0]).toMatchObject({ call: 'call@1', title: 'Click call@1', phase: 'before', test: 'pays' });
  });

  test('a full snapshot it did not hold starts its frame’s chain again, past a chain whose start was let go', async () => {
    const store = new RunInspect();
    // A chain whose full snapshot went with the worker's bound: its later snapshots no longer render.
    store.addSnapshot('w', heavy('call@1', MAX_WORKER_SNAPSHOTS - 1024));
    store.addSnapshot('w', snapshot('call@2', 'before', ['HTML', {}, [[1, 0]]], { full: false, index: 1 }));
    const tail = ['HTML', {}, ['BODY', {}, 'x'.repeat(4096)]];
    store.addSnapshot('w', snapshot('call@3', 'before', tail, { full: false, index: 2 }));
    expect(await store.render('w', 'call@1', 'after')).toEqual({ status: 410, message: SNAPSHOT_GONE });
    expect(await store.render('w', 'call@2', 'before')).toEqual({ status: 410, message: SNAPSHOT_GONE });
    // The worker sends the chain again from its full snapshot as Inspect opens: what was left of it goes.
    store.addSnapshot('w', snapshot('call@1', 'after', ['HTML', {}, ['BODY', {}, 'Cart']]));
    store.addSnapshot('w', snapshot('call@2', 'before', ['HTML', {}, [[1, 1]]], { full: false, index: 1 }));
    expect(store.heard('w').map((s) => s.call)).toEqual(['call@1', 'call@2']);
    expect(await store.render('w', 'call@2', 'before')).toMatchObject({ html: '<html><body>Cart</body></html>' });
    // A page's next navigation: the earlier chain stays, and renders.
    store.addSnapshot('w', snapshot('call@4', 'before', ['HTML', {}, ['BODY', {}, 'Paid']]));
    expect(await store.render('w', 'call@2', 'before')).toMatchObject({ html: '<html><body>Cart</body></html>' });
    expect(await store.render('w', 'call@4', 'before')).toMatchObject({ html: '<html><body>Paid</body></html>' });
  });

  test('renders no snapshot whose chain lacks one it refers to: a gap the worker left shows by its place', async () => {
    const store = new RunInspect();
    store.addSnapshot('w', snapshot('call@1', 'before', ['HTML', {}, ['BODY', {}, 'Cart']]));
    // The snapshot at place 1 never came: one at place 2 that names it does not render, one that names place 0 does.
    store.addSnapshot('w', snapshot('call@2', 'before', ['HTML', {}, [[1, 1]]], { full: false, index: 2 }));
    store.addSnapshot('w', snapshot('call@3', 'before', ['HTML', {}, [[3, 1]]], { full: false, index: 3 }));
    expect(await store.render('w', 'call@2', 'before')).toEqual({ status: 410, message: SNAPSHOT_UNSENT });
    expect(await store.render('w', 'call@3', 'before')).toMatchObject({ html: '<html><body>Cart</body></html>' });
  });

  test('refuses a page that costs more to render than a render may, in a bounded time', async () => {
    const store = new RunInspect();
    store.addSnapshot('w', snapshot('call@0', 'after', ['HTML', {}, 'x']));
    // Each snapshot's two children are the whole of the snapshot before it.
    for (let k = 1; k <= 40; k++) {
      const root = k === 1 ? 1 : 0;
      store.addSnapshot(
        'w',
        snapshot(`call@${k}`, 'after', ['B', {}, [[1, root]], [[1, root]]], { full: false, index: k }),
      );
    }
    const started = performance.now();
    expect(await store.render('w', 'call@40', 'after')).toEqual({ status: 410, message: SNAPSHOT_TOO_LARGE });
    expect(performance.now() - started).toBeLessThan(4000);
  });

  test('hides again the value of a field that holds a secret, and a card’s number, whatever the worker sent', async () => {
    const store = new RunInspect();
    const html = [
      'HTML',
      {},
      [
        'BODY',
        {},
        ['INPUT', { name: 'cvc', __playwright_value_: '123' }],
        ['INPUT', { autocomplete: 'one-time-code', value: '884213' }],
        ['P', {}, '4242 4242 4242 4242'],
      ],
    ];
    store.addSnapshot('w', snapshot('call@1', 'after', html));
    const page = await store.render('w', 'call@1', 'after');
    if ('status' in page) throw new Error(page.message);
    expect(page.html).not.toMatch(/123|884213|4242/);
  });

  test('keeps a worker’s latest snapshots within its bound, and the run’s within the run’s', async () => {
    const store = new RunInspect();
    const each = 10 * MB;
    for (let i = 1; i <= 4; i++) store.addSnapshot('w', heavy(`call@${i}`, each));
    expect(store.heard('w').map((s) => s.call)).toEqual(['call@2', 'call@3', 'call@4']);
    expect(await store.render('w', 'call@1', 'after')).toEqual({ status: 410, message: SNAPSHOT_GONE });
    expect(await store.render('w', 'call@9', 'after')).toEqual({ status: 404, message: SNAPSHOT_MISSING });
    expect(await store.render('other', 'call@1', 'after')).toEqual({ status: 404, message: SNAPSHOT_MISSING });
    // Other workers fill the run's bound: the run's oldest go first, whichever worker's they are.
    const workers = Math.ceil(MAX_RUN_SNAPSHOTS / (3 * each));
    for (let w = 1; w <= workers; w++) {
      for (let i = 1; i <= 3; i++) store.addSnapshot(`w${w}`, heavy(`call@${i}`, each));
    }
    expect(store.size().snapshots).toBeLessThanOrEqual(MAX_RUN_SNAPSHOTS);
    expect(store.heard('w')).toEqual([]);
    expect(store.heard(`w${workers}`)).toHaveLength(3);
  });

  test('keeps the run’s resources within its bound, the least recently used going first', () => {
    const store = new RunInspect();
    const size = 20 * MB;
    const sha1 = (c: string) => `${c.repeat(40)}.png`;
    const add = (c: string) =>
      store.addResource({ sha1: sha1(c), contentType: 'image/png', data: new Uint8Array(size).fill(1) });
    add('a');
    add('b');
    add('c');
    // A render reads the first again: the second is the least recently used.
    expect(store.resource(sha1('a'))).not.toBeNull();
    add('d');
    expect(store.size().resources).toBeLessThanOrEqual(MAX_RUN_RESOURCES);
    expect(store.resource(sha1('b'))).toBeNull();
    expect(store.resource(sha1('a'))).not.toBeNull();
    expect(store.resource(sha1('d'))).not.toBeNull();
  });

  test('counts each snapshot’s header too, and keeps a bounded number of snapshots and resources', () => {
    const store = new RunInspect();
    // A small page naming many long addresses: its header outweighs its JSON.
    const resources = Array.from({ length: 30 }, (_, i) => ({
      url: `https://shop.test/${String(i).padStart(4, '0')}${'x'.repeat(2000)}`,
      sha1: `${'a'.repeat(40)}.css`,
    }));
    for (let i = 0; i < 1000; i++) store.addSnapshot('w', snapshot(`call@${i}`, 'after', ['HTML', {}], { resources }));
    expect(store.size().snapshots).toBeLessThanOrEqual(MAX_WORKER_SNAPSHOTS);
    expect(store.size().snapshots).toBeGreaterThan(MAX_WORKER_SNAPSHOTS - 200_000);
    expect(store.heard('w').length).toBeLessThan(300);

    const many = new RunInspect();
    for (let i = 0; i < MAX_WORKER_SNAPSHOT_COUNT + 10; i++) many.addSnapshot('w', snapshot(`call@${i}`, 'after', 'x'));
    expect(many.size().counts.snapshots).toBe(MAX_WORKER_SNAPSHOT_COUNT);
    for (let w = 1; many.size().counts.snapshots < MAX_RUN_SNAPSHOT_COUNT && w < 10; w++) {
      for (let i = 0; i < MAX_WORKER_SNAPSHOT_COUNT; i++)
        many.addSnapshot(`w${w}`, snapshot(`call@${i}`, 'after', 'x'));
    }
    expect(many.size().counts.snapshots).toBe(MAX_RUN_SNAPSHOT_COUNT);
    for (let i = 0; i < MAX_RUN_RESOURCE_COUNT + 10; i++) {
      many.addResource({
        sha1: `${i.toString(16).padStart(40, '0')}.png`,
        contentType: 'image/png',
        data: new Uint8Array(1),
      });
    }
    expect(many.size().counts.resources).toBe(MAX_RUN_RESOURCE_COUNT);
  });

  test('refuses what would take every run’s Inspect past the instance’s budget, and gives a run’s back as it ends', () => {
    const budget = new InspectBudget(4 * MB);
    const [first, second] = [new RunInspect(budget), new RunInspect(budget)];
    expect(first.addSnapshot('w', heavy('call@1', 3 * MB))).toBe('kept');
    expect(second.addSnapshot('w', heavy('call@1', 2 * MB))).toBe('full');
    expect(
      second.addResource({ sha1: `${'b'.repeat(40)}.png`, contentType: 'image/png', data: new Uint8Array(2 * MB) }),
    ).toBe('full');
    first.clear();
    expect(budget.used).toBe(0);
    expect(second.addSnapshot('w', heavy('call@1', 2 * MB))).toBe('kept');
    expect(budget.used).toBe(second.size().snapshots);
  });

  test('adds a snapshot in a constant time, however many it holds', () => {
    const store = new RunInspect();
    const add = (from: number, count: number) => {
      const started = performance.now();
      for (let i = from; i < from + count; i++) store.addSnapshot('w', snapshot(`call@${i}`, 'after', 'x'));
      return performance.now() - started;
    };
    add(0, 10_000);
    // No add scans what the store holds: 20,000 more, the oldest going as they come, take well under a second.
    expect(add(10_000, 20_000)).toBeLessThan(1500);
  });

  test('keeps a page rendered until the worker’s store lets a snapshot go, and answers its viewport from its snapshot alone', async () => {
    const store = new RunInspect();
    /** What a snapshot counts in a store of its own. */
    const sizeOf = (held: ReturnType<typeof snapshot>) => {
      const probe = new RunInspect();
      probe.addSnapshot('w', held);
      return probe.size().snapshots;
    };
    const older = snapshot('call@0', 'before', ['HTML', {}, ['BODY', {}, 'Home']], { frame: 'frame@0' });
    store.addSnapshot('w', older);
    store.addSnapshot('w', snapshot('call@1', 'before', ['HTML', {}, ['BODY', {}, 'Cart']]));
    store.addSnapshot('w', snapshot('call@1', 'after', ['HTML', {}, [[1, 1]]], { full: false, index: 1 }));
    const page = await store.render('w', 'call@1', 'after');
    expect(page).toMatchObject({ html: '<html><body>Cart</body></html>' });
    expect(await store.render('w', 'call@1', 'after')).toBe(page);
    // A later snapshot changes no page before it.
    store.addSnapshot('w', snapshot('call@2', 'before', ['HTML', {}, [[1, 0]]], { full: false, index: 2 }));
    expect(await store.render('w', 'call@1', 'after')).toBe(page);
    // A snapshot that takes the worker past its bound lets the oldest go, another page's: this one renders again.
    const held = store.size().snapshots;
    const bytes = MAX_WORKER_SNAPSHOTS - held + Math.floor(sizeOf(older) / 2) - sizeOf(heavy('call@9', 0));
    store.addSnapshot('w', heavy('call@9', bytes));
    expect(store.heard('w').map((s) => `${s.phase}@${s.call}`)).toEqual([
      'before@call@1',
      'after@call@1',
      'before@call@2',
      'after@call@9',
    ]);
    const again = await store.render('w', 'call@1', 'after');
    expect(again).not.toBe(page);
    expect(again).toEqual(page);

    // The viewport is read from the snapshot's JSON alone, without parsing it whole.
    const parse = JSON.parse;
    let longest = 0;
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      longest = Math.max(longest, text.length);
      return parse(text, reviver);
    }) as typeof JSON.parse;
    try {
      expect(store.viewport('w', 'call@9', 'after')).toEqual({ width: 1280, height: 800 });
    } finally {
      JSON.parse = parse;
    }
    expect(longest).toBeLessThan(1000);
  });

  test('parses no snapshot of a chain that no reference of the page reaches', async () => {
    const store = new RunInspect();
    const long = ['HTML', {}, ['BODY', {}, 'x'.repeat(100_000)]];
    store.addSnapshot('w', snapshot('call@0', 'after', long));
    for (let k = 1; k < 8; k++) {
      store.addSnapshot('w', snapshot(`call@${k}`, 'after', ['HTML', {}, [[1, 1]]], { full: false, index: k }));
    }
    // A page that refers to no snapshot before it parses its own alone; one that refers to the first, those two.
    store.addSnapshot('w', snapshot('call@8', 'after', ['HTML', {}, ['BODY', {}, 'Paid']], { full: false, index: 8 }));
    store.addSnapshot('w', snapshot('call@9', 'after', ['HTML', {}, [[9, 1]]], { full: false, index: 9 }));
    const parse = JSON.parse;
    let parsed = 0;
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      parsed++;
      return parse(text, reviver);
    }) as typeof JSON.parse;
    try {
      expect(await store.render('w', 'call@8', 'after')).toMatchObject({ html: '<html><body>Paid</body></html>' });
      expect(parsed).toBe(1);
      expect(await store.render('w', 'call@9', 'after')).toMatchObject({
        html: `<html><body>${'x'.repeat(100_000)}</body></html>`,
      });
      expect(parsed).toBe(3);
    } finally {
      JSON.parse = parse;
    }
  });

  test('lets a worker’s snapshots go as its test ends, saying why a page of one is gone', async () => {
    const store = new RunInspect();
    store.addSnapshot('w', snapshot('call@1', 'before', ['HTML', {}, ['BODY', {}, 'Cart']]));
    store.addSnapshot('other', snapshot('call@1', 'before', ['HTML', {}, ['BODY', {}, 'Cart']]));
    store.endTest('w');
    expect(store.heard('w')).toEqual([]);
    expect(store.heard('other')).toHaveLength(1);
    expect(await store.render('w', 'call@1', 'before')).toEqual({ status: 410, message: SNAPSHOT_TEST_ENDED });
    // The next test's pages are kept again, of its own chains: one that builds on a page not sent says so.
    store.addSnapshot('w', snapshot('call@4', 'before', ['HTML', {}, [[1, 1]]], { full: false, index: 1 }));
    expect(await store.render('w', 'call@4', 'before')).toEqual({ status: 410, message: SNAPSHOT_UNSENT });
    // A full one starts a chain of its own, the one before it whose start never came going.
    store.addSnapshot('w', snapshot('call@5', 'before', ['HTML', {}, ['BODY', {}, 'Paid']]));
    expect(store.heard('w').map((s) => s.call)).toEqual(['call@5']);
  });

  test('lets every snapshot and resource go as the project starts masking elements', async () => {
    const store = new RunInspect();
    store.addResource({ sha1: `${'b'.repeat(40)}.png`, contentType: 'image/png', data: Buffer.from('PNG') });
    store.addSnapshot('w', snapshot('call@1', 'before', ['HTML', {}, ['BODY', {}, 'Balance: 12,345.67']]));
    store.mask();
    expect(store.heard('w')).toEqual([]);
    expect(store.size()).toMatchObject({ snapshots: 0, resources: 0, pages: 0 });
    expect(await store.render('w', 'call@1', 'before')).toEqual({ status: 410, message: SNAPSHOT_MASKED_GONE });
  });

  test('tells a chain whose start the worker never sent from one the instance let go', async () => {
    const store = new RunInspect();
    // The page's full snapshot never came (over its size, or left out of the backlog): what builds on it says so.
    store.addSnapshot('w', snapshot('call@2', 'before', ['HTML', {}, [[1, 1]]], { full: false, index: 1 }));
    expect(await store.render('w', 'call@2', 'before')).toEqual({ status: 410, message: SNAPSHOT_UNSENT });
    // A chain whose start the instance let go keeps today's sentence.
    const kept = new RunInspect();
    kept.addSnapshot('w', heavy('call@1', MAX_WORKER_SNAPSHOTS - 2048));
    kept.addSnapshot('w', snapshot('call@2', 'before', ['HTML', {}, [[1, 0]]], { full: false, index: 1 }));
    kept.addSnapshot(
      'w',
      snapshot('call@3', 'before', ['HTML', {}, ['BODY', {}, 'x'.repeat(4096)]], { full: false, index: 2 }),
    );
    expect(await kept.render('w', 'call@2', 'before')).toEqual({ status: 410, message: SNAPSHOT_GONE });
  });

  test('says why a page does not show in the words its host gives it, the instance’s by default', async () => {
    expect(INSTANCE_INSPECT_WORDS).toMatchObject({ gone: SNAPSHOT_GONE, missing: SNAPSHOT_MISSING });
    const words = Object.fromEntries(
      Object.keys(INSTANCE_INSPECT_WORDS).map((why) => [why, `The app’s ${why}.`]),
    ) as unknown as typeof INSTANCE_INSPECT_WORDS;
    const store = new RunInspect(new InspectBudget(), words);
    expect(await store.render('w', 'call@9', 'after')).toEqual({ status: 404, message: 'The app’s missing.' });
    store.addSnapshot('w', snapshot('call@2', 'before', ['HTML', {}, [[1, 1]]], { full: false, index: 1 }));
    expect(await store.render('w', 'call@2', 'before')).toEqual({ status: 410, message: 'The app’s unsent.' });
    store.addSnapshot('w', snapshot('call@1', 'before', ['HTML', {}, ['BODY', {}, 'Cart']]));
    store.endTest('w');
    expect(await store.render('w', 'call@1', 'before')).toEqual({ status: 410, message: 'The app’s testEnded.' });
  });
});
