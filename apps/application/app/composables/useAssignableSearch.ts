import type { TrackerUserOption } from '#shared/integrations/types';

/** How long typing pauses before the words are searched. */
const SEARCH_DELAY_MS = 250;
/** How long a project key typed by hand rests before its chosen people are looked up. */
const LOOKUP_DELAY_MS = 400;

/**
 * The people a tracker lets a connection assign in a project, searched by name
 * or email while the picker is open. A refused search keeps Jira's message and
 * what to grant; an empty list for no words at all says Jira listed no one,
 * which is what Jira Cloud answers when the account may not browse users. Every
 * person a search or a lookup listed stays known by id, so a chosen person keeps
 * their name and avatar: the `chosen` ids are looked up as they change, and again
 * once a changed project key rests. An answer for an earlier connection or
 * project, or an older search, is dropped. The assignee pickers and the people
 * fields of the create modal share it.
 */
export function useAssignableSearch(
  connectionId: () => number | null | undefined,
  projectKey: () => string | null | undefined,
  chosen?: () => Array<string | null | undefined>,
) {
  const people = ref<TrackerUserOption[]>([]);
  const loading = ref(false);
  const problem = ref<AssignableSearchProblem | null>(null);
  const known = reactive(new Map<string, TrackerUserOption>());
  /** Increments per search and per change of connection or project, so an older answer never lands. */
  let generation = 0;
  /** Increments per change of connection or project, so a lookup for the one before never lands. */
  let scope = 0;
  let open = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let lookUpTimer: ReturnType<typeof setTimeout> | undefined;

  const ready = () => Boolean(connectionId() && projectKey());

  function remember(users: TrackerUserOption[]) {
    for (const user of users) known.set(user.id, user);
  }

  async function fetchUsers(params: Record<string, string>): Promise<TrackerUserOption[]> {
    const query = new URLSearchParams({ project: projectKey() ?? '', ...params });
    const { users } = await $fetch<{ users: TrackerUserOption[] }>(
      `/api/integrations/connections/${connectionId()}/assignable?${query.toString()}`,
    );
    return users;
  }

  async function search(words = '') {
    clearTimeout(searchTimer);
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
      remember(users);
      people.value = users;
      problem.value = users.length === 0 && !words.trim() ? NO_ONE_LISTED : null;
    } catch (err) {
      if (current !== generation) return;
      people.value = [];
      problem.value = assignableSearchProblem(err);
    } finally {
      if (current === generation) loading.value = false;
    }
  }

  /** Searches the words once typing pauses; the menu clearing its words as it closes searches nothing. */
  function searchSoon(words: string) {
    clearTimeout(searchTimer);
    if (!open) return;
    searchTimer = setTimeout(() => void search(words), SEARCH_DELAY_MS);
  }

  /** Lists the people as the menu opens; a search still waiting when it closes is dropped. */
  function onOpen(isOpen: boolean) {
    open = isOpen;
    if (isOpen) void search();
    else clearTimeout(searchTimer);
  }

  /** Learns the name and avatar of saved account ids a search has not listed yet. */
  async function lookUp(accountIds: Array<string | null | undefined>) {
    if (!ready()) return;
    const current = scope;
    const missing = [...new Set(accountIds.filter((id): id is string => Boolean(id) && !known.has(id!)))];
    await Promise.all(
      missing.map(async (accountId) => {
        try {
          const users = await fetchUsers({ accountId });
          if (current === scope) remember(users);
        } catch (err) {
          if (current === scope) problem.value ??= assignableSearchProblem(err);
        }
      }),
    );
  }

  if (chosen) {
    watch(
      () => chosen().filter(Boolean).join('\n'),
      () => void lookUp(chosen()),
      { immediate: true },
    );
  }

  watch([connectionId, projectKey], () => {
    scope++;
    generation++;
    clearTimeout(searchTimer);
    people.value = [];
    problem.value = null;
    loading.value = false;
    if (chosen) {
      clearTimeout(lookUpTimer);
      lookUpTimer = setTimeout(() => void lookUp(chosen()), LOOKUP_DELAY_MS);
    }
  });

  onScopeDispose(() => {
    scope++;
    generation++;
    clearTimeout(searchTimer);
    clearTimeout(lookUpTimer);
  });

  return { people, loading, problem, known, ready, search, searchSoon, onOpen, lookUp };
}
