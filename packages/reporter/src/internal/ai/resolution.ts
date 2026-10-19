/**
 * The authoring loop, reporter-side: drive the agent to compile a prompt into a
 * committed entry, then verify it. Each iteration sends the server a stateless
 * `{ template, param names, action history, masked snapshot }` and gets back one
 * decision — an element (role + name + snapshot ref) + action, or done +
 * postcondition. The model's picks are turned into the committed locator by the
 * deterministic `@piwitests/core` scorer, grounded on the element the ref names
 * (`ground.ts`), so sampling never changes the bytes. Param values are
 * masked out of every outbound snapshot; secrets never leave the machine.
 *
 * The wire types mirror the server's `#shared/ai-step-resolution` (the reporter
 * must not import app `shared/`); a change here is a server-contract change.
 */
import type { Locator, Page, Response } from '@playwright/test';
import { ariaSnapshotBestEffort } from '../capture/capture-fixtures.js';
import type { LocatorEntry, Postcondition, RunEntry, RunStep } from './artifact.js';
import { ARTIFACT_VERSION } from './artifact.js';
import { groundElement } from './ground.js';
import { assertPostcondition, buildLocator, executeStep } from './interpreter.js';
import { extractPlaceholders, isParametric, maskValues, type ParamValues } from './params.js';

/** ARIA snapshots can be large; cap what we send so cost/latency stay bounded. */
const MAX_SNAPSHOT_CHARS = 24_000;

/** Default ceiling on how many steps one flow resolution may take. */
const DEFAULT_MAX_STEPS = 20;
/** The most response URLs one wait request sends, and the longest URL kept (the dashboard bounds both). */
const MAX_OBSERVED_RESPONSES = 50;
const MAX_OBSERVED_URL_CHARS = 4_000;

// ── Wire contract (mirror of #shared/ai-step-resolution) ─────────────────────

export interface ResolvedElement {
  role: string;
  name?: string;
  level?: number;
  ref?: string;
}

export interface StepHistoryItem {
  action: string;
  element?: ResolvedElement;
  value?: string;
}

export interface StepResolutionRequest {
  kind: 'locator' | 'run' | 'wait';
  template: string;
  paramNames: string[];
  ariaSnapshot: string;
  history: StepHistoryItem[];
  /** `wait` kind: the masked XHR/fetch URLs the just-run step triggered. */
  observedResponses?: string[];
  screenshot?: { mediaType: 'image/png' | 'image/jpeg'; data: string };
}

export interface ResolvedPostcondition {
  assert: 'visible' | 'hidden' | 'attached' | 'url';
  element?: ResolvedElement;
  url?: string;
}

export interface StepResolutionResponse {
  done?: boolean;
  element?: ResolvedElement;
  action?: string;
  value?: string;
  optional?: boolean;
  postcondition?: ResolvedPostcondition;
  /** `wait` kind: URL glob replay should wait for after the step (absent = no wait). */
  waitForResponse?: string;
  reason?: string;
}

/** The transport that turns one iteration into one decision (an LLM call, server-side). */
export interface StepResolver {
  resolveStep(request: StepResolutionRequest): Promise<StepResolutionResponse>;
}

/** Posts each iteration to the dashboard's reporter-authenticated resolution endpoint. */
export class ServerStepResolver implements StepResolver {
  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string | null,
  ) {}

  async resolveStep(request: StepResolutionRequest): Promise<StepResolutionResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    const url = `${this.serverUrl.replace(/\/+$/, '')}/api/ai/step-resolution`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message || `piwi AI: step resolution failed (${res.status})`);
    }
    return (await res.json()) as StepResolutionResponse;
  }
}

/**
 * A `Locator`-shaped proxy that defers to `resolveOnce()` on first use — so a
 * `piwiLocator` cache miss in resolve mode can return synchronously, then author
 * and commit the entry when the caller first acts on or asserts it. Each method
 * returns a promise that resolves the real locator once (memoized) and delegates.
 */
export function lazyLocator(resolveOnce: () => Promise<Locator>): Locator {
  let pending: Promise<Locator> | null = null;
  const ensure = (): Promise<Locator> => (pending ??= resolveOnce());
  const handler: ProxyHandler<Record<string, never>> = {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      return (...args: unknown[]) =>
        ensure().then((loc) => (loc as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args));
    },
  };
  return new Proxy({}, handler) as unknown as Locator;
}

