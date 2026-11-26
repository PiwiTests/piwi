import { describe, expect, test } from 'vitest';
import {
  ENVIRONMENT_LIMITS,
  envFileProblem,
  environmentAliasProblem,
  environmentKeyProblem,
  environmentListProblems,
  environmentMatchesPattern,
  normalizeEnvironmentLabel,
  parseEnvironmentForRun,
  requiredTagProblem,
  requiredTagsGrepInvert,
  requiredTagsGrepInvertProblem,
  resolveEnvironment,
} from '../src/environments';
import { RUN_VARIABLE_LIMITS, mergeRunVariables, parseRunVariables } from '../src/run-variables';

const environments = [
  { id: 1, key: 'local', aliases: ['development'], position: 0 },
  { id: 2, key: 'staging', aliases: ['stg', 'staging-*'], position: 2 },
  { id: 3, key: 'Preview', aliases: ['pr-*'], position: 1 },
  { id: 4, key: 'production', aliases: [], position: 3 },
];

describe('normalizeEnvironmentLabel', () => {
  test('trims, cuts and reads empty text as none', () => {
    expect(normalizeEnvironmentLabel('  staging ')).toBe('staging');
    expect(normalizeEnvironmentLabel('   ')).toBeNull();
    expect(normalizeEnvironmentLabel(null)).toBeNull();
    expect(normalizeEnvironmentLabel(42)).toBeNull();
    expect(normalizeEnvironmentLabel('x'.repeat(300))).toHaveLength(ENVIRONMENT_LIMITS.labelChars);
  });
});

describe('resolveEnvironment', () => {
  test.each([
    ['staging', 2],
    ['Staging ', 2],
    ['STG', 2],
    ['staging-eu', 2],
    ['pr-123', 3],
    ['preview', 3],
    ['development', 1],
    ['qa', null],
    ['', null],
    [null, null],
  ])('resolves %j to %j', (label, id) => {
    expect(resolveEnvironment(label, environments)).toBe(id);
  });

  test('takes a key before an alias, and the first pattern in position order', () => {
    const list = [
      { id: 1, key: 'a', aliases: ['b'], position: 0 },
      { id: 2, key: 'b', aliases: [], position: 1 },
      { id: 3, key: 'c', aliases: ['x-*'], position: 3 },
      { id: 4, key: 'd', aliases: ['x-*'], position: 2 },
    ];
    expect(resolveEnvironment('b', list)).toBe(2);
    expect(resolveEnvironment('x-1', list)).toBe(4);
  });
});

describe('environmentMatchesPattern', () => {
  test('matches a key or an exact alias, ignoring case, and patterns over them', () => {
    const staging = environments[1]!;
    expect(environmentMatchesPattern(staging, 'Staging')).toBe(true);
    expect(environmentMatchesPattern(staging, 'stg')).toBe(true);
    expect(environmentMatchesPattern(staging, 'stag*')).toBe(true);
    expect(environmentMatchesPattern(staging, 'prod*')).toBe(false);
  });
});

describe('the field rules', () => {
  test.each(['staging', 'eu west 1', 'https://staging.example.com', 'prod/eu'])('takes the key %j', (key) => {
    expect(environmentKeyProblem(key)).toBeNull();
  });

  test.each(['', ' staging', 'stag$ing', "it's", 'x'.repeat(81), '//share', 'a\nb'])('refuses the key %j', (key) => {
    expect(environmentKeyProblem(key)).not.toBeNull();
  });

  test('takes aliases with * and refuses one that takes every label', () => {
    expect(environmentAliasProblem('pr-*')).toBeNull();
    expect(environmentAliasProblem('*')).not.toBeNull();
    expect(environmentAliasProblem('a$*')).not.toBeNull();
  });

  test.each([
    ['@smoke', true],
    ['@read-only_2', true],
    ['smoke', false],
    ['@', false],
    ['@a b', false],
    ['@a|b', false],
    ['@a.b', false],
  ])('the tag %j passes: %j', (tag, ok) => {
    expect(requiredTagProblem(tag) === null).toBe(ok);
  });

  test.each([
    ['.env', true],
    ['.env.staging', true],
    ['.env.eu-west.local', true],
    ['env.staging', false],
    ['.env/../x', false],
    ['.env..x', false],
    ['../.env', false],
    ['.env.staging\\x', false],
  ])('the env file %j passes: %j', (name, ok) => {
    expect(envFileProblem(name) === null).toBe(ok);
  });
});

