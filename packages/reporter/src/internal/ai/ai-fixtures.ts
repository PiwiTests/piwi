/**
 * The `piwiAi` fixtures: they add `page.piwiLocator(...)` and `page.piwiRun(...)`
 * to Playwright's `page`, resolving each prompt from a committed artifact and
 * replaying it with plain Playwright calls — zero LLM calls, zero network in the
 * default `replay` mode.
 *
 * The `page` fixture is overridden and its methods attached in place, so when
 * these compose over the capture fixtures the replayed actions flow through the
 * instrumented page (feeding trace, report and healing history like hand-written
 * code). Shipped separately from `piwiFixtures` and composable with it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test as playwrightTest } from '@playwright/test';
import type {
  Fixtures,
  Locator,
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestInfo,
  TestType,
} from '@playwright/test';
import { ariaSnapshotBestEffort } from '../capture/capture-fixtures.js';
import { ATTACHMENT_NAMES } from '../capture/attachments.js';
import { captureCallerLocation } from '../capture/locator-healing.js';
import type { AiEntry } from './artifact.js';
import { readEntry, writeEntry } from './artifact.js';
import { DEFAULT_AI_DIR, entryPath, findTemplateSites, ordinalForLocation } from './keys.js';
import { buildLocator, executeRun, locatorSource } from './interpreter.js';
import type { ParamArgs, ParamValues } from './params.js';
import { validateParams } from './params.js';
import type { StepResolver } from './resolution.js';
import { lazyLocator, resolveLocator, resolveRun, ServerStepResolver } from './resolution.js';

/** How the fixture behaves on a cache miss. */
export type AiMode = 'replay' | 'resolve' | 'heal';

/** What to do when replay finds no committed entry. */
export type AiOnMiss = 'fail' | 'fixme';

/**
 * The natural-language surface attached to `page`. Template-literal types make a
 * missing or misspelled `{param}` a compile error (`ParamArgs`): a template with
 * placeholders requires a matching params object, one without takes no argument.
 */
export interface PiwiAi {
  /** Resolve a single element by description. Returns a real, synchronous `Locator`. */
  piwiLocator<S extends string>(template: S, ...params: ParamArgs<S>): Locator;
  /** Replay a compiled flow (steps + postcondition oracle). */
  piwiRun<S extends string>(template: S, ...params: ParamArgs<S>): Promise<void>;
}

/** Resolved fixture configuration, read from the bridged `PIWI_AI*` env vars. */
interface AiConfig {
  mode: AiMode;
  dir: string;
  onMiss: AiOnMiss;
  /** Force re-resolution of already-valid entries (`--update-ai`). */
  update: boolean;
  /** Caps; `undefined` falls back to the resolution/interpreter defaults. */
  maxSteps?: number;
  maxSnapshotChars?: number;
  optionalProbeTimeout?: number;
  responseWaitTimeout?: number;
  /** Opt-in vision fallback (off unless the model supports images). */
  screenshotFallback: boolean;
}

/** Parse the mode env value; anything unrecognized is the safe `replay` default. */
export function parseAiMode(value: string | undefined): AiMode {
  return value === 'resolve' || value === 'heal' ? value : 'replay';
}

/** Parse a non-negative integer env value, or `undefined` when unset/invalid. */
export function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function readAiConfig(env: NodeJS.ProcessEnv): AiConfig {
  return {
    mode: parseAiMode(env.PIWI_AI),
    dir: env.PIWI_AI_DIR || DEFAULT_AI_DIR,
    onMiss: env.PIWI_AI_ON_MISS === 'fixme' ? 'fixme' : 'fail',
    update: env.PIWI_AI_UPDATE === 'true',
    maxSteps: readPositiveInt(env.PIWI_AI_MAX_FLOW_STEPS),
    maxSnapshotChars: readPositiveInt(env.PIWI_AI_MAX_SNAPSHOT_CHARS),
    optionalProbeTimeout: readPositiveInt(env.PIWI_AI_OPTIONAL_PROBE_TIMEOUT),
    responseWaitTimeout: readPositiveInt(env.PIWI_AI_RESPONSE_WAIT_TIMEOUT),
    screenshotFallback: env.PIWI_AI_SCREENSHOT_FALLBACK === 'true',
  };
}

/** The stable per-test identity used for keying (describe path + test title). */
function testIdentity(testInfo: TestInfo): string {
  const titles = testInfo.titlePath.slice(1);
  return titles.length > 0 ? titles.join(' › ') : testInfo.title;
}

