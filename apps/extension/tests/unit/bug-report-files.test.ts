import { describe, it, expect, beforeEach } from 'vitest';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { bugContextFrom, bugReportFromFiles, isBugReportArchive } from '@piwitests/core/bug-report';
import { bugPhrases } from '@piwitests/core/bug-phrases';
import {
  assembleBugReport,
  bugReportArchive,
  bugReportEntries,
  bugReportMarkdown,
  NO_SCREENSHOT_TAKEN,
  specFileName,
  stepViewIds,
  withoutStepShots,
} from '../../src/content/bug-report-files.js';
import {
  addBugScreenshot,
  appendBugEntries,
  getBugEvidence,
  getBugScreenshots,
  type StoredBugEvidence,
} from '../../src/shared/bug-storage.js';
import { BUG_RELAY, readRelayedEntry } from '../../src/shared/bug-relay.js';
import { createZip, readZipEntry } from '../../src/shared/zip.js';

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

const ORIGIN = 'https://shop.test';

function ev(overrides: Partial<RawCaptureEvent>): RawCaptureEvent {
  return {
    kind: 'click',
    target: null,
    value: null,
    checked: null,
    inputType: null,
    isPasswordField: false,
    pageUrl: `${ORIGIN}/cart`,
    timestamp: 1,
    ...overrides,
  };
}

const evidence: StoredBugEvidence = {
  console: [],
  consoleDropped: 0,
  requests: [],
  requestsDropped: 0,
  outline: '- main',
  screenshotNote: null,
  title: '  Coupon: not applied!  ',
  context: null,
  screenshots: 0,
};

const context = bugContextFrom({
  url: `${ORIGIN}/cart`,
  userAgent: null,
  viewport: null,
  time: 5,
  extensionVersion: null,
});

describe('assembleBugReport', () => {
  it('turns the recording into a steps document with the title, and names its screenshots', () => {
    const report = assembleBugReport({
      events: [
        ev({ kind: 'navigate', value: `${ORIGIN}/cart` }),
        ev({
          kind: 'assert',
          target: null,
          assertion: { matcher: 'toHaveURL', expected: '/thanks', actual: '/cart', negated: false, note: null },
        }),
      ],
      startedAt: 1,
      evidence,
      screenshots: [
        { moment: 'marked', step: 1, takenAt: 2, dataUrl: 'data:image/png;base64,AA==' },
        { moment: 'finish', step: 1, takenAt: 3, dataUrl: 'data:image/png;base64,AQ==' },
      ],
      context,
    });
    expect(report.steps).toMatchObject({ v: 1, title: 'Coupon: not applied!', origin: ORIGIN });
    expect(report.steps.steps.map((s) => s.action)).toEqual(['goto', 'assert']);
    expect(report.evidence.screenshots.map((s) => s.file)).toEqual([
      'screenshots/1-marked.png',
      'screenshots/2-finish.png',
    ]);
    expect(report.evidence.screenshotNote).toBeNull();
    expect(specFileName(report)).toBe('coupon-not-applied.spec.ts');
  });

  it('says why there is no screenshot', () => {
    const report = assembleBugReport({ events: [], startedAt: 1, evidence, screenshots: [], context });
    expect(report.evidence.screenshotNote).toBe(NO_SCREENSHOT_TAKEN);
    const withNote = assembleBugReport({
      events: [],
      startedAt: 1,
      evidence: { ...evidence, screenshotNote: 'no grant', title: null },
      screenshots: [],
      context,
    });
    expect(withNote.evidence.screenshotNote).toBe('no grant');
    expect(specFileName(withNote)).toBe('bug-on-cart.spec.ts');
  });

  it('keeps the screenshot of each step the worker kept, named after the step, and leaves them out on request', () => {
    const view = (id: string) => ({ id, box: { x: 1, y: 2, width: 3, height: 4 } });
    const events = [
      ev({ kind: 'navigate', value: `${ORIGIN}/cart`, timestamp: 1 }),
      ev({ kind: 'click', target: null, timestamp: 2, view: view('v1') }),
      ev({ kind: 'click', target: null, timestamp: 3, view: view('gone') }),
    ];
    expect(stepViewIds(events)).toEqual(['v1', 'gone']);
    const views = [
      { id: 'v1', dataUrl: 'data:image/jpeg;base64,AAEC', takenAt: 7, viewport: { width: 800, height: 600 } },
    ];
    const report = assembleBugReport({ events, startedAt: 1, evidence, screenshots: [], context, views });
    expect(report.evidence.stepShots).toEqual([
      { step: 1, file: 'steps/002.jpg', box: view('v1').box, viewport: { width: 800, height: 600 }, takenAt: 7 },
    ]);
    const images = new Map([['steps/002.jpg', views[0]!.dataUrl]]);
    const names = bugReportEntries(report, [], undefined, images).map((e) => e.name);
    expect(names).toContain('steps/002.jpg');
    expect(withoutStepShots(report).evidence).not.toHaveProperty('stepShots');
    expect(bugReportEntries(withoutStepShots(report), [], undefined, images).map((e) => e.name)).not.toContain(
      'steps/002.jpg',
    );
    expect(assembleBugReport({ events, startedAt: 1, evidence, screenshots: [], context }).evidence).not.toHaveProperty(
      'stepShots',
    );
  });

  it('puts the steps, the test, the Markdown, the evidence and the screenshots in the archive', () => {
    const shots = [{ moment: 'marked' as const, step: 0, takenAt: 2, dataUrl: 'data:image/png;base64,AAEC' }];
    const report = assembleBugReport({
      events: [ev({ kind: 'navigate', value: `${ORIGIN}/cart` })],
      startedAt: 1,
      evidence,
      screenshots: shots,
      context,
    });
    const entries = bugReportEntries(report, shots);
    expect(entries.map((e) => e.name)).toEqual([
      'mimetype',
      'steps.json',
      'coupon-not-applied.spec.ts',
      'bug-report.md',
      'evidence.json',
      'screenshots/1-marked.png',
    ]);
    expect(entries[0]!.data).toBe('application/vnd.piwi.bug-report+zip');
    expect([...(entries[5]!.data as Uint8Array)]).toEqual([0, 1, 2]);
    expect(JSON.parse(entries[4]!.data as string)).toMatchObject({ v: 1, context: { pageKey: '/cart' } });
  });

  it('writes an archive whose first bytes say it is a bug report, read back as the same report', async () => {
    const report = assembleBugReport({
      events: [ev({ kind: 'navigate', value: `${ORIGIN}/cart` })],
      startedAt: 1,
      evidence,
      screenshots: [],
      context,
    });
    const archive = bugReportArchive(report, []);
    expect(isBugReportArchive(archive)).toBe(true);
    expect(isBugReportArchive(createZip([{ name: 'steps.json', data: '{}' }]))).toBe(false);
    const text = async (name: string) => new TextDecoder().decode((await readZipEntry(archive, name))!);
    const read = bugReportFromFiles({ steps: await text('steps.json'), evidence: await text('evidence.json') });
    expect(read).toEqual({ ok: true, report });
  });
});

