import { ASSIGNEE_EMPTY_HINT, assigneeSearchHint } from '#shared/integrations/jira-setup';
import type { TrackerUserOption } from '#shared/integrations/types';

/** What the person sees under a people picker when a search went wrong or found no one. */
export interface AssignableSearchProblem {
  state: 'error' | 'warning';
  text: string;
  hint: string | null;
}

/**
 * The people a tracker lets a connection assign in a project, searched by name
 * or email. A refused search keeps Jira's message and what to grant; an empty
 * list for no words at all says Jira listed no one, which is what Jira Cloud
 * answers when the account may not browse users. Every person a search or a
 * lookup listed stays known by id, so a chosen person keeps their name and
 * avatar. The assignee pickers and the people fields of the create modal share it.
 */
export function useAssignableSearch(
  connectionId: () => number | null | undefined,
  projectKey: () => string | null | undefined,
) {
  const people = ref<TrackerUserOption[]>([]);
  const loading = ref(false);
  const problem = ref<AssignableSearchProblem | null>(null);
  const known = reactive(new Map<string, TrackerUserOption>());
  /** Increments per search, so an older answer never overwrites a newer one. */
  let generation = 0;

  const ready = () => Boolean(connectionId() && projectKey());

  function remember(users: TrackerUserOption[]) {
    for (const user of users) known.set(user.id, user);
  }

  async function fetchUsers(params: Record<string, string>): Promise<TrackerUserOption[]> {
    const query = new URLSearchParams({ project: projectKey() ?? '', ...params });
    const { users } = await $fetch<{ users: TrackerUserOption[] }>(
      `/api/integrations/connections/${connectionId()}/assignable?${query.toString()}`,
    );
    remember(users);
    return users;
  }

  function refusal(err: unknown): AssignableSearchProblem {
    const status = (err as { data?: { data?: { providerStatus?: number } } } | null)?.data?.data?.providerStatus;
    return {
      state: 'error',
      text: errorMessage(err, 'Could not search the people Jira can assign'),
      hint: assigneeSearchHint(status),
    };
  }

  async function search(words = '') {
    const current = ++generation;
    if (!ready()) {
      people.value = [];
      problem.value = null;
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const users = await fetchUsers({ q: words });
      if (current !== generation) return;
      people.value = users;
      problem.value =
        users.length === 0 && !words.trim()
          ? { state: 'warning', text: 'Jira listed no one for this project.', hint: ASSIGNEE_EMPTY_HINT }
          : null;
    } catch (err) {
      if (current !== generation) return;
      people.value = [];
      problem.value = refusal(err);
    } finally {
      if (current === generation) loading.value = false;
    }
  }
  const searchSoon = useDebounceFn((words: string) => search(words), 250);

  /** Learns the name and avatar of saved account ids a search has not listed yet. */
  async function lookUp(accountIds: Array<string | null | undefined>) {
    if (!ready()) return;
    const missing = [...new Set(accountIds.filter((id): id is string => Boolean(id) && !known.has(id!)))];
    await Promise.all(
      missing.map(async (accountId) => {
        try {
          await fetchUsers({ accountId });
        } catch (err) {
          problem.value ??= refusal(err);
        }
      }),
    );
  }

  watch([connectionId, projectKey], () => {
    generation++;
    people.value = [];
    problem.value = null;
    loading.value = false;
  });

  return { people, loading, problem, known, ready, search, searchSoon, lookUp };
}
