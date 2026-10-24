import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionFromEvents, type RawCaptureEvent } from '@piwitests/core/recording';
import { toStepsDocument, type PiwiSteps } from '@piwitests/core/steps';
import { renderSpec, stepLocator } from '@piwitests/core/codegen';
import { playwrightLocator } from '../e2e/playwright-locator.js';
import { labFile, type Scenario } from './scenarios.js';

/**
 * The replay lab's moving parts: the real extension, loaded from a copy of
 * `dist/` granted the lab's origin (the permission a person grants in the
 * popup), records a scenario driven by Playwright's trusted input; the steps
 * are then replayed by the extension in a fresh browser, and written as a spec
 * for Playwright to run.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export const LAB = {
  origin: (process.env.LAB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, ''),
  dry: !!process.env.LAB_DRY,
  out: path.join(here, 'out'),
  viewport: { width: 1400, height: 900 },
  /** How long a person looks at a page before acting; a server-rendered app ignores input until it has hydrated. */
  settleMs: Number(process.env.LAB_SETTLE_MS ?? 5000),
  /** How many times each recording is replayed, each in a fresh browser: a step that plays only sometimes shows. */
  replays: Math.max(1, Number(process.env.LAB_REPLAYS ?? 1)),
  /** `events` replays with the page's own events, as Firefox does: the lab's extension has no `debugger`. */
  driver: process.env.LAB_DRIVER === 'events' ? 'events' : 'trusted',
  /** The build the lab loads: `dist/`, or another kept to compare with (`LAB_DIST`). */
  dist: process.env.LAB_DIST ? path.resolve(process.env.LAB_DIST) : path.join(here, '..', '..', 'dist'),
};

/** The address a scenario starts on: a route of `LAB.origin`, or a full URL of a site of its own. */
export function startUrl(scenario: Scenario): string {
  return new URL(scenario.start, `${LAB.origin}/`).href;
}

/** The origin a scenario records on, the one the person grants in the popup. */
export function originOf(scenario: Scenario): string {
  return new URL(startUrl(scenario)).origin;
}

function settleMsOf(scenario: Scenario): number {
  return scenario.settleMs ?? LAB.settleMs;
}

/** The extension the lab loads: a copy of `dist/` per worker, so one worker starting never pulls it from another's browser. */
let EXT = path.join(LAB.out, 'ext');

/**
 * Copies `dist/` into the lab with the origins of `scenarios` granted, as a
 * person grants each in the popup, for the worker `worker`.
 */
export function prepareExtension(scenarios: readonly Scenario[], worker = 0): void {
  EXT = path.join(LAB.out, `ext-${worker}`);
  rmSync(EXT, { recursive: true, force: true });
  cpSync(LAB.dist, EXT, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...new Set(scenarios.map((s) => `${originOf(s)}/*`))];
  if (LAB.driver === 'events') manifest.permissions = manifest.permissions.filter((p: string) => p !== 'debugger');
  writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const dir of ['results', 'specs', 'shots']) mkdirSync(path.join(LAB.out, dir), { recursive: true });
}

interface Lab {
  ctx: BrowserContext;
  /** An extension page: messages from it reach the background script, as the popup's do. */
  ctl: Page;
}

async function launch(): Promise<Lab> {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'piwi-lab-')), {
    channel: 'chromium',
    viewport: LAB.viewport,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let worker = ctx.serviceWorkers()[0];
  const deadline = Date.now() + 30_000;
  while (!worker && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker = ctx.serviceWorkers()[0];
  }
  if (!worker) throw new Error('The extension’s background script did not start.');
  const ctl = await ctx.newPage();
  await ctl.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  return { ctx, ctl };
}

