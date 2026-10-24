import { describe, it, expect } from 'vitest';
import type { RecordedStep, StepAssertion } from '@piwitests/core/recording';
import { toStepsDocument } from '@piwitests/core/steps';
import {
  evidenceLines,
  absoluteUrl,
  chooseElement,
  createWaker,
  evaluateAssertion,
  replayVerdict,
  STEP_WAIT_MAX_MS,
  stepTimeout,
  verdictText,
  type LocatorLook,
  type Observation,
} from '../../src/content/replay-core.js';
import { readReportFile, readStepsFile } from '../../src/content/steps-file.js';
import { BUG_REPORT_MEDIA_TYPE, emptyBugEvidence } from '@piwitests/core/bug-report';
import { createZip } from '../../src/shared/zip.js';
import { setBrowserLanguage } from './setup-i18n.js';

const ORIGIN = 'http://localhost:3000';

function seen(overrides: Partial<Observation> = {}): Observation {
  return {
    count: 1,
    text: '  Total:\n 40 ',
    value: null,
    name: 'Total',
    visible: true,
    enabled: true,
    checked: false,
    url: `${ORIGIN}/cart`,
    ...overrides,
  };
}

function expecting(matcher: StepAssertion['matcher'], expected: string | null = null, negated = false): StepAssertion {
  return { matcher, expected, actual: null, negated, note: null };
}

describe('evaluateAssertion', () => {
  it('compares text whole, with whitespace collapsed, as Playwright does', () => {
    expect(evaluateAssertion(expecting('toHaveText', 'Total: 40'), seen(), ORIGIN)).toEqual({
      holds: true,
      found: '"Total: 40"',
    });
    expect(evaluateAssertion(expecting('toHaveText', 'Total: 42'), seen(), ORIGIN)).toEqual({
      holds: false,
      found: '"Total: 40"',
    });
    expect(evaluateAssertion(expecting('toHaveText', 'Total'), seen(), ORIGIN).holds).toBe(false);
  });

  it('checks values exactly, names like text, and states', () => {
    expect(evaluateAssertion(expecting('toHaveValue', 'SPRING10'), seen({ value: 'SPRING10' }), ORIGIN).holds).toBe(
      true,
    );
    expect(evaluateAssertion(expecting('toHaveValue', 'SPRING10'), seen({ value: 'spring10' }), ORIGIN).holds).toBe(
      false,
    );
    expect(evaluateAssertion(expecting('toHaveAccessibleName', 'Total'), seen(), ORIGIN).holds).toBe(true);
    expect(evaluateAssertion(expecting('toBeDisabled'), seen(), ORIGIN)).toEqual({ holds: false, found: 'enabled' });
    expect(evaluateAssertion(expecting('toBeVisible', null, true), seen(), ORIGIN).holds).toBe(false);
  });

  it('takes an element that is not there as hidden, and never as visible or as any text', () => {
    const gone = seen({ count: 0 });
    expect(evaluateAssertion(expecting('toBeVisible'), gone, ORIGIN)).toEqual({
      holds: false,
      found: 'nothing on the page',
    });
    expect(evaluateAssertion(expecting('toBeHidden'), gone, ORIGIN).holds).toBe(true);
    expect(evaluateAssertion(expecting('toHaveText', ''), gone, ORIGIN).holds).toBe(false);
    expect(evaluateAssertion(expecting('toHaveText', 'x'), seen({ count: 3 }), ORIGIN).found).toBe('3 elements');
  });

  it('compares a URL in full, a path joined to the replay origin', () => {
    expect(absoluteUrl('/thanks', ORIGIN)).toBe(`${ORIGIN}/thanks`);
    expect(evaluateAssertion(expecting('toHaveURL', '/thanks'), seen({ url: `${ORIGIN}/thanks` }), ORIGIN).holds).toBe(
      true,
    );
    expect(evaluateAssertion(expecting('toHaveURL', '/thanks'), seen(), ORIGIN)).toEqual({
      holds: false,
      found: `${ORIGIN}/cart`,
    });
  });

  it('finds a text inside, counts every element, and checks a checked state', () => {
    expect(evaluateAssertion(expecting('toContainText', 'Total'), seen(), ORIGIN)).toEqual({
      holds: true,
      found: '"Total: 40"',
    });
    expect(evaluateAssertion(expecting('toContainText', 'Total: 4 2'), seen(), ORIGIN).holds).toBe(false);
    expect(evaluateAssertion(expecting('toHaveCount', '3'), seen({ count: 3 }), ORIGIN)).toEqual({
      holds: true,
      found: '3 elements',
    });
    expect(evaluateAssertion(expecting('toHaveCount', '3'), seen({ count: 1 }), ORIGIN)).toEqual({
      holds: false,
      found: '1 element',
    });
    expect(evaluateAssertion(expecting('toHaveCount', '0'), seen({ count: 0 }), ORIGIN)).toEqual({
      holds: true,
      found: 'nothing on the page',
    });
    expect(evaluateAssertion(expecting('toBeChecked'), seen(), ORIGIN)).toEqual({ holds: false, found: 'not checked' });
    expect(evaluateAssertion(expecting('toBeChecked'), seen({ checked: true }), ORIGIN).holds).toBe(true);
    expect(evaluateAssertion(expecting('toBeChecked', null, true), seen(), ORIGIN).holds).toBe(true);
  });

  it('says a count it found as reported when it is the count the report gives', () => {
    const counted: RecordedStep = {
      action: 'assert',
      target: null,
      value: null,
      redacted: false,
      pageUrl: '/cart',
      timestamp: 0,
      assertion: { matcher: 'toHaveCount', expected: '3', actual: '1', negated: false, note: null },
    };
    expect(replayVerdict([counted], [{ status: 'failed', detail: null, found: '1 element' }], false)).toMatchObject({
      sameAsReported: true,
    });
  });

  it('says what it found in the interface language, page texts quoted its way and never changed', () => {
    setBrowserLanguage('fr');
    expect(evaluateAssertion(expecting('toHaveText', 'Total: 42'), seen(), ORIGIN).found).toBe(
      '«\u202fTotal: 40\u202f»',
    );
    expect(evaluateAssertion(expecting('toBeVisible'), seen({ count: 0 }), ORIGIN).found).toBe(
      'aucun élément sur la page',
    );
    expect(evaluateAssertion(expecting('toHaveText', 'x'), seen({ count: 3 }), ORIGIN).found).toBe('3 éléments');
    expect(evaluateAssertion(expecting('toBeDisabled'), seen(), ORIGIN).found).toBe('activé');
    expect(evaluateAssertion(expecting('toBeVisible'), seen({ visible: false }), ORIGIN).found).toBe('masqué');
  });
});

