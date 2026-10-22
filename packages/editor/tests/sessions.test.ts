import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { TestFunctionEntry } from '@piwitests/core/function-match';
import type { RawCaptureEvent, RecordedTarget } from '@piwitests/core/recording';
import type { RecordParams, RecordingUpdate } from '../src/protocol';
import type { LaunchRequest, LauncherToService, ServiceToLauncher } from '../src/recorder/ipc';
import type { ProjectOptions, ProjectUse } from '../src/recorder/project-options';
import {
  RecordingSessions,
  blockImports,
  indentBlock,
  UPDATE_INTERVAL_MS,
  recorderLanguage,
  startUrl,
  type LauncherEvents,
  type RecordTarget,
} from '../src/recorder/sessions';

const BASE = 'http://127.0.0.1:4173';
const CONFIG = path.resolve('/work/shop/playwright.config.ts');
const ROOT = path.dirname(CONFIG);
const SPEC_FILE = path.join(ROOT, 'tests', 'checkout.spec.ts');
const URI = 'file:///work/shop/tests/checkout.spec.ts';

const SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('pays', async ({ page }) => {",
  '',
  '});',
  '',
].join('\n');

/** An insertion of `newText` at the start of `line`. */
const insertAt = (line: number, newText: string) => ({
  range: { start: { line, character: 0 }, end: { line, character: 0 } },
  newText,
});

let dist = '';

beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-sessions-'));
  fs.writeFileSync(path.join(dist, 'record-ide.js'), '');
  fs.writeFileSync(
    path.join(dist, 'record-ide-messages.json'),
    JSON.stringify({
      en: { record_stop: { message: 'Stop' }, record_title: { message: 'Recording' } },
      fr: { record_stop: { message: 'Arrêter' } },
      pt_BR: { record_title: { message: 'Gravando' } },
    }),
  );
});

