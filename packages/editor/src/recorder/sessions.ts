/**
 * Recording sessions: one per `piwi/record`, each a browser the launcher opened with the project's own Playwright and
 * the `use` options of one of its projects, and the recorded block it writes into a file. The events the launcher
 * reports are rendered, all the steps each time, with `renderSpec`, and the block, the imports the file lacks, its
 * steps and its warnings go to the client as a `piwi/recordingChanged` notification, in order. An event renders at
 * once when the update interval since the latest update is over (`UPDATE_INTERVAL_MS`, longer after a slow
 * rendering); otherwise the events received meanwhile render together when it is. While paused nothing is sent;
 * resuming sends the latest block again. A session ends with a last notification, `stopped` or `failed`, sent at
 * once, and its browser closes.
 */
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeStepInWords } from '@piwitests/core/bug-report';
import { bugPhrases } from '@piwitests/core/bug-phrases';
import {
  isPageExpression,
  renderSpec,
  safeLocator,
  stepLocator,
  type CodegenOptions,
  type CodegenResult,
} from '@piwitests/core/codegen';
import type { TestFunctionEntry } from '@piwitests/core/function-match';
import { codegenConfigOf, type CodegenConfigOptions } from '@piwitests/core/piwi-config';
import { sessionFromEvents, type RawCaptureEvent, type RecordedStep } from '@piwitests/core/recording';
import type {
  FileEdit,
  PageCandidatesResult,
  PiwiCommand,
  RecordInto,
  RecordParams,
  RecordResult,
  RecordingStep,
  RecordingUpdate,
  RunCommandArgs,
} from '../protocol.js';
import { recorderBrowser, type RecorderBrowser } from './context-options.js';
import type { LaunchRequest, LauncherToService, ServiceToLauncher } from './ipc.js';
import {
  expectModuleOf,
  importBindings,
  importInsertion,
  missingImports,
  testImportOf,
  type ImportBindings,
} from './imports.js';
import { projectNode, projectNodeEnv } from './node.js';
import {
  declaredNamesAt,
  fileFixtures,
  pageCandidates,
  placementBefore,
  recordingPlacement,
} from './page-candidates.js';
import { handoffLauncher, type Handoff } from './handoff.js';
import { canonicalPath } from './playwright.js';
import type { ProjectOptions } from './project-options.js';

/** The files of the editor service's `dist/` a recording needs beside the language server. */
export const LAUNCHER_FILE = 'piwi-recorder-launcher.cjs';
export const BUNDLE_FILE = 'record-ide.js';
export const MESSAGES_FILE = 'record-ide-messages.json';

/** How long a launcher may take to close its browser and exit before it is killed. */
const EXIT_TIMEOUT_MS = 8_000;

/** How long a recording from a test's page waits for the config's Piwi options before it starts without them. */
const CONFIG_WAIT_MS = 10_000;

/** The shortest time between two renderings of a session, in ms. */
export const UPDATE_INTERVAL_MS = 100;

/** The time between two renderings is at least this many times the last one's duration. */
const RENDERING_SHARE = 3;

/** The spec files of a folder read to find the module a new spec imports `test` from. */
const MAX_SIBLINGS = 50;

const ENGLISH = bugPhrases('en');

/** A launcher's process, as a session holds it. */
export interface LauncherHandle {
  send(message: ServiceToLauncher): void;
  kill(): void;
}

/** What a launcher tells its session. */
export interface LauncherEvents {
  message(message: LauncherToService): void;
  /** The process ended; `detail` is the last line it wrote to its error output, if any. */
  exit(code: number | null, detail: string | null): void;
}

/** Starts a launcher in the config's folder. Throws when it cannot. */
export type LauncherFactory = (cwd: string, events: LauncherEvents) => LauncherHandle;

/**
 * Forks the bundled launcher with the project's Node (`projectNode`), with an IPC channel and its error output kept
 * for a failure's message.
 */
