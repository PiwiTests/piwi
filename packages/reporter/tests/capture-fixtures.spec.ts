import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import {
  ariaSnapshotBestEffort,
  ariaSnapshotJSONBestEffort,
  piwiFixtures,
  probeElementAttrs,
  CAPTURED_ATTRS_ARG,
  configuredCodeReachRoots,
} from '../src/internal/capture/capture-fixtures.js';
import {
  ATTACHMENT_NAMES,
  FAILURE_SCREENSHOT_ATTACHMENT,
  LOCATOR_SUGGESTION_ANNOTATION,
} from '../src/internal/capture/attachments.js';
import { keepsFailureScreenshots } from '../src/internal/capture/failure-screenshot.js';
import type { LocatorSnapshot } from '../src/internal/capture/locator-healing.js';
import * as path from 'node:path';
import {
  ariaSampleIdentity,
  writeAriaSampleFile,
  clearAriaSampleFile,
  resetAriaSampleCache,
} from '../src/internal/support/aria-sampling.js';

/**
 * Call the probe with the real shared role maps (CAPTURED_ATTRS_ARG) and just
 * the per-test `keep` list — mirrors how the fixtures invoke it in production,
 * so the tests exercise the same single-source-of-truth maps.
 */
const probe = (el: unknown, keep: string[] = []) => probeElementAttrs(el, { ...CAPTURED_ATTRS_ARG, keep });

/** A minimal fake Locator exposing only what ariaSnapshotBestEffort touches. */
function fakeLocator(ariaSnapshot?: (opts?: unknown) => Promise<string>): Locator {
  return { ariaSnapshot } as unknown as Locator;
}

/**
 * A minimal fake DOM element exposing only what probeElementAttrs touches:
 * getAttribute, direct properties, getBoundingClientRect, ownerDocument
 * (CSS.escape + querySelectorAll), tagName, textContent, labels.
 */
function fakeElement(opts: {
  tagName?: string;
  attrs?: Record<string, string>;
  props?: Record<string, unknown>;
  rect?: { x: number; y: number; width: number; height: number };
  textContent?: string;
  labelCount?: number;
  /** Maps a CSS selector to the number of matches querySelectorAll should report. */
  selectorMatches?: Record<string, number>;
  /** Throw instead of returning a count for a given selector (simulates an invalid selector). */
  throwingSelectors?: Set<string>;
  /** Make ownerDocument access itself throw, to exercise the outer best-effort catch. */
  brokenDocument?: boolean;
}): unknown {
  const {
    tagName = 'div',
    attrs = {},
    props = {},
    rect = { x: 0, y: 0, width: 10, height: 10 },
    textContent = '',
    labelCount = 0,
    selectorMatches = {},
    throwingSelectors = new Set<string>(),
  } = opts;

  const querySelectorAll = (sel: string) => {
    if (throwingSelectors.has(sel)) throw new Error(`invalid selector: ${sel}`);
    return { length: selectorMatches[sel] ?? 0 };
  };

  return {
    tagName: tagName.toUpperCase(), // real DOM tagName is uppercase; probe lowercases it
    getAttribute: (key: string) => (key in attrs ? attrs[key] : null),
    ...props,
    getBoundingClientRect: () => rect,
    textContent,
    // A real `labels` is an indexable NodeList of elements, not just a count —
    // the probe reads the first one's text off it as `labelText`.
    labels: labelCount > 0 ? Array.from({ length: labelCount }, (_, i) => ({ textContent: `Label ${i}` })) : null,
    ownerDocument: opts.brokenDocument
      ? undefined
      : {
          defaultView: { CSS: { escape: (s: string) => s } },
          querySelectorAll,
        },
  };
}