async function buildPostcondition(
  resolved: ResolvedPostcondition | undefined,
  template: string,
  ctx: ResolutionContext,
): Promise<Postcondition> {
  if (!resolved)
    throw new Error(`piwi AI: flow "${template}" resolved without a postcondition (the oracle is mandatory)`);
  if (resolved.assert === 'url') {
    if (!resolved.url) throw new Error(`piwi AI: flow "${template}" postcondition is a url assert without a url`);
    return { assert: 'url', url: resolved.url };
  }
  const compiled = resolved.element ? await groundElement(ctx.page, resolved.element, ctx.params) : null;
  if (!compiled) throw new Error(`piwi AI: flow "${template}" postcondition element could not be compiled`);
  return { assert: resolved.assert, locator: compiled.locator };
}

// ── Snapshot capture (trimmed + masked) ──────────────────────────────────────

/** How a resolution reads the page snapshot — injectable so tests need no browser. */
export type SnapshotReader = (page: Page, params: ParamValues) => Promise<string>;

/**
 * Reads the AI-mode snapshot with param values masked out of everything but its
 * `[ref=…]` markers, which name elements and must reach the model intact.
 */
export const readMaskedSnapshot: SnapshotReader = async (page, params) => {
  const raw = await ariaSnapshotBestEffort(page.locator('body'));
  if (!raw) return '';
  return raw
    .split(/(\[ref=\w+\])/)
    .map((part, i) => (i % 2 === 1 ? part : maskValues(part, params)))
    .join('');
};

/**
 * Observe the XHR/fetch response URLs an action triggers — browser-facing, so
 * injectable for tests. Runs the action, then settles briefly to catch
 * fire-and-forget replies before sampling.
 */
type ResponseObserver = (page: Page, action: () => Promise<void>, settleMs?: number) => Promise<string[]>;

const observeXhrResponses: ResponseObserver = async (page, action, settleMs) => {
  const urls: string[] = [];
  const onResponse = (res: Response): void => {
    const type = res.request().resourceType();
    if (type === 'xhr' || type === 'fetch') urls.push(res.url());
  };
  page.on('response', onResponse);
  try {
    await action();
    await page
      .waitForLoadState('networkidle', settleMs === undefined ? undefined : { timeout: settleMs })
      .catch(() => {});
  } finally {
    page.off('response', onResponse);
  }
  return urls;
};

/** A base64 screenshot the model can fall back to when the ARIA snapshot is empty. */
export type Screenshot = { mediaType: 'image/png' | 'image/jpeg'; data: string };

/** Capture a viewport screenshot (browser-facing; injectable for tests). Null on failure. */
type ScreenshotCapturer = (page: Page) => Promise<Screenshot | null>;

const captureViewportScreenshot: ScreenshotCapturer = async (page) => {
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 60 });
    return { mediaType: 'image/jpeg', data: buffer.toString('base64') };
  } catch {
    return null;
  }
};

/** Everything one resolution needs; the browser-facing pieces and caps are injectable. */
export interface ResolutionContext {
  page: Page;
  params: ParamValues;
  resolver: StepResolver;
  readSnapshot?: SnapshotReader;
  /** Observe the responses an action triggers (default `observeXhrResponses`). */
  observeResponses?: ResponseObserver;
  /**
   * Opt-in vision fallback: when the ARIA snapshot is empty (a canvas-heavy page),
   * attach a screenshot so a vision-capable model can still ground the element.
   * Off by default — leave it off for models that do not accept images.
   */
  screenshotFallback?: boolean;
  captureScreenshot?: ScreenshotCapturer;
  /** Max steps one flow resolution may take (default `DEFAULT_MAX_STEPS`). */
  maxSteps?: number;
  /** Max characters of the snapshot sent per iteration (default `MAX_SNAPSHOT_CHARS`). */
  maxSnapshotChars?: number;
  /** Existence-probe timeout (ms) for `optional` steps executed while resolving. */
  optionalProbeTimeout?: number;
  /** Timeout (ms) for a step's `waitForResponse` (replay) and the authoring settle. */
  responseWaitTimeout?: number;
}

/** A vision-fallback screenshot, only when enabled and the ARIA snapshot is empty. */
async function maybeScreenshot(ctx: ResolutionContext, ariaSnapshot: string): Promise<Screenshot | undefined> {
  if (!ctx.screenshotFallback || ariaSnapshot.length > 0) return undefined;
  const capture = ctx.captureScreenshot ?? captureViewportScreenshot;
  return (await capture(ctx.page)) ?? undefined;
}

function assertParametric(template: string, locatorJson: string): void {
  if (extractPlaceholders(template).length > 0 && !isParametric(template, locatorJson)) {
    throw new Error(
      `piwi AI: resolved locator for "${template}" is not parametric — the grounding pinned a concrete value instead of a placeholder`,
    );
  }
}

/**
 * Resolve a single element `template` into a committed entry, then verify it is
 * reachable on the live page with the real parameter values.
 */
