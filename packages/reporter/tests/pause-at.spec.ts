import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installPickerOverlay,
  pauseAnswered,
  showPauseBar,
  showPickerChoices,
  takePauseState,
} from '@piwitests/picker-dom';
import {
  atStop,
  goOn,
  inFlightCallSite,
  markPausesWrapped,
  parsePauseAt,
  pauseHere,
  pauseGateFromTestInfo,
  pausePlace,
  pauseSkipReason,
  pickPayload,
  postPickToEditor,
  resetInspectorSwitch,
  resetPauseLogs,
  stopCallSite,
  watchStops,
  withInspector,
  withTestTimeoutHeld,
  type PausePoint,
  type PauseRecord,
  type PauseState,
} from '../src/internal/capture/pause-at.js';
import { piwiFixtures, probeElementAttrs, CAPTURED_ATTRS_ARG } from '../src/internal/capture/capture-fixtures.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import type { LocatorSnapshot } from '../src/internal/capture/locator-healing.js';
import { jsonRes, startServer } from './_helpers.js';

const PROBE = { fn: probeElementAttrs, arg: CAPTURED_ATTRS_ARG };
/** The capture fixtures' own folder: a frame there is this package's, never the test's. */
const CAPTURE_DIR = path.join(__dirname, '..', 'src', 'internal', 'capture');

describe('parsePauseAt', () => {
  const cwd = path.resolve('/work/shop');

  it('matches a call site on a listed line, whatever its column', () => {
    const set = parsePauseAt('tests/login.spec.ts:42; tests/pages/checkout.page.ts:9', cwd);
    expect(set.size).toBe(2);
    expect(set.matches('tests/login.spec.ts:42:5')).toBe(true);
    expect(set.matches('tests/login.spec.ts:42:17')).toBe(true);
    expect(set.matches('tests/pages/checkout.page.ts:9:21')).toBe(true);
    expect(set.matches('tests/login.spec.ts:43:5')).toBe(false);
    expect(set.matches('tests/other.spec.ts:42:5')).toBe(false);
    expect(set.matches(null)).toBe(false);
  });

  it('reads absolute paths, backslashes and ./ the way call sites are written', () => {
    const set = parsePauseAt(
      `${path.join(cwd, 'tests', 'login.spec.ts')}:42;./tests/a.spec.ts:3;tests\\b.spec.ts:4;../shared/c.ts:5`,
      cwd,
    );
    expect(set.matches('tests/login.spec.ts:42:1')).toBe(true);
    expect(set.matches('tests/a.spec.ts:3:1')).toBe(true);
    expect(set.matches('tests/b.spec.ts:4:1')).toBe(true);
    expect(set.matches('../shared/c.ts:5:1')).toBe(true);
  });

  it('reads a path holding a comma', () => {
    const set = parsePauseAt('tests/a,b.spec.ts:7;tests/c.spec.ts:2', cwd);
    expect(set.size).toBe(2);
    expect(set.matches('tests/a,b.spec.ts:7:3')).toBe(true);
    expect(set.matches('tests/c.spec.ts:2:3')).toBe(true);
  });

  it('is empty for an unset value and skips an entry without a line, saying so once', () => {
    resetPauseLogs();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(parsePauseAt(undefined, cwd).size).toBe(0);
      expect(parsePauseAt(' ', cwd).size).toBe(0);
      expect(parsePauseAt('tests/a.spec.ts;tests/b.spec.ts:0;:4;', cwd).size).toBe(0);
      expect(parsePauseAt('tests/a.spec.ts;tests/c.spec.ts:1', cwd).size).toBe(1);
      expect(log.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
        '[piwi] PIWI_PAUSE_AT: ignoring "tests/a.spec.ts": expected file:line',
        '[piwi] PIWI_PAUSE_AT: ignoring "tests/b.spec.ts:0": expected file:line',
        '[piwi] PIWI_PAUSE_AT: ignoring ":4": expected file:line',
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('stopCallSite', () => {
  const cwd = path.resolve('/work/shop');

  it('writes a stop’s place as the call site its breakpoint matches', () => {
    const at = stopCallSite({ file: path.join(cwd, 'tests', 'login.spec.ts'), line: 42, column: 9 }, cwd);
    expect(at).toBe('tests/login.spec.ts:42:9');
    expect(parsePauseAt('tests/login.spec.ts:42', cwd).matches(at)).toBe(true);
    expect(parsePauseAt(`${path.join(cwd, 'tests', 'login.spec.ts')}:42`, cwd).matches(at)).toBe(true);
    expect(stopCallSite({ file: path.resolve('/work/shared/c.ts'), line: 5 }, cwd)).toBe('../shared/c.ts:5:0');
  });

  it('names the line of the locator calls in flight, and none when they are on several lines', () => {
    expect(inFlightCallSite([])).toBeNull();
    expect(inFlightCallSite(['tests/a.spec.ts:4:10'])).toBe('tests/a.spec.ts:4:10');
    expect(inFlightCallSite(['tests/a.spec.ts:4:10', 'tests/a.spec.ts:4:30'])).toBe('tests/a.spec.ts:4:10');
    expect(inFlightCallSite(['tests/a.spec.ts:4:10', 'tests/a.spec.ts:5:3'])).toBeNull();
  });

  it('has none for a place outside the user’s code', () => {
    expect(stopCallSite({ file: '<unknown>' }, cwd)).toBeNull();
  });
});

describe('the pause gate', () => {
  it('pauses a headed local run only, outside Playwright’s Inspector', () => {
    expect(pauseSkipReason({ ci: undefined, headless: false })).toBeNull();
    expect(pauseSkipReason({ ci: 'false', headless: false })).toBeNull();
    expect(pauseSkipReason({ ci: 'true', headless: false })).toMatch(/running under CI/);
    expect(pauseSkipReason({ ci: undefined, headless: true })).toMatch(/headless/);
    expect(pauseSkipReason({ ci: undefined, headless: undefined })).toMatch(/headless/);
    expect(pauseSkipReason({ ci: undefined, headless: false, pwdebug: '1' })).toMatch(/PWDEBUG/);
    for (const pwdebug of ['', '0', 'false', 'console']) {
      expect(pauseSkipReason({ ci: undefined, headless: false, pwdebug })).toBeNull();
    }
  });

  it('never pauses under --debug, --debug=cli included, which sets no PWDEBUG', () => {
    expect(pauseSkipReason({ ci: undefined, headless: false, debug: 'cli' })).toBe(
      "Playwright's debugger runs the test (--debug=cli) — run without --debug",
    );
    expect(pauseSkipReason({ ci: undefined, headless: false, debug: 'inspector' })).toMatch(/--debug=inspector/);
    expect(pauseSkipReason({ ci: undefined, headless: false, debug: undefined })).toBeNull();
    const testInfo = {
      project: { use: { headless: false } },
      _configInternal: { configCLIOverrides: { debug: 'cli' } },
    };
    expect(pauseGateFromTestInfo(testInfo as never).debug).toBe('cli');
    expect(pauseGateFromTestInfo({ project: { use: {} } } as never).debug).toBeUndefined();
  });
});

describe('the stop policy', () => {
  const state = (lines: string, finished = false): PauseState => ({
    set: parsePauseAt(lines, path.resolve('/work/shop')),
    step: false,
    finished,
  });

  it('shows a breakpoint’s line and lets every other call go on, stopping again before the next', () => {
    const s = state('tests/a.spec.ts:5;tests/pages/cart.page.ts:9');
    expect(atStop(s, 'tests/a.spec.ts:4:3')).toEqual({ go: 'next' });
    expect(atStop(s, 'tests/a.spec.ts:5:11')).toEqual({ show: 'breakpoint' });
    expect(goOn(s, 'resume')).toBe('next');
    expect(atStop(s, 'tests/pages/cart.page.ts:9:7')).toEqual({ show: 'breakpoint' });
    expect(atStop(s, null)).toEqual({ go: 'next' });
  });

  it('shows the next call in the user’s code after Step, whatever its line, once', () => {
    const s = state('tests/a.spec.ts:5');
    expect(goOn(s, 'step')).toBe('next');
    expect(atStop(s, null)).toEqual({ go: 'next' });
    expect(atStop(s, 'tests/a.spec.ts:6:3')).toEqual({ show: 'step' });
    expect(goOn(s, 'resume')).toBe('next');
    expect(atStop(s, 'tests/a.spec.ts:7:3')).toEqual({ go: 'next' });
  });

  it('shows nothing more after Finish, and runs on freely', () => {
    const s = state('tests/a.spec.ts:5');
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ show: 'breakpoint' });
    expect(goOn(s, 'finish')).toBe('resume');
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ go: 'resume' });
    expect(goOn(s, 'step')).toBe('resume');
  });

  it('runs on freely from a stop with no breakpoint and no Step waiting', () => {
    const s = state('');
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ go: 'resume' });
    expect(goOn(s, 'resume')).toBe('resume');
    expect(goOn(s, 'step')).toBe('next');
  });
});