afterAll(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

/** A launcher that records what it is sent; a test plays the messages it would send. */
class FakeLauncher {
  readonly sent: ServiceToLauncher[] = [];
  killed = false;
  constructor(
    readonly cwd: string,
    readonly events: LauncherEvents,
  ) {}
  emit(message: LauncherToService) {
    this.events.message(message);
  }
  exit(code = 0, detail: string | null = null) {
    this.events.exit(code, detail);
  }
  get request(): LaunchRequest {
    const start = this.sent.find((m) => m.type === 'start');
    if (start?.type !== 'start') throw new Error('not started');
    return start.request;
  }
}

function setup(
  options: {
    projects?: ProjectUse[];
    failRead?: Error;
    /** Piwi's section of the config. */
    piwi?: unknown;
    env?: Record<string, string | undefined>;
    distDir?: string;
    readText?: (uri: string) => string | null;
    updateIntervalMs?: number;
    /** Runs as each update is sent. */
    onUpdate?: () => void;
  } = {},
) {
  const updates: RecordingUpdate[] = [];
  const launchers: FakeLauncher[] = [];
  const read: string[] = [];
  const projects = options.projects ?? [
    { name: 'chromium', testDir: path.join(ROOT, 'tests'), use: { baseURL: `${BASE}/` } },
  ];
  const sessions = new RecordingSessions({
    distDir: options.distDir ?? dist,
    notify: (update) => {
      updates.push(update);
      options.onUpdate?.();
    },
    readOptions: async (configFile): Promise<ProjectOptions> => {
      read.push(configFile);
      if (options.failRead) throw options.failRead;
      return { configFile, rootDir: path.join(ROOT, 'tests'), piwi: options.piwi ?? null, projects };
    },
    launch: (cwd, events) => {
      const launcher = new FakeLauncher(cwd, events);
      launchers.push(launcher);
      return { send: (m) => launcher.sent.push(m), kill: () => (launcher.killed = true) };
    },
    env: options.env ?? {},
    readText: options.readText,
    // Every event renders at once, unless a test looks at how updates are spaced.
    updateIntervalMs: options.updateIntervalMs ?? 0,
  });
  const start = (params: Partial<RecordParams> = {}, target: Partial<RecordTarget> = {}) =>
    sessions.start(
      { uri: URI, line: 3, character: 0, into: 'steps', ...params },
      { file: SPEC_FILE, text: SPEC, configFile: CONFIG, catalog: [], preferLocators: new Set(), ...target },
    );
  return { sessions, updates, launchers, read, start, last: () => updates[updates.length - 1]! };
}

let clock = 1_000_000;
const target = (role: string, name: string, locator: string, extra: Partial<RecordedTarget> = {}): RecordedTarget => ({
  tagName: role === 'button' ? 'button' : 'input',
  role,
  accessibleName: name,
  testId: null,
  text: role === 'button' ? name : null,
  alternatives: [
    { locator, method: locator.slice(0, locator.indexOf('(')), score: 90 },
    { locator: `locator('#${name.toLowerCase().replace(/\W+/g, '-')}')`, method: 'locator', score: 60 },
  ],
  elementKey: name,
  ...extra,
});
const event = (kind: RawCaptureEvent['kind'], fields: Partial<RawCaptureEvent>): RawCaptureEvent => ({
  kind,
  target: null,
  value: null,
  checked: null,
  inputType: null,
  isPasswordField: false,
  pageUrl: `${BASE}/login`,
  timestamp: (clock += 100),
  ...fields,
});
const EMAIL = target('textbox', 'Email', "getByRole('textbox', { name: 'Email' })");
const PASSWORD = target('textbox', 'Password', "getByRole('textbox', { name: 'Password' })");
const SIGN_IN = target('button', 'Sign in', "getByRole('button', { name: 'Sign in' })");
const navigate = (url: string) => event('navigate', { value: url, pageUrl: url });
const fill = (t: RecordedTarget, value: string, password = false) =>
  event('input', { target: t, value: password ? null : value, isPasswordField: password });
const click = (t: RecordedTarget, pageUrl = `${BASE}/login`) => event('click', { target: t, pageUrl });

const SIGN_IN_ENTRY: TestFunctionEntry = {
  id: 1,
  name: 'signIn',
  kind: 'page-object-method',
  module: './pages/sign-in.page',
  receiver: 'signInPage',
  importName: 'SignInPage',
  params: [{ name: 'email', type: 'string' }],
  urlPattern: null,
  steps: [
    { action: 'fill', target: { role: 'textbox', name: 'Email' } },
    { action: 'click', target: { role: 'button', name: 'Sign in' } },
  ],
  paramSources: [{ param: 'email', stepIndex: 0, from: 'value' }],
};

describe('starting a recording', () => {
  test('starts the launcher in the config’s folder with the project’s options, and says where the block goes', async () => {
    const { start, launchers, read } = setup({
      projects: [
        {
          name: 'chromium',
          testDir: '/work/shop/tests',
          use: { baseURL: `${BASE}/app/`, testIdAttribute: 'data-test', viewport: { width: 1024, height: 700 } },
        },
      ],
      env: { PIWI_RECORDER_HEADLESS: '1' },
    });
    const result = await start({ startUrl: '/login', language: 'fr-FR' });
    expect(result).toEqual({
      ok: true,
      sessionId: expect.any(String),
      message: 'Opening Chromium with the options of the chromium project.',
      placement: { line: 3, newLine: false, indent: '  ' },
    });
    expect(read).toEqual([CONFIG]);
    expect(launchers).toHaveLength(1);
    expect(launchers[0]!.cwd).toBe(ROOT);
    const request = launchers[0]!.request;
    expect(request).toEqual({
      cwd: ROOT,
      browserName: 'chromium',
      launchOptions: { args: ['--disable-features=Translate'], headless: true },
      contextOptions: { baseURL: `${BASE}/app/`, viewport: { width: 1024, height: 700 } },
      testIdAttribute: 'data-test',
      startUrl: `${BASE}/login`,
      bundle: path.join(dist, 'record-ide.js'),
      language: {
        code: 'fr',
        messages: { record_stop: { message: 'Arrêter' }, record_title: { message: 'Recording' } },
      },
      settings: { file: 'checkout.spec.ts', testIdAttribute: 'data-test' },
      startedAt: expect.any(Number),
    });
  });

  test('a headed browser unless PIWI_RECORDER_HEADLESS=1', async () => {
    const { start, launchers } = setup();
    await start();
    expect(launchers[0]!.request.launchOptions).toEqual({ args: ['--disable-features=Translate'], headless: false });
  });

  test('a config with several projects and none given asks which, then starts with the one named', async () => {
    const projects = ['setup', 'chromium', 'firefox'].map((name) => ({ name, testDir: '/t', use: {} }));
    const { start, launchers } = setup({ projects });
    expect(await start()).toEqual({
      ok: false,
      message: 'playwright.config.ts has 3 projects: choose the one whose options the browser gets.',
      projects: ['setup', 'chromium', 'firefox'],
    });
    expect(await start({ project: 'webkit' })).toEqual({
      ok: false,
      message: 'playwright.config.ts has no project named webkit: choose one of setup, chromium, firefox.',
      projects: ['setup', 'chromium', 'firefox'],
    });
    expect(launchers).toHaveLength(0);
    expect(await start({ project: 'firefox' })).toMatchObject({
      ok: true,
      message: 'Opening Chromium with the options of the firefox project.',
    });
  });

  test('a project’s browser and the config’s unnamed project', async () => {
    const { start, launchers } = setup({
      projects: [{ name: '', testDir: '/t', use: { defaultBrowserType: 'firefox' } }],
    });
    expect(await start()).toMatchObject({
      ok: true,
      message: 'Opening Firefox with the options of playwright.config.ts.',
    });
    expect(launchers[0]!.request.browserName).toBe('firefox');
  });

  test('a config Playwright cannot read is said in one sentence', async () => {
    const { start } = setup({
      failRead: new Error('Playwright is not installed in /work/shop: run npm install there.'),
    });
    expect(await start()).toEqual({
      ok: false,
      message: 'Playwright is not installed in /work/shop: run npm install there.',
    });
  });

  test('a page expression that is not one, or this.page for a new test, is refused', async () => {
    const { start, launchers } = setup();
    expect(await start({ page: 'page; fetch(x)' })).toEqual({
      ok: false,
      message:
        'page; fetch(x) is not an expression the steps can run on: use page, this.page or a name such as adminPage.',
    });
    expect(await start({ page: 'this.page', into: 'test', line: 5 })).toEqual({
      ok: false,
      message: 'A new test cannot run on this.page: record steps inside a method, or choose a fixture.',
    });
    expect(launchers).toHaveLength(0);
  });

  test('a caret that does not fit what is recorded is refused in one sentence', async () => {
    const pageObject = [
      "import type { Page } from '@playwright/test';",
      'export class SignInPage {',
      '  constructor(readonly page: Page) {}',
      '',
      '  async open() {',
      '',
      '  }',
      '}',
      'async function login(page) {',
      '',
      '}',
    ].join('\n');
    const spec = [
      "import { test } from '@playwright/test';",
      "test.describe('checkout', () => {",
      "  test('pays', async ({ page }) => {",
      '',
      '  });',
      '',
      '});',
    ].join('\n');
    const { start, launchers } = setup();
    const steps = 'Put the cursor inside a test, a method or a function to record steps there.';
    expect(await start({ line: 3 }, { text: pageObject })).toEqual({ ok: false, message: steps });
    expect(await start({ line: 3, into: 'test' }, { text: pageObject })).toEqual({
      ok: false,
      message:
        'A test cannot go inside a class: put the cursor inside a method to record its steps, or outside the class for a new test.',
    });
    expect(await start({ line: 5, into: 'test' }, { text: pageObject })).toEqual({
      ok: false,
      message:
        'A new test cannot go inside another function: record steps there instead, or put the cursor outside the function for a new test.',
    });
    expect(await start({ line: 3, into: 'test' }, { text: spec })).toEqual({
      ok: false,
      message:
        'A new test cannot go inside another test: record steps there instead, or put the cursor outside the test for a new test.',
    });
    expect(await start({ line: 5 }, { text: spec })).toEqual({ ok: false, message: steps });
    expect(launchers).toHaveLength(0);

    // A method, a function, a test, and between tests for a new test; a new file wherever the caret is.
    expect(await start({ line: 5 }, { text: pageObject })).toMatchObject({ ok: true });
    expect(await start({ line: 9 }, { text: pageObject })).toMatchObject({ ok: true });
    expect(await start({ line: 3 }, { text: spec })).toMatchObject({ ok: true });
    expect(await start({ line: 5, into: 'test' }, { text: spec })).toMatchObject({ ok: true });
    expect(await start({ line: 3, into: 'file' }, { text: spec })).toMatchObject({ ok: true });
    expect(launchers).toHaveLength(5);
  });

  test('a caret inside a parenthesis the file never closes is refused in one sentence', async () => {
    const text = [
      "import { test, expect } from '@playwright/test';",
      "test('pays', async ({ page }) => {",
      '  await expect(',
      "    page.getByRole('heading')",
      '});',
    ].join('\n');
    const { start, launchers } = setup();
    expect(await start({ line: 3 }, { text })).toEqual({
      ok: false,
      message:
        'The cursor is inside a ( opened on line 3 and not closed: close it, or put the cursor after the statement.',
    });
    expect(launchers).toHaveLength(0);
  });

  test('without the recorder’s files there is nothing to start', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-sessions-empty-'));
    try {
      const { start } = setup({ distDir: empty });
      expect(await start()).toEqual({
        ok: false,
        message: `The recorder is missing from this installation: record-ide.js or record-ide-messages.json was not found in ${empty}.`,
      });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a launcher that cannot start is said in one sentence', async () => {
    const sessions = new RecordingSessions({
      distDir: dist,
      notify: () => {},
      readOptions: async (configFile) => ({
        configFile,
        rootDir: '/t',
        projects: [{ name: 'a', testDir: '/t', use: {} }],
      }),
      launch: () => {
        throw new Error('The recorder is missing from this installation: /x/piwi-recorder-launcher.cjs was not found.');
      },
    });
    expect(
      await sessions.start(
        { uri: URI, line: 0, character: 0, into: 'test' },
        { file: SPEC_FILE, text: '', configFile: CONFIG, catalog: [], preferLocators: new Set() },
      ),
    ).toEqual({
      ok: false,
      message: 'The recorder is missing from this installation: /x/piwi-recorder-launcher.cjs was not found.',
    });
  });
});

describe('a recording session', () => {
  test('writes nothing until the browser is open, then the block on every event, in order', async () => {
    const { start, launchers, updates, last } = setup();
    const { sessionId } = await start({ startUrl: '/login' });
    const launcher = launchers[0]!;
    expect(updates).toEqual([]);
    launcher.emit({ type: 'started' });
    expect(updates).toEqual([
      {
        sessionId,
        uri: URI,
        into: 'steps',
        state: 'recording',
        code: '',
        importEdit: null,
        steps: [],
        warnings: [],
        message: null,
        command: null,
      },
    ]);
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'event', event: fill(EMAIL, 'dev@example.com') });
    launcher.emit({ type: 'event', event: fill(PASSWORD, '', true) });
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    launcher.emit({
      type: 'event',
      event: click(target('button', 'Orders', "getByRole('button', { name: 'Orders' })"), `${BASE}/account`),
    });
    expect(updates.map((u) => u.steps.length)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(last().code).toBe(
      [
        "await page.goto('/login');",
        "await page.getByRole('textbox', { name: 'Email' }).fill('dev@example.com');",
        "await page.getByRole('textbox', { name: 'Password' }).fill(process.env.E2E_PASSWORD ?? '');",
        "await page.getByRole('button', { name: 'Sign in' }).click();",
        'await expect(page).toHaveURL(/\\/account(?:[?#]|$)/);',
        "await expect(page.getByRole('button', { name: 'Orders' })).toHaveCount(1);",
        "await page.getByRole('button', { name: 'Orders' }).click();",
      ].join('\n'),
    );
    expect(last().steps.map((s) => s.line)).toEqual([0, 1, 2, 3, 6]);
    expect(last().steps[0]).toEqual({ words: `Go to \`${BASE}/login\``, line: 0, locators: [], chosen: null });
    expect(last().steps[1]).toEqual({
      words: 'Fill text field "Email" with "dev@example.com"',
      line: 1,
      locators: ["getByRole('textbox', { name: 'Email' })", "locator('#email')"],
      chosen: 0,
    });
    expect(last().warnings).toEqual([
      { step: 2, line: 2, message: 'A password was typed here; the spec reads it from E2E_PASSWORD.' },
    ]);
  });

  test('writes absolute URLs when the recording is not on the baseURL’s origin', async () => {
    const { start, launchers, last } = setup();
    await start({ startUrl: 'https://sso.example.test/login' });
    const launcher = launchers[0]!;
    expect(launcher.request.startUrl).toBe('https://sso.example.test/login');
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate('https://sso.example.test/login') });
    expect(last().code).toBe("await page.goto('https://sso.example.test/login');");
  });

  test('a new test at the caret: the test call, its body indented by two spaces, on the page expression', async () => {
    const text = SPEC.replace('async ({ page })', 'async ({ adminPage })');
    const { start, launchers, last } = setup();
    const result = await start({ into: 'test', line: 5, title: 'signs in', page: 'adminPage' }, { text });
    expect(result.placement).toEqual({ line: 5, newLine: false, indent: '' });
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(last().code).toBe(
      [
        "test('signs in', async ({ adminPage }) => {",
        "  await adminPage.goto('/login');",
        "  await adminPage.getByRole('button', { name: 'Sign in' }).click();",
        '});',
      ].join('\n'),
    );
    expect(last().steps.map((s) => s.line)).toEqual([1, 2]);
  });

  test('a new file: the whole spec, importing test from the module its folder’s specs use', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-sessions-file-'));
    try {
      fs.writeFileSync(path.join(folder, 'a.spec.ts'), "import { test, expect } from './fixtures';\n");
      fs.writeFileSync(path.join(folder, 'b.spec.ts'), "import { test } from './fixtures';\n");
      fs.writeFileSync(path.join(folder, 'c.spec.ts'), "import { test } from '@playwright/test';\n");
      const { start, launchers, last } = setup();
      const result = await start({ into: 'file', line: 0 }, { file: path.join(folder, 'new.spec.ts'), text: '' });
      expect(result.placement).toEqual({ line: 0, newLine: false, indent: '' });
      launchers[0]!.emit({ type: 'started' });
      launchers[0]!.emit({ type: 'event', event: navigate(`${BASE}/`) });
      expect(last().code).toBe(
        [
          "import { test, expect } from './fixtures';",
          '',
          "test('recorded flow', async ({ page }) => {",
          "  await page.goto('/');",
          '});',
        ].join('\n'),
      );
      expect(last().into).toBe('file');
      expect(last().steps[0]!.line).toBe(3);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  test('a run of steps the catalog knows becomes a call, with its import as data', async () => {
    const { start, launchers, last } = setup();
    await start({}, { catalog: Promise.resolve([SIGN_IN_ENTRY]) });
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'event', event: fill(EMAIL, 'dev@example.com') });
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(last().code).toBe(
      [
        'const signInPage = new SignInPage(page);',
        "await page.goto('/login');",
        "await signInPage.signIn('dev@example.com');",
      ].join('\n'),
    );
    expect(last().importEdit).toEqual(insertAt(1, "import { SignInPage } from './pages/sign-in.page';\n"));
    expect(last().steps.map((s) => [s.line, s.functionName])).toEqual([
      [1, undefined],
      [2, 'signIn'],
      [2, 'signIn'],
    ]);
  });

  test('a page object the test declares already is not instantiated again, and its import is not repeated', async () => {
    const text = [
      "import { test } from '@playwright/test';",
      "import { SignInPage } from './pages/sign-in.page';",
      '',
      "test('signs in', async ({ page }) => {",
      '  const signInPage = new SignInPage(page);',
      '',
      '});',
      '',
    ].join('\n');
    const { start, launchers, last } = setup();
    await start({ line: 5 }, { text, catalog: [SIGN_IN_ENTRY] });
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'event', event: fill(EMAIL, 'dev@example.com') });
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(last().code).toBe(["await page.goto('/login');", "await signInPage.signIn('dev@example.com');"].join('\n'));
    expect(last().importEdit).toBeNull();
  });

  test('a new test takes the page objects the file’s tests take as fixtures', async () => {
    const text = [
      "import { test } from './fixtures';",
      '',
      "test('opens the cart', async ({ page, signInPage, cart }) => {",
      "  await page.goto('/');",
      '});',
      '',
      '',
    ].join('\n');
    const { start, launchers, last } = setup();
    await start({ into: 'test', line: 6 }, { text, catalog: [SIGN_IN_ENTRY] });
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'event', event: fill(EMAIL, 'dev@example.com') });
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(last().code).toBe(
      [
        "test('recorded flow', async ({ page, signInPage }) => {",
        "  await page.goto('/login');",
        "  await signInPage.signIn('dev@example.com');",
        '});',
      ].join('\n'),
    );
    expect(last().importEdit).toBeNull();
  });

  test('the imports leave out what the file imports now, as the editor holds it', async () => {
    let current: string | null = null;
    const { start, launchers, last } = setup({ readText: (uri) => (uri === URI ? current : null) });
    await start({}, { catalog: [SIGN_IN_ENTRY] });
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'event', event: fill(EMAIL, 'dev@example.com') });
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    // Without a current text, the text the recording started from.
    expect(last().importEdit).toEqual(insertAt(1, "import { SignInPage } from './pages/sign-in.page';\n"));
    current = ['import { SignInPage } from "./pages/sign-in.page"', SPEC].join('\n');
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(last().importEdit).toBeNull();
    expect(last().code).toContain('const signInPage = new SignInPage(page);');
  });

  test('checks added in the browser are expect lines where they were added, and the file is asked for expect from @playwright/test unless a spec beside it takes it from the fixtures module', async () => {
    const text = SPEC.replace("import { test, expect } from '@playwright/test';", "import { test } from './fixtures';");
    const { start, launchers, last } = setup();
    await start({}, { text });
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    const total = target('status', 'Total', "getByRole('status', { name: 'Total' })");
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    launcher.emit({
      type: 'event',
      event: event('assert', {
        target: null,
        assertion: { matcher: 'toHaveURL', expected: '/account', actual: null, negated: false, note: null },
      }),
    });
    launcher.emit({
      type: 'event',
      event: event('assert', {
        target: total,
        assertion: { matcher: 'toHaveText', expected: 'Total: 42', actual: null, negated: false, note: null },
      }),
    });
    expect(last().code).toBe(
      [
        "await page.goto('/login');",
        "await page.getByRole('button', { name: 'Sign in' }).click();",
        "await expect(page).toHaveURL('/account');",
        "await expect(page.getByRole('status', { name: 'Total' })).toHaveText('Total: 42');",
      ].join('\n'),
    );
    expect(last().steps.map((s) => [s.line, s.words])).toEqual([
      [0, `Go to \`${BASE}/login\``],
      [1, 'Click button "Sign in"'],
      [2, expect.stringContaining('/account')],
      [3, expect.stringContaining('Total: 42')],
    ]);
    expect(last().importEdit).toEqual(insertAt(1, "import { expect } from '@playwright/test';\n"));

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-sessions-expect-'));
    try {
      fs.writeFileSync(path.join(folder, 'a.spec.ts'), "import { test, expect } from './fixtures';\n");
      const beside = setup();
      await beside.start({}, { file: path.join(folder, 'checkout.spec.ts'), text });
      beside.launchers[0]!.emit({ type: 'started' });
      beside.launchers[0]!.emit({ type: 'event', event: navigate(`${BASE}/login`) });
      beside.launchers[0]!.emit({
        type: 'event',
        event: event('assert', {
          target: null,
          assertion: { matcher: 'toHaveURL', expected: '/login', actual: null, negated: false, note: null },
        }),
      });
      expect(beside.last().code).toContain("await expect(page).toHaveURL('/login');");
      expect(beside.last().importEdit).toEqual(insertAt(1, "import { expect } from './fixtures';\n"));
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  test('a spec loading test with require gets expect as a require declaration after the last one, once', async () => {
    const text = [
      "const { test } = require('@playwright/test');",
      "const { CartPage } = require('./pages/cart.page');",
      '',
      "test('pays', async ({ page }) => {",
      '',
      '});',
      '',
    ].join('\n');
    const check = event('assert', {
      target: null,
      assertion: { matcher: 'toHaveURL', expected: '/login', actual: null, negated: false, note: null },
    });
    const { start, launchers, last } = setup();
    await start({ line: 4 }, { text });
    launchers[0]!.emit({ type: 'started' });
    launchers[0]!.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launchers[0]!.emit({ type: 'event', event: check });
    expect(last().code).toBe(["await page.goto('/login');", "await expect(page).toHaveURL('/login');"].join('\n'));
    expect(last().importEdit).toEqual(insertAt(2, "const { expect } = require('@playwright/test');\n"));

    const bound = setup();
    await bound.start({ line: 4 }, { text: text.replace('const { test }', 'const { test, expect }') });
    bound.launchers[0]!.emit({ type: 'started' });
    bound.launchers[0]!.emit({ type: 'event', event: check });
    expect(bound.last().importEdit).toBeNull();
  });

  test('a tab the application opens is said, and the block stays', async () => {
    const notice = 'A new tab opened: what you do there is not recorded yet. Record in the first tab.';
    const { start, launchers, updates, last } = setup();
    await start();
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'notice', message: notice });
    expect(last()).toMatchObject({ state: 'recording', code: "await page.goto('/login');", message: notice });
    expect(last().steps).toHaveLength(1);
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(last().message).toBeNull();
    expect(updates).toHaveLength(4);
  });

  test('the config’s Piwi section sets the waits, the values, their prefix, the test steps and a new test’s tags', async () => {
    const piwi = {
      codegen: {
        pageWaits: false,
        values: 'env',
        envPrefix: 'SHOP_',
        testSteps: 'page',
        tags: ['@recorded'],
        annotations: [{ type: 'piwi:owner', description: '@shop-team' }],
      },
    };
    const record = async (params: Partial<RecordParams>) => {
      const { start, launchers, last } = setup({ piwi });
      await start(params);
      const launcher = launchers[0]!;
      launcher.emit({ type: 'started' });
      launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
      launcher.emit({ type: 'event', event: fill(EMAIL, 'dev@example.com') });
      launcher.emit({
        type: 'event',
        event: click(target('button', 'Orders', "getByRole('button', { name: 'Orders' })"), `${BASE}/account`),
      });
      return last().code;
    };
    expect(await record({ into: 'steps' })).toBe(
      [
        '// Typed values come from SHOP_EMAIL.',
        "await test.step('/login', async () => {",
        "  await page.goto('/login');",
        "  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.SHOP_EMAIL ?? '');",
        '});',
        "await test.step('/account', async () => {",
        "  await page.getByRole('button', { name: 'Orders' }).click();",
        '});',
      ].join('\n'),
    );
    const test = await record({ into: 'test', line: 5, title: 'opens orders' });
    expect(test.split('\n').slice(0, 5)).toEqual([
      "test('opens orders', {",
      "  tag: ['@recorded'],",
      '  annotation: [',
      "    { type: 'piwi:owner', description: '@shop-team' },",
      '  ],',
    ]);
    expect(test).toContain("  await test.step('/login', async () => {");
  });

  test('in a page object, the steps are not wrapped in test.step, and what the section holds wrongly is said', async () => {
    const text = [
      "import type { Page } from '@playwright/test';",
      'export class LoginPage {',
      '  constructor(private readonly page: Page) {}',
      '  async signIn() {',
      '',
      '  }',
      '}',
      '',
    ].join('\n');
    const { start, launchers, updates, last } = setup({ piwi: { codegen: { testSteps: 'page', values: 'secret' } } });
    await start({ line: 4 }, { text });
    launchers[0]!.emit({ type: 'started' });
    launchers[0]!.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    expect(last().code).toBe("await this.page.goto('/login');");
    expect(updates[0]!.message).toBe(
      "playwright.config.ts: @piwi.codegen.values must be 'literal' or 'env'; it is ignored.",
    );
  });

  test('says on its first block that a sign-in state is missing, and when the start page did not load', async () => {
    const { start, launchers, updates } = setup({
      projects: [
        { name: 'a', testDir: '/t', use: { baseURL: `${BASE}/`, storageState: 'playwright/.auth/none.json' } },
      ],
    });
    await start();
    const launcher = launchers[0]!;
    expect(launcher.request.contextOptions).toEqual({ baseURL: `${BASE}/` });
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'notice', message: `${BASE}/ did not load (net::ERR_CONNECTION_REFUSED).` });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/`) });
    expect(updates.map((u) => u.message)).toEqual([
      'The sign-in state playwright/.auth/none.json does not exist yet: run the setup project first.',
      `${BASE}/ did not load (net::ERR_CONNECTION_REFUSED).`,
      null,
    ]);
    expect(updates.every((u) => u.state === 'recording')).toBe(true);
  });

  test('without a baseURL or a start page the browser opens a blank page, and the first block says so', async () => {
    const { start, launchers, last } = setup({ projects: [{ name: 'a', testDir: '/t', use: {} }] });
    await start();
    expect(launchers[0]!.request.startUrl).toBe('about:blank');
    launchers[0]!.emit({ type: 'started' });
    expect(last()).toMatchObject({
      state: 'recording',
      code: '',
      message: 'The browser opened on a blank page: go to the page to record there.',
    });
    launchers[0]!.emit({ type: 'event', event: navigate('https://shop.test/') });
    expect(last()).toMatchObject({ code: "await page.goto('https://shop.test/');", message: null });
  });

  test('Pause in the editor: the browser hears it, the update says paused, and nothing is recorded until Resume', async () => {
    const { start, sessions, launchers, updates, last } = setup();
    const { sessionId } = await start();
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    sessions.command(sessionId!, 'pause');
    expect(launcher.sent[launcher.sent.length - 1]).toEqual({ type: 'pause', paused: true });
    expect(updates).toHaveLength(3);
    expect(last()).toMatchObject({ state: 'paused', code: "await page.goto('/login');" });
    launcher.emit({ type: 'event', event: fill(EMAIL, 'dev@example.com') });
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(updates).toHaveLength(3);
    sessions.command(sessionId!, 'resume');
    expect(launcher.sent[launcher.sent.length - 1]).toEqual({ type: 'pause', paused: false });
    expect(updates).toHaveLength(4);
    expect(last().state).toBe('recording');
    expect(last().steps).toHaveLength(1);
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(updates).toHaveLength(5);
    expect(last().steps).toHaveLength(2);
  });

  test('Pause and Resume in the browser reach the editor as updates, and are not sent back', async () => {
    const { start, launchers, updates, last } = setup();
    await start();
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'paused', paused: true });
    expect(last()).toMatchObject({ state: 'paused' });
    launcher.emit({ type: 'paused', paused: true });
    expect(updates).toHaveLength(3);
    launcher.emit({ type: 'paused', paused: false });
    expect(last()).toMatchObject({ state: 'recording', code: "await page.goto('/login');" });
    expect(launcher.sent.map((m) => m.type)).toEqual(['start']);
  });

  test('Stop: a last update says stopped, the launcher closes the browser, and later events are ignored', async () => {
    const { start, sessions, launchers, updates, last } = setup();
    const { sessionId } = await start();
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    let done = false;
    const stopping = sessions.stop(sessionId!).then(() => (done = true));
    expect(last()).toMatchObject({ state: 'stopped', message: null, code: "await page.goto('/login');" });
    expect(launcher.sent.map((m) => m.type)).toEqual(['start', 'stop']);
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    launcher.emit({ type: 'closed' });
    expect(updates).toHaveLength(3);
    await Promise.resolve();
    expect(done).toBe(false);
    launcher.exit(0);
    await stopping;
    expect(done).toBe(true);
    // The session is gone.
    sessions.command(sessionId!, 'resume');
    await sessions.stop(sessionId!);
    expect(updates).toHaveLength(3);
  });

  test('pausing then stopping keeps the edits: the last update says stopped', async () => {
    const { start, sessions, launchers, last } = setup();
    const { sessionId } = await start();
    launchers[0]!.emit({ type: 'started' });
    sessions.command(sessionId!, 'pause');
    void sessions.stop(sessionId!);
    expect(last().state).toBe('stopped');
  });

  test('Stop in the browser, and the browser closing, end the session', async () => {
    const one = setup();
    await one.start();
    one.launchers[0]!.emit({ type: 'started' });
    one.launchers[0]!.emit({ type: 'stopped-in-browser' });
    expect(one.last()).toMatchObject({ state: 'stopped', message: 'Stopped in the browser.' });
    expect(one.launchers[0]!.sent.map((m) => m.type)).toEqual(['start', 'stop']);

    const two = setup();
    await two.start();
    two.launchers[0]!.emit({ type: 'started' });
    two.launchers[0]!.emit({ type: 'closed' });
    expect(two.last()).toMatchObject({ state: 'stopped', message: 'The browser was closed: the recording stopped.' });
  });

  test('a browser that is not installed fails with the command that installs it, in the config’s folder', async () => {
    const { start, launchers, updates, last } = setup();
    await start();
    launchers[0]!.emit({
      type: 'failed',
      reason: 'browser-missing',
      message:
        "The browser did not start: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1243/chrome.",
    });
    expect(updates).toHaveLength(1);
    expect(last()).toMatchObject({
      state: 'failed',
      message: `Chromium is not installed for this project's Playwright: run npx playwright install chromium in ${ROOT}.`,
      command: {
        title: 'Install Chromium',
        command: 'piwi.runCommand',
        arguments: [{ cwd: ROOT, command: 'npx playwright install chromium' }],
      },
    });
    expect(launchers[0]!.sent.map((m) => m.type)).toEqual(['start', 'stop']);
  });

  test('a missing branded channel installs that channel', async () => {
    const { start, launchers, last } = setup({ projects: [{ name: 'a', testDir: '/t', use: { channel: 'msedge' } }] });
    await start();
    launchers[0]!.emit({ type: 'failed', reason: 'browser-missing', message: "distribution 'msedge' is not found" });
    expect(last().command).toEqual({
      title: 'Install Microsoft Edge',
      command: 'piwi.runCommand',
      arguments: [{ cwd: ROOT, command: 'npx playwright install msedge' }],
    });
  });

  test('other failures say what the launcher said; a launcher that dies says how', async () => {
    const one = setup();
    await one.start();
    one.launchers[0]!.emit({
      type: 'failed',
      reason: 'launch-failed',
      message: 'The browser did not open: bad proxy.',
    });
    expect(one.last()).toMatchObject({
      state: 'failed',
      message: 'The browser did not open: bad proxy.',
      command: null,
    });

    const two = setup();
    await two.start();
    two.launchers[0]!.emit({ type: 'started' });
    two.launchers[0]!.exit(1, 'Error: out of memory.');
    expect(two.last()).toMatchObject({
      state: 'failed',
      message: 'The recorder stopped unexpectedly: Error: out of memory.',
    });
    two.launchers[0]!.emit({ type: 'event', event: navigate(`${BASE}/`) });
    expect(two.updates).toHaveLength(2);
  });

  test('closing the file stops its sessions; disposing stops them all', async () => {
    const { start, sessions, launchers, updates } = setup();
    await start();
    await start({ uri: 'file:///work/shop/tests/other.spec.ts' });
    launchers.forEach((l) => l.emit({ type: 'started' }));
    sessions.stopFile(URI);
    expect(updates.slice(2).map((u) => [u.uri, u.state, u.message])).toEqual([
      [URI, 'stopped', 'The file was closed: the recording stopped.'],
    ]);
    sessions.dispose();
    expect(updates.slice(3).map((u) => [u.uri, u.state])).toEqual([
      ['file:///work/shop/tests/other.spec.ts', 'stopped'],
    ]);
    expect(launchers.map((l) => l.sent.map((m) => m.type))).toEqual([
      ['start', 'stop'],
      ['start', 'stop'],
    ]);
  });
});