/** Render a path relative to cwd with forward slashes (matches caller locations). */
function relativeToCwd(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

/**
 * One template ↔ compiled-locator mapping carried by the usage manifest — the
 * natural-language *intent* behind a locator the test replayed. Locators are
 * rendered in Playwright's source style (the form its error messages print), so
 * the dashboard and AI diagnosis can join a failing locator back to its prompt.
 * Values never appear here: templates keep their `{param}` placeholders and
 * locators their `{{param}}` markers, so secrets never leave the machine.
 */
export interface AiIntent {
  template: string;
  locator: string;
  kind: 'locator' | 'run';
}

/** Record the intent mappings of one committed entry (deduped by template+locator). */
export function recordIntents(intents: Map<string, AiIntent>, entry: AiEntry): void {
  const add = (locator: string, kind: AiIntent['kind']): void => {
    intents.set(`${entry.template}\x00${locator}`, { template: entry.template, locator, kind });
  };
  if (entry.kind === 'locator') {
    add(locatorSource(entry.locator), 'locator');
    return;
  }
  for (const step of entry.steps) add(locatorSource(step.locator), 'run');
  if (entry.postcondition.locator) add(locatorSource(entry.postcondition.locator), 'run');
}

/** The exact, actionable message shown when replay finds no committed entry. */
export function missMessage(template: string, testTitle: string, relPath: string): string {
  return [
    `piwi AI: no committed entry for "${template}" in test "${testTitle}".`,
    `  expected file: ${relPath}`,
    `  run:  piwi ai resolve --grep ${JSON.stringify(testTitle)}`,
    `  (requires a configured authoring model; commit the generated file afterwards)`,
  ].join('\n');
}

/**
 * Build the `PiwiAi` surface for one running test. Reads the spec source once to
 * assign stable source-position ordinals to duplicate templates, resolves each
 * prompt to its entry file, and replays hits. Records which entries were used so
 * teardown can attach the usage manifest for the dashboard.
 */
function createAiApi(
  page: Page,
  testInfo: TestInfo,
  config: AiConfig,
  used: Set<string>,
  intents: Map<string, AiIntent>,
): PiwiAi {
  const testTitle = testIdentity(testInfo);
  let source: string | null = null;
  const readSource = (): string => {
    if (source === null) {
      try {
        source = fs.readFileSync(testInfo.file, 'utf8');
      } catch {
        source = '';
      }
    }
    return source;
  };

  const ordinalFor = (template: string, location: string | null): number => {
    if (!location) return 0;
    const sites = findTemplateSites(readSource(), template);
    if (sites.length <= 1) return 0;
    const callLine = /:(\d+):\d+$/.exec(location)?.[1];
    const perFileSites = sites.map((s) => `${testInfo.file}:${s}`);
    const match = perFileSites.find((s) => /:(\d+):\d+$/.exec(s)?.[1] === callLine);
    return match ? ordinalForLocation(perFileSites, match) : 0;
  };

  const resolveFile = (template: string): string => {
    const location = captureCallerLocation();
    const ordinal = ordinalFor(template, location);
    return entryPath({ specFile: testInfo.file, testTitle, template, ordinal, dir: config.dir });
  };

  const missInReplay = (template: string, file: string): never => {
    const message = missMessage(template, testTitle, relativeToCwd(file));
    if (config.onMiss === 'fixme') {
      testInfo.annotations.push({ type: 'fixme', description: message });
      testInfo.fixme();
    }
    throw new Error(message);
  };

  const requireResolver = (): StepResolver => {
    const serverUrl = process.env.PIWI_DASHBOARD_URL;
    if (!serverUrl) {
      throw new Error(`piwi AI: ${config.mode} mode needs PIWI_DASHBOARD_URL (the authoring server) to be set`);
    }
    const apiKey = process.env.PIWI_API_KEY ?? null;
    return new ServerStepResolver(serverUrl, apiKey, process.env.PIWI_DESKTOP_KEY === '1' ? apiKey : null);
  };

  const readAria = (p: Page): Promise<string | null> => ariaSnapshotBestEffort(p.locator('body'));
  const step = <T>(title: string, body: () => Promise<T>): Promise<T> => playwrightTest.step(title, body);

  /** A hit is reusable unless we are authoring and were asked to force regeneration. */
  const canReuse = <K extends AiEntry['kind']>(
    entry: AiEntry | null,
    kind: K,
  ): entry is Extract<AiEntry, { kind: K }> => entry?.kind === kind && !(config.mode !== 'replay' && config.update);

  return {
    piwiLocator(template, ...params) {
      const values = (params[0] ?? {}) as ParamValues;
      validateParams(template, params[0]);
      const file = resolveFile(template);
      const existing = readEntry(file);
      if (canReuse(existing, 'locator')) {
        used.add(file);
        recordIntents(intents, existing);
        return buildLocator(page, existing.locator, values);
      }
      if (config.mode === 'replay') return missInReplay(template, file);
      // Resolve/heal: return a lazy locator that authors + verifies + commits the
      // entry on first use, then delegates to the freshly-built real locator.
      const resolver = requireResolver();
      return lazyLocator(async () => {
        const entry = await resolveLocator(template, {
          page,
          params: values,
          resolver,
          maxSnapshotChars: config.maxSnapshotChars,
          screenshotFallback: config.screenshotFallback,
        });
        writeEntry(file, entry);
        used.add(file);
        recordIntents(intents, entry);
        return buildLocator(page, entry.locator, values);
      });
    },
    async piwiRun(template, ...params) {
      const values = (params[0] ?? {}) as ParamValues;
      validateParams(template, params[0]);
      const file = resolveFile(template);
      const existing = readEntry(file);
      if (canReuse(existing, 'run')) {
        used.add(file);
        recordIntents(intents, existing);
        await step(`piwiRun: ${template}`, () =>
          executeRun(existing, {
            page,
            params: values,
            readAria,
            step,
            optionalProbeTimeout: config.optionalProbeTimeout,
            responseWaitTimeout: config.responseWaitTimeout,
          }),
        );
        return;
      }
      if (config.mode === 'replay') {
        missInReplay(template, file);
        return;
      }
      const resolver = requireResolver();
      await step(`piwiRun (resolve): ${template}`, async () => {
        const entry = await resolveRun(template, {
          page,
          params: values,
          resolver,
          maxSteps: config.maxSteps,
          maxSnapshotChars: config.maxSnapshotChars,
          optionalProbeTimeout: config.optionalProbeTimeout,
          responseWaitTimeout: config.responseWaitTimeout,
          screenshotFallback: config.screenshotFallback,
        });
        writeEntry(file, entry);
        used.add(file);
        recordIntents(intents, entry);
      });
    },
  };
}

/**
 * Attach the per-test usage manifest so the dashboard can aggregate liveness,
 * and — via the intent mappings — join a failing locator back to the prompt it
 * was compiled from (shown on the healing panel and fed to AI diagnosis).
 */
async function attachUsage(testInfo: TestInfo, used: Set<string>, intents: Map<string, AiIntent>): Promise<void> {
  if (used.size === 0) return;
  const entries = [...used].map(relativeToCwd).sort();
  const intentList = [...intents.values()].sort(
    (a, b) => a.template.localeCompare(b.template) || a.locator.localeCompare(b.locator),
  );
  await testInfo.attach(ATTACHMENT_NAMES.aiUsage, {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ entries, ...(intentList.length > 0 ? { intents: intentList } : {}) })),
  });
}

