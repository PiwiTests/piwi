import type { CapabilityId, CapabilityState } from '#shared/capabilities';
import type { CapabilityStates } from '#shared/handlers/capabilities';
import type { ApiResponse } from '~~/types/api';
import { coverageLossKey } from '~/utils/coverage-insights';

type CoverageLossResponse = ApiResponse<typeof import('~~/server/api/projects/[id]/coverage-loss.get').default>;

/** The most tests one coverage-loss read names. */
const MAX_TESTS = 50;

/**
 * The code only some tests of a project run (`GET /api/projects/:id/coverage-loss`),
 * read in the browser when an action that quarantines or releases them is about
 * to be taken, and kept per set of tests for the component's life. `load` reads
 * nothing while `active` is false (the project's coverage capability is not
 * active), for no test, or for more than 50; `answerFor` is the answer once it
 * arrived, else null. A read that fails answers null, and the action goes on
 * without it.
 */
export function useCoverageLoss(
  projectId: MaybeRefOrGetter<string | number | null | undefined>,
  active: MaybeRefOrGetter<boolean>,
) {
  const answers = shallowRef(new Map<string, CoverageLossResponse | null>());
  const reading = new Set<string>();

  async function load(testCaseIds: number[]): Promise<void> {
    const project = toValue(projectId);
    const key = coverageLossKey(testCaseIds);
    if (!toValue(active) || project == null || project === '' || !key || testCaseIds.length > MAX_TESTS) return;
    if (answers.value.has(key) || reading.has(key)) return;
    reading.add(key);
    let answer: CoverageLossResponse | null = null;
    try {
      answer = await $fetch<CoverageLossResponse>(`/api/projects/${project}/coverage-loss`, { query: { tests: key } });
    } catch {
      answer = null;
    } finally {
      reading.delete(key);
    }
    answers.value = new Map(answers.value).set(key, answer);
  }

  function answerFor(testCaseIds: number[]): CoverageLossResponse | null {
    return answers.value.get(coverageLossKey(testCaseIds)) ?? null;
  }

  return { load, answerFor };
}

/**
 * Whether a project's coverage capability is active, for a component that does
 * not wait on the capability states before it renders: false until they are
 * read (`useProjectCapabilities`), and for no project.
 */
export function useCoverageActive(projectId: string | number | null | undefined) {
  const state = shallowRef<((id: CapabilityId) => CapabilityState) | null>(null);
  if (projectId != null && projectId !== '') {
    void useProjectCapabilities(Number(projectId)).then((capabilities) => (state.value = capabilities.state));
  }
  return computed(() => state.value?.('coverage') === 'active');
}

/**
 * Whether a project's coverage capability is active, for a page that offers a
 * quarantine only after an interaction (a selection): false until `resolve`
 * read the project's capability states, in the browser, once; a read that
 * failed is tried again on the next `resolve`. The page's own render reads
 * nothing.
 */
export function useLazyCoverageActive(projectId: MaybeRefOrGetter<string | number | null | undefined>) {
  const active = shallowRef(false);
  let reading: Promise<void> | null = null;

  function resolve(): Promise<void> {
    const project = toValue(projectId);
    if (reading || project == null || project === '') return reading ?? Promise.resolve();
    reading = $fetch<CapabilityStates>(`/api/projects/${project}/capabilities`)
      .then((states) => {
        active.value = states.items.some((item) => item.id === 'coverage' && item.state === 'active');
      })
      .catch(() => {
        reading = null;
      });
    return reading;
  }

  return { active: computed(() => active.value), resolve };
}
