import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { effectScope, nextTick, onScopeDispose, reactive, ref, watch, type EffectScope } from 'vue';
import { assignableSearchProblem, NO_ONE_LISTED } from '../../app/utils/assignable-search';

/**
 * The search behind the assignee pickers and the people fields: a failed search reads as the server's message and
 * what to grant, typing searches once it pauses and only while the menu is open, and an answer for a connection or
 * project the picker has left never lands.
 */

/** A `$fetch` refusal as the browser gets it: the route's JSON body under `data`. */
const fetchError = (status: number, message: string, providerStatus?: number | null) =>
  Object.assign(new Error(`[GET] "/api/integrations/connections/1/assignable": ${status}`), {
    statusCode: status,
    data: {
      statusCode: status,
      message,
      ...(providerStatus === undefined ? {} : { data: { errorCode: 'TRACKER_SEARCH_FAILED', providerStatus } }),
    },
  });

describe('assignableSearchProblem', () => {
  test('a 403 keeps Jira message and names the permission to grant', () => {
    const problem = assignableSearchProblem(fetchError(502, 'Jira request failed (403 Forbidden): no', 403));
    expect(problem.state).toBe('error');
    expect(problem.text).toBe('Jira request failed (403 Forbidden): no');
    expect(problem.hint).toContain('Browse users and groups');
  });

  test('a 401 asks to check the connection email and token', () => {
    expect(assignableSearchProblem(fetchError(502, 'Jira request failed (401)', 401)).hint).toMatch(/email and token/);
  });

  test('a 429 asks to try again', () => {
    expect(assignableSearchProblem(fetchError(502, 'Jira request failed (429)', 429)).hint).toMatch(/Try again/);
  });

  test('a search Jira never answered keeps the message and gives no hint', () => {
    expect(
      assignableSearchProblem(fetchError(502, 'Jira did not answer the search for assignable people.', null)),
    ).toEqual({ state: 'error', text: 'Jira did not answer the search for assignable people.', hint: null });
  });

  test('a failure without a message of the server reads as a failed search', () => {
    expect(assignableSearchProblem(new TypeError('Failed to fetch'))).toEqual({
      state: 'error',
      text: 'Could not search the people Jira can assign',
      hint: null,
    });
    expect(assignableSearchProblem(null).text).toBe('Could not search the people Jira can assign');
  });
});

interface Call {
  url: URL;
  resolve: (users: Array<{ id: string; displayName: string }>) => void;
  reject: (err: unknown) => void;
}

