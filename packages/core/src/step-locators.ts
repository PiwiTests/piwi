/**
 * The locators a test used, read back from the steps Playwright reports for it.
 *
 * Every locator action and assertion step carries its full chain: in
 * `params.locator` from Playwright 1.63, and after the action verb in the step
 * title on 1.61 and 1.62 (`Select option getByRole('form', …).getByLabel('Country')`,
 * `Fill "Jane" getByLabel('Name')`, `Expect "toHaveValue" getByLabel('Country')`).
 * Only the chain, the action name and the call site are kept: typed values and
 * expected values never leave the step.
 */
import { renderLocatorChain, tryParseLocatorChain, type LocatorChain } from './locator-chain';
import { MAX_STEP_PARAM_VALUE_CHARS } from './step-analysis';
import { isCaptureStep } from './step-tree';

/** The subset of a stored step this module reads. */
export interface LocatorStepLike {
  title?: unknown;
  category?: unknown;
  subtitle?: unknown;
  params?: unknown;
  location?: unknown;
}

/** One locator use: what the step did, through which chain, from which line. */
export interface StepLocatorUse {
  /** Position of the step in the stored step list. */
  stepIndex: number;
  /** Normalized action: `click`, `fill`, `selectOption`, `expect.toHaveValue`, `expect.not.toBeVisible`, … */
  action: string;
  /** The chain in canonical form. */
  locator: string;
  chain: LocatorChain;
  /** `file:line:col` of the innermost user frame, as stored (may be absolute). */
  location: string | null;
}

/**
 * Step titles of locator actions, as Playwright prints them, mapped to the
 * action name. Titles ending in `"` carry a quoted value right after the verb.
 */
const ACTION_TITLES: ReadonlyArray<readonly [string, string]> = [
  ['Double click', 'dblclick'],
  ['Click', 'click'],
  ['Fill "', 'fill'],
  ['Select option', 'selectOption'],
  ['Uncheck', 'uncheck'],
  ['Check', 'check'],
  ['Hover', 'hover'],
  ['Tap', 'tap'],
  ['Focus', 'focus'],
  ['Blur', 'blur'],
  ['Press "', 'press'],
  ['Type "', 'type'],
  ['Set input files', 'setInputFiles'],
  ['Drag and drop', 'dragTo'],
  ['Drop files or data onto an element', 'drop'],
  ['Dispatch "', 'dispatchEvent'],
  ['Scroll into view', 'scrollIntoViewIfNeeded'],
  ['Wait for selector', 'waitFor'],
  ['Query count', 'count'],
  ['Evaluate', 'evaluate'],
];

/** Readable names for the stored action keys, in sentence case. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  click: 'Click',
  dblclick: 'Double click',
  fill: 'Fill',
  selectOption: 'Select option',
  check: 'Check',
  uncheck: 'Uncheck',
  hover: 'Hover',
  tap: 'Tap',
  focus: 'Focus',
  blur: 'Blur',
  press: 'Press',
  type: 'Type',
  setInputFiles: 'Set input files',
  dragTo: 'Drag and drop',
  drop: 'Drop',
  dispatchEvent: 'Dispatch event',
  scrollIntoViewIfNeeded: 'Scroll into view',
  waitFor: 'Wait for',
  count: 'Count',
  evaluate: 'Evaluate',
  expect: 'Expect',
  other: 'Other',
};

/** A stored action key (`selectOption`, `expect.not.toBeVisible`, …) as a sentence-case label. */
export function locatorActionLabel(action: string): string {
  if (action.startsWith('expect.')) {
    const rest = action.slice('expect.'.length);
    return rest.startsWith('not.') ? `Expect not ${rest.slice(4)}` : `Expect ${rest}`;
  }
  return ACTION_LABELS[action] ?? action;
}

/** Actions that operate the element, as opposed to reading or asserting on it. */
const INTERACTIONS = new Set([
  'click',
  'dblclick',
  'fill',
  'selectOption',
  'check',
  'uncheck',
  'hover',
  'tap',
  'focus',
  'blur',
  'press',
  'type',
  'setInputFiles',
  'dragTo',
  'drop',
  'dispatchEvent',
  'scrollIntoViewIfNeeded',
]);

/** Whether a stored action operates the element (a click, a fill, …) rather than asserting on it. */
export function isInteractionAction(action: string): boolean {
  return INTERACTIONS.has(action);
}

/** Index just past a quoted value opened at `open` (the index of its `"`). */
function endOfQuoted(title: string, open: number): number {
  for (let i = open + 1; i < title.length; i++) {
    if (title[i] === '\\') {
      i++;
      continue;
    }
    if (title[i] === '"') return i + 1;
  }
  return -1;
}

/** Read an `Expect "<matcher>"` title head: the action name and where the head ends. */
function readExpectTitle(title: string): { action: string; end: number } | null {
  if (!title.startsWith('Expect "')) return null;
  const end = endOfQuoted(title, 'Expect '.length);
  if (end < 0) return null;
  const words = title
    .slice('Expect "'.length, end - 1)
    .replace(/\(.*\)$/, '')
    .split(/\s+/)
    .filter((w) => w !== 'poll' && w !== 'soft');
  const matcher = words.pop();
  if (!matcher) return null;
  return { action: `expect.${words.includes('not') ? 'not.' : ''}${matcher}`, end };
}