describe('ariaSnapshotBestEffort', () => {
  it('returns null when the installed Playwright predates locator.ariaSnapshot (< 1.49)', async () => {
    const locator = fakeLocator(undefined);
    expect(await ariaSnapshotBestEffort(locator)).toBeNull();
  });

  it('calls ariaSnapshot with mode: "ai" first and returns its result (>= 1.59)', async () => {
    const ariaSnapshot = vi.fn().mockResolvedValue('- button "Submit"');
    const locator = fakeLocator(ariaSnapshot);
    const result = await ariaSnapshotBestEffort(locator, 500);
    expect(result).toBe('- button "Submit"');
    expect(ariaSnapshot).toHaveBeenCalledTimes(1);
    expect(ariaSnapshot).toHaveBeenCalledWith({ timeout: 500, mode: 'ai' });
  });

  it('omits the timeout key entirely when none is given', async () => {
    const ariaSnapshot = vi.fn().mockResolvedValue('- text');
    const locator = fakeLocator(ariaSnapshot);
    await ariaSnapshotBestEffort(locator);
    expect(ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
  });

  it('falls back to { ref: true } when mode: "ai" rejects (1.52)', async () => {
    const ariaSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('mode not supported'))
      .mockResolvedValueOnce('- ref-annotated snapshot');
    const locator = fakeLocator(ariaSnapshot);
    const result = await ariaSnapshotBestEffort(locator, 250);
    expect(result).toBe('- ref-annotated snapshot');
    expect(ariaSnapshot).toHaveBeenNthCalledWith(1, { timeout: 250, mode: 'ai' });
    expect(ariaSnapshot).toHaveBeenNthCalledWith(2, { timeout: 250, ref: true });
  });

  it('returns null (never throws) when both attempts reject', async () => {
    const ariaSnapshot = vi.fn().mockRejectedValue(new Error('nope'));
    const locator = fakeLocator(ariaSnapshot);
    await expect(ariaSnapshotBestEffort(locator)).resolves.toBeNull();
    expect(ariaSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('ariaSnapshotJSONBestEffort', () => {
  it('returns null when the installed Playwright has no ariaSnapshotJSON (< 1.63)', async () => {
    const locator = { ariaSnapshot: async () => '- button' } as unknown as Locator;
    expect(await ariaSnapshotJSONBestEffort(locator)).toBeNull();
  });

  it('stringifies the JSON tree the method returns', async () => {
    const tree = [{ role: 'button', name: 'Pay' }];
    const ariaSnapshotJSON = vi.fn().mockResolvedValue(tree);
    const locator = { ariaSnapshotJSON } as unknown as Locator;
    const result = await ariaSnapshotJSONBestEffort(locator, 500);
    expect(result).toBe(JSON.stringify(tree));
    expect(ariaSnapshotJSON).toHaveBeenCalledWith({ timeout: 500 });
  });

  it('returns null (never throws) when the method rejects', async () => {
    const ariaSnapshotJSON = vi.fn().mockRejectedValue(new Error('nope'));
    const locator = { ariaSnapshotJSON } as unknown as Locator;
    await expect(ariaSnapshotJSONBestEffort(locator)).resolves.toBeNull();
  });
});

describe('probeElementAttrs', () => {
  it('captures tagName (lowercased), attribute values, and geometry center', () => {
    const el = fakeElement({
      tagName: 'BUTTON',
      attrs: { type: 'submit' },
      rect: { x: 10, y: 20, width: 100, height: 50 },
    });
    const out = probe(el, ['type']);
    expect(out.tagName).toBe('button');
    expect(out.attributes).toEqual({ type: 'submit' });
    expect(out.center).toEqual({ x: 60, y: 45 });
  });

  it('falls back to a direct property when getAttribute returns null', () => {
    const el = fakeElement({ props: { value: 'a direct prop, not an attribute' } });
    const out = probe(el, ['value']);
    expect(out.attributes.value).toBe('a direct prop, not an attribute');
  });

  it('truncates attribute values to 200 chars and non-string values are stringified', () => {
    const el = fakeElement({ props: { 'aria-level': 3 }, attrs: { title: 'x'.repeat(250) } });
    const out = probe(el, ['title', 'aria-level']);
    expect(out.attributes.title).toHaveLength(200);
    expect(out.attributes['aria-level']).toBe('3');
  });

  it('records null for an attribute that is absent entirely', () => {
    const el = fakeElement({});
    const out = probe(el, ['data-missing']);
    expect(out.attributes['data-missing']).toBeNull();
  });

  it('collapses whitespace and truncates textContent to 80 chars', () => {
    const el = fakeElement({ textContent: `line one\n\n   line   two   ${'z'.repeat(100)}` });
    const out = probe(el, []);
    expect(out.textContent).not.toContain('\n');
    expect(out.textContent.length).toBeLessThanOrEqual(80);
    expect(out.textContent.startsWith('line one line two')).toBe(true);
  });

  it('sets hasLabel true only when the element has associated <label>s', () => {
    expect(probe(fakeElement({ labelCount: 1 }), []).hasLabel).toBe(true);
    expect(probe(fakeElement({ labelCount: 0 }), []).hasLabel).toBe(false);
  });

  it('computes selectorCounts for data-testid, id, name, and each class', () => {
    const el = fakeElement({
      attrs: { 'data-testid': 'save-btn', id: 'save', name: 'saveField', class: 'btn primary' },
      selectorMatches: {
        '[data-testid="save-btn"]': 1,
        '#save': 1,
        '[name="saveField"]': 2, // ambiguous — a real form field named the same on the page
        '.btn': 3,
        '.primary': 1,
      },
    });
    const out = probe(el, ['data-testid', 'id', 'name', 'class']);
    expect(out.selectorCounts.testId).toBe(1);
    expect(out.selectorCounts.id).toBe(1);
    expect(out.selectorCounts.name).toBe(2);
    expect(out.selectorCounts.classes).toEqual({ btn: 3, primary: 1 });
  });

  it('omits a selectorCounts key entirely when the element has no such attribute', () => {
    const el = fakeElement({});
    const out = probe(el, []);
    expect(out.selectorCounts).toEqual({});
  });

  it('ignores a selector that throws (invalid CSS) rather than failing the whole probe', () => {
    const el = fakeElement({
      attrs: { id: 'weird:id' },
      throwingSelectors: new Set(['#weird:id']),
    });
    const out = probe(el, ['id']);
    expect(out.selectorCounts.id).toBeUndefined();
    expect(out.tagName).toBe('div'); // the rest of the probe still completed
  });

  it('never fails the whole probe when ownerDocument access itself throws', () => {
    const el = fakeElement({ attrs: { id: 'x' }, brokenDocument: true });
    const out = probe(el, ['id']);
    expect(out.selectorCounts).toEqual({});
    expect(out.tagName).toBe('div');
  });

  it('caps the class list probed to the first 10 classes', () => {
    const classes = Array.from({ length: 15 }, (_, i) => `c${i}`);
    const el = fakeElement({
      attrs: { class: classes.join(' ') },
      selectorMatches: Object.fromEntries(classes.map((c) => [`.${c}`, 1])),
    });
    const out = probe(el, ['class']);
    expect(Object.keys(out.selectorCounts.classes ?? {})).toHaveLength(10);
  });
});

describe('per-call-site capture dedupe', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Probe result for a plain `<button>Save</button>`. */
  const savedButton = {
    tagName: 'button',
    attributes: { 'data-testid': 'save' },
    textContent: 'Save',
    center: { x: 1, y: 1 },
    hasLabel: false,
    selectorCounts: {},
  };

  /**
   * Drive `actions` through the real fixtures against a fake page, reporting
   * what the capture path asked the browser for and what it attached.
   */
  async function runCapture(
    evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>,
    actions: (
      page: { getByTestId: (id: string) => { click: () => Promise<void> } },
      emit: (event: string) => void,
    ) => Promise<void>,
    infoOverrides: { status?: string; file?: string; title?: string } = {},
  ) {
    let ariaSnapshots = 0;
    const fakeLocator = {
      click: async () => {},
      evaluate,
      ariaSnapshot: async () => {
        ariaSnapshots++;
        return '- button "Save"';
      },
    };
    const locatorFactory = () => fakeLocator;
    const listeners = new Map<string, Array<() => void>>();
    const fakePage = {
      getByRole: locatorFactory,
      getByTestId: locatorFactory,
      getByText: locatorFactory,
      getByLabel: locatorFactory,
      getByPlaceholder: locatorFactory,
      getByAltText: locatorFactory,
      getByTitle: locatorFactory,
      locator: locatorFactory,
      on: (event: string, handler: () => void) => {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
      },
      evaluate: async () => null,
    };
    const emit = (event: string) => (listeners.get(event) ?? []).forEach((handler) => handler());

    const attached: LocatorSnapshot[] = [];
    const ariaAttachments: string[] = [];
    const testInfo = {
      status: infoOverrides.status ?? 'passed',
      file: infoOverrides.file,
      title: infoOverrides.title,
      attach: vi.fn(async (name: string, body: { body: Buffer | string }) => {
        if (name === ATTACHMENT_NAMES.locators) attached.push(...JSON.parse(String(body.body)));
        if (name === ATTACHMENT_NAMES.ariaSnapshot) ariaAttachments.push(String(body.body));
      }),
      annotations: [],
    };

    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];

    await captureFixture({}, () => pageFixture({ page: fakePage }, (page) => actions(page as never, emit)), testInfo);
    return { attached, ariaSnapshots, ariaAttachments };
  }

  it('probes a call site once however many times that line runs', async () => {
    let probes = 0;
    const { attached } = await runCapture(
      async () => {
        probes++;
        return savedButton;
      },
      async (page) => {
        for (let i = 0; i < 5; i++) await page.getByTestId('save').click();
      },
    );

    // Five actions, one source line — and `dedupeSnapshotsByLocation` would
    // have discarded four of five captures anyway.
    expect(probes).toBe(1);
    expect(attached).toHaveLength(1);
    expect(attached[0]!.element?.accessibleName).toBe('Save');
  });

  it('skips the ARIA snapshot when the probed attributes settle the name', async () => {
    const { attached, ariaSnapshots } = await runCapture(
      async () => savedButton,
      async (page) => {
        await page.getByTestId('save').click();
      },
    );

    // A button with text and no aria-label/aria-labelledby is named by its
    // content, so the second round trip cannot change the answer.
    expect(ariaSnapshots).toBe(0);
    expect(attached[0]!.element?.accessibleName).toBe('Save');
  });

  it('still asks the browser when only it can settle the name', async () => {
    const { ariaSnapshots } = await runCapture(
      async () => ({ ...savedButton, attributes: { 'aria-labelledby': 'heading-1' } }),
      async (page) => {
        await page.getByTestId('save').click();
      },
    );

    expect(ariaSnapshots).toBe(1);
  });

  it('releases a call site whose probe failed so a later run of that line retries', async () => {
    let probes = 0;
    const { attached } = await runCapture(
      async () => {
        probes++;
        if (probes === 1) throw new Error('element detached');
        return savedButton;
      },
      async (page) => {
        for (let i = 0; i < 2; i++) {
          await page.getByTestId('save').click();
          // Let the failed probe settle before the line runs again.
          await sleep(20);
        }
      },
    );

    expect(probes).toBe(2);
    expect(attached).toHaveLength(1);
    expect(attached[0]!.element?.textContent).toBe('Save');
  });

  describe('green ARIA sampling on pass', () => {
    const PROJECT = 'cap-fix-sample';
    const FILE = path.join(process.cwd(), 'tests/sampled.spec.ts');
    const TITLE = 'shows the dashboard';
    const identity = ariaSampleIdentity(path.relative(process.cwd(), FILE).split(path.sep).join('/'), TITLE);

    const savedEnv = { project: process.env.PIWI_PROJECT_NAME, flag: process.env.PIWI_SAMPLE_ARIA_ON_PASS };
    afterEach(() => {
      clearAriaSampleFile(PROJECT);
      resetAriaSampleCache();
      process.env.PIWI_PROJECT_NAME = savedEnv.project;
      process.env.PIWI_SAMPLE_ARIA_ON_PASS = savedEnv.flag;
    });

    it('attaches the ARIA snapshot when the passing test is in the due set', async () => {
      process.env.PIWI_PROJECT_NAME = PROJECT;
      delete process.env.PIWI_SAMPLE_ARIA_ON_PASS;
      writeAriaSampleFile(PROJECT, [identity]);
      resetAriaSampleCache();

      const { ariaAttachments } = await runCapture(
        async () => savedButton,
        async (page) => {
          await page.getByTestId('save').click();
        },
        { status: 'passed', file: FILE, title: TITLE },
      );
      expect(ariaAttachments).toHaveLength(1);
    });

    it('does not sample a passing test outside the due set (rate limit)', async () => {
      process.env.PIWI_PROJECT_NAME = PROJECT;
      delete process.env.PIWI_SAMPLE_ARIA_ON_PASS;
      writeAriaSampleFile(PROJECT, [ariaSampleIdentity('tests/other.spec.ts', 'something else')]);
      resetAriaSampleCache();

      const { ariaAttachments } = await runCapture(
        async () => savedButton,
        async (page) => {
          await page.getByTestId('save').click();
        },
        { status: 'passed', file: FILE, title: TITLE },
      );
      expect(ariaAttachments).toHaveLength(0);
    });

    it('never samples when the run-start call left no sample set (fallback)', async () => {
      process.env.PIWI_PROJECT_NAME = PROJECT;
      delete process.env.PIWI_SAMPLE_ARIA_ON_PASS;
      clearAriaSampleFile(PROJECT);
      resetAriaSampleCache();

      const { ariaAttachments } = await runCapture(
        async () => savedButton,
        async (page) => {
          await page.getByTestId('save').click();
        },
        { status: 'passed', file: FILE, title: TITLE },
      );
      expect(ariaAttachments).toHaveLength(0);
    });

    it('never samples when sampleAriaOnPass is off, even for a due test', async () => {
      process.env.PIWI_PROJECT_NAME = PROJECT;
      process.env.PIWI_SAMPLE_ARIA_ON_PASS = 'false';
      writeAriaSampleFile(PROJECT, [identity]);
      resetAriaSampleCache();

      const { ariaAttachments } = await runCapture(
        async () => savedButton,
        async (page) => {
          await page.getByTestId('save').click();
        },
        { status: 'passed', file: FILE, title: TITLE },
      );
      expect(ariaAttachments).toHaveLength(0);
    });
  });
});

describe('seeded in-page probe', () => {
  const savedButton = {
    tagName: 'button',
    attributes: { 'data-testid': 'save' },
    textContent: 'Save',
    center: { x: 1, y: 1 },
    hasLabel: false,
    selectorCounts: {},
  };

  /**
   * The two ways capture can reach the probe are told apart by the argument:
   * the stub is handed the global's name (a string), while the fallback ships
   * `probeElementAttrs` itself with the full `ProbeArg` object.
   */
  const isStubCall = (arg: unknown) => typeof arg === 'string';

  /** Fake context that records what the fixtures seeded into it. */
  function fakeContext() {
    const initScripts: string[] = [];
    return {
      scripts: initScripts,
      context: {
        addInitScript: async (script: { content: string }) => {
          initScripts.push(script.content);
        },
        newPage: async () => ({}),
        close: async () => {},
        on: () => {},
      },
    };
  }

  it('seeds the probe into the context so captures ship a stub instead of the source', async () => {
    const calls: Array<'stub' | 'source'> = [];
    const { scripts, context } = fakeContext();
    const fakeLocator = {
      click: async () => {},
      evaluate: async (_fn: unknown, arg?: unknown) => {
        calls.push(isStubCall(arg) ? 'stub' : 'source');
        return savedButton;
      },
    };
    const factory = (..._args: unknown[]) => fakeLocator;
    const fakePage = {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: factory,
      on: () => {},
      context: () => context,
      evaluate: async () => null,
    };

    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];

    await captureFixture(
      {},
      () =>
        pageFixture({ page: fakePage }, async (page) => {
          await (page.getByTestId('save') as unknown as { click: () => Promise<void> }).click();
        }),
      { status: 'passed', attach: async () => {}, annotations: [] },
    );

    // The seeded script carries the probe and its argument, so the per-capture
    // call needs neither.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('__piwiProbeElement');
    expect(scripts[0]).toContain('roleSources');
    expect(calls).toEqual(['stub']);
  });

  it('ships the probe source when the page has no seeded probe, and stops re-trying it', async () => {
    const calls: Array<'stub' | 'source'> = [];
    const fakeLocator = {
      click: async () => {},
      // A page the init script never reached: the stub finds no global and
      // reports null rather than throwing.
      evaluate: async (_fn: unknown, arg?: unknown) => {
        if (isStubCall(arg)) {
          calls.push('stub');
          return null;
        }
        calls.push('source');
        return savedButton;
      },
    };
    const factory = (..._args: unknown[]) => fakeLocator;
    const listeners = new Map<string, Array<() => void>>();
    const fakePage = {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: factory,
      on: (event: string, handler: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      },
      evaluate: async () => null,
    };
    const emit = (event: string) => (listeners.get(event) ?? []).forEach((h) => h());

    const attached: LocatorSnapshot[] = [];
    const testInfo = {
      status: 'passed',
      attach: vi.fn(async (name: string, body: { body: Buffer }) => {
        if (name === ATTACHMENT_NAMES.locators) attached.push(...JSON.parse(String(body.body)));
      }),
      annotations: [],
    };

    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];

    const click = async (page: typeof fakePage) =>
      await (page.getByTestId('save') as unknown as { click: () => Promise<void> }).click();

    await captureFixture(
      {},
      () =>
        pageFixture({ page: fakePage }, async (page) => {
          // Separate lines, so the per-call-site dedupe does not hide the
          // second capture.
          await click(page);
          await new Promise((r) => setTimeout(r, 10));
          await (page.getByTestId('other') as unknown as { click: () => Promise<void> }).click();
          await new Promise((r) => setTimeout(r, 10));
          // A navigation seeds the next document, so the fast path is worth
          // another try.
          emit('framenavigated');
          await (page.getByTestId('third') as unknown as { click: () => Promise<void> }).click();
          await new Promise((r) => setTimeout(r, 10));
        }),
      testInfo,
    );

    // First capture discovers the miss and falls back; the second skips
    // straight to the source; the navigation re-arms the stub.
    expect(calls).toEqual(['stub', 'source', 'source', 'stub', 'source']);
    expect(attached.every((snapshot) => snapshot.element !== null)).toBe(true);
  });
});

describe('locator capture teardown race', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps a probe rejection after the capture deadline from becoming an unhandled rejection', async () => {
    // The element probe (locator.evaluate) never settles during the test and
    // rejects only after teardown — simulating a page that closes while the
    // probe is still in flight. The 500ms capture deadline wins the race; the
    // probe's late rejection must be observed, or Playwright would fail
    // whichever test is running when it surfaces as an unhandled rejection.
    let rejectProbe: ((reason: Error) => void) | undefined;
    const fakeLocator = {
      click: async () => {},
      evaluate: () =>
        new Promise((_, reject) => {
          rejectProbe = reject;
        }),
    };
    const locatorFactory = (..._args: unknown[]) => fakeLocator;
    const fakePage = {
      getByRole: locatorFactory,
      getByTestId: locatorFactory,
      getByText: locatorFactory,
      getByLabel: locatorFactory,
      getByPlaceholder: locatorFactory,
      getByAltText: locatorFactory,
      getByTitle: locatorFactory,
      locator: locatorFactory,
      on: () => {},
      evaluate: async () => null, // web-vitals read at teardown
    };
    const testInfo = { status: 'passed', attach: vi.fn(async () => {}), annotations: [] };

    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, testInfo: unknown) => Promise<void>,
    ];

    const unhandled: unknown[] = [];
    const priorListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason) => unhandled.push(reason));

    try {
      await captureFixture(
        {},
        () =>
          pageFixture({ page: fakePage }, async (page) => {
            await (page.getByTestId('save') as unknown as { click: () => Promise<void> }).click();
            // Let the 500ms probe deadline win the race before the test ends.
            await sleep(600);
          }),
        testInfo,
      );

      // The page "closes" after teardown; the in-flight probe now rejects.
      rejectProbe?.(new Error('page closed at teardown'));
      await sleep(20);

      expect(unhandled).toEqual([]);
      // The action was still captured (as a placeholder snapshot) and attached.
      expect(testInfo.attach).toHaveBeenCalledWith(ATTACHMENT_NAMES.locators, expect.anything());
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const listener of priorListeners) process.on('unhandledRejection', listener);
    }
  });
});

