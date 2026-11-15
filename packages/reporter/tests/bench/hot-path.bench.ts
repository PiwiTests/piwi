import { bench, describe } from 'vitest';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { ProbedAttrs } from '@piwitests/picker-dom';
import { piwiFixtures } from '../../src/internal/capture/capture-fixtures.js';
import {
  captureCallerLocation,
  dedupeSnapshotsByLocation,
  generateAlternatives,
  type LocatorSnapshot,
} from '../../src/internal/capture/locator-healing.js';

/**
 * Node-side hot path of the capture fixtures, measured without a browser.
 *
 * The end-to-end benchmark (`run.mjs`) answers "how much slower is my suite",
 * but its numbers are dominated by browser round trips and carry a browser's
 * variance. This one isolates the CPU the fixtures burn in the worker process:
 * the stack capture taken on every action, the Proxy indirection on every
 * locator property access, alternative generation, and the teardown
 * serialization. Those are the parts that scale with test count rather than
 * with page weight.
 *
 * Run with `npm run reporter:bench:micro`.
 */

/** A probe result shaped like a real button deep in a table — the common capture target. */
const PROBED: ProbedAttrs = {
  tagName: 'button',
  attributes: {
    'data-testid': 'open-42',
    id: null,
    name: 'open-42',
    class: 'btn btn-primary',
    placeholder: null,
    alt: null,
    title: null,
    role: null,
    type: 'submit',
    'aria-label': null,
  },
  textContent: 'Open order 42',
  center: { x: 120, y: 480 },
  hasLabel: false,
  labelText: null,
  selectorCounts: {
    testId: 1,
    name: 1,
    classes: { btn: 200, 'btn-primary': 200 },
    roleName: 1,
    text: 1,
  },
  rolePosition: { role: 'button', count: 201, index: 42 },
  ancestors: [
    { tag: 'td', depth: 1, testId: null, id: null, role: 'cell', ariaLabel: null, scopedRoleCount: 1 },
    { tag: 'tr', depth: 2, testId: null, id: null, role: 'row', ariaLabel: null, scopedRoleCount: 1 },
    { tag: 'tbody', depth: 3, testId: null, id: 'rows', role: null, ariaLabel: null, idCount: 1 },
    { tag: 'section', depth: 5, testId: null, id: null, role: 'region', ariaLabel: 'Orders', roleCount: 2 },
  ],
};

const withName = { ...PROBED, accessibleName: 'Open order 42' };

/** A test's worth of snapshots, as `flushSink` sees them before attaching. */
const SNAPSHOTS: LocatorSnapshot[] = Array.from({ length: 40 }, (_, i) => ({
  location: `tests/checkout.spec.ts:${20 + (i % 20)}:15`,
  used: { method: 'getByTestId', args: [`open-${i}`], raw: `getByTestId(["open-${i}"])` },
  element: {
    tagName: 'button',
    attributes: PROBED.attributes,
    textContent: `Open order ${i}`,
    accessibleName: `Open order ${i}`,
    center: PROBED.center,
    rolePosition: PROBED.rolePosition!,
    ancestors: PROBED.ancestors,
  },
  alternatives: generateAlternatives(withName),
}));

/**
 * Drive one instrumented action through the real fixtures, exactly as a test
 * would: the capture fixture opens the sink, the page fixture installs the
 * locator wrappers, and the action goes through the Proxy. The fake page's
 * probe resolves immediately with `PROBED`, so what is left on the clock is the
 * fixtures' own work — never a browser round trip.
 */
