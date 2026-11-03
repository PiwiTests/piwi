import { describe, it, expect, vi } from 'vitest';
import {
  environmentalSkipReason,
  inspectionGateFromTestInfo,
  shouldInspectOnFailure,
  type InspectionGate,
} from '../src/internal/capture/inspect-on-failure.js';
import { resolveOptions, applyOptionsToEnv, PIWI_ENV_KEYS } from '../src/internal/config/env.js';

/** Every variable `detectCi` reads, so a case sees only the ones it sets, whatever CI runs the suite. */
const CI_KEYS = [
  'CI',
  'JENKINS_URL',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'TF_BUILD',
  'BITBUCKET_BUILD_NUMBER',
  'TEAMCITY_VERSION',
  'CODEBUILD_BUILD_ID',
  'bamboo_buildKey',
];

/** A gate that passes every check — each test flips exactly one field. */
function openGate(overrides: Partial<InspectionGate> = {}): InspectionGate {
  return {
    enabled: 'true',
    ci: false,
    status: 'failed',
    expectedStatus: 'passed',
    headless: false,
    retry: 0,
    retries: 0,
    ...overrides,
  };
}

describe('shouldInspectOnFailure', () => {
  it('opens for a headed local failure when enabled', () => {
    expect(shouldInspectOnFailure(openGate())).toBe(true);
  });

  it('opens for a timed-out test', () => {
    expect(shouldInspectOnFailure(openGate({ status: 'timedOut' }))).toBe(true);
  });

  it('stays closed unless the flag is exactly "true"', () => {
    expect(shouldInspectOnFailure(openGate({ enabled: undefined }))).toBe(false);
    expect(shouldInspectOnFailure(openGate({ enabled: 'false' }))).toBe(false);
    expect(shouldInspectOnFailure(openGate({ enabled: '1' }))).toBe(false);
  });

  it('never opens under CI, even when enabled', () => {
    expect(shouldInspectOnFailure(openGate({ ci: true }))).toBe(false);
  });

  it('reads CI as detectCi does: a provider that sets no CI counts, CI=0 or false does not', () => {
    const testInfo = { status: 'failed', expectedStatus: 'passed', retry: 0, project: { use: { headless: false } } };
    const gateWith = (env: Record<string, string>) => {
      for (const key of CI_KEYS) vi.stubEnv(key, env[key] ?? '');
      return inspectionGateFromTestInfo(testInfo as never, 'true');
    };
    try {
      expect(gateWith({ JENKINS_URL: 'https://jenkins.example' }).ci).toBe(true);
      expect(gateWith({ TEAMCITY_VERSION: '2025.03' }).ci).toBe(true);
      expect(gateWith({ CI: '1' }).ci).toBe(true);
      expect(gateWith({ CI: '0' }).ci).toBe(false);
      expect(gateWith({ CI: 'false' }).ci).toBe(false);
      expect(shouldInspectOnFailure(gateWith({}))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('requires an explicitly headed browser', () => {
    expect(shouldInspectOnFailure(openGate({ headless: true }))).toBe(false);
    // Unset headless means Playwright's default (headless) — stays closed.
    expect(shouldInspectOnFailure(openGate({ headless: undefined }))).toBe(false);
  });

  it('only opens for failed/timedOut outcomes', () => {
    expect(shouldInspectOnFailure(openGate({ status: 'passed' }))).toBe(false);
    expect(shouldInspectOnFailure(openGate({ status: 'skipped' }))).toBe(false);
    expect(shouldInspectOnFailure(openGate({ status: 'interrupted' }))).toBe(false);
    expect(shouldInspectOnFailure(openGate({ status: undefined }))).toBe(false);
  });

  it('skips an expected failure (test.fail())', () => {
    expect(shouldInspectOnFailure(openGate({ expectedStatus: 'failed' }))).toBe(false);
  });

  it('waits for the final attempt when retries are configured', () => {
    expect(shouldInspectOnFailure(openGate({ retry: 0, retries: 2 }))).toBe(false);
    expect(shouldInspectOnFailure(openGate({ retry: 1, retries: 2 }))).toBe(false);
    expect(shouldInspectOnFailure(openGate({ retry: 2, retries: 2 }))).toBe(true);
  });
});

describe('environmentalSkipReason', () => {
  it('is null when the feature is off (nothing was opted into)', () => {
    expect(environmentalSkipReason(openGate({ enabled: undefined, headless: true }))).toBeNull();
  });

  it('is null when the run would actually pass the gate (the feature ran)', () => {
    expect(environmentalSkipReason(openGate())).toBeNull();
  });

  it('is null for a non-failure or an expected failure', () => {
    expect(environmentalSkipReason(openGate({ status: 'passed', headless: true }))).toBeNull();
    expect(environmentalSkipReason(openGate({ expectedStatus: 'failed', headless: true }))).toBeNull();
  });

  it('explains a headless skip when enabled on a real failure', () => {
    const reason = environmentalSkipReason(openGate({ headless: true }));
    expect(reason).toMatch(/headless/);
    expect(environmentalSkipReason(openGate({ headless: undefined }))).toMatch(/headless/);
  });

  it('explains a CI skip, and CI wins over headless', () => {
    expect(environmentalSkipReason(openGate({ ci: true }))).toMatch(/CI/);
    expect(environmentalSkipReason(openGate({ ci: true, headless: true }))).toMatch(/CI/);
  });

  it('stays silent when the only reason to skip is a pending retry', () => {
    // The final attempt will produce the message; a mid-retry skip is expected.
    expect(environmentalSkipReason(openGate({ retry: 0, retries: 2 }))).toBeNull();
  });
});

describe('inspectOnFailure option plumbing', () => {
  it('reads PIWI_INSPECT_ON_FAIL as a boolean fallback', () => {
    const saved = process.env.PIWI_INSPECT_ON_FAIL;
    try {
      process.env.PIWI_INSPECT_ON_FAIL = 'true';
      expect(resolveOptions({}).inspectOnFailure).toBe(true);
      process.env.PIWI_INSPECT_ON_FAIL = 'false';
      expect(resolveOptions({}).inspectOnFailure).toBe(false);
      expect(resolveOptions({ inspectOnFailure: true }).inspectOnFailure).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.PIWI_INSPECT_ON_FAIL;
      else process.env.PIWI_INSPECT_ON_FAIL = saved;
    }
  });

  it('bridges the option into the worker env', () => {
    const saved = process.env.PIWI_INSPECT_ON_FAIL;
    try {
      delete process.env.PIWI_INSPECT_ON_FAIL;
      applyOptionsToEnv({ inspectOnFailure: true });
      expect(process.env[PIWI_ENV_KEYS.inspectOnFailure]).toBe('true');
      applyOptionsToEnv({ inspectOnFailure: false });
      expect(process.env[PIWI_ENV_KEYS.inspectOnFailure]).toBe('false');
      // Unset option leaves the env untouched (default-off lives in the gate).
      delete process.env.PIWI_INSPECT_ON_FAIL;
      applyOptionsToEnv({});
      expect(process.env[PIWI_ENV_KEYS.inspectOnFailure]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PIWI_INSPECT_ON_FAIL;
      else process.env.PIWI_INSPECT_ON_FAIL = saved;
    }
  });
});