/** Local `{ [key: string]: any }` used by the extend signature (mirrors capture fixtures). */
type FixtureArgs = { [key: string]: any };

/**
 * Fixtures that override `page` to carry the `PiwiAi` surface. Composable with
 * `piwiFixtures`; keep this separate so a project can opt into AI steps without
 * the capture fixtures (and vice versa).
 */
export const piwiAiFixtures: Fixtures<
  {},
  {},
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = {
  page: async ({ page }: PlaywrightTestArgs, use: (value: Page) => Promise<void>, testInfo: TestInfo) => {
    const config = readAiConfig(process.env);
    const used = new Set<string>();
    const intents = new Map<string, AiIntent>();
    const ai = createAiApi(page, testInfo, config, used, intents);
    Object.assign(page, ai);
    try {
      await use(page);
    } finally {
      await attachUsage(testInfo, used, intents);
    }
  },
};

/**
 * Add the `PiwiAi` surface to a test's `page`. Compose over `extendPiwiFixtures`
 * (or a base `test`) — e.g. `export const test = extendPiwiAi(extendPiwiFixtures(base))`.
 */
export function extendPiwiAi<TestArgs extends FixtureArgs, WorkerArgs extends FixtureArgs>(
  test: TestType<TestArgs, WorkerArgs>,
): TestType<TestArgs & { page: Page & PiwiAi }, WorkerArgs> {
  return (
    test as unknown as {
      extend: (f: typeof piwiAiFixtures) => TestType<TestArgs & { page: Page & PiwiAi }, WorkerArgs>;
    }
  ).extend(piwiAiFixtures);
}