describe('the spacing of updates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('events within the update interval render together once it is over; Stop renders at once', async () => {
    vi.useFakeTimers();
    const { start, sessions, launchers, updates, last } = setup({ updateIntervalMs: UPDATE_INTERVAL_MS });
    const { sessionId } = await start();
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    launcher.emit({ type: 'event', event: fill(EMAIL, 'dev@example.com') });
    expect(updates).toHaveLength(1);
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS - 1);
    expect(updates).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(updates).toHaveLength(2);
    expect(last().steps).toHaveLength(2);

    // After a quiet interval, an event renders at once.
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS);
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    expect(updates).toHaveLength(3);
    expect(last().steps).toHaveLength(3);

    // Pausing sends the paused update at once, with the event due, and nothing else is due; resuming renders at once.
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    sessions.command(sessionId!, 'pause');
    expect(updates).toHaveLength(4);
    expect(last()).toMatchObject({ state: 'paused' });
    expect(last().steps).toHaveLength(4);
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 2);
    expect(updates).toHaveLength(4);
    sessions.command(sessionId!, 'resume');
    expect(updates).toHaveLength(5);
    expect(last().steps).toHaveLength(4);

    // The last update holds every event, without waiting.
    launcher.emit({ type: 'event', event: click(SIGN_IN) });
    void sessions.stop(sessionId!);
    expect(updates).toHaveLength(6);
    expect(last()).toMatchObject({ state: 'stopped' });
    expect(last().steps).toHaveLength(5);
    vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 2);
    expect(updates).toHaveLength(6);
    launcher.exit(0);
  });

  test('after a slow rendering the next waits three times as long', async () => {
    vi.useFakeTimers();
    const { start, launchers, updates } = setup({
      updateIntervalMs: UPDATE_INTERVAL_MS,
      // Each update takes 50 ms to render and send.
      onUpdate: () => vi.setSystemTime(Date.now() + 50),
    });
    await start();
    const launcher = launchers[0]!;
    launcher.emit({ type: 'started' });
    launcher.emit({ type: 'event', event: navigate(`${BASE}/login`) });
    vi.advanceTimersByTime(149);
    expect(updates).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(updates).toHaveLength(2);
  });
});

