import { describe, expect, test } from 'vitest';
import {
  DEFAULT_RUN_NAME_TEMPLATE,
  emptyTestManagementBinding,
  MAX_STATUS_NAME_LENGTH,
  resolveTestManagementBinding,
  statusNameTooLong,
  validateRunNameTemplate,
} from '#shared/integrations/test-management-binding';
import { folderOptions } from '#shared/integrations/test-management-picker';

describe('resolveTestManagementBinding', () => {
  test('a binding with nothing but a connection and a project takes the safe defaults', () => {
    expect(resolveTestManagementBinding({ connectionId: 3, providerProjectKey: 'SHOP' })).toEqual({
      connectionId: 3,
      providerProjectKey: 'SHOP',
      enabled: true,
      dryRun: true,
      keySources: { tags: true, externalId: false },
      runScope: expect.objectContaining({ defaultBranch: true }),
      runPolicy: { mode: 'per-run', nameTemplate: DEFAULT_RUN_NAME_TEMPLATE },
      statuses: { pass: 'Pass', fail: 'Fail', flaky: null, notExecuted: 'Not Executed' },
      options: { flakyAs: 'pass', skippedAs: null, includeError: false, includeComment: true },
    });
  });

  test('an empty or hostile payload resolves to the unbound defaults', () => {
    for (const input of [
      undefined,
      null,
      'x',
      7,
      [],
      { connectionId: 'a' },
      { connectionId: -1 },
      { connectionId: 1.5 },
    ]) {
      expect(resolveTestManagementBinding(input)).toMatchObject({ connectionId: null, dryRun: true, enabled: true });
    }
    expect(emptyTestManagementBinding().providerProjectKey).toBeNull();
  });

  test('keeps what a person set and clamps what they could not', () => {
    const binding = resolveTestManagementBinding({
      connectionId: 2,
      providerProjectKey: ' SHOP ',
      enabled: false,
      dryRun: false,
      keySources: { tags: false, externalId: true },
      runPolicy: { nameTemplate: 'Nightly #{runId}', folderId: ' 40001 ', version: '4.2' },
      statuses: { pass: ' Passed ', flaky: 'Unstable' },
      options: { flakyAs: 'flaky', skippedAs: 'notExecuted', includeError: true, includeComment: false },
    });
    expect(binding).toMatchObject({
      providerProjectKey: 'SHOP',
      enabled: false,
      dryRun: false,
      keySources: { tags: false, externalId: true },
      runPolicy: { nameTemplate: 'Nightly #{runId}', folderId: '40001', version: '4.2' },
      statuses: { pass: 'Passed', fail: 'Fail', flaky: 'Unstable', notExecuted: 'Not Executed' },
      options: { flakyAs: 'flaky', skippedAs: 'notExecuted', includeError: true, includeComment: false },
    });
  });

  test('a template that fails the check, and an unknown option value, fall back to the defaults', () => {
    const binding = resolveTestManagementBinding({
      runPolicy: { nameTemplate: 'no id here' },
      options: { flakyAs: 'maybe', skippedAs: 'pass' },
    });
    expect(binding.runPolicy.nameTemplate).toBe(DEFAULT_RUN_NAME_TEMPLATE);
    expect(binding.options).toMatchObject({ flakyAs: 'pass', skippedAs: null });
  });

  test('an explicit run scope is kept and a missing one is the default branch', () => {
    expect(resolveTestManagementBinding({}).runScope.defaultBranch).toBe(true);
    expect(resolveTestManagementBinding({ runScope: { defaultBranch: false } }).runScope.defaultBranch).toBe(false);
  });

  test('a status name is cut at the tool’s limit', () => {
    const long = 'x'.repeat(MAX_STATUS_NAME_LENGTH + 5);
    expect(statusNameTooLong(long)).toBe(true);
    expect(statusNameTooLong('Pass')).toBe(false);
    expect(resolveTestManagementBinding({ statuses: { pass: long } }).statuses.pass).toHaveLength(
      MAX_STATUS_NAME_LENGTH,
    );
  });
});

describe('validateRunNameTemplate', () => {
  test('accepts the default and a name with several variables', () => {
    expect(validateRunNameTemplate(DEFAULT_RUN_NAME_TEMPLATE)).toEqual({ ok: true });
    expect(validateRunNameTemplate('{branch} {commit} {date} {ciBuild} {environment} {runId}')).toEqual({ ok: true });
  });

  test.each([
    ['', 'Enter a name'],
    ['   ', 'Enter a name'],
    ['Nightly', '{runId}'],
    ['Nightly {run}', '{run} is not a variable'],
    ['Nightly {runId', '{runId}'],
    ['Nightly {runId} }', 'brace'],
    ['x'.repeat(201) + '{runId}', '200 characters'],
  ])('refuses %j', (template, message) => {
    const check = validateRunNameTemplate(template);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain(message);
  });
});

describe('folderOptions', () => {
  test('names each folder with its parents and sorts by path', () => {
    expect(
      folderOptions([
        { id: '2', name: 'Release 4.2', parentId: '1' },
        { id: '1', name: 'Nightly', parentId: null },
        { id: '3', name: 'Orphan', parentId: '99' },
      ]),
    ).toEqual([
      { id: '1', path: 'Nightly' },
      { id: '2', path: 'Nightly / Release 4.2' },
      { id: '3', path: 'Orphan' },
    ]);
  });

  test('stops at a loop in a malformed answer', () => {
    const options = folderOptions([
      { id: '1', name: 'A', parentId: '2' },
      { id: '2', name: 'B', parentId: '1' },
    ]);
    expect(options).toHaveLength(2);
  });
});