/**
 * Structural-probe fakes: role-source scans need index access over real
 * node lists, and ancestors need a parentElement chain — richer than the
 * `{ length }` stubs above.
 */
function fakeDomNode(tagName: string, attrs: Record<string, string> = {}): any {
  return {
    tagName: tagName.toUpperCase(),
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    parentElement: null as any,
    // Scoped role-source scan inside an anchor; tests assign the contents.
    scopedNodes: [] as any[],
    querySelectorAll(_sel: string) {
      return this.scopedNodes;
    },
    // Used to look for a heading that names a repeated container.
    querySelector(_sel: string) {
      return null;
    },
  };
}

function fakeStructuralElement(opts: {
  tagName: string;
  attrs?: Record<string, string>;
  /** Nodes returned for the document-wide role-source scan (should include the element itself). */
  roleNodes?: any[];
  /** Match counts for plain count selectors (testid/id uniqueness probes). */
  countMatches?: Record<string, number>;
  parent?: any;
}): any {
  const { tagName, attrs = {}, roleNodes = [], countMatches = {} } = opts;
  const el = fakeDomNode(tagName, attrs);
  el.parentElement = opts.parent ?? null;
  el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 10, height: 10 });
  el.textContent = '';
  el.labels = null;
  el.ownerDocument = {
    defaultView: { CSS: { escape: (s: string) => s } },
    querySelectorAll: (sel: string) =>
      sel.startsWith('[role],') ? roleNodes : Array.from({ length: countMatches[sel] ?? 0 }),
  };
  return el;
}