describe('startUrl', () => {
  test('an absolute address, a path on the baseURL, the baseURL, or a blank page', () => {
    expect(startUrl('https://sso.test/login', `${BASE}/`)).toEqual({ url: 'https://sso.test/login' });
    expect(startUrl('/login', `${BASE}/app/`)).toEqual({ url: `${BASE}/login` });
    expect(startUrl('login', `${BASE}/app/`)).toEqual({ url: `${BASE}/app/login` });
    expect(startUrl('', `${BASE}/app/`)).toEqual({ url: `${BASE}/app/` });
    expect(startUrl(null, null)).toEqual({ url: 'about:blank' });
    expect(startUrl('localhost:3000/cart', null)).toEqual({ url: 'http://localhost:3000/cart' });
  });

  test('a path without a baseURL, or an address the browser should not open, is refused', () => {
    expect(startUrl('/login', null)).toEqual({
      error:
        '/login is a path, and the project has no baseURL: give the whole address, such as http://localhost:3000/login.',
    });
    expect(startUrl('javascript:alert(1)', null)).toEqual({
      error: 'javascript:alert(1) is not a page the recorder can record: give an http or https address.',
    });
    // The recorder records http and https pages only.
    expect(startUrl('file:///work/shop/index.html', null)).toEqual({
      error: 'file:///work/shop/index.html is not a page the recorder can record: give an http or https address.',
    });
  });
});