/** The action a step title names, and where the title head (verb plus any quoted value) ends. */
function readTitle(title: string): { action: string; end: number } | null {
  const expectHead = readExpectTitle(title);
  if (expectHead) return expectHead;
  for (const [prefix, action] of ACTION_TITLES) {
    if (!title.startsWith(prefix)) continue;
    if (prefix.endsWith('"')) {
      // Titles print the value raw, so a value ending in `\` hides its closing
      // quote; the chain is then found after the verb all the same.
      const end = endOfQuoted(title, prefix.length - 1);
      return { action, end: end < 0 ? prefix.length : end };
    }
    const next = title[prefix.length];
    if (next === undefined || next === ' ') return { action, end: prefix.length };
  }
  return null;
}

const CHAIN_START = /(?:getBy[A-Za-z]+|locator|frameLocator)\(/g;

/**
 * Find the chain at the end of a Playwright 1.61 title: the earliest position
 * after `from` where the rest of the title parses as a whole chain. Values
 * typed into fields come before the chain, so a value that happens to contain
 * `getByText(` cannot win unless the whole remainder parses.
 */
function chainAtEnd(title: string, from: number): LocatorChain | null {
  CHAIN_START.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = CHAIN_START.exec(title)) !== null) {
    if (m.index > 0 && title[m.index - 1] !== ' ') continue;
    const chain = tryParseLocatorChain(title.slice(m.index));
    if (chain) return chain;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * A chain from a 1.63 `params.locator` or subtitle, unless it was cut short: a
 * cut value ends in `…`, and one exactly at the default cap was cut by a
 * reporter that added no marker. A cut chain can still parse, as a shorter one.
 */
function chainFromText(value: unknown): LocatorChain | null {
  if (typeof value !== 'string' || !value || value.endsWith('…') || value.length === MAX_STEP_PARAM_VALUE_CHARS) {
    return null;
  }
  return tryParseLocatorChain(value);
}

/** The locator use a stored step records, or null for steps that used no locator. */
export function extractStepLocatorUse(step: LocatorStepLike, stepIndex = 0): StepLocatorUse | null {
  const title = typeof step.title === 'string' ? step.title : '';
  const head = readTitle(title);
  const params = asRecord(step.params);
  const chain = chainFromText(params?.locator) ?? chainFromText(step.subtitle) ?? chainAtEnd(title, head?.end ?? 0);
  if (!chain) return null;
  const action = head?.action ?? (step.category === 'assertion' ? 'expect' : 'other');
  return {
    stepIndex,
    action,
    locator: renderLocatorChain(chain),
    chain,
    location: typeof step.location === 'string' && step.location ? step.location : null,
  };
}

/** Every locator use in a stored step list, in step order; the capture's own reads are not the test's uses. */
export function extractStepLocatorUses(steps: unknown): StepLocatorUse[] {
  if (!Array.isArray(steps)) return [];
  const out: StepLocatorUse[] = [];
  steps.forEach((step, i) => {
    const s = asRecord(step);
    if (!s || isCaptureStep(s)) return;
    const use = extractStepLocatorUse(s, i);
    if (use) out.push(use);
  });
  return out;
}

/** Every `file:line:col` location in a stored step list, in step order. */
export function stepLocations(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    const location = asRecord(step)?.location;
    return typeof location === 'string' && location ? [location] : [];
  });
}

/**
 * The project root inside absolute step locations. Steps carry the absolute
 * path of each file; a location in the test's own file (project-relative
 * `testFilePath`) shows where the root ends. Null when no location is in the
 * test's file — every step of a page-object-only test sits in other files.
 */
export function findLocationRoot(locations: string[], testFilePath: string | null): string | null {
  const file = testFilePath?.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!file) return null;
  for (const loc of locations) {
    const path = loc.replace(/\\/g, '/').replace(/(?::\d+){1,2}$/, '');
    if (path.endsWith(`/${file}`)) return path.slice(0, path.length - file.length);
  }
  return null;
}

/** A location with forward slashes and, when it starts with `root`, relative to it. */
export function stripLocationRoot(location: string, root: string | null): string {
  const normalized = location.replace(/\\/g, '/');
  return root && normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}

/** A directory as a location root: forward slashes and one trailing `/`. Null when empty. */
export function locationRootOf(dir: unknown): string | null {
  if (typeof dir !== 'string' || !dir.trim()) return null;
  return `${dir.trim().replace(/\\/g, '/').replace(/\/+$/, '')}/`;
}

/**
 * The root to strip from an execution's step locations: the run's working
 * directory when it prefixes one of them, else the root found from the test's
 * own file. A working directory that prefixes none (a shard that ran in another
 * agent's workspace, a drive letter in another case) would strip nothing.
 */
export function resolveLocationRoot(
  locations: string[],
  testFilePath: string | null,
  workingDir: unknown,
): string | null {
  const dir = locationRootOf(workingDir);
  if (dir && locations.some((loc) => loc.replace(/\\/g, '/').startsWith(dir))) return dir;
  return findLocationRoot(locations, testFilePath);
}

/** Whether a location is a machine path (`/home/…`, `C:/…`) rather than project-relative. */
export function isAbsoluteLocation(location: string): boolean {
  return /^(?:[A-Za-z]:)?[\\/]/.test(location);
}
