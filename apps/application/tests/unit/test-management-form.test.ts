import { describe, expect, test } from 'vitest';
import { emptyTestManagementBinding, resolveTestManagementBinding } from '#shared/integrations/test-management-binding';
import {
  hasTestManagementProblem,
  testManagementFromForm,
  testManagementProblems,
  testManagementToForm,
} from '~/utils/test-management-form';

const bound = () =>
  testManagementToForm(
    resolveTestManagementBinding({ connectionId: 4, providerProjectKey: 'SHOP', runPolicy: { folderId: '77' } }),
  );

describe('testManagementToForm and testManagementFromForm', () => {
  test('a new binding is unbound, with dry run on and tags as the only key source', () => {
    const form = testManagementToForm(emptyTestManagementBinding());
    expect(form).toMatchObject({
      connectionId: 0,
      dryRun: true,
      enabled: true,
      keySources: { tags: true, externalId: false },
      includeError: false,
      flakyAs: 'pass',
      skippedAs: '',
    });
    expect(testManagementFromForm(form)).toEqual({ connectionId: null });
  });

  test('a saved binding comes back from the form unchanged', () => {
    const binding = resolveTestManagementBinding({
      connectionId: 4,
      providerProjectKey: 'SHOP',
      enabled: false,
      dryRun: false,
      keySources: { tags: false, externalId: true },
      runScope: { branches: ['main', 'release/*'], defaultBranch: false, environments: ['prod'] },
      runPolicy: { nameTemplate: 'Piwi #{runId}', folderId: '77', version: '4.2' },
      statuses: { pass: 'Passed', fail: 'Failed', flaky: 'Flaky', notExecuted: 'Skipped' },
      options: { flakyAs: 'flaky', skippedAs: 'notExecuted', includeError: true, includeComment: false },
    });
    expect(resolveTestManagementBinding(testManagementFromForm(testManagementToForm(binding)))).toEqual(binding);
  });

  test('leaves an empty folder, version and flaky status out instead of sending empty strings', () => {
    const form = bound();
    form.folderId = '';
    form.version = '  ';
    form.statuses.flaky = '';
    const body = testManagementFromForm(form) as { runPolicy: object; statuses: { flaky: unknown } };
    expect(body.runPolicy).not.toHaveProperty('folderId');
    expect(body.runPolicy).not.toHaveProperty('version');
    expect(body.statuses.flaky).toBeNull();
  });

  test('keeps the comment option the form does not edit', () => {
    const form = testManagementToForm(resolveTestManagementBinding({ options: { includeComment: false } }));
    form.connectionId = 4;
    expect((testManagementFromForm(form) as { options: { includeComment: boolean } }).options.includeComment).toBe(
      false,
    );
  });
});

describe('testManagementProblems', () => {
  test('an unbound form has no problem, whatever its fields hold', () => {
    const form = testManagementToForm(emptyTestManagementBinding());
    form.nameTemplate = '';
    expect(hasTestManagementProblem(testManagementProblems(form))).toBe(false);
  });

  test('a name without {runId} is refused with the reason', () => {
    const form = bound();
    form.nameTemplate = 'Nightly {branch}';
    expect(testManagementProblems(form).nameTemplate).toContain('{runId}');
    form.nameTemplate = 'Nightly {runId}';
    expect(testManagementProblems(form).nameTemplate).toBeNull();
  });

  test('a bound form needs a project, a flaky status for "flaky", and a key source', () => {
    const form = bound();
    form.providerProjectKey = ' ';
    form.flakyAs = 'flaky';
    form.keySources = { tags: false, externalId: false };
    expect(testManagementProblems(form)).toMatchObject({
      project: expect.any(String),
      flaky: expect.any(String),
      keySources: expect.any(String),
    });
    form.providerProjectKey = 'SHOP';
    form.statuses.flaky = 'Flaky';
    form.keySources.tags = true;
    expect(hasTestManagementProblem(testManagementProblems(form))).toBe(false);
  });
});