export function forkLauncher(file: string): LauncherFactory {
  return (cwd, events) => {
    if (!fs.existsSync(file)) throw new Error(`The recorder is missing from this installation: ${file} was not found.`);
    const node = projectNode();
    const child = fork(file, [], {
      cwd,
      env: projectNodeEnv(node),
      execArgv: [],
      execPath: node.execPath,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let detail: string | null = null;
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      events.exit(code, detail);
    };
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      detail =
        chunk
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .pop() ?? detail;
    });
    child.on('message', (message) => events.message(message as LauncherToService));
    child.on('error', (error) => {
      detail = error.message;
      if (child.pid === undefined) end(null);
    });
    child.on('close', (code) => end(code));
    return {
      send: (message) => {
        if (child.connected) child.send(message);
      },
      kill: () => {
        child.kill();
      },
    };
  };
}

/** The file a recording writes into, and what its rendering reads from the context the file belongs to. */
export interface RecordTarget {
  file: string;
  /** The file's text, as the editor holds it. */
  text: string;
  /** The Playwright config holding the file. */
  configFile: string;
  /** The project's functions, for the calls a run of steps collapses into; read while the options are. */
  catalog: TestFunctionEntry[] | Promise<TestFunctionEntry[]>;
  /** The canonical locators the project's tests already use, preferred among a step's alternatives. */
  preferLocators: ReadonlySet<string>;
}

export interface RecordingSessionsOptions {
  /** The folder holding the launcher, the recorder's IDE bundle and its catalogs. */
  distDir: string;
  /** Sends an update to the client. */
  notify(update: RecordingUpdate): void;
  /** The resolved `use` options of a config's projects. */
  readOptions(configFile: string): Promise<ProjectOptions>;
  /** Starts a launcher; the bundled one by default. */
  launch?: LauncherFactory;
  /** The environment: `PIWI_RECORDER_HEADLESS=1` opens the browser headless. The process's by default. */
  env?: Record<string, string | undefined>;
  /**
   * The current text of the file at `uri`, as the editor holds it; null when the service holds none. An update's
   * imports leave out what the file imports already; without it, the text the recording started from is read.
   */
  readText?(uri: string): string | null;
  /**
   * The shortest time between two renderings, in ms ({@link UPDATE_INTERVAL_MS} by default); the time after a
   * rendering is also at least {@link RENDERING_SHARE} times its duration. 0 renders on every event.
   */
  updateIntervalMs?: number;
}

type Final = 'stopped' | 'failed';

interface Session {
  id: string;
  uri: string;
  /** The file's text when the recording started. */
  text: string;
  into: RecordInto;
  state: RecordingUpdate['state'];
  events: RawCaptureEvent[];
  startedAt: number;
  codegen: CodegenOptions;
  /** The module `expect` is imported from when the block checks something, decided when the recording starts. */
  expectModule: string;
  /** The origin of the project's `baseURL`: a recording on it writes paths. */
  baseOrigin: string | null;
  cwd: string;
  /** The browser the launcher opens; null for a test's page handed over. */
  browser: RecorderBrowser | null;
  /** Sentences for the first update: the options left out. */
  notes: string[];
  /** The latest update rendered, kept when a later rendering fails. */
  latest: RecordingUpdate | null;
  /** The code and the import lines of the latest rendering, whose imports the file may lack. */
  rendered: Pick<CodegenResult, 'code' | 'imports'> | null;
  /** When the latest update was sent, in ms. */
  sentAt: number;
  /** How long after `sentAt` the next rendering may run, in ms. */
  wait: number;
  /** The rendering due once the wait is over. */
  timer: ReturnType<typeof setTimeout> | null;
  launcher: LauncherHandle | null;
  /** Resolves once the launcher has exited. */
  exited: Promise<void>;
  exit: () => void;
}

/** The browsers and channels a message names, as a person reads them. */
const LABELS: Record<string, string> = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
};

function isFinal(state: RecordingUpdate['state']): state is Final {
  return state === 'stopped' || state === 'failed';
}

/** The origin of an http or https address; null for anything else. */
export function originOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The recorder's language for an editor's BCP 47 tag, among the catalogs the recorder ships: `fr`, `fr-FR` → `fr`;
 * `pt`, `pt-BR`, `pt_BR` → `pt_BR`; `de…` → `de`; `es…` → `es`; anything else → `en`.
 */
export function recorderLanguage(tag: string | null | undefined): string {
  const primary = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (primary === 'pt') return 'pt_BR';
  return primary === 'fr' || primary === 'de' || primary === 'es' ? primary : 'en';
}

