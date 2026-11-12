/**
 * Pure helpers for the project's tracker binding form
 * (`ProjectIntegrationSettings.vue` and its parts): run scopes and
 * automatic-creation rules are edited as text (comma-separated lists) and
 * numbers, and turned back into the binding's shapes on save; the server
 * normalizes and clamps them again.
 */
import { DEFAULT_AUTO_CREATE_RULE, type AutoCreateRule, type TrackerRunScope } from '#shared/integrations/automation';
import type { TrackerIssueTypeOption } from '#shared/integrations/types';

/** A run scope as the form edits it. */
export interface RunScopeForm {
  branches: string;
  defaultBranch: boolean;
  environments: string;
}

/** An automatic-creation rule as the form edits it. */
export interface AutoCreateRuleForm extends RunScopeForm {
  tags: string;
  minOccurrences: number;
  minRuns: number;
  minDays: number;
  labels: string;
}

/** A comma-separated list: trimmed, empty entries dropped. */
function commaSeparatedList(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function runScopeToForm(scope: TrackerRunScope): RunScopeForm {
  return {
    branches: scope.branches.join(', '),
    defaultBranch: scope.defaultBranch,
    environments: scope.environments.join(', '),
  };
}

export function runScopeFromForm(form: RunScopeForm): TrackerRunScope {
  return {
    branches: commaSeparatedList(form.branches),
    defaultBranch: form.defaultBranch,
    environments: commaSeparatedList(form.environments),
  };
}

export function autoCreateRuleToForm(rule: AutoCreateRule): AutoCreateRuleForm {
  return {
    ...runScopeToForm(rule),
    tags: rule.tags.map((tag) => `@${tag}`).join(', '),
    minOccurrences: rule.minOccurrences,
    minRuns: rule.minRuns,
    minDays: rule.minDays,
    labels: rule.labels.join(', '),
  };
}

export function autoCreateRuleFromForm(form: AutoCreateRuleForm): AutoCreateRule {
  return {
    ...runScopeFromForm(form),
    tags: commaSeparatedList(form.tags).map((tag) => tag.replace(/^@/, '')),
    minOccurrences: Number(form.minOccurrences),
    minRuns: Number(form.minRuns),
    minDays: Number(form.minDays),
    labels: commaSeparatedList(form.labels),
  };
}

/** The form of a new rule: the default one, on the default branch. */
export function newAutoCreateRuleForm(): AutoCreateRuleForm {
  return autoCreateRuleToForm(DEFAULT_AUTO_CREATE_RULE);
}

/**
 * The issue types a binding lists for test tags that the Jira project's own list also holds: an entry is kept when it
 * is the id of a listed type or, ignoring case, the name of one, the two forms a binding stores. With no list, because
 * the project has none or its types could not be loaded, none is kept.
 */
export function pruneDeclaredIssueTypes(selected: string[], listed: TrackerIssueTypeOption[] | null): string[] {
  if (!listed) return [];
  return selected.filter((entry) =>
    listed.some((type) => type.id === entry || type.name.toLowerCase() === entry.toLowerCase()),
  );
}