export async function resolveLocator(template: string, ctx: ResolutionContext): Promise<LocatorEntry> {
  const readSnapshot = ctx.readSnapshot ?? readMaskedSnapshot;
  const cap = ctx.maxSnapshotChars ?? MAX_SNAPSHOT_CHARS;
  const ariaSnapshot = (await readSnapshot(ctx.page, ctx.params)).slice(0, cap);
  const screenshot = await maybeScreenshot(ctx, ariaSnapshot);
  const decision = await ctx.resolver.resolveStep({
    kind: 'locator',
    template,
    paramNames: Object.keys(ctx.params),
    ariaSnapshot,
    history: [],
    ...(screenshot ? { screenshot } : {}),
  });
  if (!decision.element) throw new Error(`piwi AI: resolver returned no element for "${template}"`);
  const compiled = await groundElement(ctx.page, decision.element, ctx.params);
  if (!compiled) throw new Error(`piwi AI: element for "${template}" could not be compiled to a stable locator`);

  const entry: LocatorEntry = {
    version: ARTIFACT_VERSION,
    kind: 'locator',
    template,
    locator: compiled.locator,
    fingerprint: compiled.fingerprint,
  };
  assertParametric(template, JSON.stringify(compiled.locator));

  // Verify: the built locator must resolve on the live page with real values.
  const built: Locator = buildLocator(ctx.page, compiled.locator, ctx.params);
  await built.first().waitFor({ state: 'visible' });
  return entry;
}

/**
 * Resolve a flow into a committed entry: iterate the agent, executing each step
 * with real parameter values so the page advances, until it declares the flow
 * done. The postcondition is asserted immediately (the verify oracle) before the
 * entry is returned, so a subtly wrong flow never lands.
 */
export async function resolveRun(template: string, ctx: ResolutionContext): Promise<RunEntry> {
  const readSnapshot = ctx.readSnapshot ?? readMaskedSnapshot;
  const maxSteps = ctx.maxSteps ?? DEFAULT_MAX_STEPS;
  const cap = ctx.maxSnapshotChars ?? MAX_SNAPSHOT_CHARS;
  const paramNames = Object.keys(ctx.params);
  const steps: RunStep[] = [];
  const history: StepHistoryItem[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const ariaSnapshot = (await readSnapshot(ctx.page, ctx.params)).slice(0, cap);
    const screenshot = await maybeScreenshot(ctx, ariaSnapshot);
    const decision = await ctx.resolver.resolveStep({
      kind: 'run',
      template,
      paramNames,
      ariaSnapshot,
      history,
      ...(screenshot ? { screenshot } : {}),
    });

    if (decision.done) {
      const postcondition = await buildPostcondition(decision.postcondition, template, ctx);
      await assertPostcondition(postcondition, { page: ctx.page, params: ctx.params });
      return { version: ARTIFACT_VERSION, kind: 'run', template, steps, postcondition };
    }

    if (!decision.element || !decision.action) {
      throw new Error(`piwi AI: resolver returned neither a step nor done for "${template}"`);
    }
    const compiled = await groundElement(ctx.page, decision.element, ctx.params);
    if (!compiled) throw new Error(`piwi AI: a step element for "${template}" could not be compiled`);

    const step: RunStep = { locator: compiled.locator, action: decision.action, fingerprint: compiled.fingerprint };
    if (decision.value !== undefined) step.value = decision.value;
    if (decision.optional) step.optional = true;
    steps.push(step);

    // Execute with real values so the page advances for the next iteration, while
    // observing the Ajax calls it triggers. No drift guard here — the element was
    // just read off this very snapshot.
    const observe = ctx.observeResponses ?? observeXhrResponses;
    const observed = await observe(
      ctx.page,
      () =>
        executeStep(step, {
          page: ctx.page,
          params: ctx.params,
          optionalProbeTimeout: ctx.optionalProbeTimeout,
        }).then(() => undefined),
      ctx.responseWaitTimeout,
    );
    history.push({ action: decision.action, element: decision.element, value: decision.value });

    // Let the model pick the network response replay should wait for, from the
    // real (masked) URLs the action produced. Prompt URLs never contain them.
    const observedResponses = [...new Set(observed.map((url) => maskValues(url, ctx.params)))]
      .filter((url) => url.length <= MAX_OBSERVED_URL_CHARS)
      .slice(0, MAX_OBSERVED_RESPONSES);
    if (observedResponses.length > 0) {
      const waitDecision = await ctx.resolver.resolveStep({
        kind: 'wait',
        template,
        paramNames,
        ariaSnapshot: '',
        history,
        observedResponses,
      });
      if (waitDecision.waitForResponse) step.waitForResponse = waitDecision.waitForResponse;
    }
  }

  throw new Error(`piwi AI: exceeded the ${maxSteps}-step budget resolving "${template}"`);
}