describe('bugReportMarkdown', () => {
  const report = () =>
    assembleBugReport({
      events: [
        ev({ kind: 'navigate', value: `${ORIGIN}/cart` }),
        ev({
          kind: 'assert',
          target: null,
          assertion: { matcher: 'toHaveURL', expected: '/thanks', actual: '/cart', negated: false, note: null },
        }),
      ],
      startedAt: 1,
      evidence: { ...evidence, title: null },
      screenshots: [],
      context,
    });

  it('writes the report in English by default, the stored note as it is', () => {
    const markdown = bugReportMarkdown(report());
    expect(markdown).toContain('## Steps to reproduce');
    expect(markdown).toContain('2. The page should be `/thanks`');
    expect(markdown).toContain(`No screenshot: ${NO_SCREENSHOT_TAKEN}`);
  });

  it('writes it in the language it is given, the note in that language, steps.json and the test unchanged', () => {
    const french = { phrases: bugPhrases('fr'), screenshotNote: () => 'aucune n’a été prise' };
    const markdown = bugReportMarkdown(report(), french);
    expect(markdown).toContain('# Bug sur /cart');
    expect(markdown).toContain('2. La page devrait être `/thanks`');
    expect(markdown).toContain('Aucune capture d’écran\u00a0: aucune n’a été prise');
    const [, steps, spec] = bugReportEntries(report(), [], french);
    const [, englishSteps, englishSpec] = bugReportEntries(report(), []);
    expect(steps).toEqual(englishSteps);
    expect(spec).toEqual(englishSpec);
  });
});

describe('bug evidence storage', () => {
  it('keeps the first 100 entries of each kind and counts the rest', async () => {
    const entry = { level: 'error' as const, source: 'console' as const, message: 'x', page: '/', time: 1 };
    await appendBugEntries({ console: Array.from({ length: 60 }, () => entry) });
    await appendBugEntries({ console: Array.from({ length: 60 }, () => entry) });
    const stored = await getBugEvidence();
    expect(stored.console).toHaveLength(100);
    expect(stored.consoleDropped).toBe(20);
  });

  it('keeps three screenshots, the latest replacing the last', async () => {
    for (let i = 0; i < 5; i++) {
      await addBugScreenshot({ moment: i === 4 ? 'finish' : 'marked', step: i, takenAt: i, dataUrl: 'data:,' });
    }
    expect((await getBugScreenshots()).map((s) => s.step)).toEqual([0, 1, 4]);
    expect((await getBugEvidence()).screenshots).toBe(3);
  });
});

describe('readRelayedEntry', () => {
  const token = 't'.repeat(32);
  const message = (item: unknown, t = token) => ({ source: BUG_RELAY.ENTRY, token: t, item });

  it('reads an entry carrying the recording’s token', () => {
    expect(
      readRelayedEntry(
        message({ kind: 'request', entry: { method: 'post', url: '/api', status: 500, page: '/', time: 3 } }),
        token,
      ),
    ).toEqual({ kind: 'request', entry: { method: 'POST', url: '/api', status: 500, page: '/', time: 3 } });
  });

  it('drops an entry with another token, another source, or an unknown kind', () => {
    const item = { kind: 'console', entry: { level: 'error', message: 'x' } };
    expect(readRelayedEntry(message(item, 'other'), token)).toBeNull();
    expect(readRelayedEntry({ ...message(item), source: 'page' }, token)).toBeNull();
    expect(readRelayedEntry(message({ kind: 'cookie', entry: {} }), token)).toBeNull();
    expect(readRelayedEntry('text', token)).toBeNull();
  });

  it('keeps only known fields, truncated', () => {
    const read = readRelayedEntry(
      message({ kind: 'console', entry: { level: 'fatal', source: 'x', message: 'm'.repeat(900), extra: 1 } }),
      token,
    );
    if (read?.kind !== 'console') throw new Error('expected a console entry');
    expect(read.entry).toMatchObject({ level: 'error', source: 'console', page: '' });
    expect(read.entry.message).toHaveLength(500);
    expect(read.entry).not.toHaveProperty('extra');
  });
});