export async function open(page: Page, scenario: Scenario): Promise<void> {
  // A scenario whose element never comes fails at that step, not at the test's timeout.
  page.context().setDefaultTimeout(30_000);
  await page.goto(startUrl(scenario), { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load', { timeout: 90_000 }).catch(() => undefined);
  await page.waitForTimeout(settleMsOf(scenario));
}

function shot(name: string): string {
  return path.join(LAB.out, 'shots', `${name}.png`);
}

export interface Recording {
  events: RawCaptureEvent[];
  startedAt: number;
  endUrl: string;
}

/** Drives `scenario` with the extension recording, and answers what it captured. */
export async function record(scenario: Scenario): Promise<Recording> {
  const { ctx, ctl } = await launch();
  try {
    const page = await ctx.newPage();
    await open(page, scenario);
    const origin = originOf(scenario);
    const tabId = await ctl.evaluate(async (origin) => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      return tab!.id!;
    }, origin);
    const started = await ctl.evaluate(
      ({ tabId, pattern, mode }) =>
        chrome.runtime.sendMessage({ type: 'piwi-start-recording', originPattern: pattern, tabId, mode }),
      { tabId, pattern: `${origin}/*`, mode: scenario.mode ?? 'actions' },
    );
    if (!started?.ok) throw new Error(`The recording did not start: ${JSON.stringify(started)}`);
    await page.waitForFunction(() => !!document.getElementById('piwi-record-hud-host'), null, { timeout: 15_000 });
    await scenario.run(page);
    await page.waitForTimeout(1500);
    const state = (await ctl.evaluate(
      async () => (await chrome.storage.session.get('piwiRecording')).piwiRecording,
    )) as { events: RawCaptureEvent[]; startedAt: number };
    // The page the recording ended on: the last of the origin's tabs, as a step may have opened one.
    const last =
      ctx
        .pages()
        .filter((p) => p.url().startsWith(origin))
        .pop() ?? page;
    await last.screenshot({ path: shot(`${scenario.name}.recorded`) });
    return { events: state.events, startedAt: state.startedAt, endUrl: last.url() };
  } finally {
    await ctx.close();
  }
}

export interface Replay {
  status: string;
  results: Array<{ status: string; detail: string | null }>;
  /** The step the replay could not play and handed to the person, which in the lab nobody does. */
  divergedAt: number | null;
  reason: string | null;
  endUrl: string | null;
  seconds: number;
  /** How the replay acted: `cdp` (trusted input) or `synthetic` (the page's own events), with why. */
  driver: { driver: string; reason: string | null } | null;
}

/** Replays `doc` with the extension in a fresh browser, from `start`; `run` names its screenshot. */
export async function replay(scenario: Scenario, doc: PiwiSteps, run = 0): Promise<Replay> {
  const { ctx, ctl } = await launch();
  const began = Date.now();
  const origin = originOf(scenario);
  try {
    const page = await ctx.newPage();
    await open(page, scenario);
    const started = await ctl.evaluate(
      ({ steps, origin }) =>
        chrome.runtime.sendMessage({ type: 'piwi-start-replay', steps, origin, stepMode: false, inject: false }),
      { steps: doc, origin },
    );
    if (!started?.ok) throw new Error(`The replay did not start: ${JSON.stringify(started)}`);
    // The replay script is registered for the origin: a load starts it.
    await page.reload();
    const deadline = Date.now() + 30_000 + doc.steps.length * 15_000;
    type Stored = {
      status: string;
      position: number;
      results: Replay['results'];
      driver?: Replay['driver'];
      handOver?: { step: number; reason: string } | null;
    } | null;
    let state: Stored = null;
    const answered = new Set<number>();
    const secrets = [...(scenario.secrets ?? [])];
    while (Date.now() < deadline) {
      state = (await ctl.evaluate(async () => (await chrome.storage.session.get('piwiReplay')).piwiReplay)) as Stored;
      if (state && state.status !== 'running' && state.status !== 'paused') break;
      const handed = state?.handOver;
      // A password the recording never kept: typed by the person, who then says it is done.
      const secretStep = handed ? doc.steps[handed.step] : undefined;
      if (handed && secretStep?.action === 'fill' && secretStep.redacted && secrets.length > 0) {
        const tab = ctx
          .pages()
          .filter((p) => p.url().startsWith(origin))
          .pop();
        const locator = secretStep.target ? stepLocator(secretStep.target, { locators: 'stable' }) : null;
        if (tab && locator && !answered.has(handed.step)) {
          answered.add(handed.step);
          await playwrightLocator(tab, locator).fill(secrets.shift()!);
          await pressInReplayPanel(tab, 'hand-over-done');
        }
      } else if (handed) {
        // Any other step handed to the person waits for them: in the lab, nobody comes.
        break;
      }
      // A file step asks for the file the report names: chosen in the replay's panel, as the developer would.
      const step = state ? doc.steps[state.position] : undefined;
      if (state && step?.action === 'setInputFiles' && !answered.has(state.position)) {
        const tab = ctx
          .pages()
          .filter((p) => p.url().startsWith(origin))
          .pop();
        if (tab && (await chooseInReplayPanel(tab, (step.value ?? '').split('\n').map(labFile)))) {
          answered.add(state.position);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const last = ctx
      .pages()
      .filter((p) => p.url().startsWith(origin))
      .pop();
    await last?.waitForTimeout(1500);
    const name = run === 0 ? `${scenario.name}.replayed` : `${scenario.name}.replayed-${run + 1}`;
    await last?.screenshot({ path: shot(name) }).catch(() => undefined);
    const results = state?.results ?? [];
    const handed = state?.handOver ?? null;
    const at = handed ? handed.step : results.findIndex((r) => r.status === 'diverged');
    return {
      status: handed ? 'handed over' : (state?.status ?? 'timeout'),
      results,
      divergedAt: at >= 0 ? at : null,
      reason: handed ? handed.reason : at >= 0 ? results[at]!.detail : null,
      endUrl: last?.url() ?? null,
      seconds: Math.round((Date.now() - began) / 1000),
      driver: state?.driver ?? null,
    };
  } finally {
    await ctx.close();
  }
}

type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

/** The node carrying `attribute` (with `value`, when given) anywhere in the page, closed shadow roots included. */
function findNode(root: DomNode, attribute: string, value?: string): number | null {
  const attrs = root.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === attribute && (value === undefined || attrs[i + 1] === value)) return root.backendNodeId;
  }
  for (const child of [...(root.children ?? []), ...(root.shadowRoots ?? [])]) {
    const found = findNode(child, attribute, value);
    if (found) return found;
  }
  return null;
}

/** Clicks the replay panel's control `key` (`data-piwi-control`), inside its closed shadow root. */
async function pressInReplayPanel(page: Page, key: string): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const backendNodeId = findNode(root, 'data-piwi-control', key);
    if (!backendNodeId) return false;
    const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId })) as { object: { objectId: string } };
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { this.click(); }',
    });
    return true;
  } catch {
    return false;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Sets `files` on the replay panel's file field, inside its closed shadow root; false while it is not there yet. */
async function chooseInReplayPanel(page: Page, files: string[]): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const backendNodeId = findNode(root, 'data-piwi-replay-file');
    if (!backendNodeId) return false;
    await cdp.send('DOM.setFileInputFiles', { files, backendNodeId });
    return true;
  } catch {
    return false;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Runs `scenario` in a plain browser, without the extension: to write and check a new one. */
export async function dryRun(scenario: Scenario): Promise<string> {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: LAB.viewport });
    await open(page, scenario);
    await scenario.run(page);
    return page.url();
  } finally {
    await browser.close();
  }
}