describe('recorderLanguage', () => {
  test('the editor’s language among the recorder’s catalogs', () => {
    expect(['fr', 'fr-FR', 'FR-ca'].map(recorderLanguage)).toEqual(['fr', 'fr', 'fr']);
    expect(['pt-BR', 'pt_BR', 'pt', 'pt-PT'].map(recorderLanguage)).toEqual(['pt_BR', 'pt_BR', 'pt_BR', 'pt_BR']);
    expect(['de', 'de-AT', 'es', 'es-419'].map(recorderLanguage)).toEqual(['de', 'de', 'es', 'es']);
    expect(['en-US', 'ja', '', null, undefined, 'dev'].map(recorderLanguage)).toEqual([
      'en',
      'en',
      'en',
      'en',
      'en',
      'en',
    ]);
  });

  test('the catalog sent is the language’s merged over English', async () => {
    const { start, launchers } = setup();
    await start({ language: 'pt-BR' });
    expect(launchers[0]!.request.language).toEqual({
      code: 'pt_BR',
      messages: { record_stop: { message: 'Stop' }, record_title: { message: 'Gravando' } },
    });
    await start({ language: 'ja' });
    expect(launchers[1]!.request.language.code).toBe('en');
  });
});

describe('blockImports', () => {
  const check = 'await expect(page).toHaveURL(/\\/cart(?:[?#]|$)/);';
  test('expect from @playwright/test, or from the fixtures module known to export it, when the block checks something and the file lacks it', () => {
    const fixtures = "import { test } from './shop-fixtures';\n";
    expect(blockImports(fixtures, { code: check, imports: [] })).toEqual([
      "import { expect } from '@playwright/test';",
    ]);
    expect(blockImports(fixtures, { code: check, imports: [] }, { expectModule: './shop-fixtures' })).toEqual([
      "import { expect } from './shop-fixtures';",
    ]);
    expect(blockImports("import type { Page } from '@playwright/test';\n", { code: check, imports: [] })).toEqual([
      "import { expect } from '@playwright/test';",
    ]);
    expect(blockImports("const { test } = require('@playwright/test');\n", { code: check, imports: [] })).toEqual([
      "import { expect } from '@playwright/test';",
    ]);
  });

  test('nothing for expect when the file imports it or the block checks nothing; catalog imports as before', () => {
    const both = "import { test, expect } from './shop-fixtures';\n";
    expect(blockImports(both, { code: check, imports: [] })).toEqual([]);
    const call = "import { CartPage } from './pages/cart';";
    expect(blockImports("import { test } from './f';\n", { code: 'await cart.open();', imports: [call] })).toEqual([
      call,
    ]);
    expect(blockImports('', { code: 'await page.expectation(1); await my.expect(2);', imports: [] })).toEqual([]);
  });
});

describe('indentBlock', () => {
  test('the first line goes at the caret, the others take the caret line’s indentation', () => {
    expect(indentBlock("  await page.goto('/cart');\n\n  await page.getByRole('button').click();\n", '    ')).toBe(
      "await page.goto('/cart');\n\n    await page.getByRole('button').click();",
    );
    expect(indentBlock('a();\n  b();', '\t')).toBe('a();\n\t  b();');
    expect(indentBlock("await page.goto('/');", '  ')).toBe("await page.goto('/');");
    expect(indentBlock('', '  ')).toBe('');
  });
});