describe('probeElementAttrs — structural probe (rolePosition + ancestors)', () => {
  it('records the position among same-role elements, document-wide', () => {
    const other = fakeDomNode('input', { type: 'text' });
    const el = fakeStructuralElement({ tagName: 'input', attrs: { type: 'email' } });
    el.ownerDocument.querySelectorAll = (sel: string) => (sel.startsWith('[role],') ? [other, el] : []);
    const probed = probe(el, ['type']);
    expect(probed.rolePosition).toEqual({ role: 'textbox', count: 2, index: 1 });
  });

  it('counts same-level headings separately (levelCount)', () => {
    const h1 = fakeDomNode('h1');
    const h2a = fakeDomNode('h2');
    const h2b = fakeDomNode('h2');
    const el = fakeStructuralElement({ tagName: 'h1' });
    el.ownerDocument.querySelectorAll = (sel: string) => (sel.startsWith('[role],') ? [el, h2a, h1, h2b] : []);
    const probed = probe(el, []);
    expect(probed.rolePosition).toEqual({ role: 'heading', count: 4, index: 0, levelCount: 2 });
  });

  it('collects anchor-worthy ancestors with scoped and document-wide counts', () => {
    const plainDiv = fakeDomNode('div');
    const form = fakeDomNode('form', { 'data-testid': 'signup-form', id: 'signup' });
    plainDiv.parentElement = form;
    const el = fakeStructuralElement({
      tagName: 'input',
      attrs: { type: 'email' },
      parent: plainDiv,
      countMatches: { '[data-testid="signup-form"]': 1, '#signup': 1 },
    });
    el.ownerDocument.querySelectorAll = (sel: string) =>
      sel.startsWith('[role],')
        ? [form, el]
        : Array.from({ length: { '[data-testid="signup-form"]': 1, '#signup': 1 }[sel] ?? 0 });
    form.scopedNodes = [el];
    const probed = probe(el, ['type']);
    // The plain div is not anchor-worthy; the form is, at depth 2.
    expect(probed.ancestors).toEqual([
      {
        tag: 'form',
        depth: 2,
        testId: 'signup-form',
        id: 'signup',
        role: null,
        ariaLabel: null,
        scopedRoleCount: 1,
        testIdCount: 1,
        idCount: 1,
        roleCount: 1,
      },
    ]);
  });

  it('stops at body and caps the number of collected anchors', () => {
    // el → 5 anchor-worthy divs (ids) → body → html; only 4 nearest collected.
    let parent: any = fakeDomNode('body');
    const chain: any[] = [];
    for (let i = 5; i >= 1; i--) {
      const anc = fakeDomNode('div', { id: `panel${i}` });
      anc.parentElement = parent;
      parent = anc;
      chain.unshift(anc);
    }
    const el = fakeStructuralElement({ tagName: 'button', parent });
    el.ownerDocument.querySelectorAll = (sel: string) => (sel.startsWith('[role],') ? [el] : []);
    const probed = probe(el, []);
    expect(probed.ancestors?.map((a: any) => a.id)).toEqual(['panel1', 'panel2', 'panel3', 'panel4']);
  });

  it('yields no structural data for a role-less element', () => {
    const el = fakeStructuralElement({ tagName: 'div', parent: fakeDomNode('form', { id: 'f' }) });
    const probed = probe(el, []);
    expect(probed.rolePosition).toBeNull();
    expect(probed.ancestors).toEqual([]);
  });

  it('drops the position when the element is missing from the scan', () => {
    const stranger = fakeDomNode('input');
    const el = fakeStructuralElement({ tagName: 'input', roleNodes: [stranger] });
    const probed = probe(el, []);
    expect(probed.rolePosition).toBeNull();
  });

  it('survives a broken document without failing the capture', () => {
    const el = fakeStructuralElement({ tagName: 'input' });
    el.ownerDocument = undefined;
    const probed = probe(el, []);
    expect(probed.rolePosition).toBeNull();
    expect(probed.ancestors).toEqual([]);
    expect(probed.tagName).toBe('input');
  });
});