/**
 * The page a recording opens: an absolute address as given (`localhost:3000/x` reads as `http://`), a path on the
 * project's `baseURL` (resolved as `page.goto` resolves it), the `baseURL` itself when none is given, else
 * `about:blank`. Only http and https addresses open, the pages the recorder records.
 */
export function startUrl(
  given: string | null | undefined,
  baseURL: string | null,
): { url: string } | { error: string } {
  const text = given?.trim() ?? '';
  if (!text) return { url: baseURL ?? 'about:blank' };
  const address = /^[\w.-]+:\d+(?:[/?#]|$)/.test(text) ? `http://${text}` : text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(address)) {
    let parsed: URL;
    try {
      parsed = new URL(address);
    } catch {
      return { error: `${text} is not an address the browser can open.` };
    }
    if (parsed.href === 'about:blank' || ['http:', 'https:'].includes(parsed.protocol)) return { url: parsed.href };
    return { error: `${text} is not a page the recorder can record: give an http or https address.` };
  }
  if (!baseURL) {
    const example = `http://localhost:3000${text.startsWith('/') ? '' : '/'}${text}`;
    return { error: `${text} is a path, and the project has no baseURL: give the whole address, such as ${example}.` };
  }
  try {
    return { url: new URL(text, baseURL).href };
  } catch {
    return { error: `The project's baseURL, ${baseURL}, is not an address.` };
  }
}

/** The texts of the spec files beside `file`, the first ones by name. */
function siblingSpecs(file: string): string[] {
  const dir = path.dirname(file);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(n) && path.join(dir, n) !== file);
  } catch {
    return [];
  }
  return names
    .sort()
    .slice(0, MAX_SIBLINGS)
    .flatMap((name) => {
      try {
        return [fs.readFileSync(path.join(dir, name), 'utf-8')];
      } catch {
        return [];
      }
    });
}

/**
 * What a new spec beside `file` starts from, as the specs there do: the module most of them import `test` from (null
 * when none does), and the fixtures the tests of those that import it take.
 */
function siblingTestSetup(file: string): { testImport: string | null; fixtures: Set<string> } {
  const specs = siblingSpecs(file).map((text) => ({ text, module: testImportOf(text) }));
  const counts = new Map<string, number>();
  for (const { module } of specs) if (module) counts.set(module, (counts.get(module) ?? 0) + 1);
  const testImport = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const fixtures = new Set(specs.filter((s) => s.module === testImport).flatMap((s) => [...fileFixtures(s.text)]));
  return { testImport, fixtures };
}

/** Why a recording into `into` cannot start where the caret is (`context`); null when it can. */
function placementRefusal(into: RecordInto, context: PageCandidatesResult['context']): string | null {
  if (into === 'steps' && (context === 'class' || context === 'file'))
    return 'Put the cursor inside a test, a method or a function to record steps there.';
  if (into !== 'test') return null;
  if (context === 'class')
    return 'A test cannot go inside a class: put the cursor inside a method to record its steps, or outside the class for a new test.';
  if (context === 'test')
    return 'A new test cannot go inside another test: record steps there instead, or put the cursor outside the test for a new test.';
  if (context === 'function')
    return 'A new test cannot go inside another function: record steps there instead, or put the cursor outside the function for a new test.';
  return null;
}

/**
 * A block of code re-indented to go at a caret on a line indented with `indent`: its common leading indentation
 * removed, then `indent` added to every line after the first, which lands at the caret. Blank lines stay empty, and
 * the block ends with no blank line.
 */
export function indentBlock(code: string, indent: string): string {
  const lines = code.replace(/\s+$/, '').split('\n');
  const widths = lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length);
  const common = widths.length ? Math.min(...widths) : 0;
  return lines
    .map((line) => (line.trim() ? line.slice(common) : ''))
    .map((line, i) => (i === 0 || !line ? line : indent + line))
    .join('\n');
}

/** The recorded block as a client writes it: no trailing newline, and steps without the test body's indentation. */
function blockCode(code: string, into: RecordInto): string {
  const lines = code.replace(/\n+$/, '').split('\n');
  return (into === 'steps' ? lines.map((line) => (line.startsWith('  ') ? line.slice(2) : line)) : lines).join('\n');
}

