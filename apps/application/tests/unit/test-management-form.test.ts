import { describe, expect, test } from 'vitest';
import { emptyTestManagementBinding, resolveTestManagementBinding } from '#shared/integrations/test-management-binding';
import {
  hasTestManagementProblem,
  setTypedProject,
  setTypedStatus,
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

describe('a project key or status typed into a picker', () => {
  test('a project key is trimmed and upper-cased, as the server reads it', () => {
    const form = bound();
    form.providerProjectKey = '';
    expect(setTypedProject(form, '  shop ')).toBe(true);
    expect(form.providerProjectKey).toBe('SHOP');
    expect(testManagementProblems(form).project).toBeNull();
    expect((testManagementFromForm(form) as { providerProjectKey: string }).providerProjectKey).toBe('SHOP');
  });

  test('a text that is not a project key leaves the form as it was', () => {
    const form = bound();
    for (const raw of ['', '  ', '1SHOP', 'SH OP', 'S', 'SHOP-1', 'SH/OP', `S${'H'.repeat(100)}`]) {
      expect(setTypedProject(form, raw)).toBe(false);
      expect(form.providerProjectKey).toBe('SHOP');
    }
  });

  test('a project key of 100 characters is taken, one of 101 is not', () => {
    const form = bound();
    expect(setTypedProject(form, `S${'H'.repeat(99)}`)).toBe(true);
    expect(setTypedProject(form, `S${'H'.repeat(100)}`)).toBe(false);
  });

  test('a status is kept as typed, trimmed, in the field it was typed into', () => {
    const form = bound();
    for (const field of ['pass', 'fail', 'flaky', 'notExecuted'] as const) {
      expect(setTypedStatus(form, field, `  Custom ${field} `)).toBe(true);
      expect(form.statuses[field]).toBe(`Custom ${field}`);
    }
    expect((testManagementFromForm(form) as { statuses: object }).statuses).toEqual({
      pass: 'Custom pass',
      fail: 'Custom fail',
      flaky: 'Custom flaky',
      notExecuted: 'Custom notExecuted',
    });
  });

  test('a status can be typed before a project is chosen', () => {
    const form = testManagementToForm(emptyTestManagementBinding());
    form.connectionId = 4;
    expect(setTypedStatus(form, 'pass', 'Passed')).toBe(true);
    expect(form.providerProjectKey).toBe('');
    expect(form.statuses.pass).toBe('Passed');
  });

  test('an empty status, or one over the tool’s limit, is refused', () => {
    const form = bound();
    expect(setTypedStatus(form, 'fail', '   ')).toBe(false);
    expect(setTypedStatus(form, 'fail', 'x'.repeat(256))).toBe(false);
    expect(form.statuses.fail).toBe('Fail');
    expect(setTypedStatus(form, 'fail', 'x'.repeat(255))).toBe(true);
  });
});