describe('environmentListProblems', () => {
  test('finds a key or exact alias that names two environments', () => {
    expect(environmentListProblems(environments)).toEqual([]);
    expect(
      environmentListProblems([
        { key: 'staging', aliases: [] },
        { key: 'Staging', aliases: [] },
      ]),
    ).toHaveLength(1);
    expect(
      environmentListProblems([
        { key: 'staging', aliases: ['stg'] },
        { key: 'qa', aliases: ['STG'] },
      ]),
    ).toHaveLength(1);
    expect(environmentListProblems([{ key: 'staging', aliases: ['Staging'] }])).toHaveLength(1);
    expect(
      environmentListProblems([
        { key: 'a', aliases: ['x-*'] },
        { key: 'b', aliases: ['x-*'] },
      ]),
    ).toEqual([]);
  });
});

describe('requiredTagsGrepInvert', () => {
  const matches = (pattern: string, text: string) => new RegExp(pattern, 'gi').test(text);

  test('leaves out the tests that carry none of the tags', () => {
    const pattern = requiredTagsGrepInvert(['@smoke', '@readonly']);
    expect(matches(pattern, 'checkout pays @slow')).toBe(true);
    expect(matches(pattern, 'checkout pays @smoke')).toBe(false);
    expect(matches(pattern, 'cart @readonly @slow')).toBe(false);
    expect(matches(pattern, '@smoke-extended checkout')).toBe(true);
    expect(matches(pattern, 'login @SMOKE')).toBe(false);
  });

  test('keeps the run own pattern beside it', () => {
    const pattern = requiredTagsGrepInvert(['@smoke'], 'flaky');
    expect(matches(pattern, 'a flaky test @smoke')).toBe(true);
    expect(matches(pattern, 'a test @smoke')).toBe(false);
    expect(matches(pattern, 'a test')).toBe(true);
  });

  test('keeps an own pattern written /source/flags with i as its source, and refuses one without i', () => {
    const required = requiredTagsGrepInvert(['@smoke']);
    for (const [own, kept] of [
      ['/slow/i', 'slow'],
      ['/slow/gi', 'slow'],
      ['/a/b/ig', 'a/b'],
      ['//i', ''],
      ['/slow/m', '/slow/m'],
      ['/slow', '/slow'],
      ['/a\u2028b/i', '/a\u2028b/i'],
    ] as const) {
      expect(requiredTagsGrepInvertProblem(own), own).toBeNull();
      expect(requiredTagsGrepInvert(['@smoke'], own), own).toBe(`(?:${kept})|${required}`);
    }
    expect(matches(requiredTagsGrepInvert(['@smoke'], '/Slow/i'), 'a slow test @smoke')).toBe(true);
    expect(requiredTagsGrepInvert(['@smoke'], '')).toBe(required);
    expect(requiredTagsGrepInvertProblem('/Slow/')).toBe(
      "-G /Slow/ matches letters in their case, which a protected environment's run cannot keep: it reads -G ignoring case, as -G /Slow/i does",
    );
    for (const own of ['/slow/g', '/x/i/']) {
      expect(requiredTagsGrepInvertProblem(own, '--grep-invert'), own).toMatch(/^--grep-invert .* matches letters/);
      expect(() => requiredTagsGrepInvert(['@smoke'], own), own).toThrow(/matches letters in their case/);
    }
  });
});

describe('parseEnvironmentForRun', () => {
  const staging = {
    id: 2,
    key: 'staging',
    name: 'Staging',
    protected: false,
    requiredTags: [],
    envFile: '.env.staging',
  };

  test('reads none and a whole environment', () => {
    expect(parseEnvironmentForRun(null)).toEqual({ ok: true, value: null });
    expect(parseEnvironmentForRun(staging)).toEqual({ ok: true, value: staging });
  });

  test('refuses a protected environment with no tag, a path, and a key a variable cannot hold', () => {
    expect(parseEnvironmentForRun({ ...staging, protected: true }).ok).toBe(false);
    expect(parseEnvironmentForRun({ ...staging, envFile: '../.env' }).ok).toBe(false);
    expect(parseEnvironmentForRun({ ...staging, key: 'a$b' }).ok).toBe(false);
    expect(parseEnvironmentForRun({ ...staging, requiredTags: ['smoke'] }).ok).toBe(false);
    expect(parseEnvironmentForRun({ ...staging, protected: 'yes' }).ok).toBe(false);
  });
});

describe('mergeRunVariables', () => {
  test('takes the environment value for a name both set, then its own names', () => {
    const merged = mergeRunVariables(
      [
        { name: 'TENANT', value: 'acme' },
        { name: 'TEST_ENV', value: 'local' },
      ],
      [
        { name: 'TEST_ENV', value: 'staging' },
        { name: 'BASE_URL', value: 'https://staging.example.com' },
      ],
    );
    expect(merged).toEqual([
      { name: 'TENANT', value: 'acme' },
      { name: 'TEST_ENV', value: 'staging' },
      { name: 'BASE_URL', value: 'https://staging.example.com' },
    ]);
    expect(parseRunVariables(merged, RUN_VARIABLE_LIMITS.merged).ok).toBe(true);
  });
});