describe('_expect assertion capture', () => {
  // What the in-page probe would report for the asserted element. A role-less
  // <div> keeps the capture path off the ARIA-snapshot branch, so the fake
  // locator only needs `evaluate`.
  const FAKE_ATTRS = {
    tagName: 'div',
    attributes: {},
    textContent: 'Save changes',
    center: { x: 10, y: 20 },
    hasLabel: false,
    selectorCounts: {},
    rolePosition: null,
    ancestors: [],
  };

  interface HarnessTestInfo {
    status: string;
    attach: ReturnType<typeof vi.fn>;
    annotations: Array<{ type: string; description?: string }>;
  }

  /**
   * Drive the real fixtures with a fake page whose locator factories all
   * return `fakeLocator` — the same wiring as the teardown-race test above.
   * The test body plays the role of Playwright's matcher layer by calling
   * `locator._expect(expression, options)` directly on the wrapped locator.
   */
  async function runCaptureTest(opts: {
    fakeLocator: Record<string, unknown>;
    body: (page: Record<string, (...args: unknown[]) => unknown>) => Promise<void>;
    finalStatus?: string;
    rootAria?: string;
  }): Promise<{ testInfo: HarnessTestInfo; snapshots: LocatorSnapshot[] | null }> {
    const factory = () => opts.fakeLocator;
    // flushSink reads page.locator(':root') for the failure-time ARIA snapshot.
    const rootLocator = { ariaSnapshot: async () => opts.rootAria ?? null };
    const fakePage = {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: (sel: string) => (sel === ':root' ? rootLocator : opts.fakeLocator),
      on: () => {},
      evaluate: async () => null,
    };
    const testInfo: HarnessTestInfo = { status: 'passed', attach: vi.fn(async () => {}), annotations: [] };

    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, testInfo: unknown) => Promise<void>,
    ];

    await captureFixture(
      {},
      () =>
        pageFixture({ page: fakePage }, async (page) => {
          await opts.body(page as unknown as Record<string, (...args: unknown[]) => unknown>);
          if (opts.finalStatus) testInfo.status = opts.finalStatus;
        }),
      testInfo,
    );

    const call = testInfo.attach.mock.calls.find((c) => c[0] === ATTACHMENT_NAMES.locators);
    const snapshots = call ? (JSON.parse((call[1] as { body: Buffer }).body.toString()) as LocatorSnapshot[]) : null;
    return { testInfo, snapshots };
  }

  it('captures the element when a positive presence assertion passes', async () => {
    const result = { matches: true, received: undefined };
    const fakeLocator = {
      _expect: vi.fn(async () => result),
      evaluate: vi.fn(async () => FAKE_ATTRS),
    };
    let returned: unknown;

    const { snapshots } = await runCaptureTest({
      fakeLocator,
      body: async (page) => {
        const loc = page.getByTestId!('save') as { _expect: (...args: unknown[]) => Promise<unknown> };
        returned = await loc._expect('to.be.visible', { isNot: false, timeout: 5000 });
      },
    });

    // The assertion outcome is passed through untouched (same object).
    expect(returned).toBe(result);
    expect(fakeLocator._expect).toHaveBeenCalledExactlyOnceWith('to.be.visible', { isNot: false, timeout: 5000 });

    expect(snapshots).not.toBeNull();
    expect(snapshots).toHaveLength(1);
    const snap = snapshots![0]!;
    expect(snap.used).toEqual({ method: 'getByTestId', args: ['save'], raw: 'getByTestId(["save"])' });
    // The call site is this spec file — the same first-user-frame the failing
    // assertion's error stack would carry, so the exact-location rung matches.
    expect(snap.location).toMatch(/tests\/capture-fixtures\.spec\.ts:\d+:\d+$/);
    expect(snap.element).not.toBeNull();
    expect(snap.element!.tagName).toBe('div');
    expect(snap.element!.textContent).toBe('Save changes');
    expect(snap.alternatives.map((a) => a.locator)).toContain("getByText('Save changes')");
  });

  it('skips negated assertions — a passing .not proves nothing resolvable', async () => {
    const fakeLocator = {
      _expect: vi.fn(async () => ({ matches: false })),
      evaluate: vi.fn(async () => FAKE_ATTRS),
    };

    const { snapshots } = await runCaptureTest({
      fakeLocator,
      body: async (page) => {
        const loc = page.getByText!('gone') as { _expect: (...args: unknown[]) => Promise<unknown> };
        await loc._expect('to.be.visible', { isNot: true, timeout: 100 });
      },
    });

    expect(snapshots).toBeNull();
    expect(fakeLocator.evaluate).not.toHaveBeenCalled();
  });

  it('skips absence, multi-element, and page-level expressions even when they pass', async () => {
    const fakeLocator = {
      _expect: vi.fn(async () => ({ matches: true })),
      evaluate: vi.fn(async () => FAKE_ATTRS),
    };

    const { snapshots } = await runCaptureTest({
      fakeLocator,
      body: async (page) => {
        const loc = page.locator!('.rows') as { _expect: (...args: unknown[]) => Promise<unknown> };
        for (const expression of ['to.be.hidden', 'to.have.count', 'to.have.text.array', 'to.have.title']) {
          await loc._expect(expression, { isNot: false });
        }
      },
    });

    expect(snapshots).toBeNull();
    expect(fakeLocator.evaluate).not.toHaveBeenCalled();
  });

  it('probes a repeated call site only once but attaches its snapshot', async () => {
    const fakeLocator = {
      _expect: vi.fn(async () => ({ matches: true })),
      evaluate: vi.fn(async () => FAKE_ATTRS),
    };

    const { snapshots } = await runCaptureTest({
      fakeLocator,
      body: async (page) => {
        const loc = page.getByRole!('button', { name: 'Save' }) as {
          _expect: (...args: unknown[]) => Promise<unknown>;
        };
        for (let i = 0; i < 3; i++) {
          await loc._expect('to.be.visible', { isNot: false });
        }
      },
    });

    expect(fakeLocator._expect).toHaveBeenCalledTimes(3);
    expect(fakeLocator.evaluate).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots![0]!.element).not.toBeNull();
  });

  it('records a failed presence assertion for the fresh-locator suggestion', async () => {
    const fakeLocator = {
      _expect: vi.fn(async () => ({ matches: false, received: 'hidden' })),
      evaluate: vi.fn(async () => FAKE_ATTRS),
    };

    const { testInfo, snapshots } = await runCaptureTest({
      fakeLocator,
      body: async (page) => {
        const loc = page.getByText!('Save') as { _expect: (...args: unknown[]) => Promise<unknown> };
        await loc._expect('to.be.visible', { isNot: false, timeout: 100 });
      },
      finalStatus: 'failed',
      rootAria: '- button "Save changes"',
    });

    // No element was captured (the assertion missed), but the call site is
    // still marked exercised via its placeholder…
    expect(snapshots).toHaveLength(1);
    expect(snapshots![0]!.element).toBeNull();
    expect(fakeLocator.evaluate).not.toHaveBeenCalled();

    // …and the miss fed the failed-locator signal: teardown suggested a fresh
    // locator for the renamed element on the failing page.
    const suggestion = testInfo.annotations.find((a) => a.type === LOCATOR_SUGGESTION_ANNOTATION);
    expect(suggestion).toBeDefined();
    expect(suggestion!.description).toContain("getByText('Save')");
    expect(suggestion!.description).toContain('Save changes');
  });

  it('degrades to no capture when the result carries no matches flag', async () => {
    const fakeLocator = {
      _expect: vi.fn(async () => ({})),
      evaluate: vi.fn(async () => FAKE_ATTRS),
    };

    const { testInfo, snapshots } = await runCaptureTest({
      fakeLocator,
      body: async (page) => {
        const loc = page.getByTestId!('save') as { _expect: (...args: unknown[]) => Promise<unknown> };
        await loc._expect('to.be.visible', { isNot: false });
      },
    });

    // Placeholder only: the location counts as exercised, no element claim,
    // no failed-locator record.
    expect(snapshots).toHaveLength(1);
    expect(snapshots![0]!.element).toBeNull();
    expect(fakeLocator.evaluate).not.toHaveBeenCalled();
    expect(testInfo.annotations).toEqual([]);
  });

  it('leaves the property untouched when the installed Playwright has no _expect', async () => {
    const fakeLocator = {
      click: async () => {},
      evaluate: vi.fn(async () => FAKE_ATTRS),
    };

    await runCaptureTest({
      fakeLocator,
      body: async (page) => {
        const loc = page.getByTestId!('save') as { _expect?: unknown };
        expect(loc._expect).toBeUndefined();
      },
    });
  });
});

describe('visible() and frameLocator() chains', () => {
  const PAY_ATTRS = {
    tagName: 'button',
    attributes: {},
    textContent: 'Pay',
    center: { x: 1, y: 1 },
    hasLabel: false,
    selectorCounts: {},
    rolePosition: null,
    ancestors: [],
  };

  /**
   * Drive the real fixtures against a fake page, letting the body build a
   * locator through whatever chain it likes and click it, then return the
   * captured healing snapshots.
   */
  async function runChain(
    fakePageExtras: Record<string, unknown>,
    body: (page: Record<string, (...args: unknown[]) => unknown>) => Promise<void>,
  ): Promise<LocatorSnapshot[] | null> {
    const leaf = {
      click: async () => {},
      evaluate: async () => PAY_ATTRS,
      ariaSnapshot: async () => '- button "Pay"',
    };
    const rootLocator = { ariaSnapshot: async () => null };
    const factory = () => leaf;
    const fakePage = {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: (sel: string) => (sel === ':root' ? rootLocator : { visible: () => leaf, evaluate: leaf.evaluate }),
      on: () => {},
      evaluate: async () => null,
      ...fakePageExtras,
    };
    const testInfo = {
      status: 'passed',
      attach: vi.fn(async (_name: string, _body: { body: Buffer }) => {}),
      annotations: [],
    };

    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];

    await captureFixture(
      {},
      () =>
        pageFixture({ page: fakePage }, (page) =>
          body(page as unknown as Record<string, (...args: unknown[]) => unknown>),
        ),
      testInfo,
    );

    const call = testInfo.attach.mock.calls.find((c) => c[0] === ATTACHMENT_NAMES.locators);
    return call ? (JSON.parse(call[1].body.toString()) as LocatorSnapshot[]) : null;
  }

  it('keeps the origin locator when the chain goes through visible()', async () => {
    const snapshots = await runChain({}, async (page) => {
      const loc = page.locator!('button') as { visible: () => { click: () => Promise<void> } };
      await loc.visible().click();
    });

    expect(snapshots).toHaveLength(1);
    // visible() narrows without changing identity, so the healed locator is the
    // origin `locator('button')`, not the `visible()` call.
    expect(snapshots![0]!.used).toEqual({ method: 'locator', args: ['button'], raw: 'locator(["button"])' });
    expect(snapshots![0]!.element?.textContent).toBe('Pay');
  });

  it('records a no-selector frameLocator() chain like a page-level locator', async () => {
    const frameLocator = { getByRole: () => ({ click: async () => {}, evaluate: async () => PAY_ATTRS }) };
    const snapshots = await runChain({ frameLocator: () => frameLocator }, async (page) => {
      const loc = page.frameLocator!() as { getByRole: (...a: unknown[]) => { click: () => Promise<void> } };
      await loc.getByRole('button', { name: 'Pay' }).click();
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots![0]!.used).toEqual({
      method: 'getByRole',
      args: ['button', { name: 'Pay' }],
      raw: 'getByRole(["button",{"name":"Pay"}])',
    });
    expect(snapshots![0]!.element?.textContent).toBe('Pay');
  });

  it('leaves the selector form of frameLocator() unwrapped', async () => {
    const frameLocator = { getByRole: () => ({ click: async () => {}, evaluate: async () => PAY_ATTRS }) };
    const snapshots = await runChain({ frameLocator: () => frameLocator }, async (page) => {
      const loc = page.frameLocator!('#frame') as { getByRole: (...a: unknown[]) => { click: () => Promise<void> } };
      await loc.getByRole('button', { name: 'Pay' }).click();
    });

    // The selector form is returned as Playwright hands it back — its locators
    // are outside the capture proxy, so nothing is recorded.
    expect(snapshots).toBeNull();
  });
});