function makeInstrumentedRun(actions: number) {
  const locator = {
    click: async () => {},
    evaluate: async () => PROBED,
    ariaSnapshot: async () => '- button "Open order 42"',
  };
  const factory = () => locator;
  const page = {
    getByRole: factory,
    getByTestId: factory,
    getByText: factory,
    getByLabel: factory,
    getByPlaceholder: factory,
    getByAltText: factory,
    getByTitle: factory,
    locator: factory,
    on: () => {},
    evaluate: async () => null,
    isClosed: () => true,
  } as unknown as Page;

  const testInfo = { status: 'passed', attach: async () => {}, annotations: [] } as unknown as TestInfo;

  const pageFixture = piwiFixtures.page as unknown as (
    args: { page: Page },
    use: (page: Page) => Promise<void>,
  ) => Promise<void>;
  const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
    (args: object, use: () => Promise<void>, info: TestInfo) => Promise<void>,
  ];

  return async () => {
    await captureFixture(
      {},
      () =>
        pageFixture({ page }, async (instrumented) => {
          for (let i = 0; i < actions; i++) {
            await (instrumented.getByTestId(`open-${i}`) as unknown as { click: () => Promise<void> }).click();
          }
        }),
      testInfo,
    );
  };
}

/**
 * A stack of the shape `captureCallerLocation` walks, so the parsing half can
 * be measured without paying for a fresh capture.
 */
const SAMPLE_STACK = [
  'Error',
  '    at captureCallerLocation (/app/node_modules/@piwitests/reporter/dist/index.js:1204:20)',
  '    at Object.click (/app/node_modules/@piwitests/reporter/dist/index.js:1388:32)',
  '    at /app/node_modules/@playwright/test/lib/worker.js:88:19',
  '    at Object.<anonymous> (/app/tests/checkout.spec.ts:42:38)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
].join('\n');

describe('per-action synchronous cost', () => {
  bench('captureCallerLocation (once per action and per assertion call site)', () => {
    captureCallerLocation();
  });

  // The two halves of the call above: V8 materializing the stack string, then
  // walking it for the first user frame. Which half dominates decides whether
  // the cost is addressable in this package at all.
  bench('  └ new Error().stack (the capture half)', () => {
    void new Error().stack;
  });

  bench('  └ walking a captured stack (the parse half)', () => {
    captureCallerLocation(SAMPLE_STACK);
  });

  bench('JSON.stringify of the origin args (the snapshot `raw` field)', () => {
    JSON.stringify(['button', { name: 'Open order 42', exact: true }]);
  });
});

describe('per-action asynchronous cost', () => {
  bench('generateAlternatives on a probed button', () => {
    generateAlternatives(withName);
  });
});

describe('whole-test cost', () => {
  const withCapture = makeInstrumentedRun(20);

  bench('20 instrumented actions, sink open, flushed at teardown', async () => {
    await withCapture();
  });

  bench('dedupe + serialize 40 snapshots (the teardown attachment)', () => {
    JSON.stringify(dedupeSnapshotsByLocation(SNAPSHOTS));
  });
});

describe('proxy indirection', () => {
  const raw = { click: async () => {}, evaluate: async () => PROBED } as unknown as Locator;
  const factory = () => raw;
  const page = {
    getByRole: factory,
    getByTestId: factory,
    getByText: factory,
    getByLabel: factory,
    getByPlaceholder: factory,
    getByAltText: factory,
    getByTitle: factory,
    locator: factory,
    on: () => {},
  } as unknown as Page;

  // The page fixture wraps the page's locator methods before its first await (`instrumentPage`), so the fake page
  // hands out a real capture proxy as soon as the fixture starts. What the fixture awaits next reads a browser this
  // page does not have, so how the fixture ends is ignored.
  const pageFixture = piwiFixtures.page as unknown as (
    args: { page: Page },
    use: (page: Page) => Promise<void>,
  ) => Promise<void>;
  pageFixture({ page }, async () => {}).catch(() => {});
  const proxied = page.getByTestId('open-42');
  if (proxied === raw) throw new Error('the page fixture did not wrap the page synchronously');

  bench('property read on a bare locator', () => {
    void (raw as unknown as Record<string, unknown>).click;
  });

  bench('property read through the capture proxy', () => {
    void (proxied as unknown as Record<string, unknown>).click;
  });
});