describe('useAssignableSearch', () => {
  const calls: Call[] = [];
  let scope: EffectScope;
  let useAssignableSearch: typeof import('../../app/composables/useAssignableSearch').useAssignableSearch;

  beforeEach(async () => {
    vi.useFakeTimers();
    calls.length = 0;
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('reactive', reactive);
    vi.stubGlobal('watch', watch);
    vi.stubGlobal('onScopeDispose', onScopeDispose);
    vi.stubGlobal('assignableSearchProblem', assignableSearchProblem);
    vi.stubGlobal('NO_ONE_LISTED', NO_ONE_LISTED);
    vi.stubGlobal(
      '$fetch',
      (path: string) =>
        new Promise((resolve, reject) => {
          calls.push({ url: new URL(path, 'http://piwi.test'), resolve: (users) => resolve({ users }), reject });
        }),
    );
    ({ useAssignableSearch } = await import('../../app/composables/useAssignableSearch'));
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const settle = async () => {
    await nextTick();
    await Promise.resolve();
    await nextTick();
  };

  function picker(chosenId: string | null = null) {
    const connection = ref<number | null>(1);
    const project = ref<string | null>('PAY');
    const chosen = ref<string | null>(chosenId);
    const search = scope.run(() =>
      useAssignableSearch(
        () => connection.value,
        () => project.value,
        () => [chosen.value],
      ),
    )!;
    return { connection, project, chosen, search };
  }

  test('looks up the chosen person at once, and drops the answer for a project it has left', async () => {
    const { project, search } = picker('acct-2');
    await settle();
    expect(calls.map((c) => c.url.searchParams.get('accountId'))).toEqual(['acct-2']);

    project.value = 'OPS';
    await settle();
    calls[0]!.resolve([{ id: 'acct-2', displayName: 'Sam Ortiz' }]);
    calls[0]!.reject(fetchError(502, 'stale', 403));
    await settle();
    expect(search.known.has('acct-2')).toBe(false);
    expect(search.problem.value).toBeNull();
  });

  test('drops a refused lookup for a project it has left', async () => {
    const { project, search } = picker('acct-2');
    await settle();
    project.value = 'OPS';
    await settle();
    calls[0]!.reject(fetchError(502, 'Jira request failed (403)', 403));
    await settle();
    expect(search.problem.value).toBeNull();
  });

  test('looks the chosen person up again once a typed project key rests', async () => {
    const { project, search } = picker('acct-2');
    await settle();
    calls[0]!.resolve([]);
    await settle();
    calls.length = 0;

    for (const key of ['O', 'OP', 'OPS']) {
      project.value = key;
      await settle();
      vi.advanceTimersByTime(100);
    }
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(400);
    await settle();
    expect(calls.map((c) => [c.url.searchParams.get('project'), c.url.searchParams.get('accountId')])).toEqual([
      ['OPS', 'acct-2'],
    ]);
    calls[0]!.resolve([{ id: 'acct-2', displayName: 'Sam Ortiz' }]);
    await settle();
    expect(search.known.get('acct-2')?.displayName).toBe('Sam Ortiz');
  });

  test('searches typed words once typing pauses, only while the menu is open', async () => {
    const { search } = picker();
    search.searchSoon('sa');
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(0);

    search.onOpen(true);
    expect(calls.map((c) => c.url.searchParams.get('q'))).toEqual(['']);
    search.searchSoon('s');
    vi.advanceTimersByTime(100);
    search.searchSoon('sa');
    vi.advanceTimersByTime(250);
    expect(calls.map((c) => c.url.searchParams.get('q'))).toEqual(['', 'sa']);
  });

  test('closing the menu drops a waiting search and the cleared words search nothing', async () => {
    const { search } = picker();
    search.onOpen(true);
    search.searchSoon('sa');
    search.onOpen(false);
    vi.advanceTimersByTime(1000);
    search.searchSoon('');
    vi.advanceTimersByTime(1000);
    expect(calls.map((c) => c.url.searchParams.get('q'))).toEqual(['']);
  });

  test('a change of project drops a waiting search', async () => {
    const { project, search } = picker();
    search.onOpen(true);
    search.searchSoon('sa');
    project.value = 'OPS';
    await settle();
    vi.advanceTimersByTime(1000);
    expect(calls.map((c) => c.url.searchParams.get('q'))).toEqual(['']);
  });

  test('a picker that goes away drops its waiting search and lookup', async () => {
    const { project, search } = picker('acct-2');
    await settle();
    calls.length = 0;
    search.onOpen(true);
    calls.length = 0;
    search.searchSoon('sa');
    project.value = 'OPS';
    await settle();
    scope.stop();
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(0);
  });

  test('a refused search shows why, and an empty list for no words says Jira listed no one', async () => {
    const { search } = picker();
    search.onOpen(true);
    calls[0]!.reject(fetchError(502, 'Jira request failed (403 Forbidden)', 403));
    await settle();
    expect(search.problem.value).toMatchObject({ state: 'error', text: 'Jira request failed (403 Forbidden)' });
    expect(search.loading.value).toBe(false);

    search.onOpen(true);
    calls[1]!.resolve([]);
    await settle();
    expect(search.problem.value).toEqual(NO_ONE_LISTED);
  });
});
