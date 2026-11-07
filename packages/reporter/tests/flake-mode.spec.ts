import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { flakeErrorSignature, parseFlakePlan, type FlakePlan } from '@piwitests/core/flake-plan';
import {
  cdpCommandFor,
  flakeContextOptions,
  flakeResultLine,
  flakeRoleForTest,
  flakeRunMetadata,
  installFlakeConditions,
  isFlakeMode,
  labModeConflict,
  loadFlakePlan,
  recordFlakeResult,
  resetFlakePlanCache,
  unappliedReports,
  type FlakeAttempt,
} from '../src/internal/flake/mode.js';
import { wrapConfig } from '../src/public/config-wrapper.js';

const ERROR = 'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'total\')\nExpected: "$42"';

function plan(overrides: Partial<Record<keyof FlakePlan, unknown>> = {}): FlakePlan {
  return parseFlakePlan({
    version: 1,
    experimentId: 'exp-7',
    test: { file: 'tests/checkout.spec.ts', title: 'pays', suite: ['checkout'], project: 'chromium' },
    arm: {
      id: 'arm-2',
      conditions: [
        { kind: 'delay', route: 'GET /api/cart', ms: 1800 },
        { kind: 'cpu', rate: 4 },
        { kind: 'alongside', test: { file: 'tests/admin.spec.ts', title: 'resets catalog' } },
      ],
    },
    errorSignatures: [flakeErrorSignature(ERROR)],
    ...overrides,
  });
}

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-flake-'));
  resetFlakePlanCache();
});
afterEach(() => {
  delete process.env.PIWI_FLAKE_PLAN;
  delete process.env.PIWI_FLAKE_RESULTS;
  delete process.env.PIWI_PROBE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('flake mode switch', () => {
  it('is on when PIWI_FLAKE_PLAN names a file', () => {
    expect(isFlakeMode()).toBe(false);
    process.env.PIWI_FLAKE_PLAN = '  ';
    expect(isFlakeMode()).toBe(false);
    process.env.PIWI_FLAKE_PLAN = path.join(dir, 'plan.json');
    expect(isFlakeMode()).toBe(true);
  });

  it('refuses probe mode and flake mode together', () => {
    process.env.PIWI_PROBE = '1';
    expect(labModeConflict()).toBeNull();
    process.env.PIWI_FLAKE_PLAN = path.join(dir, 'plan.json');
    expect(labModeConflict()).toMatch(/PIWI_PROBE and PIWI_FLAKE_PLAN are both set/);
    expect(() => wrapConfig({})).toThrow(/a run is a probe run or a flake-lab run, not both/);
  });

  it('forces retries to 0 in flake mode, as in probe mode', () => {
    expect(wrapConfig({ retries: 2 }).retries).toBe(2);
    process.env.PIWI_FLAKE_PLAN = path.join(dir, 'plan.json');
    expect(wrapConfig({ retries: 2 }).retries).toBe(0);
    delete process.env.PIWI_FLAKE_PLAN;
    process.env.PIWI_PROBE = '1';
    expect(wrapConfig({ retries: 2 }).retries).toBe(0);
  });
});

describe('loadFlakePlan', () => {
  it('reads and validates the plan file', () => {
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(file, JSON.stringify(plan()));
    process.env.PIWI_FLAKE_PLAN = file;
    expect(loadFlakePlan().arm.id).toBe('arm-2');
  });

  it('names the file and the problem for a missing or invalid plan', () => {
    const file = path.join(dir, 'plan.json');
    process.env.PIWI_FLAKE_PLAN = file;
    expect(() => loadFlakePlan()).toThrow(/Cannot read the flake plan .*plan\.json/);
    fs.writeFileSync(file, JSON.stringify({ ...plan(), arm: { id: 'a', conditions: [{ kind: 'memory' }] } }));
    expect(() => loadFlakePlan()).toThrow(/kind "memory" is not a condition this version knows .*plan\.json/);
  });
});

describe('flakeRoleForTest', () => {
  const abs = (file: string) => path.join(process.cwd(), file);

  it('matches the target on file, title, suite and project', () => {
    const p = plan();
    const test = {
      file: abs('tests/checkout.spec.ts'),
      title: 'pays',
      titlePath: ['tests/checkout.spec.ts', 'checkout', 'pays'],
      project: 'chromium',
    };
    expect(flakeRoleForTest(p, test)).toBe('target');
    expect(flakeRoleForTest(p, { ...test, project: 'firefox' })).toBeNull();
    expect(flakeRoleForTest(p, { ...test, titlePath: ['tests/checkout.spec.ts', 'guest', 'pays'] })).toBeNull();
    expect(flakeRoleForTest(p, { ...test, file: abs('tests/cart.spec.ts') })).toBeNull();
  });

  it('matches the target in any project when the plan pins none', () => {
    const p = plan({ test: { file: 'tests/checkout.spec.ts', title: 'pays', suite: [], project: null } });
    expect(flakeRoleForTest(p, { file: abs('tests/checkout.spec.ts'), title: 'pays', project: 'webkit' })).toBe(
      'target',
    );
  });

  it('names an alongside test a companion', () => {
    expect(
      flakeRoleForTest(plan(), {
        file: abs('tests/admin.spec.ts'),
        title: 'resets catalog',
        titlePath: ['tests/admin.spec.ts', 'admin', 'resets catalog'],
        project: 'chromium',
      }),
    ).toBe('companion');
  });
});

describe('flakeResultLine', () => {
  const attempt: FlakeAttempt = {
    role: 'target',
    file: path.join(process.cwd(), 'tests/checkout.spec.ts'),
    title: 'pays',
    project: 'chromium',
    browserName: 'chromium',
    status: 'failed',
    errorText: ERROR.replace('$42', '$17'),
    startedAt: 1_000,
    duration: 2_500,
    workerIndex: 3,
    parallelIndex: 1,
    repeatEachIndex: 4,
    retry: 0,
    conditions: [{ kind: 'delay', outcome: 'applied' }],
  };

  it('carries what the lab needs, and matches a failure seen in history', () => {
    expect(flakeResultLine(plan(), attempt)).toEqual({
      version: 1,
      experimentId: 'exp-7',
      armId: 'arm-2',
      role: 'target',
      file: 'tests/checkout.spec.ts',
      title: 'pays',
      project: 'chromium',
      browserName: 'chromium',
      status: 'failed',
      errorSignature: flakeErrorSignature(ERROR),
      matchesHistory: true,
      startedAt: 1_000,
      duration: 2_500,
      workerIndex: 3,
      parallelIndex: 1,
      repeatEachIndex: 4,
      retry: 0,
      conditions: [{ kind: 'delay', outcome: 'applied' }],
    });
  });

  it('keeps a different failure apart, and a pass has no signature', () => {
    const other = flakeResultLine(plan(), {
      ...attempt,
      errorText: 'TimeoutError: page.click: Timeout 30000ms exceeded.',
    });
    expect(other.errorSignature).not.toBeNull();
    expect(other.matchesHistory).toBe(false);
    const passed = flakeResultLine(plan(), { ...attempt, status: 'passed', errorText: null });
    expect(passed.errorSignature).toBeNull();
    expect(passed.matchesHistory).toBe(false);
  });

  it('a companion line carries no conditions', () => {
    expect(flakeResultLine(plan(), { ...attempt, role: 'companion' }).conditions).toEqual([]);
  });
});

describe('conditions outside Chromium', () => {
  it('skips cpu and network with a note on another browser, and still installs route conditions', async () => {
    const routed: string[] = [];
    const page = {
      context: () => ({
        browser: () => ({ browserType: () => ({ name: () => 'firefox' }) }),
        newCDPSession: () => {
          throw new Error('CDP session is only available in Chromium');
        },
      }),
      on: () => {},
      mainFrame: () => null,
      route: async (pattern: string) => {
        routed.push(pattern);
      },
    } as unknown as Page;
    const p = plan({
      arm: {
        id: 'a',
        conditions: [
          { kind: 'delay', route: 'GET /api/cart', ms: 10 },
          { kind: 'cpu', rate: 4 },
          { kind: 'network', latencyMs: 100, downKbps: 1000, upKbps: 500 },
          { kind: 'project', name: 'firefox' },
        ],
      },
    });
    const installed = await installFlakeConditions(page, p);
    expect(routed).toEqual(['**/*']);
    expect(installed.reports()).toEqual([
      { kind: 'delay', outcome: 'not-matched' },
      { kind: 'cpu', outcome: 'skipped', note: 'needs Chromium; this attempt ran in firefox' },
      { kind: 'network', outcome: 'skipped', note: 'needs Chromium; this attempt ran in firefox' },
      { kind: 'project', outcome: 'by-command' },
    ]);
  });

  it('routes the page in every arm, so an arm differs from its control by its conditions only', async () => {
    for (const conditions of [[], [{ kind: 'cpu', rate: 4 }], [{ kind: 'project', name: 'firefox' }]]) {
      const routed: string[] = [];
      const page = {
        context: () => ({ browser: () => ({ browserType: () => ({ name: () => 'firefox' }) }) }),
        on: () => {},
        mainFrame: () => null,
        route: async (pattern: string) => {
          routed.push(pattern);
        },
      } as unknown as Page;
      await installFlakeConditions(page, plan({ arm: { id: 'a', conditions } }));
      expect(routed).toEqual(['**/*']);
    }
  });

  it('reports every page condition unapplied when the attempt opened no page', () => {
    expect(unappliedReports(plan())).toEqual([
      { kind: 'delay', outcome: 'not-matched' },
      { kind: 'cpu', outcome: 'skipped', note: 'the attempt opened no page' },
      { kind: 'alongside', outcome: 'by-command' },
    ]);
  });

  it('maps timezone and locale to context options, and reports them unapplied without a page', () => {
    const arm = plan({
      arm: {
        id: 'a',
        conditions: [
          { kind: 'timezone', timeZone: 'Europe/Paris' },
          { kind: 'locale', locale: 'fr-FR' },
        ],
      },
    });
    expect(flakeContextOptions(arm)).toEqual({ timezoneId: 'Europe/Paris', locale: 'fr-FR' });
    expect(flakeContextOptions(plan({ arm: { id: 'a', conditions: [{ kind: 'cpu', rate: 4 }] } }))).toBeNull();
    expect(unappliedReports(arm)).toEqual([
      { kind: 'timezone', outcome: 'skipped', note: 'the attempt opened no page' },
      { kind: 'locale', outcome: 'skipped', note: 'the attempt opened no page' },
    ]);
  });

  it('maps cpu and network to their DevTools commands', () => {
    expect(cdpCommandFor({ kind: 'cpu', rate: 4 })).toEqual({
      method: 'Emulation.setCPUThrottlingRate',
      params: { rate: 4 },
    });
    expect(cdpCommandFor({ kind: 'network', latencyMs: 400, downKbps: 1600, upKbps: 800 })).toEqual({
      method: 'Network.emulateNetworkConditions',
      params: { offline: false, latency: 400, downloadThroughput: 200_000, uploadThroughput: 100_000 },
    });
    expect(cdpCommandFor({ kind: 'project', name: 'x' })).toBeNull();
  });
});

describe('run stamp and results file', () => {
  it('stamps the experiment and arm into the run metadata', () => {
    expect(flakeRunMetadata({ experimentId: 'exp-7', armId: 'arm-2' }, { scm: { branch: 'main' } })).toEqual({
      scm: { branch: 'main' },
      piwiFlakeLab: { experimentId: 'exp-7', armId: 'arm-2' },
      piwiOrigin: { kind: 'flake-lab', ref: 'exp-7' },
    });
  });

  it('appends one JSON line per attempt, and nothing without a results file', () => {
    const line = flakeResultLine(plan(), {
      role: 'target',
      file: null,
      title: 'pays',
      project: null,
      browserName: null,
      status: 'passed',
      errorText: null,
      startedAt: 1,
      duration: 2,
      workerIndex: 0,
      parallelIndex: 0,
      repeatEachIndex: 0,
      retry: 0,
      conditions: [],
    });
    recordFlakeResult(line);
    const file = path.join(dir, 'results.jsonl');
    process.env.PIWI_FLAKE_RESULTS = file;
    recordFlakeResult(line);
    recordFlakeResult({ ...line, status: 'failed' });
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.status)).toEqual(['passed', 'failed']);
  });
});
