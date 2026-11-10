/**
 * Pure helpers for the project's test management binding form (`ProjectTestManagementSettings.vue`): the form holds
 * strings and flags so the inputs bind cleanly, and is turned back into the binding's shape on save. The server
 * normalizes and clamps the payload again.
 */
import {
  MAX_STATUS_NAME_LENGTH,
  TEST_MANAGEMENT_PROJECT_KEY,
  validateRunNameTemplate,
  type FlakyAs,
  type ResolvedTestManagementBinding,
  type TestManagementKeySources,
} from '#shared/integrations/test-management-binding';
import { runScopeFromForm, runScopeToForm, type RunScopeForm } from '~/utils/tracker-binding-form';

/** The binding as the form edits it. */
export interface TestManagementForm {
  /** 0 is no connection: the project is not bound. */
  connectionId: number;
  providerProjectKey: string;
  enabled: boolean;
  dryRun: boolean;
  keySources: TestManagementKeySources;
  scope: RunScopeForm;
  nameTemplate: string;
  /** Empty: the project's root. */
  folderId: string;
  version: string;
  statuses: { pass: string; fail: string; flaky: string; notExecuted: string };
  flakyAs: FlakyAs;
  /** `''` leaves a skipped test out. */
  skippedAs: '' | 'notExecuted';
  includeError: boolean;
  /** Not edited here; kept so a save does not reset it. */
  includeComment: boolean;
}

export function testManagementToForm(binding: ResolvedTestManagementBinding): TestManagementForm {
  return {
    connectionId: binding.connectionId ?? 0,
    providerProjectKey: binding.providerProjectKey ?? '',
    enabled: binding.enabled,
    dryRun: binding.dryRun,
    keySources: { ...binding.keySources },
    scope: runScopeToForm(binding.runScope),
    nameTemplate: binding.runPolicy.nameTemplate,
    folderId: binding.runPolicy.folderId ?? '',
    version: binding.runPolicy.version ?? '',
    statuses: {
      pass: binding.statuses.pass,
      fail: binding.statuses.fail,
      flaky: binding.statuses.flaky ?? '',
      notExecuted: binding.statuses.notExecuted,
    },
    flakyAs: binding.options.flakyAs,
    skippedAs: binding.options.skippedAs ?? '',
    includeError: binding.options.includeError,
    includeComment: binding.options.includeComment,
  };
}

/** The body of `PUT /api/projects/:id/test-management`. */
export function testManagementFromForm(form: TestManagementForm): Record<string, unknown> {
  if (!form.connectionId) return { connectionId: null };
  return {
    connectionId: form.connectionId,
    providerProjectKey: form.providerProjectKey.trim(),
    enabled: form.enabled,
    dryRun: form.dryRun,
    keySources: { ...form.keySources },
    runScope: runScopeFromForm(form.scope),
    runPolicy: {
      mode: 'per-run',
      nameTemplate: form.nameTemplate.trim(),
      ...(form.folderId ? { folderId: form.folderId } : {}),
      ...(form.version.trim() ? { version: form.version.trim() } : {}),
    },
    statuses: {
      pass: form.statuses.pass.trim(),
      fail: form.statuses.fail.trim(),
      flaky: form.statuses.flaky.trim() || null,
      notExecuted: form.statuses.notExecuted.trim(),
    },
    options: {
      flakyAs: form.flakyAs,
      skippedAs: form.skippedAs || null,
      includeError: form.includeError,
      includeComment: form.includeComment,
    },
  };
}

/** The four result statuses the form names. */
export type StatusField = keyof TestManagementForm['statuses'];

/** A project key typed into the picker as the tool and the server read it: trimmed and upper-cased. Null for anything else. */
export function typedProjectKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  return TEST_MANAGEMENT_PROJECT_KEY.test(key) ? key : null;
}

/** A status name typed into a picker, as typed and trimmed. Null for an empty name or one the tool would not accept. */
export function typedStatusName(raw: string): string | null {
  const name = raw.trim();
  return name && name.length <= MAX_STATUS_NAME_LENGTH ? name : null;
}

/** Take a project key typed into the picker; false, and the form untouched, when it is not a project key. */
export function setTypedProject(form: TestManagementForm, raw: string): boolean {
  const key = typedProjectKey(raw);
  if (key === null) return false;
  form.providerProjectKey = key;
  return true;
}

/** Take a status name typed into one of the status pickers; false, and the form untouched, when it is not a name. */
export function setTypedStatus(form: TestManagementForm, field: StatusField, raw: string): boolean {
  const name = typedStatusName(raw);
  if (name === null) return false;
  form.statuses[field] = name;
  return true;
}

export interface TestManagementFormProblems {
  project: string | null;
  nameTemplate: string | null;
  flaky: string | null;
  keySources: string | null;
}

/** What stops the form from being saved, per field; every value null when it can be saved. */
export function testManagementProblems(form: TestManagementForm): TestManagementFormProblems {
  const bound = form.connectionId > 0;
  const template = validateRunNameTemplate(form.nameTemplate);
  return {
    project: bound && !form.providerProjectKey.trim() ? 'Choose a project of the test management tool.' : null,
    nameTemplate: bound && !template.ok ? template.message : null,
    flaky:
      bound && form.flakyAs === 'flaky' && !form.statuses.flaky.trim()
        ? 'Name the status a flaky test is reported as.'
        : null,
    keySources:
      bound && !form.keySources.tags && !form.keySources.externalId
        ? 'Choose where a test’s case key comes from.'
        : null,
  };
}

export function hasTestManagementProblem(problems: TestManagementFormProblems): boolean {
  return Object.values(problems).some((problem) => problem !== null);
}