describe('replayVerdict', () => {
  const click: RecordedStep = {
    action: 'click',
    target: null,
    value: null,
    redacted: false,
    pageUrl: '/cart',
    timestamp: 0,
  };
  const check: RecordedStep = {
    ...click,
    action: 'assert',
    assertion: { matcher: 'toHaveText', expected: 'Total: 42', actual: 'Total: 40', negated: false, note: null },
  };

  it('is reproduced when an expected result does not hold, and says when it is the value reported', () => {
    const verdict = replayVerdict(
      [click, check],
      [
        { status: 'done', detail: null },
        { status: 'failed', detail: null, found: '"Total: 40"' },
      ],
      false,
    );
    expect(verdict).toEqual({ kind: 'reproduced', step: 1, found: '"Total: 40"', sameAsReported: true });
    expect(verdictText(verdict, [click, check]).detail).toBe(
      'Step 2: expected "Total: 42", found "Total: 40", as reported.',
    );
  });

  it('says the verdict in French, with the report texts quoted the French way', () => {
    setBrowserLanguage('fr');
    const found = evaluateAssertion(check.assertion!, seen(), ORIGIN).found;
    const verdict = replayVerdict(
      [click, check],
      [
        { status: 'done', detail: null },
        { status: 'failed', detail: null, found },
      ],
      false,
    );
    expect(verdict).toEqual({ kind: 'reproduced', step: 1, found: '«\u202fTotal: 40\u202f»', sameAsReported: true });
    expect(verdictText(verdict, [click, check])).toEqual({
      title: 'Reproduit\u00a0: le bug est visible ici',
      detail: 'Étape 2\u00a0: attendu «\u202fTotal: 42\u202f», résultat\u00a0: «\u202fTotal: 40\u202f», comme signalé.',
    });
    expect(verdictText({ kind: 'diverged', step: 2, reason: 'Aucun élément.' }, [click, check]).title).toBe(
      'Impossible d’atteindre le bug\u00a0: arrêt à l’étape 3',
    );
    expect(verdictText({ kind: 'not-reproduced' }, [click, check]).title).toBe('Non reproduit');
  });

  it('says a state it found, with nothing expected to quote', () => {
    const visible: RecordedStep = { ...click, action: 'assertVisible' };
    expect(verdictText({ kind: 'reproduced', step: 0, found: 'hidden', sameAsReported: false }, [visible]).detail).toBe(
      'Step 1: found hidden.',
    );
    expect(verdictText({ kind: 'stopped', step: 1 }, [visible])).toEqual({
      title: 'Stopped',
      detail: 'Stopped before step 2.',
    });
  });

  it('is not reproduced when every expected result holds, and completed with nothing expected', () => {
    const passed = [
      { status: 'done' as const, detail: null },
      { status: 'passed' as const, detail: null },
    ];
    expect(replayVerdict([click, check], passed, false)).toEqual({ kind: 'not-reproduced' });
    expect(replayVerdict([click], [passed[0]!], false)).toEqual({ kind: 'completed' });
  });

  it('is diverged when a step could not be done, whatever came after', () => {
    expect(replayVerdict([click, check], [{ status: 'diverged', detail: 'Nothing matches.' }], false)).toEqual({
      kind: 'diverged',
      step: 0,
      reason: 'Nothing matches.',
    });
  });

  it('says a page reached as reported when it is the address the report gives, on the replay’s origin', () => {
    const page: RecordedStep = {
      ...click,
      action: 'assert',
      assertion: { matcher: 'toHaveURL', expected: '/thanks', actual: '/cart?step=2', negated: false, note: null },
    };
    const found = (url: string) => [
      { status: 'done' as const, detail: null },
      { status: 'failed' as const, detail: null, found: url },
    ];
    expect(replayVerdict([click, page], found(`${ORIGIN}/cart?step=2`), false)).toEqual({
      kind: 'reproduced',
      step: 1,
      found: `${ORIGIN}/cart?step=2`,
      sameAsReported: true,
    });
    expect(replayVerdict([click, page], found(`${ORIGIN}/cart`), false)).toMatchObject({ sameAsReported: false });
  });

  it('says a failure at the step the test failed at in its run is that failure, and a pass there is not', () => {
    const diverged = replayVerdict(
      [click, click],
      [
        { status: 'done', detail: null },
        { status: 'diverged', detail: 'Nothing matches.' },
      ],
      false,
      1,
    );
    expect(diverged).toEqual({ kind: 'diverged', step: 1, reason: 'Nothing matches.', asInRun: true });
    expect(verdictText(diverged, [click, click])).toEqual({
      title: 'Failed at step 2, as in the test run',
      detail: 'Nothing matches. The test failed at this same step when it ran.',
    });
    expect(replayVerdict([click, click], [{ status: 'diverged', detail: 'x' }], false, 1)).toEqual({
      kind: 'diverged',
      step: 0,
      reason: 'x',
    });
    const played = replayVerdict(
      [click, click],
      [
        { status: 'done', detail: null },
        { status: 'done', detail: null },
      ],
      false,
      1,
    );
    expect(played).toEqual({ kind: 'not-reproduced', runStep: 1 });
    expect(verdictText(played, [click, click]).detail).toBe('Step 2, where the test failed when it ran, played here.');
    const byHand = [
      { status: 'done' as const, detail: null },
      { status: 'manual' as const, detail: null },
    ];
    expect(replayVerdict([click, click], byHand, false, 1)).toEqual({ kind: 'completed' });
  });

  it('is stopped when the replay was stopped before the end', () => {
    expect(replayVerdict([click, check], [{ status: 'done', detail: null }], true)).toEqual({
      kind: 'stopped',
      step: 1,
    });
  });
});