/**
 * The recording as a steps document, the lines the steps read as, and the
 * spec Playwright runs; made as a bug report makes them (`sessionFromEvents`).
 */
export function stepsOf(scenario: Scenario, recording: Recording): { doc: PiwiSteps; lines: string[] } {
  const session = sessionFromEvents(recording.events, recording.events[0]?.timestamp ?? recording.startedAt);
  const doc = toStepsDocument(session, { title: scenario.name });
  const lines = doc.steps.map((step, i) => {
    const locator = step.target ? (stepLocator(step.target, { locators: 'stable' }) ?? '(no locator)') : '';
    const value = step.value != null ? ` ${JSON.stringify(step.value)}` : '';
    return `${i}. ${step.action} ${locator}${value}`.trim();
  });
  // The first load waits as a person would: the app ignores input until it has
  // hydrated, which says nothing about the recorded locators. A file step reads
  // the file from the lab's `out/files/`, where the developer running the spec
  // would have put it.
  const spec = renderSpec(session, { title: scenario.name, locators: 'stable', urlChecks: true })
    .code.replace(/(await page\.goto\([^;]*\);)/, `$1\n  await page.waitForTimeout(${settleMsOf(scenario)});`)
    .replace(/\.setInputFiles\('([^']+)'\)/g, (_, name: string) => `.setInputFiles(${JSON.stringify(labFile(name))})`);
  writeFileSync(path.join(LAB.out, 'specs', `${scenario.name}.spec.ts`), spec);
  writeFileSync(path.join(LAB.out, 'results', `${scenario.name}.steps.json`), JSON.stringify(doc, null, 2));
  return { doc, lines };
}

export function saveResult(name: string, result: Record<string, unknown>): void {
  writeFileSync(path.join(LAB.out, 'results', `${name}.json`), JSON.stringify(result, null, 2));
}