describe('withTestTimeoutHeld', () => {
  it('holds the test timeout through the runner’s counter while it runs, failing or not', async () => {
    const counter = vi.fn();
    const testInfo = { _setIgnoreTimeouts: counter };
    expect(await withTestTimeoutHeld(testInfo as never, async () => 'answer')).toBe('answer');
    await expect(
      withTestTimeoutHeld(testInfo as never, async () => {
        throw new Error('page closed');
      }),
    ).rejects.toThrow('page closed');
    expect(counter.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it('runs without it on a runner that has none', async () => {
    expect(await withTestTimeoutHeld({} as never, async () => 'answer')).toBe('answer');
  });
});

describe('what the pause says', () => {
  it('names the place and the pick’s line', () => {
    expect(pausePlace('tests/login.spec.ts:42:5')).toBe('login.spec.ts:42');
    expect(pickPayload("getByRole('button')", 'tests/login.spec.ts:42:5')).toEqual({
      kind: 'locator',
      text: "getByRole('button')",
      at: { file: 'tests/login.spec.ts', line: 42 },
    });
    expect(pickPayload("getByRole('button')", '../shared/a.ts:3:1')).toEqual({
      kind: 'locator',
      text: "getByRole('button')",
    });
  });

  it('names no line for a call site outside the run’s folder, Windows-style absolute included', () => {
    for (const location of [
      'C:/work/shop/tests/a.spec.ts:3:1',
      'C:\\work\\shop\\a.spec.ts:3:1',
      '/work/a.spec.ts:3:1',
    ]) {
      expect(pickPayload("getByRole('button')", location)).toEqual({ kind: 'locator', text: "getByRole('button')" });
    }
  });
});

describe('postPickToEditor', () => {
  beforeEach(() => resetPauseLogs());

  it('posts the pick with the pairing token', async () => {
    const bodies: unknown[] = [];
    const server = await startServer((req, res) => {
      bodies.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(req.body) });
      jsonRes(res, 200, { inserted: true });
    });
    try {
      const token = 'abcdefghijklmnop_1234';
      const sent = await postPickToEditor(
        `${server.url}/piwi/send#${token}`,
        pickPayload('getByText("Pay")', 'tests/a.spec.ts:3:1'),
      );
      expect(sent).toBe(true);
      expect(bodies).toEqual([
        {
          url: '/piwi/send',
          auth: `Bearer ${token}`,
          body: { kind: 'locator', text: 'getByText("Pay")', at: { file: 'tests/a.spec.ts', line: 3 } },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('logs a refused post once and never throws', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const refuse = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
      const address = 'http://127.0.0.1:47211/piwi/send#abcdefghijklmnop_1234';
      const payload = pickPayload('getByText("Pay")', 'tests/a.spec.ts:3:1');
      expect(await postPickToEditor(address, payload, refuse)).toBe(false);
      const broken = vi.fn(async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch;
      expect(await postPickToEditor(address, payload, broken)).toBe(false);
      expect(await postPickToEditor('not a pairing', payload, broken)).toBe(false);
      expect(await postPickToEditor(undefined, payload, broken)).toBe(false);
      expect(log.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
        '[piwi] Could not send the picked locator to the editor: the editor answered 401.',
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * A page whose pause bar answers `answers` in turn, recording what it was shown. With `pick`, the element picker
 * picks an element the probe reads as `pick` and the first locator offered is confirmed; the overlay's own reads and
 * cleanups run on Node's `globalThis`.
 */
function fakePausePage(
  answers: Array<string | null>,
  opts: {
    breakAt?: number;
    navigateAt?: number;
    pick?: Record<string, unknown>;
    holdBar?: boolean;
    /** The picker waits for a pick that never comes. */
    hangPick?: boolean;
  } = {},
) {
  const shown: unknown[] = [];
  let takes = 0;
  let navigated = false;
  // With `holdBar`, the bar stays up unanswered until it is taken down.
  let takeDown: (() => void) | null = null;
  const g = globalThis as Record<string, unknown>;
  const page = {
    evaluate: vi.fn(async (fn: unknown, arg?: unknown) => {
      if (fn === showPauseBar) shown.push(arg);
      else if (fn === takePauseState) {
        if (opts.holdBar) {
          takeDown?.();
          return null;
        }
        if (opts.breakAt !== undefined && takes === opts.breakAt) throw new Error('Target page has been closed');
        if (opts.navigateAt === takes && !navigated) {
          navigated = true;
          throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
        }
        return takes < answers.length ? answers[takes++] : 'resume';
      } else if (fn === installPickerOverlay) {
        if (!opts.hangPick) g.__piwiPickState = opts.pick ? 'picked' : 'skipped';
      }
      else if (fn === showPickerChoices) g.__piwiPickChoice = 0;
      else if (typeof fn === 'function' && String(fn).includes('__piwi')) return (fn as (a: unknown) => unknown)(arg);
      return null;
    }),
    evaluateHandle: vi.fn(async () => ({ evaluate: async () => opts.pick, dispose: async () => {} })),
    waitForFunction: vi.fn((predicate: unknown) => {
      if (opts.hangPick && predicate !== pauseAnswered) return new Promise<void>(() => {});
      return opts.holdBar ? new Promise<void>((resolve) => (takeDown = resolve)) : Promise.resolve();
    }),
    waitForLoadState: vi.fn(async () => {}),
    isClosed: () => opts.breakAt !== undefined && takes >= opts.breakAt,
  };
  return { page, shown };
}

const POINT: PausePoint = {
  location: 'tests/login.spec.ts:42:5',
  call: "Click getByRole('button', { name: 'Pay' })",
  attempt: 2,
  target: null,
};

describe('pauseHere', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('highlights the element, shows the bar with the call about to run, and hides the highlight on Resume', async () => {
    const { page, shown } = fakePausePage(['resume']);
    const hide = vi.fn(async () => {});
    const target = { highlight: vi.fn(async () => ({ dispose: hide })) };
    const choice = await pauseHere(page as never, { ...POINT, target }, PROBE, () => {});
    expect(choice).toBe('resume');
    expect(target.highlight).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
    expect(shown).toEqual([
      {
        place: 'login.spec.ts:42',
        attempt: 2,
        action: "Click getByRole('button', { name: 'Pay' })",
        locator: null,
        record: false,
      },
    ]);
  });

  it('shows the bar again after a pick, and after a navigation took it away', async () => {
    const { page, shown } = fakePausePage([null, 'pick', 'step']);
    const picks: unknown[] = [];
    const choice = await pauseHere(page as never, POINT, PROBE, (p) => void picks.push(p));
    expect(choice).toBe('step');
    expect(shown).toHaveLength(3);
    expect(page.waitForFunction.mock.calls.filter((c) => c[0] === pauseAnswered)).toHaveLength(3);
    // The fake page has no picker to answer: the pick yields nothing, and the pause goes on.
    expect(picks).toEqual([]);
  });

  it('shows the bar again when a navigation lands as it is read, and resumes once the page closed', async () => {
    const { page, shown } = fakePausePage(['step'], { navigateAt: 0 });
    expect(await pauseHere(page as never, POINT, PROBE, () => {})).toBe('step');
    expect(shown).toHaveLength(2);
    expect(page.waitForLoadState).toHaveBeenCalledOnce();
    const closed = fakePausePage(['step'], { breakAt: 0 });
    expect(await pauseHere(closed.page as never, POINT, PROBE, () => {})).toBe('resume');
  });

  it('ends Pick a locator and Record here with the stop, the picker taken out of the page', async () => {
    const g = globalThis as Record<string, unknown>;
    const picking = fakePausePage(['pick'], { hangPick: true });
    const ended = new AbortController();
    const picked = pauseHere(picking.page as never, POINT, PROBE, () => {}, undefined, ended.signal);
    await vi.waitFor(() => expect(picking.page.evaluate.mock.calls.map((c) => c[0])).toContain(installPickerOverlay));
    ended.abort('ended');
    try {
      expect(await picked).toBe('resume');
      // The picker's overlay is gone, marked as ended so that the waits still polling in the page stop.
      expect(g.__piwiPickEnded).toBe(true);
      const evaluated = picking.page.evaluate.mock.calls.map((c) => c[0]);
      expect(evaluated[evaluated.length - 1]).toBe(takePauseState);
    } finally {
      delete g.__piwiPickEnded;
    }

    const recording = fakePausePage(['record']);
    const stopped = new AbortController();
    const record = vi.fn((_ended?: AbortSignal) => new Promise<void>(() => {}));
    const recorded = pauseHere(recording.page as never, POINT, PROBE, () => {}, record, stopped.signal);
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    stopped.abort('ended');
    expect(await recorded).toBe('resume');
    // The recording got the stop's signal, to end itself and leave the page.
    expect(record.mock.calls[0]![0]).toBe(stopped.signal);
  });

  it('offers Record here when the editor can record, and shows the bar again once the recording ended', async () => {
    const { page, shown } = fakePausePage(['record', 'resume']);
    const recorded = vi.fn(async () => {});
    const choice = await pauseHere(page as never, POINT, PROBE, () => {}, recorded);
    expect(choice).toBe('resume');
    expect(recorded).toHaveBeenCalledOnce();
    expect(shown).toEqual([expect.objectContaining({ record: true }), expect.objectContaining({ record: true })]);
  });
});

/** The 1-based line this function is called from, in this file. */
function thisLine(): number {
  const frame = new Error().stack!.split('\n')[2]!;
  return Number(/:(\d+):\d+\)?$/.exec(frame)![1]);
}

/** The line this file's test bodies start at, past the fakes: the calls they make are the ones the fake debugger stops. */
let bodiesFrom = Number.POSITIVE_INFINITY;

/** Where the test body made the call the fake debugger stops, the way Playwright names the user's line. */
function callerPlace(): { file: string; line?: number; column?: number } {
  for (const line of new Error().stack!.split('\n')) {
    const m = /\(?([^\s()]+):(\d+):(\d+)\)?$/.exec(line.trim());
    if (m?.[1] === __filename && Number(m[2]) > bodiesFrom) {
      return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
    }
  }
  return { file: '<unknown>' };
}

/**
 * A browser context whose debugger stops the fake page's calls as Playwright's does: once armed (a pause asked, or
 * `next()` from a stop), the next call stops before it runs and waits until `next()` or `resume()`; a `page.pause()`
 * call stops whenever the debugger was ever steered. `steered` lists the commands it got.
 */
function fakeDebuggerContext() {
  const listeners: Array<() => void> = [];
  let armed = false;
  let enabled = false;
  let paused: { location: ReturnType<typeof callerPlace>; title: string } | null = null;
  let release: (() => void) | null = null;
  const steered: string[] = [];
  const goOnFromStop = () => {
    paused = null;
    const go = release;
    release = null;
    for (const listener of listeners) listener();
    go?.();
  };
  const debuggerApi = {
    on: (_event: string, listener: () => void) => void listeners.push(listener),
    pausedDetails: () => paused,
    requestPause: async () => {
      if (paused) throw new Error('Debugger is already paused');
      steered.push('pause');
      armed = enabled = true;
    },
    next: async () => {
      if (!paused) throw new Error('Debugger is not paused');
      steered.push('next');
      armed = true;
      goOnFromStop();
    },
    resume: async () => {
      if (!paused) throw new Error('Debugger is not paused');
      steered.push('resume');
      goOnFromStop();
    },
  };
  /** A call the debugger can stop before it runs, at `place` or where the test body made it. */
  const call = async (title: string, pauseCall = false, place?: ReturnType<typeof callerPlace>) => {
    if (!armed && !(pauseCall && enabled)) return;
    armed = false;
    paused = { location: place ?? callerPlace(), title };
    const done = new Promise<void>((resolve) => (release = resolve));
    for (const listener of listeners) listener();
    await done;
  };
  return { debuggerApi, call, steered, paused: () => paused !== null };
}

describe('breakpoints in the capture fixtures', () => {
  const env = { ...process.env };
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    delete process.env.CI;
    delete process.env.PWDEBUG;
    delete process.env.PIWI_RECORD_CHANNEL;
    resetPauseLogs();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...env };
    log.mockRestore();
  });

  const here = path.relative(process.cwd(), __filename).split(path.sep).join('/');

  /**
   * Run `body` through the real fixtures on a fake page in a context whose debugger stops its calls, and whose pause
   * bar answers `answers` in turn.
   */
  async function runWithBreakpoints(
    pauseAt: string,
    answers: string[],
    body: (page: Record<string, (...a: unknown[]) => any>) => Promise<void>,
    headless: unknown = false,
    pick?: Record<string, unknown>,
    more: {
      holdBar?: boolean;
      clickPlacedAt?: ReturnType<typeof callerPlace>;
      /** The runner's callbacks for the end of the test function, run after the body as Playwright runs them. */
      finishCallbacks?: Set<() => Promise<void> | void>;
      /** The pages' `pause` comes from their prototype, as on Playwright's `Page`. */
      protoPause?: boolean;
    } = {},
  ) {
    const { page: pausePage, shown } = fakePausePage(answers, { pick, holdBar: more.holdBar });
    const stops = fakeDebuggerContext();
    const calls: string[] = [];
    const fakeLocator = {
      click: vi.fn(async () => {
        await stops.call("Click getByText('Pay')", false, more.clickPlacedAt);
        calls.push('click');
      }),
      highlight: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        tagName: 'div',
        attributes: {},
        textContent: 'Pay',
        center: { x: 1, y: 1 },
        hasLabel: false,
        selectorCounts: {},
      })),
      _expect: vi.fn(async (expression: string) => {
        await stops.call(`Expect "${expression}"`);
        return { matches: true };
      }),
    };
    const factory = () => fakeLocator;
    const pause = vi.fn(async function (this: unknown, options?: unknown) {
      // Another page with the same prototype: one the fixtures never instrumented.
      if (this !== fakePage) {
        calls.push(`own pause, the switch ${process.env.PW_CODEGEN_NO_INSPECTOR ?? 'off'}`);
        return;
      }
      calls.push(`pause ${JSON.stringify(options ?? null)}`);
      await stops.call('Pause', true);
    });
    const pageProto: Record<string, unknown> = more.protoPause ? { pause } : {};
    const fakePage: Record<string, unknown> = Object.assign(Object.create(pageProto) as Record<string, unknown>, {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: factory,
      on: () => {},
      goto: async () => {
        await stops.call('Navigate');
        calls.push('goto');
      },
      ...(more.protoPause ? {} : { pause }),
      close: vi.fn(async () => {}),
      evaluate: pausePage.evaluate,
      evaluateHandle: pausePage.evaluateHandle,
      waitForFunction: pausePage.waitForFunction,
      isClosed: () => false,
    });
    const fakeContext = {
      debugger: stops.debuggerApi,
      newPage: async () => fakePage,
      close: async () => {},
      on: () => {},
      pages: () => [fakePage],
    };
    fakePage.context = () => fakeContext;
    const attached: Record<string, unknown[]> = {};
    /** The calls made by the time each attachment was attached. */
    const callsAtAttach: Record<string, string[]> = {};
    const testInfo = {
      status: 'passed',
      retry: 0,
      timeout: 30_000,
      project: { use: { headless } },
      attach: vi.fn(async (name: string, b: { body: Buffer }) => {
        attached[name] = JSON.parse(String(b.body)) as unknown[];
        callsAtAttach[name] = [...calls];
      }),
      annotations: [],
      ...(more.finishCallbacks ? { _onDidFinishTestFunctionCallbacks: more.finishCallbacks } : {}),
    };
    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];
    process.env.PIWI_PAUSE_AT = pauseAt;
    const testFunction = async (page: typeof fakePage) => {
      try {
        await body(page as never);
      } finally {
        for (const callback of more.finishCallbacks ?? []) await callback();
      }
    };
    await captureFixture({}, () => pageFixture({ page: fakePage }, testFunction), testInfo);
    return {
      shown,
      calls,
      steered: stops.steered,
      call: stops.call,
      debuggerApi: stops.debuggerApi,
      paused: stops.paused,
      evaluated: pausePage.evaluate.mock.calls.map((c) => c[0]),
      callsAtAttach,
      locators: (attached[ATTACHMENT_NAMES.locators] ?? []) as LocatorSnapshot[],
      pauses: (attached[ATTACHMENT_NAMES.pauses] ?? []) as PauseRecord[],
      pageProto,
      fakeContext,
    };
  }

  const place = (shown: unknown) => (shown as { place: string }).place;
  bodiesFrom = thisLine();

  it('stops at the call on a breakpoint’s line, a navigation included, and lets the others go on at once', async () => {
    const start = thisLine();
    const run = await runWithBreakpoints(
      `${here}:${start + 6};${here}:${start + 8}`,
      ['resume', 'resume'],
      async (page) => {
        await page.getByText!('Pay').click();
        await page.goto!('/cart');
        await page.getByText!('Pay').click();
        await page.goto!('/pay');
      },
    );
    expect(run.shown.map(place)).toEqual([`pause-at.spec.ts:${start + 6}`, `pause-at.spec.ts:${start + 8}`]);
    expect(run.shown.map((s) => (s as { action: string }).action)).toEqual(['Navigate', 'Navigate']);
    expect(run.calls).toEqual(['click', 'goto', 'click', 'goto']);
    expect(run.steered).toEqual(['pause', 'next', 'next', 'next', 'next']);
    expect(run.pauses).toEqual([
      expect.objectContaining({
        title: 'Navigate',
        location: expect.stringMatching(`^${here}:${start + 6}:`),
        reason: 'breakpoint',
      }),
      expect.objectContaining({
        title: 'Navigate',
        location: expect.stringMatching(`^${here}:${start + 8}:`),
        reason: 'breakpoint',
      }),
    ]);
  });

  it('stops at the next call after Step, and at none after Finish', async () => {
    const start = thisLine();
    const stepped = await runWithBreakpoints(`${here}:${start + 3}`, ['step', 'resume'], async (page) => {
      await page.getByText!('Pay').click();
      await page.getByText!('Pay').click();
      await page.goto!('/cart');
      await page.getByText!('Pay').click();
    });
    expect(stepped.shown.map(place)).toEqual([`pause-at.spec.ts:${start + 3}`, `pause-at.spec.ts:${start + 4}`]);
    expect(stepped.pauses.map((p) => p.reason)).toEqual(['breakpoint', 'step']);

    const again = thisLine();
    const finished = await runWithBreakpoints(`${here}:${again + 3};${here}:${again + 4}`, ['finish'], async (page) => {
      for (let i = 0; i < 2; i++) {
        await page.getByText!('Pay').click();
        await page.goto!('/cart');
      }
    });
    expect(finished.shown).toHaveLength(1);
    expect(finished.calls).toEqual(['click', 'goto', 'click', 'goto']);
    expect(finished.steered).toEqual(['pause', 'resume']);
  });

  it('stops before an assertion, named as Playwright titles it', async () => {
    const start = thisLine();
    const { shown } = await runWithBreakpoints(`${here}:${start + 3}`, ['resume'], async (page) => {
      const locator = page.getByText!('Pay') as { _expect: (...a: unknown[]) => Promise<unknown> };
      await locator._expect('to.be.visible', { isNot: false, timeout: 5000 });
    });
    expect(shown).toEqual([
      expect.objectContaining({ place: `pause-at.spec.ts:${start + 3}`, action: 'Expect "to.be.visible"' }),
    ]);
  });

  it('folds a locator picked at a stop into the call site’s snapshot, and posts it to the editor', async () => {
    const posts: unknown[] = [];
    const editor = await startServer((req, res) => {
      posts.push(JSON.parse(req.body));
      jsonRes(res, 200, { inserted: true });
    });
    process.env.PIWI_EDITOR_SEND = `${editor.url}/piwi/send#abcdefghijklmnop_1234`;
    const pick = {
      tagName: 'button',
      attributes: { 'data-testid': 'pay-now' },
      textContent: 'Pay now',
      center: { x: 1, y: 1 },
      hasLabel: false,
      labelText: null,
      selectorCounts: { testId: 1 },
    };
    try {
      const start = thisLine();
      const { locators, calls } = await runWithBreakpoints(
        `${here}:${start + 5}`,
        ['pick', 'resume'],
        async (page) => {
          await page.getByText!('Pay').click();
        },
        false,
        pick,
      );
      expect(calls).toEqual(['click']);
      expect(locators).toHaveLength(1);
      expect(locators[0]!.location).toMatch(new RegExp(`^${here.replace(/\./g, '\\.')}:${start + 5}:\\d+$`));
      expect(locators[0]!.used.method).toBe('getByText');
      expect(locators[0]!.element?.attributes['data-testid']).toBe('pay-now');
      expect(locators[0]!.alternatives[0]).toMatchObject({ locator: "getByTestId('pay-now')", pickedByUser: true });
      expect(posts).toEqual([{ kind: 'locator', text: "getByTestId('pay-now')", at: { file: here, line: start + 5 } }]);
      expect(log.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(
        `[piwi] Locator picked at ${here}:${start + 5}: getByTestId('pay-now')`,
      );
    } finally {
      await editor.close();
    }
  });

  it('stops at page.pause() with Piwi’s bar in a run the editor started, with Record here, the test timeout the runner’s', async () => {
    process.env.PIWI_RECORD_CHANNEL = `/tmp/piwi-no-such.sock#${'t'.repeat(20)}`;
    const start = thisLine();
    const run = await runWithBreakpoints('', ['step', 'resume'], async (page) => {
      await page.pause!();
      await page.getByText!('Pay').click();
    });
    expect(run.shown).toEqual([
      expect.objectContaining({ place: `pause-at.spec.ts:${start + 2}`, action: 'Pause', record: true }),
      // Step stops at the next call.
      expect.objectContaining({
        place: `pause-at.spec.ts:${start + 3}`,
        action: "Click getByText('Pay')",
        record: true,
      }),
    ]);
    expect(run.calls).toEqual(['pause {"__testHookKeepTestTimeout":true}', 'click']);
    expect(run.pauses.map((p) => p.reason)).toEqual(['page-pause', 'step']);
    expect(run.steered).toEqual(['pause', 'next', 'resume']);
  });

  it('stops at page.pause() in a run with breakpoints the editor did not start', async () => {
    const start = thisLine();
    const run = await runWithBreakpoints(`${here}:${start + 9}`, ['resume'], async (page) => {
      await page.pause!();
    });
    expect(run.shown).toEqual([
      expect.objectContaining({ place: `pause-at.spec.ts:${start + 2}`, action: 'Pause', record: false }),
    ]);
  });

  it('leaves page.pause() to Playwright in a run no editor started, or a headless one', async () => {
    const unpaired = await runWithBreakpoints('', [], async (page) => {
      await page.pause!();
    });
    expect(unpaired.shown).toEqual([]);
    expect(unpaired.calls).toEqual(['pause null']);
    expect(unpaired.steered).toEqual([]);
    process.env.PIWI_RECORD_CHANNEL = `/tmp/piwi-no-such.sock#${'t'.repeat(20)}`;
    const headless = await runWithBreakpoints(
      '',
      [],
      async (page) => {
        await page.pause!();
      },
      true,
    );
    expect(headless.calls).toEqual(['pause null']);
  });

  it('resumes at once a stop armed before the test ended', async () => {
    const start = thisLine();
    const run = await runWithBreakpoints(`${here}:${start + 3}`, [], async (page) => {
      await page.getByText!('Nope').click();
    });
    expect(run.steered).toEqual(['pause', 'next']);
    await run.call('Close context');
    expect(run.steered).toEqual(['pause', 'next', 'resume']);
  });

  it('never pauses a headless run, and says why once', async () => {
    const start = thisLine();
    const run = await runWithBreakpoints(
      `${here}:${start + 5}`,
      [],
      async (page) => {
        await page.getByText!('Pay').click();
      },
      true,
    );
    expect(run.shown).toEqual([]);
    expect(run.calls).toEqual(['click']);
    expect(run.steered).toEqual([]);
    expect(
      log.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('PIWI_PAUSE_AT')),
    ).toEqual([
      '[piwi] PIWI_PAUSE_AT is set but breakpoints are skipped: the browser is headless — re-run with --headed (or set use: { headless: false })',
    ]);
  });

  it('leaves a page.pause() it does not take over to Playwright and its Inspector, never resuming it', async () => {
    const start = thisLine();
    let kept: Record<string, (...a: unknown[]) => any> | null = null;
    const run = await runWithBreakpoints(`${here}:${start + 4}`, ['resume'], async (page) => {
      kept = page;
      await page.goto!('/cart');
    });
    expect(run.steered).toEqual(['pause', 'next']);
    // After the test, as in an `afterAll`, with the context still armed.
    const pausing = kept!.pause!() as Promise<void>;
    await vi.waitFor(() => expect(run.paused()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.calls).toEqual(['goto', 'pause null']);
    expect(run.steered).toEqual(['pause', 'next']);
    // The person resumes it from the Inspector.
    await run.debuggerApi.resume();
    await pausing;
  });

  it('leaves a page.pause() on a page it never instrumented to Playwright, its Inspector free to open', async () => {
    resetInspectorSwitch();
    delete process.env.PW_CODEGEN_NO_INSPECTOR;
    const start = thisLine();
    const switchAt: Array<string | undefined> = [];
    const run = await runWithBreakpoints(
      `${here}:${start + 12}`,
      ['resume'],
      async (page) => {
        switchAt.push(process.env.PW_CODEGEN_NO_INSPECTOR);
        // A page of a browser the test launched itself has Playwright's Page prototype, and no fixture wrapper.
        const other = Object.assign(Object.create(Object.getPrototypeOf(page)) as { pause: () => Promise<void> }, {
          context: () => ({}),
        });
        await other.pause();
        await page.goto!('/cart');
      },
      false,
      undefined,
      { protoPause: true },
    );
    expect(switchAt).toEqual(['1']);
    expect(run.calls).toEqual(['own pause, the switch off', 'goto']);
    expect(run.shown.map(place)).toEqual([`pause-at.spec.ts:${start + 12}`]);
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBe('1');
  });

  it('finds the test’s line of a locator call Playwright places in this package’s own files', async () => {
    const start = thisLine();
    const run = await runWithBreakpoints(
      `${here}:${start + 6}`,
      ['resume'],
      async (page) => {
        await page.goto!('/cart');
        await page.getByText!('Pay').click();
      },
      false,
      undefined,
      // Where Playwright places a call the proxy makes when this package's frames are not boxed.
      { clickPlacedAt: { file: path.join(CAPTURE_DIR, 'quiet-capture.ts'), line: 108, column: 3 } },
    );
    expect(run.shown.map(place)).toEqual([`pause-at.spec.ts:${start + 6}`]);
    expect(run.pauses).toEqual([
      expect.objectContaining({ location: expect.stringMatching(`^${here}:${start + 6}:`), reason: 'breakpoint' }),
    ]);
  });

  it('takes the bar down when the test ends under it, lets its call go at once, and waits for it before the data', async () => {
    const start = thisLine();
    let click: Promise<unknown> | null = null;
    const run = await runWithBreakpoints(
      `${here}:${start + 8}`,
      [],
      async (page) => {
        // As when a wait started before the stop runs out: the test ends with the click still stopped.
        const evaluate = page.evaluate as unknown as { mock: { calls: unknown[][] } };
        click = page.getByText!('Pay').click();
        await vi.waitFor(() => expect(evaluate.mock.calls.map((c) => c[0])).toContain(showPauseBar));
      },
      false,
      undefined,
      { holdBar: true },
    );
    expect(run.shown).toHaveLength(1);
    expect(run.evaluated.filter((fn) => fn === showPauseBar || fn === takePauseState)).toEqual([
      showPauseBar,
      takePauseState,
    ]);
    expect(run.pauses).toEqual([
      expect.objectContaining({ location: expect.stringMatching(`^${here}:${start + 8}:`), reason: 'breakpoint' }),
    ]);
    expect(run.pauses[0]!.duration).toBeGreaterThan(0);
    // The click went on as the bar came down, with nothing to stop it, and was over before the data was attached.
    expect(run.callsAtAttach[ATTACHMENT_NAMES.pauses]).toEqual(['click']);
    expect(run.steered).toEqual(['pause', 'resume']);
    await click;
  });

  it('takes the bar down as the test function ends, ahead of the runner’s own callbacks there', async () => {
    const start = thisLine();
    let evaluated: () => unknown[] = () => [];
    const screenshot: string[] = [];
    // Playwright's failure screenshot is registered before the capture fixture sets up.
    const finishCallbacks = new Set<() => void>([
      () => void screenshot.push(evaluated().includes(takePauseState) ? 'without the bar' : 'with the bar'),
    ]);
    const run = await runWithBreakpoints(
      `${here}:${start + 13}`,
      [],
      async (page) => {
        const evaluate = page.evaluate as unknown as { mock: { calls: unknown[][] } };
        evaluated = () => evaluate.mock.calls.map((c) => c[0]);
        void page.getByText!('Pay').click();
        await vi.waitFor(() => expect(evaluated()).toContain(showPauseBar));
      },
      false,
      undefined,
      { holdBar: true, finishCallbacks },
    );
    expect(finishCallbacks.size).toBe(2);
    expect(screenshot).toEqual(['without the bar']);
    expect(run.callsAtAttach[ATTACHMENT_NAMES.pauses]).toEqual(['click']);
    expect(run.steered).toEqual(['pause', 'resume']);
  });

  it('lets a held call go at once when its page closes under the bar, and keeps stopping at the breakpoints', async () => {
    const start = thisLine();
    const run = await runWithBreakpoints(
      `${here}:${start + 6}`,
      [],
      async (page) => {
        const evaluate = page.evaluate as unknown as { mock: { calls: unknown[][] } };
        const click = page.getByText!('Pay').click();
        await vi.waitFor(() => expect(evaluate.mock.calls.map((c) => c[0])).toContain(showPauseBar));
        await page.close!();
        await click;
      },
      false,
      undefined,
      { holdBar: true },
    );
    expect(run.calls).toEqual(['click']);
    expect(run.steered).toEqual(['pause', 'next']);
    expect(run.pauses[0]!.duration).toBeGreaterThan(0);
  });
});

describe('the Inspector switch', () => {
  const env = { ...process.env };
  beforeEach(() => {
    resetInspectorSwitch();
    delete process.env.PW_CODEGEN_NO_INSPECTOR;
  });
  afterEach(() => {
    resetInspectorSwitch();
    process.env = { ...env };
  });

  /** A context whose stops Piwi answers. */
  function watchedContext() {
    const dbg = {
      on: () => {},
      pausedDetails: () => null,
      requestPause: async () => {},
      next: async () => {},
      resume: async () => {},
    };
    return { debugger: dbg };
  }

  it('closes Playwright’s Inspector once every page.pause() goes through Piwi, and opens it while one left to Playwright runs', async () => {
    expect(watchStops(watchedContext() as never, () => {})).toBe(true);
    // A page.pause() Piwi could not see would stop with no Inspector to end it: the switch waits for the wrapper.
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBeUndefined();
    markPausesWrapped();
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBe('1');
    const seen: Array<string | undefined> = [];
    let endFirst = () => {};
    const first = withInspector(
      () =>
        new Promise<void>((resolve) => {
          seen.push(process.env.PW_CODEGEN_NO_INSPECTOR);
          endFirst = resolve;
        }),
    );
    await withInspector(async () => void seen.push(process.env.PW_CODEGEN_NO_INSPECTOR));
    // Still off: the first one runs.
    seen.push(process.env.PW_CODEGEN_NO_INSPECTOR);
    endFirst();
    await first;
    expect(seen).toEqual([undefined, undefined, undefined]);
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBe('1');
    await expect(
      withInspector(async () => {
        throw new Error('Target page, context or browser has been closed');
      }),
    ).rejects.toThrow('closed');
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBe('1');
  });

  it('leaves a switch set outside Piwi as it is', async () => {
    process.env.PW_CODEGEN_NO_INSPECTOR = 'yes';
    watchStops(watchedContext() as never, () => {});
    markPausesWrapped();
    await withInspector(async () => expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBe('yes'));
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBe('yes');
  });
});
