/**
 * The Whats the failure pages and a test's page offer the run dialog (`RunWhat`): one test, a cluster's tests and a
 * Flake Lab experiment. A request to one of the person's apps names one test or a run's tests, so the apps are
 * offered a cluster's tests and an experiment disabled, with the reason.
 */
import type { CiDispatchSourceInput } from '#shared/ci-dispatch-request';
import type { FlakeLabKind } from '#shared/ci-dispatches';
import type { RunWhat } from '~/composables/useRunPlace';

/** One test, by one execution of it: at its line, in the Playwright project it ran in. */
export function executionTestWhat(executionId: number, title: string): RunWhat {
  return {
    key: 'test',
    label: 'This test',
    count: 1,
    tests: title ? [title] : undefined,
    app: { source: { executionId } },
    ci: { source: { executionId, scope: 'test' } },
  };
}

/** A failure cluster's affected tests, each at the line of its latest failure: CI re-runs them. */
export function clusterTestsWhat(label: string, ci: CiDispatchSourceInput, tests?: readonly string[]): RunWhat {
  return {
    key: 'cluster',
    label,
    count: tests?.length,
    tests,
    app: { reason: 'A request to your app names one test or a run’s tests, not a cluster’s.' },
    ci: { source: ci },
  };
}

/** A test's Flake Lab experiment, `piwi flake` (reproduce) or `piwi flake verify`, which CI runs. */
export function flakeLabWhat(testCaseId: number, kind: FlakeLabKind): RunWhat {
  return {
    key: `flake-lab-${kind}`,
    label: kind === 'verify' ? 'Flake Lab: verify the fix' : 'Flake Lab: reproduce the flake',
    app: { reason: 'A request to your app runs tests, not a Flake Lab experiment.' },
    ci: { source: { testCaseId, flakeLab: kind } },
  };
}