describe('dialog capture (dialogclosed)', () => {
  /** Drive the fixtures against a fake page, fire dialog events, read the attachment. */
  async function runDialogs(
    fire: (emit: (event: string, dialog?: unknown) => void) => void,
  ): Promise<Array<Record<string, unknown>> | null> {
    const handlers = new Map<string, Array<(arg?: unknown) => void>>();
    const rootLocator = { ariaSnapshot: async () => null };
    const factory = () => ({ click: async () => {}, evaluate: async () => null });
    const fakePage = {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: (sel: string) => (sel === ':root' ? rootLocator : factory()),
      on: (event: string, handler: (arg?: unknown) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      evaluate: async () => null,
    };
    const emit = (event: string, dialog?: unknown) => (handlers.get(event) ?? []).forEach((h) => h(dialog));
    const testInfo = {
      status: 'failed',
      attach: vi.fn(async (_name: string, _body: { body: Buffer }) => {}),
      annotations: [],
    };

    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];

    await captureFixture(
      {},
      () =>
        pageFixture({ page: fakePage }, async () => {
          fire(emit);
        }),
      testInfo,
    );

    const call = testInfo.attach.mock.calls.find((c) => c[0] === ATTACHMENT_NAMES.dialogs);
    return call ? (JSON.parse(call[1].body.toString()) as Array<Record<string, unknown>>) : null;
  }

  const fakeDialog = (type: string, message: string) => ({
    type: () => type,
    message: () => message,
    defaultValue: () => '',
  });

  it('records a dialog observed through the close event', async () => {
    const dialogs = await runDialogs((emit) => {
      emit('dialogclosed', fakeDialog('confirm', 'Stay signed in?'));
    });
    expect(dialogs).toHaveLength(1);
    expect(dialogs![0]!.type).toBe('confirm');
    expect(dialogs![0]!.message).toBe('Stay signed in?');
    expect(typeof dialogs![0]!.closedAt).toBe('number');
  });

  it('attaches nothing when no dialog was observed', async () => {
    const dialogs = await runDialogs(() => {});
    expect(dialogs).toBeNull();
  });
});