describe('readReportFile', () => {
  const doc = toStepsDocument({
    steps: [
      {
        action: 'goto',
        target: null,
        value: 'https://staging.test/cart',
        redacted: false,
        pageUrl: 'https://staging.test/cart',
        timestamp: 0,
      },
      {
        action: 'press',
        target: null,
        value: 'Enter',
        redacted: false,
        pageUrl: 'https://staging.test/cart',
        timestamp: 1,
      },
    ],
    startedAt: 0,
    startUrl: 'https://staging.test/cart',
  });
  const shot = {
    step: 1,
    file: 'steps/002.jpg',
    box: { x: 1, y: 2, width: 3, height: 4 },
    viewport: { width: 800, height: 600 },
    takenAt: 5,
  };

  it('reads the screenshot of each step a .piwibug holds, and none from a steps.json', async () => {
    const archive = createZip([
      { name: 'mimetype', data: BUG_REPORT_MEDIA_TYPE },
      { name: 'steps.json', data: JSON.stringify(doc) },
      {
        name: 'evidence.json',
        data: JSON.stringify({ v: 1, context: {}, evidence: { ...emptyBugEvidence(), stepShots: [shot] } }),
      },
      { name: 'steps/002.jpg', data: new Uint8Array([0xff, 0xd8, 0xff]) },
    ]);
    expect(await readReportFile('bug.piwibug', archive)).toEqual({
      steps: doc,
      views: [{ step: 1, dataUrl: 'data:image/jpeg;base64,/9j/', box: shot.box, viewport: shot.viewport }],
      runFailedStep: null,
    });
    const json = new TextEncoder().encode(JSON.stringify(doc));
    expect(await readReportFile('steps.json', json)).toEqual({ steps: doc, views: [], runFailedStep: null });
  });

  it('reads the step a report made from a test run failed at there, when the report has it', async () => {
    const archive = (failedStep: unknown) =>
      createZip([
        { name: 'mimetype', data: BUG_REPORT_MEDIA_TYPE },
        { name: 'steps.json', data: JSON.stringify(doc) },
        {
          name: 'evidence.json',
          data: JSON.stringify({
            v: 1,
            context: {},
            evidence: emptyBugEvidence(),
            export: { source: 'execution', executionId: 7, testTitle: 'cart', failedStep, notes: [], notesDropped: 0 },
          }),
        },
      ]);
    expect((await readReportFile('bug.piwibug', archive(1))).runFailedStep).toBe(1);
    expect((await readReportFile('bug.piwibug', archive(5))).runFailedStep).toBeNull();
  });

  /** The archive with its first entry marked as deflated, its bytes left as stored: data no inflater reads. */
  function inflatesNothing(zip: Uint8Array): Uint8Array {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint16(8, 8, true);
    view.setUint16(view.getUint32(zip.length - 22 + 16, true) + 10, 8, true);
    return zip;
  }

  it('says, in the interface language, that an archive whose steps cannot be inflated cannot be read', async () => {
    const broken = inflatesNothing(createZip([{ name: 'steps.json', data: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }]));
    await expect(readReportFile('bug.zip', broken)).rejects.toThrow(/^bug\.zip cannot be read/);
    setBrowserLanguage('fr');
    await expect(readReportFile('bug.zip', broken)).rejects.toThrow(/^Impossible de lire bug\.zip/);
  });

  it('reads the steps alone when the evidence cannot be inflated', async () => {
    const archive = inflatesNothing(
      createZip([
        { name: 'evidence.json', data: new Uint8Array([0xff, 0xff, 0xff, 0xff]) },
        { name: 'steps.json', data: JSON.stringify(doc) },
      ]),
    );
    expect(await readReportFile('bug.zip', archive)).toEqual({ steps: doc, views: [], runFailedStep: null });
  });

  it('reads the steps alone when the evidence cannot be read or an image is missing', async () => {
    const noImage = createZip([
      { name: 'steps.json', data: JSON.stringify(doc) },
      { name: 'evidence.json', data: JSON.stringify({ v: 1, context: {}, evidence: { stepShots: [shot] } }) },
    ]);
    expect((await readReportFile('bug.zip', noImage)).views).toEqual([]);
    const badEvidence = createZip([
      { name: 'steps.json', data: JSON.stringify(doc) },
      { name: 'evidence.json', data: '{' },
    ]);
    expect(await readReportFile('bug.zip', badEvidence)).toEqual({ steps: doc, views: [], runFailedStep: null });
  });
});

