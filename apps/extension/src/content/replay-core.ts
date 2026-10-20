import type { RecordedStep, StepAssertion } from '@piwitests/core/recording';
import { t, tn } from '../shared/i18n.js';
import type { IconName } from '../shared/icons.js';
import type { ReplayEvidence, ReplayState, ReplayStepResult } from '../shared/replay-storage.js';

/**
 * The replay's decisions, apart from the page: whether an assertion holds on
 * what the page shows, and what a finished replay says about the bug.
 */

/** What the page shows for an assertion's element (or for the page itself). */
export interface Observation {
  /** How many elements the step's locator finds. */
  count: number;
  /** The first element's text, value, name and states. */
  text: string | null;
  value: string | null;
  name: string | null;
  visible: boolean;
  enabled: boolean;
  /** Whether the first element is checked: a checkbox, a radio, or an element whose role takes `aria-checked`. */
  checked: boolean;
  /** The page's address. */
  url: string;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whitespace collapsed and trimmed, as Playwright compares text. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** An expected URL made absolute on the replay's origin: a path is joined to it, a full URL is kept. */
export function absoluteUrl(expected: string, origin: string): string {
  try {
    return new URL(expected, `${origin}/`).href;
  } catch {
    return expected;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** A page text quoted the interface language's way: `"Total: 40"`, `« Total: 40 »`. */
export function quoted(text: string): string {
  return t('replay_quotedText', { text });
}

/** What an assertion found, in words: `"Total: 40"`, `hidden`, `nothing on the page`. */
function foundText(assertion: StepAssertion, o: Observation): string {
  if (assertion.matcher === 'toHaveURL') return o.url;
  if (o.count === 0) return t('replay_foundMissing');
  if (o.count > 1 || assertion.matcher === 'toHaveCount') return countText(o.count);
  switch (assertion.matcher) {
    case 'toHaveText':
    case 'toContainText':
      return quoted(normalizeText(o.text ?? ''));
    case 'toHaveValue':
      return quoted(o.value ?? '');
    case 'toHaveAccessibleName':
      return quoted(normalizeText(o.name ?? ''));
    case 'toBeVisible':
    case 'toBeHidden':
      return o.visible ? t('replay_foundVisible') : t('replay_foundHidden');
    case 'toBeEnabled':
    case 'toBeDisabled':
      return o.enabled ? t('replay_foundEnabled') : t('replay_foundDisabled');
    case 'toBeChecked':
      return o.checked ? t('replay_foundChecked') : t('replay_foundUnchecked');
  }
}

/** How many elements a locator found, in words: `nothing on the page`, `3 elements`. */
function countText(count: number): string {
  return count === 0 ? t('replay_foundMissing') : tn('replay_foundCount', count);
}

/**
 * Whether an assertion holds on an observation, with Playwright's rules: text
 * and names compare whole after collapsing whitespace (`toContainText` finds
 * its text inside), values compare exactly, a count counts every element the
 * locator finds, a URL compares in full, and an element that is not there is
 * hidden.
 */
export function evaluateAssertion(
  assertion: StepAssertion,
  o: Observation,
  origin: string,
): { holds: boolean; found: string } {
  const expected = assertion.expected ?? '';
  const one = o.count === 1;
  let positive: boolean;
  switch (assertion.matcher) {
    case 'toHaveText':
      positive = one && normalizeText(o.text ?? '') === normalizeText(expected);
      break;
    case 'toContainText':
      positive = one && normalizeText(o.text ?? '').includes(normalizeText(expected));
      break;
    case 'toHaveCount':
      positive = o.count === Number.parseInt(expected, 10);
      break;
    case 'toBeChecked':
      positive = one && o.checked;
      break;
    case 'toHaveValue':
      positive = one && (o.value ?? '') === expected;
      break;
    case 'toHaveAccessibleName':
      positive = one && normalizeText(o.name ?? '') === normalizeText(expected);
      break;
    case 'toBeVisible':
      positive = one && o.visible;
      break;
    case 'toBeHidden':
      positive = o.count === 0 || (one && !o.visible);
      break;
    case 'toBeEnabled':
      positive = one && o.enabled;
      break;
    case 'toBeDisabled':
      positive = one && !o.enabled;
      break;
    case 'toHaveURL':
      positive = o.url === absoluteUrl(expected, origin);
      break;
  }
  return { holds: assertion.negated ? !positive : positive, found: foundText(assertion, o) };
}

export type ReplayVerdict =
  | { kind: 'reproduced'; step: number; found: string; sameAsReported: boolean }
  /** `runStep` is the step the test failed at in its run, set when that step played here. */
  | { kind: 'not-reproduced'; runStep?: number }
  /** `asInRun` is set when the test failed at this same step in its run. */
  | { kind: 'diverged'; step: number; reason: string; asInRun?: boolean }
  | { kind: 'completed' }
  /** `step` is the step it stopped before; null when the run gave none (the desktop app's). */
  | { kind: 'stopped'; step: number | null };

/**
 * Whether what an assertion found is what the report says the reporter saw: the
 * same text, or the same page, the reported address taken on the origin it
 * was found on.
 */
function foundAsReported(assertion: StepAssertion | undefined, found: string): boolean {
  const actual = assertion?.actual;
  if (actual == null) return false;
  if (assertion!.matcher === 'toHaveURL') return found === absoluteUrl(actual, originOf(found));
  if (assertion!.matcher === 'toHaveCount') return /^\d+$/.test(actual) && found === countText(Number(actual));
  return found === quoted(normalizeText(actual)) || found === actual;
}

/**
 * What a finished replay says. A step that could not be done means the page
 * differs here (diverged), or, at the step a report made from a test run
 * failed at (`runFailedStep`), that it fails as it did in the run. Otherwise a
 * bug report's expected result that does not hold is the bug showing
 * (reproduced), and every one holding means it did not show, as does the
 * run's failed step playing. A recording with nothing expected just completed.
 */
export function replayVerdict(
  steps: RecordedStep[],
  results: ReplayStepResult[],
  stopped: boolean,
  runFailedStep: number | null = null,
): ReplayVerdict {
  const diverged = results.findIndex((r) => r?.status === 'diverged');
  if (diverged >= 0) {
    const reason = results[diverged]!.detail ?? '';
    return diverged === runFailedStep
      ? { kind: 'diverged', step: diverged, reason, asInRun: true }
      : { kind: 'diverged', step: diverged, reason };
  }
  const failed = results.findIndex((r) => r?.status === 'failed');
  if (failed >= 0) {
    const found = results[failed]!.found ?? '';
    const sameAsReported = foundAsReported(steps[failed]?.assertion, found);
    return { kind: 'reproduced', step: failed, found, sameAsReported };
  }
  if (stopped) return { kind: 'stopped', step: results.length };
  const runStep = runFailedStep == null ? undefined : results[runFailedStep]?.status;
  if (runStep === 'done' || runStep === 'passed') return { kind: 'not-reproduced', runStep: runFailedStep! };
  return steps.some((s) => s.action === 'assert' || s.action === 'assertVisible')
    ? { kind: 'not-reproduced' }
    : { kind: 'completed' };
}

/** The verdict as the replay panel says it. */
export function verdictText(verdict: ReplayVerdict, steps: RecordedStep[]): { title: string; detail: string } {
  switch (verdict.kind) {
    case 'reproduced': {
      const expected = steps[verdict.step]?.assertion?.expected;
      const step = verdict.step + 1;
      const found = verdict.found;
      let detail: string;
      if (expected != null) {
        detail = verdict.sameAsReported
          ? t('replay_verdictExpectedFoundAsReported', { step, expected, found })
          : t('replay_verdictExpectedFound', { step, expected, found });
      } else {
        detail = verdict.sameAsReported
          ? t('replay_verdictFoundAsReported', { step, found })
          : t('replay_verdictFound', { step, found });
      }
      return { title: t('replay_verdictReproduced'), detail };
    }
    case 'not-reproduced':
      return {
        title: t('replay_verdictNotReproduced'),
        detail:
          verdict.runStep == null
            ? t('replay_verdictNotReproducedDetail')
            : t('replay_verdictNotReproducedRun', { step: verdict.runStep + 1 }),
      };
    case 'diverged':
      if (verdict.asInRun) {
        return {
          title: t('replay_verdictFailedAsInRun', { step: verdict.step + 1 }),
          detail: t('replay_verdictFailedAsInRunDetail', { reason: verdict.reason }),
        };
      }
      return {
        title: t('replay_verdictDiverged', { step: verdict.step + 1 }),
        detail: t('replay_verdictDivergedDetail', { reason: verdict.reason }),
      };
    case 'completed':
      return { title: t('replay_verdictCompleted'), detail: t('replay_verdictCompletedDetail') };
    case 'stopped':
      return {
        title: t('replay_verdictStopped'),
        detail:
          verdict.step === null
            ? t('replay_verdictStoppedNoStep')
            : t('replay_verdictStoppedDetail', { step: verdict.step + 1 }),
      };
  }
}

/** The mark before a step in the replay's lists: where it is, or how it went. */
export function stepGlyph(result: ReplayStepResult | undefined, current: boolean): string {
  if (current) return '▸';
  switch (result?.status) {
    case 'done':
    case 'passed':
    case 'manual':
      return '✓';
    case 'failed':
      return '✗';
    case 'diverged':
      return '!';
    case 'skipped':
      return '–';
    default:
      return '·';
  }
}

/** The icon in front of a verdict's title. */
export const VERDICT_ICONS: Record<ReplayVerdict['kind'], IconName> = {
  reproduced: 'bug',
  'not-reproduced': 'check-circle',
  diverged: 'alert',
  completed: 'check-circle',
  stopped: 'stop',
};

/** A step's state in the replay's list, as an icon and the color it takes (`data-state`). */
export function stepStatus(
  result: ReplayStepResult | undefined,
  current: boolean,
): { icon: IconName; state: 'current' | 'ok' | 'failed' | 'diverged' | 'skipped' | 'pending' } {
  if (current) return { icon: 'play', state: 'current' };
  switch (result?.status) {
    case 'done':
    case 'passed':
      return { icon: 'check', state: 'ok' };
    case 'manual':
      return { icon: 'hand', state: 'ok' };
    case 'failed':
      return { icon: 'close', state: 'failed' };
    case 'diverged':
      return { icon: 'alert', state: 'diverged' };
    case 'skipped':
      return { icon: 'skip', state: 'skipped' };
    default:
      return { icon: 'dot', state: 'pending' };
  }
}

/** How the replay acts on the page, in words: trusted input, or the page's own events and why. */
export function driverText(choice: ReplayState['driver']): string {
  if (!choice) return '';
  if (choice.driver === 'cdp') return t('replay_driverTrusted');
  switch (choice.reason) {
    case 'unavailable':
      return t('replay_driverEventsUnavailable');
    case 'canceled':
      return t('replay_driverEventsCanceled');
    case 'lost':
      return t('replay_driverEventsLost');
    default:
      return t('replay_driverEventsRefused');
  }
}

export interface Waker {
  /** Resolves on the next `wake`, or at once when one came since the last wait. */
  wait(): Promise<void>;
  /**
   * Waits for the next wake or for `other`, whichever comes first. When
   * `other` does, the wait ends there, and a wake that comes with it or after
   * it is kept for the next wait.
   */
  until<T>(other: Promise<T>): Promise<{ woken: true } | { woken: false; value: T }>;
  wake(): void;
  /** Lets a wait in progress through, and keeps nothing when the loop is busy. */
  wakeWaiting(): void;
  /** Forgets a wake that came before this loop started. */
  reset(): void;
}

/**
 * What the replay loop waits on in step mode and when paused: Next, turning
 * step mode off or Stop, kept when they come while the loop is still busy
 * with a step (waiting for the page to settle) rather than lost with the loop
 * left waiting for a click already made. Pause and Continue only let a wait
 * in progress through: a busy loop reads them from the state at its next
 * step, and a kept wake would play the step after it without its Next.
 */
export function createWaker(): Waker {
  let release: (() => void) | null = null;
  let early = false;
  const wait = (): Promise<void> => {
    if (early) {
      early = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      release = () => {
        release = null;
        resolve();
      };
    });
  };
  return {
    wait,
    async until<T>(other: Promise<T>) {
      let woken = false;
      const waiting = wait().then(() => {
        woken = true;
      });
      const ours = release;
      const first = await Promise.race([
        waiting.then(() => ({ woken: true }) as const),
        other.then((value) => ({ woken: false, value }) as const),
      ]);
      if (!first.woken) {
        if (release === ours) release = null;
        if (woken) early = true;
      }
      return first;
    },
    wake() {
      if (release) release();
      else early = true;
    },
    wakeWaiting() {
      release?.();
    },
    reset() {
      early = false;
    },
  };
}

/** Lines of evidence shown under a verdict; more are counted. */
const EVIDENCE_SHOWN = 5;

/**
 * What the page showed during the replay, as lines under the verdict: failed
 * requests first ("POST /api/cart/coupon answered 500"), then console errors.
 * Empty when it showed nothing.
 */
export function evidenceLines(evidence: ReplayEvidence | null): { lines: string[]; more: number } {
  if (!evidence) return { lines: [], more: 0 };
  const all = [
    ...evidence.requests.map((r) =>
      r.status
        ? t('replay_seenRequest', { method: r.method, url: r.url, status: String(r.status) })
        : t('replay_seenRequestFailed', { method: r.method, url: r.url }),
    ),
    ...evidence.console.filter((c) => c.level === 'error').map((c) => t('replay_seenConsole', { message: c.message })),
  ];
  return { lines: all.slice(0, EVIDENCE_SHOWN), more: Math.max(0, all.length - EVIDENCE_SHOWN) };
}
