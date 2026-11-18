import { describe, expect, test } from 'vitest';
import {
  NO_ENVIRONMENT_LABEL,
  commandEnvironmentDefault,
  commandEnvironmentOf,
  environmentFilterItems,
  environmentFilterLabel,
} from '../../app/utils/environment-filter';
import { filterBarSummary } from '../../app/utils/filter-summary';
import { NO_ENVIRONMENT_FILTER, type EnvironmentRecord } from '../../shared/environments';

function environment(id: number, key: string, name: string, extra: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id,
    key,
    name,
    description: null,
    aliases: [],
    runVariables: [],
    appFromCheckout: false,
    protected: false,
    requiredTags: [],
    envFile: null,
    position: id,
    discovered: false,
    archived: false,
    ...extra,
  };
}

const LOCAL = environment(1, 'local', 'Local');
const STAGING = environment(2, 'staging', 'Staging', { aliases: ['stg', 'pr-*'] });
const PRODUCTION = environment(3, 'production', 'Production', { protected: true, requiredTags: ['@smoke'] });
const OLD = environment(4, 'qa', 'QA', { archived: true });

describe('environmentFilterItems', () => {
  test('offers the environments in position order by key with their name, then No environment', () => {
    const items = environmentFilterItems({ environments: [PRODUCTION, STAGING, LOCAL] });
    expect(items).toEqual([
      { label: 'Local', value: 'local' },
      { label: 'Staging', value: 'staging' },
      { label: 'Production', value: 'production' },
      { label: NO_ENVIRONMENT_LABEL, value: NO_ENVIRONMENT_FILTER },
    ]);
  });

  test('leaves archived environments out unless the filter holds one, shown by its name', () => {
    expect(environmentFilterItems({ environments: [LOCAL, OLD] }).map((item) => item.value)).toEqual([
      'local',
      NO_ENVIRONMENT_FILTER,
    ]);
    expect(environmentFilterItems({ environments: [LOCAL, OLD], selected: ['QA'] })).toContainEqual({
      label: 'QA',
      value: 'QA',
    });
  });

  test('adds the labels of recent runs no environment takes, once each, ignoring case', () => {
    const items = environmentFilterItems({
      environments: [LOCAL, STAGING],
      labels: ['Staging', 'stg', 'pr-12', 'perf', 'Perf', null, ' ', 'local'],
    });
    expect(items.map((item) => item.value)).toEqual(['local', 'staging', 'perf', NO_ENVIRONMENT_FILTER]);
  });

  test('reads the labels alone while the project has no environment, as before it had any', () => {
    expect(environmentFilterItems({ environments: [], labels: ['staging', 'dev'] })).toEqual([
      { label: 'dev', value: 'dev' },
      { label: 'staging', value: 'staging' },
      { label: NO_ENVIRONMENT_LABEL, value: NO_ENVIRONMENT_FILTER },
    ]);
  });

  test('keeps a stored value nothing offers, and offers nothing for a project with no runs', () => {
    expect(environmentFilterItems({ environments: [] })).toEqual([]);
    expect(environmentFilterItems({ environments: [], selected: ['gone'] })).toEqual([
      { label: 'gone', value: 'gone' },
      { label: NO_ENVIRONMENT_LABEL, value: NO_ENVIRONMENT_FILTER },
    ]);
    expect(environmentFilterItems({ environments: [], selected: [NO_ENVIRONMENT_FILTER] })).toEqual([
      { label: NO_ENVIRONMENT_LABEL, value: NO_ENVIRONMENT_FILTER },
    ]);
  });

  test('takes a stored value equal to a key in another case as that key', () => {
    const items = environmentFilterItems({ environments: [STAGING], selected: ['STAGING'] });
    expect(items.map((item) => item.value)).toEqual(['staging', NO_ENVIRONMENT_FILTER]);
  });
});

describe('environmentFilterLabel', () => {
  test('names a key by its environment, No environment by its words, anything else as it is', () => {
    expect(environmentFilterLabel('Staging', [STAGING])).toBe('Staging');
    expect(environmentFilterLabel('production', [STAGING, PRODUCTION])).toBe('Production');
    expect(environmentFilterLabel(NO_ENVIRONMENT_FILTER, [])).toBe(NO_ENVIRONMENT_LABEL);
    expect(environmentFilterLabel('perf', [STAGING])).toBe('perf');
  });

  test('lets the folded filter summary name the environments', () => {
    const state = { environments: ['staging'], branches: [], fullRunsOnly: true, allBranches: false };
    expect(filterBarSummary(state, { environmentLabel: (value) => environmentFilterLabel(value, [STAGING]) })).toBe(
      'Staging · all branches · full runs only',
    );
  });
});

describe('commandEnvironmentDefault', () => {
  test('starts on the shown run’s environment, never a protected or archived one', () => {
    expect(commandEnvironmentDefault(STAGING)).toBe(STAGING.id);
    expect(commandEnvironmentDefault(PRODUCTION)).toBeNull();
    expect(commandEnvironmentDefault(OLD)).toBeNull();
    expect(commandEnvironmentDefault(null)).toBeNull();
    expect(commandEnvironmentDefault(undefined)).toBeNull();
  });
});

describe('commandEnvironmentOf', () => {
  const active = [LOCAL, STAGING, PRODUCTION];

  test('reads the pick while it is offered, None as none, and the start before any pick', () => {
    expect(commandEnvironmentOf({ picked: STAGING.id, active, shown: LOCAL })).toBe(STAGING.id);
    expect(commandEnvironmentOf({ picked: null, active, shown: LOCAL })).toBeNull();
    expect(commandEnvironmentOf({ picked: undefined, active, shown: LOCAL })).toBe(LOCAL.id);
  });

  test('falls back to the start when the pick was archived or deleted', () => {
    expect(commandEnvironmentOf({ picked: OLD.id, active, shown: LOCAL })).toBe(LOCAL.id);
    expect(commandEnvironmentOf({ picked: 99, active, shown: null })).toBeNull();
  });

  test('reads a protected pick as none for a command that cannot keep to its tags', () => {
    expect(commandEnvironmentOf({ picked: PRODUCTION.id, active, shown: null })).toBe(PRODUCTION.id);
    expect(commandEnvironmentOf({ picked: PRODUCTION.id, active, shown: null, protectedAllowed: false })).toBeNull();
  });
});
