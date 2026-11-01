import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installPickerOverlay,
  pauseAnswered,
  removeStopHighlight,
  showPauseBar,
  showPickerChoices,
  showStopHighlight,
  takePauseState,
} from '@piwitests/picker-dom';
import {
  askAgain,
  askedOnce,
  atBreakpoint,
  atStop,
  BarIntents,
  callSitePlace,
  currentPauseSet,
  goOn,
  highlightAtStop,
  inFlightCallSite,
  lineKey,
  markPausesWrapped,
  parsePauseAt,
  pauseState,
  placeLine,
  replacePauseSet,
  wantsStops,
  pauseHere,
  pauseGateFromTestInfo,
  pausePlace,
  pauseSkipReason,
  pickPayload,
  postPickToEditor,
  resetInspectorSwitch,
  resetPauseLogs,
  restoreTestTime,
  stopCallSite,
  testTimeSlot,
  watchStops,
  withEndSignal,
  withInspector,
  withTestTimeoutHeld,
  type PausePoint,
  type PauseRecord,
  type PauseState,
} from '../src/internal/capture/pause-at.js';
import {
  intentAt,
  piwiFixtures,
  probeElementAttrs,
  CAPTURED_ATTRS_ARG,
  type IntentStop,
} from '../src/internal/capture/capture-fixtures.js';
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

  it('follows the links on the way to a listed file, as a stack frame names the file Node loaded', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-pause-link-')));
    try {
      fs.mkdirSync(path.join(root, 'shared', 'pages'), { recursive: true });
      fs.writeFileSync(path.join(root, 'shared', 'pages', 'cart.page.ts'), '');
      fs.mkdirSync(path.join(root, 'app'));
      fs.symlinkSync(path.join(root, 'shared', 'pages'), path.join(root, 'app', 'pages'), 'dir');
      const set = parsePauseAt('pages/cart.page.ts:3', path.join(root, 'app'));
      expect(set.matches('../shared/pages/cart.page.ts:3:5')).toBe(true);
      expect(set.matches('pages/cart.page.ts:3:5')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('compares the lines without case on Windows alone', () => {
    expect(lineKey('tests/Pages/cart.page.ts:3', true)).toBe(lineKey('tests/pages/cart.page.ts:3', true));
    expect(lineKey('tests/Pages/cart.page.ts:3', false)).not.toBe(lineKey('tests/pages/cart.page.ts:3', false));
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

  it('pauses a headless run too while the run connection to the editor is open, never under CI or a debugger', () => {
    expect(pauseSkipReason({ ci: undefined, headless: true, channel: true })).toBeNull();
    expect(pauseSkipReason({ ci: undefined, headless: undefined, channel: true })).toBeNull();
    expect(pauseSkipReason({ ci: undefined, headless: true, channel: false })).toMatch(/headless/);
    expect(pauseSkipReason({ ci: '1', headless: true, channel: true })).toMatch(/running under CI/);
    expect(pauseSkipReason({ ci: undefined, headless: true, channel: true, pwdebug: '1' })).toMatch(/PWDEBUG/);
    expect(pauseSkipReason({ ci: undefined, headless: true, channel: true, debug: 'cli' })).toMatch(/--debug=cli/);
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
  const state = (lines: string): PauseState => pauseState(parsePauseAt(lines, path.resolve('/work/shop')));

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

  it('shows no breakpoint more after Finish, and runs on freely, but for a stop asked once', () => {
    const s = state('tests/a.spec.ts:5');
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ show: 'breakpoint' });
    expect(goOn(s, 'finish')).toBe('resume');
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ go: 'resume' });
    expect(wantsStops(s)).toBe(false);
    s.pause = true;
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ show: 'pause' });
    expect(goOn(s, 'step')).toBe('next');
    expect(atStop(s, 'tests/a.spec.ts:6:3')).toEqual({ show: 'step' });
  });

  it('stops nowhere more after End the test, a stop asked once included', () => {
    const s = state('tests/a.spec.ts:5');
    s.runTo = 'tests/a.spec.ts:9';
    s.pause = true;
    expect(goOn(s, 'end')).toBe('resume');
    expect(wantsStops(s)).toBe(false);
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ go: 'resume' });
    expect(atStop(s, 'tests/a.spec.ts:9:3')).toEqual({ go: 'resume' });
  });

  it('shows the first stop in the user’s code after a Pause, and resumes a stale one on another context at once', () => {
    const s = state('');
    expect(wantsStops(s)).toBe(false);
    s.pause = true;
    expect(wantsStops(s)).toBe(true);
    // A stop outside the user's code keeps the pause asked.
    expect(atStop(s, null)).toEqual({ go: 'next' });
    expect(atStop(s, 'tests/a.spec.ts:4:3')).toEqual({ show: 'pause' });
    expect(goOn(s, 'resume')).toBe('resume');
    // The other context, armed by the same Pause, stops at its next call.
    expect(atStop(s, 'tests/a.spec.ts:9:3')).toEqual({ go: 'resume' });
  });

  it('runs to a line as a breakpoint used once, and a stop before it uses it up', () => {
    const s = state('tests/a.spec.ts:7');
    s.runTo = 'tests/a.spec.ts:9';
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ go: 'next' });
    expect(atStop(s, 'tests/a.spec.ts:9:12')).toEqual({ show: 'run-to' });
    expect(s.runTo).toBeNull();
    expect(goOn(s, 'resume')).toBe('next');
    s.runTo = 'tests/a.spec.ts:9';
    expect(atStop(s, 'tests/a.spec.ts:7:3')).toEqual({ show: 'breakpoint' });
    expect(atStop(s, 'tests/a.spec.ts:9:12')).toEqual({ go: 'next' });
    const free = state('');
    free.runTo = 'tests/a.spec.ts:9';
    expect(goOn(free)).toBe('next');
    expect(atStop(free, 'tests/a.spec.ts:9:1')).toEqual({ show: 'run-to' });
    expect(goOn(free, 'resume')).toBe('resume');
  });

  it('reads the editor’s places as call sites, and takes its breakpoints in place of PIWI_PAUSE_AT', () => {
    const cwd = path.resolve('/work/shop');
    expect(callSitePlace('tests/a.spec.ts:9:12')).toEqual({ file: 'tests/a.spec.ts', line: 9, column: 12 });
    expect(callSitePlace('../shared/b.ts:3:0')).toEqual({ file: '../shared/b.ts', line: 3 });
    expect(callSitePlace('tests/a.spec.ts')).toBeNull();
    expect(placeLine({ file: './tests/a.spec.ts', line: 9 }, cwd)).toBe('tests/a.spec.ts:9');
    process.env.PIWI_PAUSE_AT = 'tests/a.spec.ts:5';
    try {
      expect(currentPauseSet().matches('tests/a.spec.ts:5:1')).toBe(true);
      const set = replacePauseSet([{ file: 'tests/a.spec.ts', line: 6 }]);
      expect(currentPauseSet()).toBe(set);
      expect(set.matches('tests/a.spec.ts:6:1')).toBe(true);
      expect(set.matches('tests/a.spec.ts:5:1')).toBe(false);
      expect(replacePauseSet([]).size).toBe(0);
      expect(currentPauseSet().size).toBe(0);
    } finally {
      replacePauseSet(null);
      delete process.env.PIWI_PAUSE_AT;
    }
    expect(currentPauseSet().size).toBe(0);
  });

  it('runs on freely from a stop with no breakpoint and no Step waiting', () => {
    const s = state('');
    expect(atStop(s, 'tests/a.spec.ts:5:3')).toEqual({ go: 'resume' });
    expect(goOn(s, 'resume')).toBe('resume');
    expect(goOn(s, 'step')).toBe('next');
  });

  it('asks again what a stop used up when it does not show, a line asked since winning', () => {
    const s = state('tests/a.spec.ts:5');
    s.pause = true;
    s.runTo = 'tests/a.spec.ts:9';
    const asked = askedOnce(s);
    expect(atStop(s, 'tests/a.spec.ts:4:3')).toEqual({ show: 'pause' });
    expect(s).toMatchObject({ step: false, pause: false, runTo: null });
    askAgain(s, asked);
    expect(s).toMatchObject({ step: false, pause: true, runTo: 'tests/a.spec.ts:9' });
    expect(atStop(s, 'tests/a.spec.ts:4:3')).toEqual({ show: 'pause' });
    s.step = true;
    s.runTo = 'tests/a.spec.ts:12';
    askAgain(s, asked);
    expect(s).toMatchObject({ step: true, pause: true, runTo: 'tests/a.spec.ts:12' });
  });

  it('is at a breakpoint while its line is one of the set and the attempt did not finish', () => {
    const s = state('tests/a.spec.ts:5');
    expect(atBreakpoint(s, 'tests/a.spec.ts:5:3')).toBe(true);
    expect(atBreakpoint(s, null)).toBe(false);
    s.set = parsePauseAt('tests/a.spec.ts:6', path.resolve('/work/shop'));
    expect(atBreakpoint(s, 'tests/a.spec.ts:5:3')).toBe(false);
    expect(atBreakpoint(s, 'tests/a.spec.ts:6:3')).toBe(true);
    goOn(s, 'finish');
    expect(atBreakpoint(s, 'tests/a.spec.ts:6:3')).toBe(false);
  });
});

