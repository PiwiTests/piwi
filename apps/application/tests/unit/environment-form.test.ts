import { describe, expect, test } from 'vitest';
import {
  environmentDraft,
  environmentDraftBody,
  environmentDraftHasProblem,
  environmentDraftProblems,
  environmentMoves,
  type EnvironmentDraft,
} from '../../app/utils/environment-form';
import type { EnvironmentRecord } from '../../shared/environments';

function environment(id: number, key: string, extra: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id,
    key,
    name: key,
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

function draft(extra: Partial<EnvironmentDraft> = {}): EnvironmentDraft {
  return { ...environmentDraft(null), key: 'staging', name: 'Staging', ...extra };
}

describe('environmentDraft', () => {
  test('copies an environment into its form, and starts a new one empty', () => {
    const record = environment(1, 'staging', {
      name: 'Staging',
      description: 'Reset nightly',
      aliases: ['stg'],
      runVariables: [{ name: 'TEST_ENV', value: 'staging' }],
      envFile: '.env.staging',
    });
    expect(environmentDraft(record)).toEqual({
      key: 'staging',
      name: 'Staging',
      description: 'Reset nightly',
      aliases: ['stg'],
      runVariables: [{ name: 'TEST_ENV', value: 'staging' }],
      appFromCheckout: false,
      protected: false,
      requiredTags: [],
      envFile: '.env.staging',
    });
    expect(environmentDraft(null).key).toBe('');
    expect(environmentDraft(null).runVariables).toEqual([]);
  });
});

describe('environmentDraftProblems', () => {
  test('passes a whole environment', () => {
    const problems = environmentDraftProblems(
      draft({
        aliases: ['stg', 'pr-*'],
        runVariables: [{ name: 'TEST_ENV', value: 'staging' }],
        protected: true,
        requiredTags: ['@smoke'],
        envFile: '.env.staging',
      }),
    );
    expect(environmentDraftHasProblem(problems)).toBe(false);
  });

  test('names the field each rule refuses', () => {
    const problems = environmentDraftProblems(
      draft({
        key: 'stag$ing',
        name: '',
        aliases: ['*'],
        runVariables: [
          { name: 'PIWI_ENVIRONMENT', value: 'x' },
          { name: 'TEST_ENV', value: 'a' },
          { name: 'TEST_ENV', value: 'b' },
          { name: '', value: '' },
        ],
        envFile: 'config/.env',
      }),
    );
    expect(problems.key).toMatch(/not an environment key/);
    expect(problems.name).toMatch(/needs a name/);
    expect(problems.aliases).toMatch(/more than \*/);
    expect(problems.runVariables[0]).toBeTruthy();
    expect(problems.runVariables[1]).toBeUndefined();
    expect(problems.runVariables[2]).toBe('TEST_ENV is set twice.');
    expect(problems.runVariables[3]).toBeUndefined();
    expect(problems.envFile).toMatch(/not an env file name/);
    expect(environmentDraftHasProblem(problems)).toBe(true);
  });

  test('asks a protected environment for a required tag, and checks each tag', () => {
    expect(environmentDraftProblems(draft({ protected: true })).requiredTags).toMatch(/needs a required tag/);
    expect(environmentDraftProblems(draft({ protected: true, requiredTags: ['smoke'] })).requiredTags).toMatch(
      /not a tag/,
    );
    expect(environmentDraftProblems(draft({ protected: false })).requiredTags).toBeUndefined();
  });

  test('refuses a key or an alias another environment names, ignoring case', () => {
    const others = [environment(1, 'production', { aliases: ['prod'] })];
    expect(environmentDraftProblems(draft({ key: 'Production' }), others).list).toMatch(/names two environments/);
    expect(environmentDraftProblems(draft({ aliases: ['PROD'] }), others).list).toMatch(/names two environments/);
    expect(environmentDraftProblems(draft(), others).list).toBeUndefined();
  });

  test('lets a declared environment take over a discovered one it names', () => {
    const others = [environment(1, 'stg', { discovered: true })];
    expect(environmentDraftProblems(draft({ aliases: ['stg'] }), others).list).toBeUndefined();
    expect(environmentDraftProblems(draft({ key: 'stg' }), others).list).toBeUndefined();
  });
});

describe('environmentDraftBody', () => {
  test('trims each text, drops empty rows and repeats, and sends none for an empty description or env file', () => {
    expect(
      environmentDraftBody(
        draft({
          key: ' staging ',
          name: ' Staging ',
          description: '  ',
          aliases: ['stg', ' stg ', ''],
          runVariables: [
            { name: ' TEST_ENV ', value: 'staging' },
            { name: '', value: '' },
          ],
          requiredTags: ['@smoke', '@smoke'],
          envFile: ' ',
        }),
      ),
    ).toEqual({
      key: 'staging',
      name: 'Staging',
      description: null,
      aliases: ['stg'],
      runVariables: [{ name: 'TEST_ENV', value: 'staging' }],
      appFromCheckout: false,
      protected: false,
      requiredTags: ['@smoke'],
      envFile: null,
    });
  });
});

describe('environmentMoves', () => {
  const list = [
    { id: 1, position: 0 },
    { id: 2, position: 1 },
    { id: 3, position: 5 },
  ];

  test('swaps positions with the neighbor', () => {
    expect(environmentMoves(list, 3, -1)).toEqual([
      { id: 3, position: 1 },
      { id: 2, position: 5 },
    ]);
    expect(environmentMoves(list, 1, 1)).toEqual([
      { id: 1, position: 1 },
      { id: 2, position: 0 },
    ]);
  });

  test('moves nothing past either end, or for an id not listed', () => {
    expect(environmentMoves(list, 1, -1)).toEqual([]);
    expect(environmentMoves(list, 3, 1)).toEqual([]);
    expect(environmentMoves(list, 9, 1)).toEqual([]);
  });

  test('numbers the list again when the two share a position', () => {
    const tied = [
      { id: 1, position: 0 },
      { id: 2, position: 0 },
      { id: 3, position: 0 },
    ];
    expect(environmentMoves(tied, 3, -1)).toEqual([
      { id: 3, position: 1 },
      { id: 2, position: 2 },
    ]);
  });
});
