/**
 * What the demo's simulated workers say to a view of them, as a worker of a live run says it
 * (`@piwitests/core/live-view`): the call each test is in as Playwright logs it (`call-log`), the page at a call for
 * **Inspect** (`snapshot`), or why none comes, and how each test ended (`test-ended`). The demo runs no browser, so no
 * image, page event, text or filmstrip: the call logs are written from the simulated steps, and the pages are moments
 * of a committed trace of the checkout page (`DEMO_INSPECT_TRACE`), which the service worker renders as the server
 * renders a trace (`app/demo/api/live-view.ts`). Pure: the simulator publishes these, and the demo's watch reads them as
 * a watch reads its stream (`app/demo/live-watch.ts`).
 */
import {
  compressCallLog,
  type LiveCall,
  type LiveCallLog,
  type LiveViewerMessage,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import { SIMULATOR_CALL_LOGS, storyByClusterId } from '#shared/demo/failure-stories.mjs';
import { parseLocation } from '#shared/parse-location';

/** The committed trace whose pages Inspect shows in the demo: the checkout page, up to its disabled Pay button. */
export const DEMO_INSPECT_TRACE = 'demo/traces/checkout-pay-timeout.zip';

/** The locator of the Pay button cluster 1's story waits on: its click logs the story's call log, and keeps retrying. */
const PAY_LOCATOR = storyByClusterId(1)!.locator!;

/** The moments of a call the trace holds a page of: `<phase>@<call>` among its snapshots. */
export type DemoTracePhase = 'before' | 'after';

/**
 * The calls of the trace Inspect shows, by the target of the simulated step each stands for (its `subtitle`): the
 * navigation to the checkout, the email field filled, and the Pay click that waits on the disabled button, each with
 * the moments the trace holds a page of.
 */
export const DEMO_TRACE_CALLS: Readonly<Record<string, { call: string; phases: readonly DemoTracePhase[] }>> = {
  '/checkout': { call: 'call@8', phases: ['after'] },
  "getByLabel('Email address')": { call: 'call@10', phases: ['before', 'after'] },
  [PAY_LOCATOR]: { call: 'call@12', phases: ['before', 'after'] },
};

/** The trace's page and its main frame, which every page Inspect shows is of. */
const TRACE_PAGE = 'page@checkout';
const TRACE_FRAME = 'frame@checkout';

/** How long the story's call log covers of the Pay click, in ms: its first two retries. */
const PAY_LOG_MS = 150;
/** How often the Pay click tries again past them, in ms, as Playwright's last retry interval. */
const PAY_RETRY_MS = 500;
/** The most retries the Pay click's log counts: Playwright folds them into one line anyway. */
const MAX_PAY_RETRIES = 2000;
/** One retry of a click whose element is not enabled, its lines written as the story's log writes them. */
const PAY_RETRY = [
  'waiting for element to be visible, enabled and stable',
  'element is not enabled',
  'retrying click action',
  `waiting ${PAY_RETRY_MS}ms`,
];

/** What a demo worker says in place of its page's image, which a view shows where the image would be. */
export const DEMO_NO_IMAGE =
  'The demo runs no browser, so no image of the page comes. The call log shows the call its test is in.';
/** What a demo worker says when a view asks for its page's text. */
export const DEMO_NO_TEXT = 'The demo runs no browser: it has no page to read the text of.';
/** What a demo worker says for Inspect of a test whose calls the trace holds no page of. */
export const DEMO_NO_PAGES =
  'The demo has no page of this test: Inspect shows the checkout page from a recorded trace, for a test that opens it.';

/** A simulated step, as the demo logs the call it stands for. */
export interface DemoStep {
  title: string;
  /** Its target: a locator, or an address. */
  subtitle?: string;
  category: string;
  /** Project-relative `file:line:col` of the call. */
  location?: string;
  params?: Record<string, string | number | boolean>;
}

/** The call a step stands for, as Playwright's call stream names it: its title with its target, and its place. */
export function demoCall(step: DemoStep, testLocation: string): LiveCall {
  const at = parseLocation(step.location ?? testLocation);
  return {
    title: step.subtitle ? `${step.title} ${step.subtitle}` : step.title,
    file: at.filePath || null,
    line: at.line,
  };
}

/**
 * The lines Playwright logs of a step's call once it has run `ms`, as it writes them, before they are folded: a
 * navigation's address, a locator's wait, and for the story's Pay click the story's own log, then one retry each
 * `PAY_RETRY_MS` it goes on waiting.
 */
export function demoCallLines(step: DemoStep, ms: number): string[] {
  const locator = typeof step.params?.locator === 'string' ? step.params.locator : null;
  if (locator === PAY_LOCATOR) {
    const retries = Math.min(MAX_PAY_RETRIES, Math.max(0, Math.floor((ms - PAY_LOG_MS) / PAY_RETRY_MS)));
    return [...SIMULATOR_CALL_LOGS.checkoutPay, ...Array.from({ length: retries }, () => PAY_RETRY).flat()];
  }
  if (step.category === 'navigation') {
    const url = typeof step.params?.url === 'string' ? step.params.url : step.subtitle;
    return url ? [`navigating to "${url}", waiting until "load"`] : [];
  }
  return locator ? [`waiting for ${locator}`] : [];
}

/** The first line of the error a call ended with: the call a test timeout cut short, after its `---`, else its own. */
export function demoCallError(error: string): string {
  const parts = error.split('\n---\n');
  return (parts[1] ?? parts[0]!).split('\n')[0]!;
}

/**
 * A step's call log, as a worker posts it: `id`, Playwright's id of the call; its lines folded as Playwright folds a
 * failed call's; while it runs, the element the story's Pay click waits on, one matched and not enabled.
 */
export function demoCallLog(
  step: DemoStep,
  opts: { id: string; testLocation: string; status: LiveCallLog['status']; ms: number; error?: string | null },
): LiveCallLog {
  const waitsOnPay = step.params?.locator === PAY_LOCATOR && opts.status === 'running';
  return {
    id: opts.id,
    call: demoCall(step, opts.testLocation),
    status: opts.status,
    lines: compressCallLog(demoCallLines(step, opts.ms)),
    point: null,
    target: waitsOnPay ? { count: 1, box: null, enabled: false } : null,
    viewport: null,
    ms: Math.max(0, Math.round(opts.ms)),
    error: opts.error ? demoCallError(opts.error) : null,
  };
}

/**
 * The id of a step's call in one attempt of its test (`attempt`, unique in the run): the trace's, for a call Inspect
 * shows the page of, else one of its own (`n`, its place), then the attempt (`call@12:7`). Each attempt's calls and
 * pages are its own, as a worker's are; `demoTraceCall` reads the trace's id back.
 */
export function demoCallId(step: DemoStep, n: number, attempt: string): string {
  return `${(step.subtitle && DEMO_TRACE_CALLS[step.subtitle]?.call) || `demo@${n}`}:${attempt}`;
}

/** The trace's call a demo call id names: `call@12` of `call@12:7`. */
export function demoTraceCall(call: string): string {
  return call.split(':')[0]!;
}

/**
 * The notice of the page at a step's call (`call`, its id from `demoCallId`, at `phase`), for Inspect, when the trace
 * holds one: its call, title and moment, `index` its place among the test's pages, `at` when it was taken. Null when
 * the trace holds none.
 */
export function demoSnapshotNotice(
  worker: LiveWorkerId,
  test: string,
  step: DemoStep,
  opts: { call: string; testLocation: string; phase: DemoTracePhase; index: number; at: number },
): Extract<LiveViewerMessage, { type: 'snapshot' }> | null {
  const traced = step.subtitle ? DEMO_TRACE_CALLS[step.subtitle] : undefined;
  if (!traced?.phases.includes(opts.phase)) return null;
  return {
    type: 'snapshot',
    ...worker,
    call: opts.call,
    title: demoCall(step, opts.testLocation).title,
    phase: opts.phase,
    page: TRACE_PAGE,
    frame: TRACE_FRAME,
    main: true,
    full: opts.index === 0,
    index: opts.index,
    at: opts.at,
    test,
  };
}

/** Whether Inspect shows a page of any of a test's steps. */
export function demoTestHasPages(steps: readonly DemoStep[]): boolean {
  return steps.some((step) => !!step.subtitle && !!DEMO_TRACE_CALLS[step.subtitle]);
}