describe('withEndSignal', () => {
  const signal = new AbortController().signal;

  it('adds the end signal to a locator call’s options, wherever the method takes them, leaving the test’s own alone', () => {
    expect(withEndSignal('click', [], signal)).toEqual([{ signal }]);
    const options = { force: true };
    const given = withEndSignal('click', [options], signal)!;
    expect(given).toEqual([{ force: true, signal }]);
    expect(options).toEqual({ force: true });
    expect(withEndSignal('fill', ['hello'], signal)).toEqual(['hello', { signal }]);
    expect(withEndSignal('selectOption', [{ label: 'Red' }, { timeout: 5 }], signal)).toEqual([
      { label: 'Red' },
      { timeout: 5, signal },
    ]);
    expect(withEndSignal('dispatchEvent', ['click'], signal)).toEqual(['click', undefined, { signal }]);
    expect(withEndSignal('_expect', ['to.be.visible', { isNot: false }], signal)).toEqual([
      'to.be.visible',
      { isNot: false, signal },
    ]);
  });

  it('gives up with the test’s own signal too, and adds none to options it cannot read', () => {
    const own = new AbortController();
    const [options] = withEndSignal('click', [{ signal: own.signal }], signal) as [{ signal: AbortSignal }];
    expect(options.signal).not.toBe(own.signal);
    own.abort();
    expect(options.signal.aborted).toBe(true);
    expect(withEndSignal('click', ['nope'], signal)).toBeNull();
    expect(withEndSignal('fill', ['x', null], signal)).toBeNull();
    expect(withEndSignal('click', [{ signal: 'nope' }], signal)).toBeNull();
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

describe('the test time the runner counted', () => {
  function runner(elapsed: number) {
    const slot = { timeout: 3000, elapsed };
    return { slot, testInfo: { _timeoutManager: { defaultSlot: () => slot } } as never };
  }

  it('reads the runner’s default slot, and nothing on a runner without one', () => {
    expect(testTimeSlot(runner(420).testInfo)?.elapsed).toBe(420);
    expect(testTimeSlot({} as never)).toBeNull();
    expect(testTimeSlot({ _timeoutManager: { defaultSlot: () => ({}) } } as never)).toBeNull();
    expect(
      testTimeSlot({
        _timeoutManager: {
          defaultSlot: () => {
            throw new Error('gone');
          },
        },
      } as never),
    ).toBeNull();
  });

  it('brings the count of a test function that ended under the bar back to what it held as the stop began', () => {
    const { slot, testInfo } = runner(7517);
    restoreTestTime(testInfo, 2610);
    expect(slot.elapsed).toBe(2610);
  });

  it('never raises the count, and leaves a runner it cannot read alone', () => {
    const { slot, testInfo } = runner(900);
    restoreTestTime(testInfo, 1200);
    restoreTestTime(testInfo, Number.NaN);
    restoreTestTime(testInfo, -5);
    expect(slot.elapsed).toBe(900);
    expect(() => restoreTestTime({} as never, 10)).not.toThrow();
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

  it('names the host the run names in place of the editor', async () => {
    resetPauseLogs();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const refuse = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
      const address = 'http://127.0.0.1:47211/api/desktop/runs/picks#abcdefghijklmnop_1234';
      const payload = pickPayload('getByText("Pay")', 'tests/a.spec.ts:3:1');
      expect(await postPickToEditor(address, payload, refuse, 'the desktop app')).toBe(false);
      expect(log.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
        '[piwi] Could not send the picked locator to the desktop app: the desktop app answered 401.',
      ]);
    } finally {
      log.mockRestore();
      resetPauseLogs();
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
      } else if (fn === showPickerChoices) g.__piwiPickChoice = 0;
      else if (typeof fn === 'function' && String(fn).includes('__piwi')) return (fn as (a: unknown) => unknown)(arg);
      return null;
    }),
    evaluateHandle: vi.fn(async () => ({ evaluate: async () => opts.pick, dispose: async () => {} })),
    waitForFunction: vi.fn((predicate: unknown) => {
      if (opts.hangPick && predicate !== pauseAnswered) return new Promise<void>(() => {});
      return opts.holdBar ? new Promise<void>((resolve) => (takeDown = resolve)) : Promise.resolve();
    }),
    waitForLoadState: vi.fn(async () => {}),
    bringToFront: vi.fn(async () => {}),
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
    const hide = vi.fn(async () => true);
    const target = { highlight: vi.fn(() => ({ shown: Promise.resolve(true), hide })) };
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

  it('ends with its stop on a page that stops answering, taking the bar down a second at most', async () => {
    vi.useFakeTimers();
    try {
      const page = {
        evaluate: vi.fn((_fn: unknown, _arg?: unknown) => new Promise<never>(() => {})),
        waitForFunction: vi.fn(() => new Promise<never>(() => {})),
        waitForLoadState: vi.fn(async () => {}),
        isClosed: () => false,
      };
      const ended = new AbortController();
      let answer: string | undefined;
      void pauseHere(page as never, POINT, PROBE, () => {}, undefined, ended.signal).then((a) => (answer = a));
      await vi.advanceTimersByTimeAsync(0);
      expect(page.evaluate).toHaveBeenCalledWith(showPauseBar, expect.anything());
      ended.abort('ended');
      await vi.advanceTimersByTimeAsync(0);
      expect(page.evaluate.mock.calls.map((c) => c[0])).toEqual([showPauseBar, takePauseState]);
      expect(answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(answer).toBe('resume');
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes its highlight down before the test goes on, one its frame has not drawn yet included', async () => {
    vi.useFakeTimers();
    try {
      const { page, shown } = fakePausePage(['resume']);
      const order: string[] = [];
      // A frame that does not answer: the highlight is not drawn by the time the bar shows.
      const hide = vi.fn(async () => (order.push('hidden'), false));
      const target = { highlight: vi.fn(() => ({ shown: new Promise<boolean>(() => {}), hide })) };
      let answer: string | undefined;
      void pauseHere(page as never, { ...POINT, target }, PROBE, () => {}).then((a) => {
        order.push('went on');
        answer = a;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(shown).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(answer).toBe('resume');
      expect(shown).toHaveLength(1);
      expect(order).toEqual(['hidden', 'went on']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers Record here when the editor can record, and shows the bar again once the recording ended', async () => {
    const { page, shown } = fakePausePage(['record', 'resume']);
    const recorded = vi.fn(async () => {});
    const choice = await pauseHere(page as never, POINT, PROBE, () => {}, recorded);
    expect(choice).toBe('resume');
    expect(recorded).toHaveBeenCalledOnce();
    expect(shown).toEqual([expect.objectContaining({ record: true }), expect.objectContaining({ record: true })]);
  });

  it('takes an intent from outside the page as its own button, the window brought to the front, none while it runs', async () => {
    const { page, shown } = fakePausePage([], { holdBar: true });
    const intents = new BarIntents();
    const ended = new AbortController();
    let offeredMeanwhile: boolean | null = null;
    const recorded = vi.fn(async () => {
      offeredMeanwhile = intents.offer('pick');
    });
    const done = pauseHere(page as never, POINT, PROBE, () => {}, recorded, ended.signal, intents);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(intents.offer('record')).toBe(true);
    await vi.waitFor(() => expect(shown).toHaveLength(2));
    expect(recorded).toHaveBeenCalledOnce();
    expect(offeredMeanwhile).toBe(false);
    expect(page.bringToFront).toHaveBeenCalledOnce();
    ended.abort();
    expect(await done).toBe('resume');
  });
  it('ends a pick or a recording an intent started with the stop, as the bar’s own, the window’s raise included', async () => {
    const g = globalThis as Record<string, unknown>;
    const picking = fakePausePage([], { holdBar: true, hangPick: true });
    const pickIntents = new BarIntents();
    const ended = new AbortController();
    const picked = pauseHere(picking.page as never, POINT, PROBE, () => {}, undefined, ended.signal, pickIntents);
    await vi.waitFor(() => expect(picking.shown).toHaveLength(1));
    expect(pickIntents.offer('pick')).toBe(true);
    await vi.waitFor(() => expect(picking.page.evaluate.mock.calls.map((c) => c[0])).toContain(installPickerOverlay));
    ended.abort('ended');
    try {
      expect(await picked).toBe('resume');
      expect(g.__piwiPickEnded).toBe(true);
      const evaluated = picking.page.evaluate.mock.calls.map((c) => c[0]);
      expect(evaluated[evaluated.length - 1]).toBe(takePauseState);
    } finally {
      delete g.__piwiPickEnded;
    }

    // A window that does not come to the front holds nothing past the stop's end, and no recording starts then.
    const recording = fakePausePage([], { holdBar: true });
    recording.page.bringToFront = vi.fn(() => new Promise<void>(() => {}));
    const recordIntents = new BarIntents();
    const stopped = new AbortController();
    const record = vi.fn(async (_ended?: AbortSignal) => {});
    const recorded = pauseHere(recording.page as never, POINT, PROBE, () => {}, record, stopped.signal, recordIntents);
    await vi.waitFor(() => expect(recording.shown).toHaveLength(1));
    expect(recordIntents.offer('record')).toBe(true);
    await vi.waitFor(() => expect(recording.page.bringToFront).toHaveBeenCalledOnce());
    stopped.abort('closed');
    expect(await recorded).toBe('resume');
    expect(record).not.toHaveBeenCalled();
  });
});

describe('a stop’s highlight', () => {
  /** A locator whose `evaluateAll` runs the page function on `elements`, each call noted, or rejects with `fails`. */
  const locatorOf = (elements: unknown[], fails?: Error) => {
    const calls: Array<{ fn: unknown; arg: unknown }> = [];
    return {
      calls,
      evaluateAll: async (fn: (elements: unknown[], arg: unknown) => unknown, arg: unknown) => {
        calls.push({ fn, arg });
        if (fails) throw fails;
        return fn(elements, arg);
      },
    };
  };

  it('draws Piwi’s own highlight through the locator, labelled, never Playwright’s, and takes it down by its name', async () => {
    const g = globalThis as Record<string, unknown>;
    const locator = { ...locatorOf([]), highlight: vi.fn(), describe: vi.fn() };
    const page = { hideHighlight: vi.fn() };
    const call = highlightAtStop(page as never, locator as never, 'call', "getByRole('button')");
    const count = highlightAtStop(page as never, locator as never, 'count', "getByText('Pay')");
    // No document here: nothing is drawn.
    expect(await call.shown).toBe(false);
    expect(await count.shown).toBe(false);
    const [drawn, other] = locator.calls;
    expect(drawn).toEqual({
      fn: showStopHighlight,
      arg: { id: expect.stringMatching(/^call-\d+$/), kind: 'call', label: "getByRole('button')" },
    });
    expect(other!.arg).toMatchObject({ id: expect.stringMatching(/^count-\d+$/), kind: 'count' });
    expect(await call.hide()).toBe(false);
    expect(locator.calls[2]).toEqual({ fn: removeStopHighlight, arg: (drawn!.arg as { id: string }).id });
    expect(locator.highlight).not.toHaveBeenCalled();
    expect(locator.describe).not.toHaveBeenCalled();
    expect(page.hideHighlight).not.toHaveBeenCalled();
    delete g.__piwiStopHighlightsGone;
  });

  it('neither throws nor rejects on a page that breaks under it', async () => {
    const locator = locatorOf([], new Error('Target page, context or browser has been closed'));
    const highlight = highlightAtStop({} as never, locator as never, 'count', 'x');
    expect(await highlight.shown).toBe(false);
    expect(await highlight.hide()).toBe(false);
    const thrown = {
      evaluateAll: () => {
        throw new Error('not a locator');
      },
    };
    const broken = highlightAtStop({} as never, thrown as never, 'call', 'x');
    expect(await broken.shown).toBe(false);
    expect(await broken.hide()).toBe(false);
  });
});

describe('BarIntents', () => {
  it('keeps one intent handed before the bar waits, refuses a second, and none once the bar got its answer', async () => {
    const intents = new BarIntents();
    expect(intents.offer('pick')).toBe(true);
    expect(intents.offer('record')).toBe(false);
    expect(await intents.wait()).toBe('pick');
    intents.answered();
    expect(intents.offer('record')).toBe(false);
    const next = intents.wait();
    expect(intents.offer('record')).toBe(true);
    expect(await next).toBe('record');
  });
});

describe('an intent from outside the page', () => {
  const HOLDS: IntentStop = { record: true, guessed: false, holds: () => true };

  it('reaches the bar at a stop that holds, and is refused at one that is over or ending, or whose page is a guess', async () => {
    const intents = new BarIntents();
    // Answered, or ending: the test ended under it, or its page or context began to close.
    expect(intentAt(intents, 'pick', { ...HOLDS, holds: () => false })).toEqual({
      ok: false,
      message: 'The test went on.',
    });
    expect(intentAt(intents, 'record', { ...HOLDS, guessed: true, holds: () => false })).toEqual({
      ok: false,
      message: 'The test went on.',
    });
    // Its page is a guess among its context's pages: neither Pick nor Record could tell they are in the right one.
    for (const [what, name] of [
      ['pick', 'Pick a locator'],
      ['record', 'Record here'],
    ] as const) {
      expect(intentAt(intents, what, { ...HOLDS, guessed: true })).toEqual({
        ok: false,
        message: `${name} needs the page the test stopped in, which this call does not name among its context's pages: use the pause bar in the test's window.`,
      });
    }
    expect(intentAt(intents, 'record', { ...HOLDS, record: false })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Record here needs the editor that started the run/),
    });
    // None of those reached the bar: the first one taken is the one that holds.
    expect(intentAt(intents, 'pick', HOLDS)).toEqual({
      ok: true,
      message: "Pick an element in the test's window: the locator goes to the editor.",
    });
    expect(intentAt(intents, 'record', HOLDS)).toMatchObject({ ok: false, message: expect.stringMatching(/ waits: /) });
    expect(await intents.wait()).toBe('pick');
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

  it('leaves no switch of its own to the projects that depend on this one as the worker stops', () => {
    // Playwright reads the worker's environment as its `__stop__` message comes, and hands what changed on.
    const stop = () => process.emit('message' as never, { method: '__stop__' } as never);
    watchStops(watchedContext() as never, () => {});
    markPausesWrapped();
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBe('1');
    stop();
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBeUndefined();
    // A value set outside Piwi is the user's.
    resetInspectorSwitch();
    process.env.PW_CODEGEN_NO_INSPECTOR = '1';
    watchStops(watchedContext() as never, () => {});
    markPausesWrapped();
    stop();
    expect(process.env.PW_CODEGEN_NO_INSPECTOR).toBe('1');
  });

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