describe('network capture (response, requestfinished, requestfailed)', () => {
  /** A fake page that keeps the listeners the fixtures add, and fires an event at them. */
  function fakeNetworkPage() {
    const handlers = new Map<string, Array<(arg?: unknown) => void>>();
    const rootLocator = { ariaSnapshot: async () => null };
    const factory = () => ({ click: async () => {}, evaluate: async () => null });
    const page = {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: (sel: string) => (sel === ':root' ? rootLocator : factory()),
      on: (event: string, handler: (arg?: unknown) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      evaluate: async () => null,
    };
    const emit = (event: string, arg: unknown) => (handlers.get(event) ?? []).forEach((h) => h(arg));
    return { page, emit };
  }

  /** Drive the fixtures against a fake page, fire network events, read the attachment. */
  function runNetwork(
    fire: (emit: (event: string, arg: unknown) => void) => void,
    attachment: string = ATTACHMENT_NAMES.network,
  ): Promise<Array<Record<string, unknown>> | null> {
    return runNetworkOn(fakeNetworkPage(), fire, attachment);
  }

  /** Run one test through the fixtures on `target`, a page earlier tests may have used too. */
  async function runNetworkOn(
    target: ReturnType<typeof fakeNetworkPage>,
    fire: (emit: (event: string, arg: unknown) => void) => void,
    attachment: string = ATTACHMENT_NAMES.network,
  ): Promise<Array<Record<string, unknown>> | null> {
    const { page: fakePage, emit } = target;
    const testInfo = {
      status: 'failed',
      attach: vi.fn(async (_name: string, _body: { body: Buffer }) => {}),
      annotations: [],
    };

    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];

    await captureFixture(
      {},
      () =>
        pageFixture({ page: fakePage }, async () => {
          fire(emit);
        }),
      testInfo,
    );

    const call = testInfo.attach.mock.calls.find((c) => c[0] === attachment);
    return call ? (JSON.parse(call[1].body.toString()) as Array<Record<string, unknown>>) : null;
  }

  const startTime = Date.now() - 2_000;

  interface FakeExchangeOptions {
    url: string;
    method?: string;
    resourceType?: string;
    responseStart?: number;
    responseEnd?: number;
    status?: number;
    errorText?: string;
    /** A response no server sent: no request start, no server address. */
    fulfilled?: boolean;
    headers?: Record<string, string>;
  }

  /** A request and its response (null without a status), the response pointing back at its request. */
  const fakeExchange = (opts: FakeExchangeOptions) => {
    const request = {
      url: () => opts.url,
      method: () => opts.method ?? 'GET',
      resourceType: () => opts.resourceType ?? 'fetch',
      timing: () => ({
        startTime,
        requestStart: opts.fulfilled ? -1 : 5,
        responseStart: opts.responseStart ?? -1,
        responseEnd: opts.responseEnd ?? -1,
      }),
      response: async () => response,
      failure: () => (opts.errorText ? { errorText: opts.errorText } : null),
    };
    const response =
      opts.status != null
        ? {
            status: () => opts.status,
            headers: () => ({ 'content-type': 'application/json', ...opts.headers }),
            serverAddr: async () => (opts.fulfilled ? null : { ipAddress: '127.0.0.1', port: 443 }),
            request: () => request,
          }
        : null;
    return { request, response };
  };

  const fakeRequest = (opts: FakeExchangeOptions) => fakeExchange(opts).request;

  /** Backend logs as an instrumentation sends them in `X-Piwi-Logs`: gzipped JSON, base64 encoded. */
  const backendLogs = [{ level: 'error', message: 'Unhandled exception', timestamp: startTime + 3 }];
  const logsHeader = { 'x-piwi-logs': gzipSync(JSON.stringify(backendLogs)).toString('base64') };

  it('records a failed request with status 0 and its error text', async () => {
    const requests = await runNetwork((emit) => {
      emit('requestfailed', fakeRequest({ url: 'https://shop.test/api/cart', errorText: 'net::ERR_CONNECTION_RESET' }));
    });
    expect(requests).toHaveLength(1);
    expect(requests![0]).toMatchObject({
      method: 'GET',
      url: 'https://shop.test/api/cart',
      status: 0,
      failure: 'net::ERR_CONNECTION_RESET',
      startTime,
      resourceType: 'fetch',
    });
    // Without a response end, the duration runs until the failure was seen.
    expect(requests![0]!.duration).toBeGreaterThanOrEqual(2_000);
  });

  it('records finished and failed requests side by side, without a failure on the finished one', async () => {
    const requests = await runNetwork((emit) => {
      emit('requestfinished', fakeRequest({ url: 'https://shop.test/api/products', responseEnd: 105, status: 200 }));
      emit(
        'requestfailed',
        fakeRequest({ url: 'https://shop.test/api/orders', method: 'POST', errorText: 'net::ERR_CONNECTION_REFUSED' }),
      );
    });
    expect(requests).toHaveLength(2);
    const finished = requests!.find((r) => r.url === 'https://shop.test/api/products')!;
    expect(finished.status).toBe(200);
    expect(finished.duration).toBe(100);
    expect(finished).not.toHaveProperty('failure');
    const failed = requests!.find((r) => r.url === 'https://shop.test/api/orders')!;
    expect(failed).toMatchObject({ method: 'POST', status: 0, failure: 'net::ERR_CONNECTION_REFUSED' });
  });

  it('marks a response no server sent, the one a test fulfills itself', async () => {
    const requests = await runNetwork((emit) => {
      emit('requestfinished', fakeRequest({ url: 'https://shop.test/api/real', responseEnd: 40, status: 500 }));
      emit(
        'requestfinished',
        fakeRequest({ url: 'https://shop.test/api/mocked', responseEnd: 40, status: 500, fulfilled: true }),
      );
    });
    expect(requests!.find((r) => r.url === 'https://shop.test/api/real')).not.toHaveProperty('fulfilled');
    expect(requests!.find((r) => r.url === 'https://shop.test/api/mocked')).toMatchObject({
      status: 500,
      fulfilled: true,
    });
  });

  it('skips requests the page cancelled before any response, in every browser', async () => {
    const requests = await runNetwork((emit) => {
      for (const errorText of ['net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'Load request cancelled', 'cancelled']) {
        emit('requestfailed', fakeRequest({ url: `https://shop.test/api/search?q=${errorText}`, errorText }));
      }
      emit('requestfailed', fakeRequest({ url: 'https://shop.test/api/cart', errorText: 'net::ERR_FAILED' }));
    });
    expect(requests!.map((r) => r.url)).toEqual(['https://shop.test/api/cart']);
  });

  it('records a response the page cancelled once it arrived, with its status and backend logs, timed to its headers', async () => {
    const requests = await runNetwork((emit) => {
      for (const [path, status] of [
        ['/api/failing', 500],
        ['/api/missing', 404],
      ] as const) {
        const { request, response } = fakeExchange({
          url: `https://shop.test${path}`,
          status,
          responseStart: 25,
          // The moment of the cancel, not the end of the response.
          responseEnd: 1_800,
          errorText: 'net::ERR_ABORTED',
          headers: logsHeader,
        });
        emit('response', response);
        emit('requestfailed', request);
      }
    });
    expect(requests).toHaveLength(2);
    for (const [path, status] of [
      ['/api/failing', 500],
      ['/api/missing', 404],
    ] as const) {
      const request = requests!.find((r) => r.url === `https://shop.test${path}`)!;
      expect(request).toMatchObject({ method: 'GET', status, startTime, serverLogs: backendLogs, duration: 20 });
      expect(request).not.toHaveProperty('failure');
    }
  });

  it('records a response still open when the test ends, timed to its headers', async () => {
    const requests = await runNetwork((emit) => {
      const { response } = fakeExchange({
        url: 'https://shop.test/api/failing',
        status: 500,
        responseStart: 25,
        headers: { ...logsHeader, 'cache-control': 'no-store' },
      });
      emit('response', response);
      // A static asset still loading is not tracked, open or not.
      const logo = fakeExchange({ url: 'https://shop.test/logo.png', resourceType: 'image', status: 200 });
      emit('response', logo.response);
    });
    expect(requests).toHaveLength(1);
    expect(requests![0]).toMatchObject({
      url: 'https://shop.test/api/failing',
      status: 500,
      contentType: 'application/json',
      serverLogs: backendLogs,
      startTime,
      duration: 20,
    });
    expect(requests![0]).not.toHaveProperty('failure');
  });

  it('records a response that finished once, timed to its end', async () => {
    const requests = await runNetwork((emit) => {
      const { request, response } = fakeExchange({
        url: 'https://shop.test/api/products',
        status: 200,
        responseStart: 25,
        responseEnd: 105,
      });
      emit('response', response);
      emit('requestfinished', request);
    });
    expect(requests).toHaveLength(1);
    expect(requests![0]).toMatchObject({ status: 200, duration: 100 });
  });

  it('records a request still open at a test end in that test only, whatever arrives later', async () => {
    const target = fakeNetworkPage();
    const { request, response } = fakeExchange({
      url: 'https://shop.test/api/stream',
      status: 200,
      responseStart: 25,
      responseEnd: 4_000,
    });
    const first = await runNetworkOn(target, (emit) => emit('response', response));
    expect(first).toHaveLength(1);
    expect(first![0]).toMatchObject({ url: 'https://shop.test/api/stream', status: 200, duration: 20 });
    expect(await runNetworkOn(target, (emit) => emit('requestfinished', request))).toBeNull();
  });

  it('keeps the coverage id of a response that never finished', async () => {
    const saved = process.env.PIWI_COVERAGE_SERVER;
    process.env.PIWI_COVERAGE_SERVER = 'lines';
    try {
      const ids = await runNetwork((emit) => {
        const { response } = fakeExchange({
          url: 'https://shop.test/api/failing',
          status: 500,
          responseStart: 25,
          headers: { 'x-piwi-coverage': 'k1.9' },
        });
        emit('response', response);
      }, ATTACHMENT_NAMES.serverCoverageRequests);
      expect(ids).toEqual({ 'https://shop.test': ['k1.9'] });
    } finally {
      if (saved === undefined) delete process.env.PIWI_COVERAGE_SERVER;
      else process.env.PIWI_COVERAGE_SERVER = saved;
    }
  });

  describe('server coverage request ids', () => {
    const saved = process.env.PIWI_COVERAGE_SERVER;
    afterEach(() => {
      if (saved === undefined) delete process.env.PIWI_COVERAGE_SERVER;
      else process.env.PIWI_COVERAGE_SERVER = saved;
    });

    const fireCoverage = (emit: (event: string, request: unknown) => void) => {
      const finished = (url: string, id: string) =>
        emit('requestfinished', fakeRequest({ url, responseEnd: 10, status: 200, headers: { 'x-piwi-coverage': id } }));
      finished('https://shop.test/', 'k1.1');
      finished('https://shop.test/api/basket', 'k1.2');
      finished('https://shop.test/api/basket', 'k1.2');
      finished('https://api.shop.test/orders', 'k2.7');
      finished('https://shop.test/api/long', 'x'.repeat(129));
      finished('https://shop.test/api/two', 'k1.3, k1.4');
      emit('requestfinished', fakeRequest({ url: 'https://shop.test/api/plain', responseEnd: 10, status: 200 }));
    };

    it('keeps each id once, per origin, while server coverage is on', async () => {
      process.env.PIWI_COVERAGE_SERVER = 'lines';
      const requests = await runNetwork(fireCoverage, ATTACHMENT_NAMES.serverCoverageRequests);
      expect(requests).toEqual({
        'https://shop.test': ['k1.1', 'k1.2', 'k1.3', 'k1.4'],
        'https://api.shop.test': ['k2.7'],
      });
    });

    it('records nothing while server coverage is off', async () => {
      delete process.env.PIWI_COVERAGE_SERVER;
      expect(await runNetwork(fireCoverage, ATTACHMENT_NAMES.serverCoverageRequests)).toBeNull();
      process.env.PIWI_COVERAGE_SERVER = 'off';
      expect(await runNetwork(fireCoverage, ATTACHMENT_NAMES.serverCoverageRequests)).toBeNull();
    });
  });

  it('skips failed static assets, as it does finished ones', async () => {
    const requests = await runNetwork((emit) => {
      emit(
        'requestfailed',
        fakeRequest({ url: 'https://shop.test/logo.png', resourceType: 'image', errorText: 'net::ERR_FAILED' }),
      );
    });
    expect(requests).toBeNull();
  });
});

describe('network capture in Chromium', () => {
  let browser: Browser | null = null;
  let server: http.Server;
  let origin = '';

  const encoded = (value: unknown) => gzipSync(JSON.stringify(value)).toString('base64');
  const logsOf = (path: string) => [{ level: 'error', message: `Request ${path} failed`, timestamp: 1 }];
  const failingSpan = { name: 'GET /api/failing', kind: 'server', start: 1, end: 2, status: 'error' };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>Shop</title>');
        return;
      }
      if (path === '/api/slow') {
        setTimeout(() => res.end('{}'), 2_000);
        return;
      }
      res.setHeader('X-Piwi-Logs', encoded(logsOf(path)));
      if (path === '/api/failing') {
        // An unhandled exception as ASP.NET Core answers it: a JSON problem no cache may keep.
        res.statusCode = 500;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/problem+json');
        res.setHeader('X-Piwi-Trace', encoded([failingSpan]));
        res.end(JSON.stringify({ title: 'An error occurred while processing your request.', status: 500 }));
        return;
      }
      res.statusCode = path === '/api/missing' ? 404 : 500;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      browser = await chromium.launch();
    } catch {
      browser = null;
    }
  });

  afterAll(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Run one test through the capture fixtures on a new context: `body` drives
   * the page, then the context closes, as Playwright's own fixture closes it
   * before the capture fixture tears down. Returns the recorded requests.
   */
  async function captureTest(body: (page: Page) => Promise<void>): Promise<Array<Record<string, unknown>>> {
    const context = await browser!.newContext();
    const page = await context.newPage();
    const testInfo = {
      status: 'passed',
      attach: vi.fn(async (_name: string, _body: { body: Buffer }) => {}),
      annotations: [],
    };
    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: Page },
      use: (page: Page) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];
    await captureFixture(
      {},
      async () => {
        await pageFixture({ page }, body);
        await context.close();
      },
      testInfo,
    );
    const call = testInfo.attach.mock.calls.find((c) => c[0] === ATTACHMENT_NAMES.network);
    return call ? (JSON.parse(call[1].body.toString()) as Array<Record<string, unknown>>) : [];
  }

  /** The recorded requests to `path`. */
  const to = (requests: Array<Record<string, unknown>>, path: string) =>
    requests.filter((r) => r.url === `${origin}${path}`);

  it('records an unread no-store error response, which never finishes, with its logs and span', async (ctx) => {
    if (!browser) return ctx.skip();
    const requests = await captureTest(async (page) => {
      await page.goto(origin);
      await Promise.all([page.waitForResponse('**/api/failing'), page.evaluate("void fetch('/api/failing')")]);
      // Long enough that a duration running to the test's end would show.
      await page.waitForTimeout(500);
    });
    const failing = to(requests, '/api/failing');
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({
      method: 'GET',
      status: 500,
      resourceType: 'fetch',
      contentType: 'application/problem+json',
      serverLogs: logsOf('/api/failing'),
      serverTraces: [failingSpan],
    });
    expect(failing[0]).not.toHaveProperty('failure');
    expect(failing[0]!.duration).toBeGreaterThanOrEqual(0);
    expect(failing[0]!.duration).toBeLessThan(500);
  });

  it('records unread empty-bodied error responses, which Chromium fails as aborted, with their logs', async (ctx) => {
    if (!browser) return ctx.skip();
    const requests = await captureTest(async (page) => {
      await page.goto(origin);
      for (const path of ['/api/empty', '/api/missing']) {
        await Promise.all([
          page.waitForEvent('requestfailed', (request) => request.url().endsWith(path)),
          page.evaluate(`void fetch('${path}')`),
        ]);
      }
    });
    for (const [path, status] of [
      ['/api/empty', 500],
      ['/api/missing', 404],
    ] as const) {
      const recorded = to(requests, path);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ method: 'GET', status, resourceType: 'fetch', serverLogs: logsOf(path) });
      expect(recorded[0]).not.toHaveProperty('failure');
    }
  });

  it('still drops a request the page cancelled before any response', async (ctx) => {
    if (!browser) return ctx.skip();
    const requests = await captureTest(async (page) => {
      await page.goto(origin);
      await Promise.all([
        page.waitForEvent('requestfailed', (request) => request.url().endsWith('/api/slow')),
        page.evaluate(
          "const c = new AbortController(); fetch('/api/slow', { signal: c.signal }).catch(() => {}); setTimeout(() => c.abort(), 50)",
        ),
      ]);
    });
    expect(to(requests, '/api/slow')).toEqual([]);
    expect(to(requests, '/')).toHaveLength(1);
  });
});

