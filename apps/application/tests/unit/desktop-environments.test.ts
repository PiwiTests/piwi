import { describe, expect, test } from 'vitest';
import {
  builtFromCheckoutChoice,
  envFileMissing,
  environmentMismatch,
  environmentReady,
  lastPickFor,
  mostCarriedChoice,
  pickOf,
  runEnvironmentChoice,
  samePick,
  withLastPick,
  type DesktopEnvironmentChoice,
} from '#shared/desktop-environments';
import { localRunDetail, localRunEnvironmentNote } from '../../app/composables/useDesktopLocalRuns';

function choice(over: Partial<DesktopEnvironmentChoice> & { id: number; key: string }): DesktopEnvironmentChoice {
  return {
    name: over.key[0]!.toUpperCase() + over.key.slice(1),
    protected: false,
    requiredTags: [],
    envFile: null,
    team: false,
    aliases: [],
    appFromCheckout: false,
    ...over,
  };
}

const local = choice({ id: 1, key: 'local', appFromCheckout: true });
const staging = choice({ id: 2, key: 'staging', envFile: '.env.staging', aliases: ['stg'] });
const production = choice({ id: 3, key: 'production', protected: true, requiredTags: ['@smoke'] });
const teamStaging = choice({ id: 2, key: 'staging', team: true, aliases: ['stg', 'pr-*'] });
const teamPreview = choice({ id: 7, key: 'preview', team: true, appFromCheckout: true });
const choices = [local, staging, production, teamStaging, teamPreview];

describe('where an environment picker of the desktop app starts', () => {
  test('a re-run and Reproduce start on the run’s environment, unless protected', () => {
    expect(runEnvironmentChoice(choices, 2)).toBe(staging);
    expect(runEnvironmentChoice(choices, 3)).toBeNull();
    expect(runEnvironmentChoice(choices, null)).toBeNull();
    expect(runEnvironmentChoice(choices, 99)).toBeNull();
  });

  test('Bisect starts on one built from the checkout, the project’s first', () => {
    expect(builtFromCheckoutChoice(choices)).toBe(local);
    expect(builtFromCheckoutChoice([staging, teamPreview])).toBe(teamPreview);
    expect(builtFromCheckoutChoice([staging, production])).toBeNull();
  });

  test('Flake Lab starts on the environment the test’s runs carry most, unless protected', () => {
    expect(mostCarriedChoice(choices, [2, 1, 2, null, null, null])).toBe(staging);
    expect(mostCarriedChoice(choices, [3, 3, 2])).toBeNull();
    expect(mostCarriedChoice(choices, [])).toBeNull();
  });

  test('Run with options starts on the last one picked for the folder', () => {
    let stored: unknown = null;
    expect(lastPickFor(stored, '/repo')).toBeUndefined();
    stored = withLastPick(stored, '/repo', pickOf(teamStaging));
    stored = withLastPick(stored, '/other', null);
    expect(lastPickFor(stored, '/repo')).toEqual({ id: 2, team: true });
    expect(lastPickFor(stored, '/other')).toBeNull();
    expect(lastPickFor({ '/repo': { id: 'x' } }, '/repo')).toBeUndefined();
    expect(lastPickFor('garbage', '/repo')).toBeUndefined();
    expect(samePick(lastPickFor(stored, '/repo'), teamStaging)).toBe(true);
    expect(samePick(lastPickFor(stored, '/repo'), staging)).toBe(false);
  });
});

describe('what a picked environment asks', () => {
  test('a protected one runs only once confirmed', () => {
    expect(environmentReady(null, false)).toBe(true);
    expect(environmentReady(staging, false)).toBe(true);
    expect(environmentReady(production, false)).toBe(false);
    expect(environmentReady(production, true)).toBe(true);
  });

  test('an env file the linked folder lacks is said', () => {
    expect(envFileMissing(staging, ['.env'])).toBe(true);
    expect(envFileMissing(staging, ['.env.staging'])).toBe(false);
    expect(envFileMissing(local, [])).toBe(false);
    expect(envFileMissing(staging, null)).toBe(false);
  });
});

describe('the run’s line in the Local runs tray', () => {
  const run = {
    projectLabel: 'Shop',
    projectId: '4',
    steps: [{ args: ['tests/cart.spec.ts:3'], display: 'npx playwright test tests/cart.spec.ts:3' }],
    stepIndex: 0,
    runVariables: [{ name: 'TEST_ENV', value: 'staging' }],
  };

  test('names the environment and shows the command the shell runs', () => {
    expect(localRunDetail({ ...run, environment: staging })).toBe(
      'Shop · Staging · TEST_ENV=staging PIWI_ENVIRONMENT=staging npx playwright test tests/cart.spec.ts:3',
    );
    expect(localRunDetail({ ...run, environment: production, runVariables: [] })).toBe(
      "Shop · Production · PIWI_ENVIRONMENT=production npx playwright test tests/cart.spec.ts:3 --grep-invert '^(?!.*(?:^|\\s)(?:@smoke)(?:\\s|$))'",
    );
    expect(localRunDetail({ ...run, environment: null })).toBe(
      'Shop · TEST_ENV=staging npx playwright test tests/cart.spec.ts:3',
    );
  });

  test('says when the config reported another environment than the one the run was started for', () => {
    expect(localRunEnvironmentNote({ environment: staging, reported: { label: 'production', environmentId: 3 } })).toBe(
      'Started for Staging; the config reported production',
    );
    expect(localRunEnvironmentNote({ environment: staging, reported: { label: 'stg', environmentId: 2 } })).toBeNull();
    expect(localRunEnvironmentNote({ environment: staging, reported: null })).toBeNull();
    expect(localRunEnvironmentNote({ environment: null, reported: { label: 'x', environmentId: null } })).toBeNull();
    expect(environmentMismatch(teamStaging, { label: 'PR-12', environmentId: null })).toBeNull();
    expect(environmentMismatch(teamStaging, { label: 'local', environmentId: 1 })).toBe(
      'Started for Staging; the config reported local',
    );
  });
});