describe('readStepsFile', () => {
  const doc = toStepsDocument({
    steps: [
      {
        action: 'goto',
        target: null,
        value: 'https://staging.test/cart',
        redacted: false,
        pageUrl: 'https://staging.test/cart',
        timestamp: 0,
      },
    ],
    startedAt: 0,
    startUrl: 'https://staging.test/cart',
  });
  const json = new TextEncoder().encode(JSON.stringify(doc));

  it('reads a steps.json, and the one inside a bug report archive', async () => {
    expect(await readStepsFile('steps.json', json)).toEqual(doc);
    const zip = createZip([
      { name: 'bug-report.md', data: '# Bug' },
      { name: 'steps.json', data: JSON.stringify(doc) },
    ]);
    expect(await readStepsFile('bug.zip', zip)).toEqual(doc);
  });

  it('reads a deflated steps.json, as a zip tool writes it', async () => {
    const deflated = new Uint8Array(
      await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
    );
    const stored = createZip([{ name: 'steps.json', data: deflated }]);
    // Same archive, marked as deflated with the real size in the central directory.
    const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
    view.setUint16(8, 8, true);
    const central = stored.length - 22 - (46 + 'steps.json'.length);
    view.setUint16(central + 10, 8, true);
    view.setUint32(central + 24, json.length, true);
    expect(await readStepsFile('bug.zip', stored)).toEqual(doc);
  });

  it('says what is wrong with a file that holds no steps', async () => {
    await expect(readStepsFile('other.zip', createZip([{ name: 'a.txt', data: 'x' }]))).rejects.toThrow(
      /has no steps\.json/,
    );
    await expect(readStepsFile('notes.json', new TextEncoder().encode('{"a":1}'))).rejects.toThrow(
      /is not a steps file/,
    );
  });

  it("says it in French, the file checker's own message kept in English", async () => {
    setBrowserLanguage('fr');
    await expect(readStepsFile('other.zip', createZip([{ name: 'a.txt', data: 'x' }]))).rejects.toThrow(
      /^other\.zip ne contient pas de steps\.json\u00a0: choisissez le \.piwibug enregistré par Piwi Picker/,
    );
    await expect(readStepsFile('notes.json', new TextEncoder().encode('{"a":1}'))).rejects.toThrow(
      /^notes\.json n’est pas un fichier d’étapes\u00a0: \S/,
    );
  });
});