export interface BlockImportsOptions {
  /** The module `expect` is imported from; what `expectModuleOf` reads from the text alone by default. */
  expectModule?: string;
  /** The file's module statements and bindings, when read already; those of `text` by default. */
  bindings?: ImportBindings;
}

/**
 * The import lines a block needs that the file lacks: its catalog calls' imports, and `expect` when the block checks
 * something and the file does not import it, from the module `test` comes from when that is `@playwright/test` or a
 * spec of the folder imports `expect` from it, else from `@playwright/test`.
 */
export function blockImports(
  text: string,
  result: Pick<CodegenResult, 'code' | 'imports'>,
  options: BlockImportsOptions = {},
): string[] {
  const bindings = options.bindings ?? importBindings(text);
  const needsExpect = /(?<![\w$.])expect\(/.test(result.code);
  const expectLine = `import { expect } from '${options.expectModule ?? expectModuleOf(text, { bindings })}';`;
  return missingImports(text, needsExpect ? [expectLine, ...result.imports] : result.imports, bindings);
}

/**
 * The options of the config's Piwi section that apply where the code goes: `test.step` needs `test` in scope, so not
 * in a page object or a helper, and tags and annotations are a new test's.
 */
export function repositoryCodegen(
  options: CodegenConfigOptions,
  into: RecordInto,
  context: PageCandidatesResult['context'],
): CodegenConfigOptions {
  const { testSteps, tags, annotations, ...always } = options;
  return {
    ...always,
    ...(testSteps && (into !== 'steps' || context === 'test') ? { testSteps } : {}),
    ...(into !== 'steps' ? { ...(tags ? { tags } : {}), ...(annotations ? { annotations } : {}) } : {}),
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export class RecordingSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly launch: LauncherFactory;
  private readonly env: Record<string, string | undefined>;
  private readonly updateInterval: number;
  private catalogs: Record<string, Record<string, unknown>> | null = null;

  constructor(private readonly options: RecordingSessionsOptions) {
    this.launch = options.launch ?? forkLauncher(path.join(options.distDir, LAUNCHER_FILE));
    this.env = options.env ?? process.env;
    this.updateInterval = options.updateIntervalMs ?? UPDATE_INTERVAL_MS;
  }

  /**
   * Starts a recording into a file: reads the config's project options, picks the project, the start page and the
   * page expression, and starts the launcher. Answers once the launcher is asked to open the browser; what it writes
   * comes in updates. With `params.handoff`, the recording is that of a test's page instead (`attach`), from `handoff`,
   * the waiting hand-off it names, null when the test no longer waits.
   */
  async start(params: RecordParams, target: RecordTarget, handoff: Handoff | null = null): Promise<RecordResult> {
    if (params.handoff) {
      return handoff
        ? this.attach(params, target, handoff)
        : { ok: false, message: 'The test no longer waits for this recording: it went on.' };
    }
    const into = params.into;
    if (into !== 'steps' && into !== 'test' && into !== 'file')
      return { ok: false, message: 'Unknown recording target.' };
    const line = Number.isInteger(params.line) ? params.line : 0;
    const at = pageCandidates(target.text, line);
    const refusal = into === 'file' ? null : placementRefusal(into, at.context);
    if (refusal) return { ok: false, message: refusal };
    const placement = recordingPlacement(target.text, line, into);
    if ('refusal' in placement) return { ok: false, message: placement.refusal };
    const page = params.page?.trim() || at.default;
    if (!isPageExpression(page)) {
      return {
        ok: false,
        message: `${page} is not an expression the steps can run on: use page, this.page or a name such as adminPage.`,
      };
    }
    if (into !== 'steps' && page.split('.')[0] === 'this') {
      return {
        ok: false,
        message: `A new test cannot run on ${page}: record steps inside a method, or choose a fixture.`,
      };
    }
    const bundle = path.join(this.options.distDir, BUNDLE_FILE);
    const messages = this.messages(recorderLanguage(params.language));
    if (!fs.existsSync(bundle) || !messages) {
      return {
        ok: false,
        message: `The recorder is missing from this installation: ${BUNDLE_FILE} or ${MESSAGES_FILE} was not found in ${this.options.distDir}.`,
      };
    }

    let options: ProjectOptions;
    let catalog: TestFunctionEntry[];
    try {
      [options, catalog] = await Promise.all([
        this.options.readOptions(target.configFile),
        Promise.resolve(target.catalog).catch(() => []),
      ]);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const names = options.projects.map((p) => p.name);
    const config = path.basename(target.configFile);
    const project =
      params.project != null
        ? options.projects.find((p) => p.name === params.project)
        : options.projects.length === 1
          ? options.projects[0]
          : undefined;
    if (!project) {
      return {
        ok: false,
        message:
          params.project != null
            ? `${config} has no project named ${params.project}: choose one of ${names.join(', ')}.`
            : `${config} has ${names.length} projects: choose the one whose options the browser gets.`,
        projects: names,
      };
    }

    const cwd = path.dirname(canonicalPath(target.configFile));
    const browser = recorderBrowser(project.use, {
      cwd,
      headless: this.env.PIWI_RECORDER_HEADLESS === '1',
      exists: (file) => fs.existsSync(file),
    });
    const baseURL = typeof browser.contextOptions.baseURL === 'string' ? browser.contextOptions.baseURL : null;
    const start = startUrl(params.startUrl, baseURL);
    if ('error' in start) return { ok: false, message: start.error };

    const title = params.title?.trim();
    const fromConfig = codegenConfigOf(options.piwi);
    const siblings = into === 'file' ? siblingTestSetup(target.file) : null;
    const codegen: CodegenOptions = {
      format: into === 'steps' ? 'body' : into,
      ...(siblings
        ? { testImport: testImportOf(target.text) ?? siblings.testImport ?? undefined, fixtures: siblings.fixtures }
        : {}),
      ...(into === 'test' ? { fixtures: fileFixtures(target.text) } : {}),
      ...(into !== 'file' ? { bodyImports: 'none' as const, declaredNames: declaredNamesAt(target.text, line) } : {}),
      locators: 'stable',
      urlChecks: true,
      ...repositoryCodegen(fromConfig.options, into, at.context),
      page,
      catalog,
      preferLocators: target.preferLocators,
      ...(title ? { title } : {}),
    };
    let exit = () => {};
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const session: Session = {
      id: randomUUID(),
      uri: params.uri,
      text: target.text,
      into,
      state: 'starting',
      events: [],
      startedAt: Date.now(),
      codegen,
      expectModule: expectModuleOf(target.text, { siblings: () => siblingSpecs(target.file) }),
      baseOrigin: originOf(baseURL),
      cwd,
      browser,
      notes: [
        ...browser.notes,
        ...(start.url === 'about:blank' ? ['The browser opened on a blank page: go to the page to record there.'] : []),
        ...fromConfig.problems.map((problem) => `${config}: ${problem}`),
      ],
      latest: null,
      rendered: null,
      sentAt: -Infinity,
      wait: 0,
      timer: null,
      launcher: null,
      exited,
      exit,
    };
    const request: LaunchRequest = {
      cwd,
      browserName: browser.browserName,
      launchOptions: browser.launchOptions,
      contextOptions: browser.contextOptions,
      testIdAttribute: browser.testIdAttribute,
      startUrl: start.url,
      bundle,
      language: messages,
      settings: { file: path.basename(target.file), testIdAttribute: browser.testIdAttribute },
      startedAt: session.startedAt,
    };
    try {
      session.launcher = this.launch(cwd, {
        message: (message) => this.onMessage(session, message),
        exit: (code, detail) => this.onExit(session, code, detail),
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.sessions.set(session.id, session);
    session.launcher.send({ type: 'start', request });
    const label = LABELS[browser.browserName] ?? browser.browserName;
    return {
      ok: true,
      sessionId: session.id,
      message: project.name
        ? `Opening ${label} with the options of the ${project.name} project.`
        : `Opening ${label} with the options of ${config}.`,
      placement,
    };
  }

  /**
   * Records in the page of a test paused in a run the editor started (`handoff`), from where it is paused: the steps
   * are rendered as a test's body continuing on its page (no opening navigation), on the page expression in scope at
   * the paused statement, with the config's Piwi options when they are read in time, and written on a new line above
   * that statement. The test loads the recorder into its page; the session drives it as a launcher's browser.
   */
  private async attach(params: RecordParams, target: RecordTarget, handoff: Handoff): Promise<RecordResult> {
    const placement = placementBefore(target.text, handoff.line - 1);
    const at = pageCandidates(target.text, placement.line);
    const refuse = (message: string): RecordResult => {
      handoff.socket.end(`${JSON.stringify({ type: 'refused', message })}\n`);
      return { ok: false, message };
    };
    if (at.context !== 'test' && at.context !== 'function') {
      return refuse('The test is paused outside a test or a function of this file: nothing can be written there.');
    }
    const bundle = path.join(this.options.distDir, BUNDLE_FILE);
    const messages = this.messages(recorderLanguage(params.language));
    if (!fs.existsSync(bundle) || !messages) {
      return refuse(
        `The recorder is missing from this installation: ${BUNDLE_FILE} or ${MESSAGES_FILE} was not found in ${this.options.distDir}.`,
      );
    }
    const [options, catalog] = await Promise.all([
      Promise.race([
        this.options.readOptions(target.configFile).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CONFIG_WAIT_MS).unref?.()),
      ]),
      Promise.resolve(target.catalog).catch(() => []),
    ]);
    const config = path.basename(target.configFile);
    const fromConfig = codegenConfigOf(options?.piwi);
    const codegen: CodegenOptions = {
      format: 'body',
      continuePage: true,
      bodyImports: 'none',
      declaredNames: declaredNamesAt(target.text, placement.line),
      locators: 'stable',
      urlChecks: true,
      ...repositoryCodegen(fromConfig.options, 'steps', at.context),
      page: at.default,
      catalog,
      preferLocators: target.preferLocators,
    };
    let exit = () => {};
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const cwd = path.dirname(canonicalPath(target.configFile));
    const session: Session = {
      id: randomUUID(),
      uri: params.uri,
      text: target.text,
      into: 'steps',
      state: 'starting',
      events: [],
      startedAt: Date.now(),
      codegen,
      expectModule: expectModuleOf(target.text, { siblings: () => siblingSpecs(target.file) }),
      baseOrigin: originOf(handoff.baseURL),
      cwd,
      browser: null,
      notes: fromConfig.problems.map((problem) => `${config}: ${problem}`),
      latest: null,
      rendered: null,
      sentAt: -Infinity,
      wait: 0,
      timer: null,
      launcher: null,
      exited,
      exit,
    };
    const testIdAttribute = handoff.testIdAttribute;
    session.launcher = handoffLauncher(handoff)(cwd, {
      message: (message) => this.onMessage(session, message),
      exit: (code, detail) => this.onExit(session, code, detail),
    });
    this.sessions.set(session.id, session);
    session.launcher.send({
      type: 'start',
      request: {
        cwd,
        browserName: 'chromium',
        launchOptions: {},
        contextOptions: {},
        testIdAttribute,
        startUrl: 'about:blank',
        bundle,
        language: messages,
        settings: { file: path.basename(target.file), testIdAttribute },
        startedAt: session.startedAt,
      },
    });
    const where = `${path.basename(target.file)}:${placement.line + 1}`;
    return {
      ok: true,
      sessionId: session.id,
      message:
        handoff.reason === 'pause'
          ? `Recording in the test's browser from page.pause() at ${where}.`
          : `Recording in the test's browser from the breakpoint at ${where}.`,
      placement,
    };
  }

  /** Pauses or resumes a session from the editor; the recorder's bar in the browser shows it too. */
  command(sessionId: string, command: 'pause' | 'resume'): void {
    const session = this.sessions.get(sessionId);
    if (!session || isFinal(session.state) || session.state === 'starting') return;
    if (command !== 'pause' && command !== 'resume') return;
    session.launcher?.send({ type: 'pause', paused: command === 'pause' });
    this.paused(session, command === 'pause');
  }

  /**
   * A session paused, from the editor or the browser: nothing done in the browser is recorded, nothing is written,
   * and the update says `paused`; resumed, it says `recording` with the latest block again.
   */
  private paused(session: Session, paused: boolean): void {
    if (paused && session.state === 'recording') {
      session.state = 'paused';
      this.cancelUpdate(session);
      this.sendUpdate(session);
    } else if (!paused && session.state === 'paused') {
      session.state = 'recording';
      this.sendUpdate(session);
    }
  }

  /** Stops a session: its last update says `stopped`, and resolves once its browser is closed. */
  async stop(sessionId: string, message: string | null = null): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.finish(session, 'stopped', message);
    await session.exited;
  }

  /** Stops the sessions writing into a file. */
  stopFile(uri: string): void {
    for (const session of this.sessions.values()) {
      if (session.uri === uri) this.finish(session, 'stopped', 'The file was closed: the recording stopped.');
    }
  }

  /** Stops every session. */
  dispose(): void {
    for (const session of this.sessions.values()) this.finish(session, 'stopped', 'The editor service stopped.');
  }

  /** The recorder's language and catalog, merged over English; null when the catalogs cannot be read. */
  private messages(code: string): { code: string; messages: Record<string, unknown> } | null {
    if (!this.catalogs) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.options.distDir, MESSAGES_FILE), 'utf-8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || !('en' in parsed)) return null;
        this.catalogs = parsed as Record<string, Record<string, unknown>>;
      } catch {
        return null;
      }
    }
    return { code, messages: { ...this.catalogs.en, ...this.catalogs[code] } };
  }

  private onMessage(session: Session, message: LauncherToService): void {
    if (isFinal(session.state)) return;
    switch (message.type) {
      case 'started': {
        session.state = 'recording';
        this.sendUpdate(session, { message: session.notes.join(' ') || null });
        break;
      }
      case 'event': {
        // Nothing done in the browser while the recording is paused is recorded.
        if (session.state === 'paused') break;
        session.events.push(message.event);
        if (session.state === 'recording') this.scheduleUpdate(session);
        break;
      }
      case 'notice': {
        if (session.state === 'recording') this.sendUpdate(session, { message: message.message });
        break;
      }
      case 'stopped-in-browser':
        this.finish(session, 'stopped', 'Stopped in the browser.');
        break;
      case 'paused':
        this.paused(session, message.paused);
        break;
      case 'closed':
        this.finish(session, 'stopped', 'The browser was closed: the recording stopped.');
        break;
      case 'failed':
        this.finish(session, 'failed', ...this.failure(session, message));
        break;
    }
  }

  /** The message and the action of a launcher's failure: installing a missing browser in the config's folder. */
  private failure(
    session: Session,
    failed: Extract<LauncherToService, { type: 'failed' }>,
  ): [string, PiwiCommand | null] {
    if (failed.reason !== 'browser-missing' || !session.browser) return [failed.message, null];
    const channel = session.browser.launchOptions.channel;
    const install = typeof channel === 'string' && channel !== 'chromium' ? channel : session.browser.browserName;
    const label = LABELS[install] ?? install;
    const command = `npx playwright install ${install}`;
    return [
      `${label} is not installed for this project's Playwright: run ${command} in ${session.cwd}.`,
      {
        title: `Install ${label}`,
        command: 'piwi.runCommand',
        arguments: [{ cwd: session.cwd, command } satisfies RunCommandArgs],
      },
    ];
  }

  private onExit(session: Session, code: number | null, detail: string | null): void {
    if (!isFinal(session.state)) {
      const why = detail ? `: ${detail.replace(/[.!?]$/, '')}` : ` (exit code ${code ?? 'none'})`;
      this.finish(session, 'failed', `The recorder stopped unexpectedly${why}.`);
    }
    this.sessions.delete(session.id);
    session.exit();
  }

  /** Ends a session: its last update, then its launcher asked to close the browser and exit, killed if it does not. */
  private finish(session: Session, state: Final, message: string | null, command: PiwiCommand | null = null): void {
    if (isFinal(session.state)) return;
    session.state = state;
    this.sendUpdate(session, { message, command });
    const launcher = session.launcher;
    if (!launcher) return session.exit();
    launcher.send({ type: 'stop' });
    const timer = setTimeout(() => launcher.kill(), EXIT_TIMEOUT_MS);
    timer.unref?.();
    void session.exited.then(() => clearTimeout(timer));
  }

  /** Renders the session's events at once, unless the wait after the latest update is not over: then once it is. */
  private scheduleUpdate(session: Session): void {
    if (session.timer) return;
    const due = this.updateInterval === 0 ? 0 : session.sentAt + session.wait - Date.now();
    if (due <= 0) return this.sendUpdate(session);
    session.timer = setTimeout(() => {
      session.timer = null;
      if (session.state === 'recording') this.sendUpdate(session);
    }, due);
    session.timer.unref?.();
  }

  private cancelUpdate(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
  }

  /** Renders the session's events and sends the update now, in place of any rendering due later. */
  private sendUpdate(session: Session, extra: { message?: string | null; command?: PiwiCommand | null } = {}): void {
    this.cancelUpdate(session);
    const start = Date.now();
    this.send(this.update(session, extra));
    session.sentAt = Date.now();
    session.wait = Math.max(this.updateInterval, RENDERING_SHARE * (session.sentAt - start));
  }

  /** The text of the session's file now, else as it was when the recording started. */
  private currentText(session: Session): string {
    return this.options.readText?.(session.uri) ?? session.text;
  }

  /**
   * The edit that adds the imports a rendering needs and the file lacks now; none for a whole file. The file's text
   * is read once, for the names it binds and where its import statements end.
   */
  private importEdit(session: Session, rendered: Pick<CodegenResult, 'code' | 'imports'> | null): FileEdit | null {
    if (session.into === 'file' || !rendered) return null;
    const text = this.currentText(session);
    const bindings = importBindings(text);
    const lines = blockImports(text, rendered, { expectModule: session.expectModule, bindings });
    return importInsertion(text, lines, bindings);
  }

  private send(update: RecordingUpdate): void {
    try {
      this.options.notify(update);
    } catch {
      // The connection is gone: the session ends all the same.
    }
  }

  /** The session's block, rendered from all its events; the latest block again when the rendering fails. */
  private update(
    session: Session,
    extra: { message?: string | null; command?: PiwiCommand | null } = {},
  ): RecordingUpdate {
    const base = {
      sessionId: session.id,
      uri: session.uri,
      into: session.into,
      state: session.state,
      message: extra.message ?? null,
      command: extra.command ?? null,
    };
    try {
      const recorded = sessionFromEvents(session.events, session.startedAt);
      const origin = originOf(recorded.startUrl);
      const result: CodegenResult = renderSpec(recorded, {
        ...session.codegen,
        urls: origin && origin === session.baseOrigin ? 'relative' : 'absolute',
      });
      const preferLocators = session.codegen.preferLocators;
      session.rendered = result;
      session.latest = {
        ...base,
        code: blockCode(result.code, session.into),
        importEdit: this.importEdit(session, result),
        steps: recorded.steps.map((step, i) => stepOf(step, i, result, preferLocators)),
        warnings: result.warnings.map((w) => ({
          step: w.step,
          line: (result.stepLines[w.step] ?? 1) - 1,
          message: w.message,
        })),
      };
      return session.latest;
    } catch (error) {
      const latest = session.latest ?? { code: '', steps: [], warnings: [] };
      return {
        ...base,
        code: latest.code,
        importEdit: this.importEdit(session, session.rendered),
        steps: latest.steps,
        warnings: latest.warnings,
        message: `The last step could not be written: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/** A step as an update lists it: in words, its line, the locators the recorder verified and the one written. */
function stepOf(
  step: RecordedStep,
  index: number,
  result: CodegenResult,
  preferLocators: ReadonlySet<string> | undefined,
): RecordingStep {
  const locators = unique(
    (step.target?.alternatives ?? []).flatMap((alternative) => {
      const safe = safeLocator(alternative.locator);
      return safe ? [safe.text] : [];
    }),
  );
  const written = step.target ? stepLocator(step.target, { locators: 'stable', preferLocators }) : null;
  const chosen = written === null ? -1 : locators.indexOf(written);
  const span = result.matchedSpans.find((s) => index >= s.startStep && index <= s.endStep);
  return {
    words: describeStepInWords(step, ENGLISH),
    line: (result.stepLines[index] ?? 1) - 1,
    locators,
    chosen: chosen < 0 ? null : chosen,
    ...(span ? { functionName: span.functionName } : {}),
  };
}
