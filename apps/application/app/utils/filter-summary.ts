/**
 * The one line a folded Filters block reads for a `FilterBar`: each control the
 * bar shows, as it is set, then what the filters hide.
 */
import type { FilterBarState } from '~/components/shared/FilterBar.vue';

export interface FilterSummaryOptions {
  /** The bar shows an environment select. */
  environments?: boolean;
  /** With no environment picked, the bar reads the default environment unless `allEnvironments` is set. */
  environmentPolicy?: boolean;
  /** The name of the default environment. */
  defaultEnvironment?: string | null;
  /** The bar shows a branch select. */
  branches?: boolean;
  /** With no branch picked, the bar reads the default branch unless `allBranches` is set. */
  branchPolicy?: boolean;
  defaultBranch?: string | null;
  /** What the filters hide, in words ("3 partial runs hidden"). */
  hidden?: string[];
  /** The words an environment value shows (a project's environment by its name); the value itself by default. */
  environmentLabel?: (value: string) => string;
}

function picked(values: string[], none: string, plural: string): string {
  if (values.length === 0) return none;
  if (values.length === 1) return values[0]!;
  return `${values.length} ${plural}`;
}

export function filterBarSummary(state: FilterBarState, options: FilterSummaryOptions = {}): string {
  const parts: string[] = [];
  if (options.environments !== false) {
    const label = options.environmentLabel ?? ((value: string) => value);
    if (state.environments.length === 0 && options.environmentPolicy && !state.allEnvironments) {
      parts.push(
        options.defaultEnvironment ? `Default environment (${options.defaultEnvironment})` : 'Default environment',
      );
    } else parts.push(picked(state.environments.map(label), 'All environments', 'environments'));
  }
  if (options.branches !== false) {
    if (state.branches.length > 0) parts.push(picked(state.branches, '', 'branches'));
    else if (options.branchPolicy && !state.allBranches)
      parts.push(options.defaultBranch ? `default branch (${options.defaultBranch})` : 'default branch');
    else parts.push('all branches');
  }
  parts.push(state.fullRunsOnly ? 'full runs only' : 'partial runs included');
  return [...parts, ...(options.hidden ?? [])].join(' · ');
}

/** "3 partial runs hidden", "1 run on another branch hidden": the words for a count of hidden runs. */
export function hiddenRunsPhrase(count: number, kind: 'partial' | 'other-branches' | 'other-environments'): string {
  if (kind === 'partial') return count === 1 ? '1 partial run hidden' : `${count} partial runs hidden`;
  if (kind === 'other-environments') {
    return count === 1 ? '1 run in another environment hidden' : `${count} runs in other environments hidden`;
  }
  return count === 1 ? '1 run on another branch hidden' : `${count} runs on other branches hidden`;
}