describe('failure-page screenshot', () => {
  /** A fake page whose screenshot bytes are its name; closing it marks it closed. */
  function fakeShotPage(name: string) {
    let closed = false;
    const rootLocator = { ariaSnapshot: async () => null };
    const factory = (_selector?: string) => ({ click: async () => {}, evaluate: async () => null });
    return {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: (sel: string) => (sel === ':root' ? rootLocator : factory()),
      on: () => {},
      evaluate: async () => null,
      screenshot: vi.fn(async (_options?: unknown) => Buffer.from(name)),
      isClosed: () => closed,
      close: async () => {
        closed = true;
      },
    };
  }
  type ShotPage = ReturnType<typeof fakeShotPage>;

  /**
   * Run the capture fixture around two pages and `body`, with Playwright's
   * `screenshot` option, and return the failure-page screenshot it attached.
   */
  async function runShot(
    screenshot: unknown,
    body: (first: ShotPage, second: ShotPage) => Promise<void>,
    info: { status?: string; retry?: number } = {},
  ): Promise<{ shot: string | null; first: ShotPage; second: ShotPage }> {
    const first = fakeShotPage('first page');
    const second = fakeShotPage('second page');
    const testInfo = {
      status: info.status ?? 'failed',
      retry: info.retry ?? 0,
      attach: vi.fn(async (_name: string, _body: { body: Buffer; contentType: string }) => {}),
      annotations: [],
    };
    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: ShotPage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: { screenshot: unknown }, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];

    await captureFixture(
      { screenshot },
      () => pageFixture({ page: first }, () => pageFixture({ page: second }, () => body(first, second))),
      testInfo,
    );

    const call = testInfo.attach.mock.calls.find((c) => c[0] === FAILURE_SCREENSHOT_ATTACHMENT);
    if (call) expect(call[1].contentType).toBe('image/png');
    return { shot: call ? call[1].body.toString() : null, first, second };
  }

  it('attaches the page the test last acted on, not the last page opened', async () => {
    const { shot, second } = await runShot('only-on-failure', async (first) => {
      await first.getByTestId('save').click();
    });
    expect(shot).toBe('first page');
    expect(second.screenshot).not.toHaveBeenCalled();
  });

  it('takes it before a close takes the page with it', async () => {
    const { shot } = await runShot('only-on-failure', async (first) => {
      await first.getByTestId('save').click();
      await first.close();
    });
    expect(shot).toBe('first page');
  });

  it('passes the option’s fullPage through, as Playwright does for its own', async () => {
    const { first } = await runShot({ mode: 'on', fullPage: true }, async (page) => {
      await page.getByTestId('save').click();
    });
    expect(first.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true, caret: 'initial' }));
  });

  it('takes none when Playwright keeps no screenshot of this failure', async () => {
    const act = async (first: ShotPage) => {
      await first.getByTestId('save').click();
    };
    expect((await runShot('off', act)).shot).toBeNull();
    expect((await runShot(undefined, act)).shot).toBeNull();
    expect((await runShot('on-first-failure', act, { retry: 1 })).shot).toBeNull();
  });

  it('takes none for a passing test', async () => {
    const { shot, first } = await runShot(
      'on',
      async (page) => {
        await page.getByTestId('save').click();
      },
      { status: 'passed' },
    );
    expect(shot).toBeNull();
    expect(first.screenshot).not.toHaveBeenCalled();
  });
});

describe('keepsFailureScreenshots', () => {
  it('follows the modes that keep a failed attempt’s screenshots', () => {
    expect(keepsFailureScreenshots('on', 0)).toBe(true);
    expect(keepsFailureScreenshots('only-on-failure', 2)).toBe(true);
    expect(keepsFailureScreenshots({ mode: 'only-on-failure', fullPage: true }, 0)).toBe(true);
    expect(keepsFailureScreenshots('on-first-failure', 0)).toBe(true);
    expect(keepsFailureScreenshots('on-first-failure', 1)).toBe(false);
    expect(keepsFailureScreenshots('off', 0)).toBe(false);
    expect(keepsFailureScreenshots(undefined, 0)).toBe(false);
  });
});

describe('configuredCodeReachRoots', () => {
  afterEach(() => {
    delete process.env.PIWI_CODE_REACH_ROOTS;
  });

  it('reads a JSON array, a JSON object per origin, or a path list', () => {
    expect(configuredCodeReachRoots()).toBeNull();
    process.env.PIWI_CODE_REACH_ROOTS = JSON.stringify(['app', '', 3]);
    expect(configuredCodeReachRoots()).toEqual(['app']);
    process.env.PIWI_CODE_REACH_ROOTS = JSON.stringify({ 'http://localhost:5281': 'admin', '*': ['app', 1] });
    expect(configuredCodeReachRoots()).toEqual({ 'http://localhost:5281': ['admin'], '*': ['app'] });
    process.env.PIWI_CODE_REACH_ROOTS = ['app', 'lib'].join(path.delimiter);
    expect(configuredCodeReachRoots()).toEqual(['app', 'lib']);
  });
});
