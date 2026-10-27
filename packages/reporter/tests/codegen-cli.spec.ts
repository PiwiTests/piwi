import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiwiSteps } from '@piwitests/core/steps';
import { parseCodegenArgs, renderStepsFile, runCodegen } from '../src/cli/codegen.js';

/** No desktop app, whatever runs on this machine. */
const NO_DESKTOP = { PIWI_DESKTOP_CONFIG: '/nonexistent/desktop.json' };

const STEPS: PiwiSteps = {
  v: 1,
  title: 'Coupon not applied',
  origin: 'https://staging.acme.test',
  recordedAt: 0,
  note: null,
  steps: [
    { action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 0 },
    {
      action: 'click',
      target: {
        tagName: 'button',
        role: 'button',
        accessibleName: 'Checkout',
        testId: null,
        text: 'Checkout',
        alternatives: [
          { locator: `locator('.btn').nth(1)`, method: 'locator', score: 20 },
          { locator: `getByRole('button', { name: 'Checkout' })`, method: 'getByRole', score: 90 },
        ],
      },
      value: null,
      redacted: false,
      pageUrl: '/cart',
      timestamp: 1,
    },
    {
      action: 'assert',
      target: {
        tagName: 'output',
        role: null,
        accessibleName: null,
        testId: 'total',
        text: 'Total: 40',
        alternatives: [{ locator: `getByTestId('total')`, method: 'getByTestId', score: 100 }],
      },
      value: null,
      redacted: false,
      pageUrl: '/checkout',
      timestamp: 2,
      assertion: { matcher: 'toHaveText', expected: 'Total: 42', actual: 'Total: 40', negated: false, note: null },
    },
  ],
};

describe('parseCodegenArgs', () => {
  it('reads the file, the flags and the env fallbacks', () => {
    const args = parseCodegenArgs(
      ['steps.json', '--out', 'tests/bugs/a.spec.ts', '--tag', 'bug', '--tag', '@checkout', '--fail-reason', 'SHOP-1'],
      { ...NO_DESKTOP, PIWI_DASHBOARD_URL: 'https://dash.example/', PIWI_PROJECT_NAME: 'web', PIWI_API_KEY: 'k' },
    );
    expect(args).toMatchObject({
      file: 'steps.json',
      out: 'tests/bugs/a.spec.ts',
      tags: ['bug', '@checkout'],
      fail: true,
      failReason: 'SHOP-1',
      urlChecks: true,
      absoluteUrls: false,
      serverUrl: 'https://dash.example',
      project: 'web',
      apiKey: 'k',
    });
  });

  it('finds the file after value flags', () => {
    expect(parseCodegenArgs(['--title', 'x', 'steps.json'], NO_DESKTOP).file).toBe('steps.json');
  });

  it('requires a file and a value for each value flag', () => {
    expect(() => parseCodegenArgs([], NO_DESKTOP)).toThrow(/No steps file/);
    expect(() => parseCodegenArgs(['steps.json', '--out'], NO_DESKTOP)).toThrow(/--out expects a value/);
  });
});

describe('renderStepsFile', () => {
  const args = parseCodegenArgs(['steps.json'], NO_DESKTOP);

  it('renders paths, stable locators and a URL check after a navigation', () => {
    const { code } = renderStepsFile(JSON.stringify(STEPS), args, null);
    expect(code).toContain(`test('Coupon not applied', async ({ page }) => {`);
    expect(code).toContain(`await page.goto('/cart');`);
    expect(code).toContain(`await page.getByRole('button', { name: 'Checkout' }).click();`);
    expect(code).toContain('await expect(page).toHaveURL(/\\/checkout(?:[?#]|$)/);');
    expect(code).toContain(`await expect(page.getByTestId('total')).toHaveText('Total: 42'); // recorded: 'Total: 40'`);
  });

  it('prefers what the suite already uses', () => {
    const suiteLocators = new Set([`locator('.btn').nth(1)`]);
    const { code } = renderStepsFile(JSON.stringify(STEPS), args, { catalog: [], suiteLocators });
    // A brittle chain is never preferred, even when the suite uses it.
    expect(code).toContain(`getByRole('button', { name: 'Checkout' })`);
  });

  it('names every problem of a file that is not a steps document', () => {
    const broken = { ...STEPS, steps: [{ ...STEPS.steps[0], action: 'eval' }] };
    expect(() => renderStepsFile(JSON.stringify(broken), args, null)).toThrow(
      /steps\.json is not a steps file:\n {2}steps\[0\]\.action: is not a known action/,
    );
  });
});

describe('runCodegen', () => {
  let dir: string;
  let stepsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-codegen-'));
    stepsFile = path.join(dir, 'steps.json');
    fs.writeFileSync(stepsFile, JSON.stringify(STEPS));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the spec, and replaces an existing one only with --force', async () => {
    const out = path.join(dir, 'tests', 'bugs', 'coupon.spec.ts');
    expect(await runCodegen([stepsFile, '--out', out], NO_DESKTOP, dir)).toBe(0);
    expect(fs.readFileSync(out, 'utf-8')).toContain(`test('Coupon not applied'`);
    fs.writeFileSync(out, 'mine');
    expect(await runCodegen([stepsFile, '--out', out], NO_DESKTOP, dir)).toBe(2);
    expect(fs.readFileSync(out, 'utf-8')).toBe('mine');
    expect(await runCodegen([stepsFile, '--out', out, '--force', '--fail'], NO_DESKTOP, dir)).toBe(0);
    expect(fs.readFileSync(out, 'utf-8')).toContain('test.fail();');
  });

  it('fails on a missing file', async () => {
    expect(await runCodegen([path.join(dir, 'nope.json')], NO_DESKTOP, dir)).toBe(2);
  });

  it('uses the project catalog and suite locators when a dashboard is configured', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.endsWith('/api/projects/menu')
        ? { items: [{ id: 7, name: 'web' }] }
        : url.endsWith('/test-functions')
          ? { testFunctions: [] }
          : { locators: [{ locator: `getByRole("button", {name: "Checkout"})` }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = path.join(dir, 'a.spec.ts');
    const env = { ...NO_DESKTOP, PIWI_DASHBOARD_URL: 'https://dash.example', PIWI_PROJECT_NAME: 'web' };
    expect(await runCodegen([stepsFile, '--out', out], env, dir)).toBe(0);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://dash.example/api/projects/menu',
      'https://dash.example/api/projects/7/test-functions',
      'https://dash.example/api/projects/7/locator-index',
    ]);
  });

  it('renders without the dashboard when it cannot be reached, and never calls it offline', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...NO_DESKTOP, PIWI_DASHBOARD_URL: 'https://dash.example', PIWI_PROJECT_NAME: 'web' };
    expect(await runCodegen([stepsFile, '--out', path.join(dir, 'a.spec.ts')], env, dir)).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/warning: no catalog or suite locators/));
    fetchMock.mockClear();
    expect(await runCodegen([stepsFile, '--out', path.join(dir, 'b.spec.ts'), '--offline'], env, dir)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