describe('createWaker', () => {
  it('lets the loop through on the next wake', async () => {
    const waker = createWaker();
    let through = false;
    const waiting = waker.wait().then(() => (through = true));
    await Promise.resolve();
    expect(through).toBe(false);
    waker.wake();
    await waiting;
    expect(through).toBe(true);
  });

  it('keeps a wake that came while the loop was busy, for its next wait', async () => {
    // Step mode turned off while a step still waited for the page: the loop
    // must not then wait for a Next that was never going to come.
    const waker = createWaker();
    waker.wake();
    await expect(waker.wait()).resolves.toBeUndefined();
  });

  it('keeps one wake only, and forgets it when a new loop starts', async () => {
    const waker = createWaker();
    waker.wake();
    waker.wake();
    await waker.wait();
    let through = false;
    void waker.wait().then(() => (through = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(through).toBe(false);

    const fresh = createWaker();
    fresh.wake();
    fresh.reset();
    let freshThrough = false;
    void fresh.wait().then(() => (freshThrough = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(freshThrough).toBe(false);
  });

  it('ends at the other answer when it comes first, and keeps a wake that comes after it', async () => {
    // The person answered a hand-over, then clicked Next while the loop was still busy.
    const waker = createWaker();
    await expect(waker.until(Promise.resolve('done'))).resolves.toEqual({ woken: false, value: 'done' });
    waker.wake();
    await expect(waker.wait()).resolves.toBeUndefined();
  });

  it('keeps a wake that comes in the same moment as the other answer', async () => {
    const waker = createWaker();
    let answer!: (value: string) => void;
    const answered = waker.until(new Promise<string>((resolve) => (answer = resolve)));
    answer('done');
    waker.wake();
    await expect(answered).resolves.toEqual({ woken: false, value: 'done' });
    await expect(waker.wait()).resolves.toBeUndefined();
  });

  it('ends at a wake that comes first', async () => {
    const waker = createWaker();
    const answered = waker.until(new Promise<string>(() => undefined));
    waker.wake();
    await expect(answered).resolves.toEqual({ woken: true });
  });

  it('lets a wait in progress through on a wake of a waiting loop, and keeps nothing when none waits', async () => {
    // Pause and Continue: the loop reads them from the state, so a busy loop needs no wake from them.
    const waker = createWaker();
    const waiting = waker.wait();
    waker.wakeWaiting();
    await expect(waiting).resolves.toBeUndefined();
    waker.wakeWaiting();
    let through = false;
    void waker.wait().then(() => (through = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(through).toBe(false);
  });
});

describe('evidenceLines', () => {
  const request = (status: number) => ({ method: 'POST', url: '/api/cart/coupon', status, page: '/cart', time: 1 });
  const error = (message: string) => ({
    level: 'error' as const,
    source: 'console' as const,
    message,
    page: '/cart',
    time: 1,
  });

  it('says what failed during the replay, requests first, and counts the rest', () => {
    const shown = evidenceLines({
      token: 't',
      console: [error('Coupon failed: 500'), { ...error('slow'), level: 'warn' }],
      requests: [request(500), request(0)],
    });
    expect(shown.lines).toEqual([
      'POST /api/cart/coupon answered 500',
      'POST /api/cart/coupon got no answer',
      'Console error: Coupon failed: 500',
    ]);
    expect(shown.more).toBe(0);
    const many = evidenceLines({ token: 't', console: [], requests: Array.from({ length: 8 }, () => request(502)) });
    expect(many.lines).toHaveLength(5);
    expect(many.more).toBe(3);
  });

  it('shows nothing when the page showed nothing', () => {
    expect(evidenceLines(null)).toEqual({ lines: [], more: 0 });
  });
});

describe('chooseElement', () => {
  const look = (locator: string, ...found: string[]): LocatorLook<string> => ({ locator, found });
  const any = () => true;

  it('takes what the spec’s own locator finds alone, as the spec would', () => {
    const choice = chooseElement([look('spec', 'save'), look('alt', 'save')], any);
    expect(choice).toEqual({ element: 'save', locator: 'spec', votes: 2.5 });
  });

  it('falls back on another recorded locator when the spec’s finds nothing', () => {
    expect(chooseElement([look('spec'), look('css', 'button'), look('text')], any)).toEqual({
      element: 'button',
      locator: 'css',
      votes: 1,
    });
  });

  it('falls back on one that finds the element alone when the spec’s finds several', () => {
    expect(chooseElement([look('spec', 'a', 'b'), look('row', 'b')], any)?.element).toBe('b');
  });

  it('keeps the spec’s element unless two other locators agree on another', () => {
    expect(chooseElement([look('spec', 'a'), look('one', 'b')], any)?.element).toBe('a');
    expect(chooseElement([look('spec', 'a'), look('one', 'b'), look('two', 'b')], any)).toEqual({
      element: 'b',
      locator: 'one',
      votes: 2,
    });
  });

  it('weighs a brittle locator’s vote less: two by position do not outvote the spec’s own', () => {
    const brittle = (locator: string, ...found: string[]): LocatorLook<string> => ({ locator, found, weight: 0.5 });
    expect(chooseElement([look('spec', 'alice'), brittle('nth', 'bob'), brittle('class', 'bob')], any)?.element).toBe(
      'alice',
    );
    expect(chooseElement([look('spec'), brittle('nth', 'bob')], any)).toEqual({
      element: 'bob',
      locator: 'nth',
      votes: 0.5,
    });
  });

  it('breaks a tie for the better-ranked locator', () => {
    expect(chooseElement([look('spec'), look('first', 'x'), look('second', 'y')], any)?.locator).toBe('first');
  });

  it('lets another locator vote only for an element of the kind recorded', () => {
    const fits = (element: string) => element !== 'heading';
    expect(chooseElement([look('spec'), look('text', 'heading')], fits)).toBeNull();
    expect(chooseElement([look('spec'), look('text', 'heading'), look('css', 'button')], fits)?.element).toBe('button');
    // The spec's own locator is taken as the spec takes it.
    expect(chooseElement([look('spec', 'heading')], fits)?.element).toBe('heading');
  });

  it('chooses nothing when no locator finds one element alone', () => {
    expect(chooseElement([look('spec', 'a', 'b'), look('alt')], any)).toBeNull();
    expect(chooseElement([], any)).toBeNull();
  });
});

describe('stepTimeout', () => {
  const at = (...timestamps: number[]) => timestamps.map((timestamp) => ({ timestamp }));

  it('waits as Playwright does when the person did not wait longer', () => {
    expect(stepTimeout(at(1_000, 3_000), 1, 10_000)).toBe(10_000);
  });

  it('waits as long as the person waited when recording, and some', () => {
    expect(stepTimeout(at(1_000, 17_000), 1, 10_000)).toBe(21_000);
  });

  it('waits at most a minute however long the person took', () => {
    expect(stepTimeout(at(1_000, 600_000), 1, 10_000)).toBe(STEP_WAIT_MAX_MS);
  });

  it('waits the base time for a first step, or for steps with no time recorded', () => {
    expect(stepTimeout(at(5_000), 0, 10_000)).toBe(10_000);
    expect(stepTimeout(at(0, 0), 1, 10_000)).toBe(10_000);
    expect(stepTimeout(at(9_000, 2_000), 1, 10_000)).toBe(10_000);
  });
});
