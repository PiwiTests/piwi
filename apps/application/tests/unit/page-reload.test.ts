import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computed, readonly, ref, watch, type Ref } from 'vue';
import type { AssistantBlock } from '#shared/assistant';
import { refetchKeeping } from '../../app/utils/refetch-keeping';

/**
 * A read asked from outside a page (the assistant, once a proposal is applied) goes through the readers the page
 * registered, which keep what it shows when they fail; a page that registered none has every `useFetch` refreshed.
 */

const { unmounts } = vi.hoisted(() => ({ unmounts: [] as Array<() => void> }));

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onUnmounted: (fn: () => void) => unmounts.push(fn),
}));

type Run = { id: number; status: string; keptAt: string | null };

/**
 * The run page's run, as `useFetch` holds it, and `refreshNuxtData()` as Nuxt runs it: with no key every `useFetch`
 * reads again, and one whose read fails is reset to its default; with keys, only theirs, none of them the run's.
 */
function runPage(answer: () => Promise<Run>) {
  const run: Ref<Run | undefined> = ref({ id: 7, status: 'running', keptAt: null });
  const refreshNuxtData = vi.fn(async (keys?: string | string[]) => {
    if (keys !== undefined) return;
    try {
      run.value = await answer();
    } catch {
      run.value = undefined;
    }
  });
  vi.stubGlobal('refreshNuxtData', refreshNuxtData);
  return { run, refreshNuxtData };
}

const badGateway = () => Promise.reject(Object.assign(new Error('502 Bad Gateway'), { status: 502 }));

async function pageReload() {
  vi.resetModules();
  return import('../../app/composables/usePageReload');
}

beforeEach(() => {
  unmounts.length = 0;
  vi.stubGlobal('__IMPORT_META_CLIENT__', true);
});

afterEach(() => {
  for (const unmount of unmounts) unmount();
  vi.unstubAllGlobals();
});

describe('reloadPage', () => {
  test('refreshes every useFetch of a page that registered no reader', async () => {
    const { run, refreshNuxtData } = runPage(async () => ({ id: 7, status: 'passed', keptAt: null }));
    const { reloadPage } = await pageReload();
    await reloadPage();
    expect(refreshNuxtData).toHaveBeenCalledOnce();
    expect(run.value?.status).toBe('passed');
  });

  test('reads through the page’s readers while it is mounted, and keeps what it shows when they fail', async () => {
    const { run, refreshNuxtData } = runPage(badGateway);
    const { reloadPage, usePageReload } = await pageReload();
    const read = vi.fn(refetchKeeping(run, badGateway));
    usePageReload(read);

    await reloadPage();
    expect(read).toHaveBeenCalledOnce();
    // Only the instance's capability states are refreshed by key, never every read of the page.
    expect(refreshNuxtData.mock.calls).toEqual([['capabilities-instance']]);
    expect(run.value).toEqual({ id: 7, status: 'running', keptAt: null });

    // The page left.
    for (const unmount of unmounts.splice(0)) unmount();
    await reloadPage();
    expect(read).toHaveBeenCalledOnce();
    expect(refreshNuxtData.mock.calls).toEqual([['capabilities-instance'], []]);
  });

  test('registers nothing during the server render', async () => {
    vi.stubGlobal('__IMPORT_META_CLIENT__', false);
    const { refreshNuxtData } = runPage(badGateway);
    const { reloadPage, usePageReload } = await pageReload();
    const read = vi.fn(async () => {});
    usePageReload(read);
    await reloadPage();
    expect(read).not.toHaveBeenCalled();
    expect(refreshNuxtData).toHaveBeenCalledOnce();
  });
});

describe('the assistant’s Apply', () => {
  /** The assistant, with the Nuxt composables it calls played by the test, and a conversation holding `block`. */
  async function assistantWith(block: Extract<AssistantBlock, { kind: 'proposal' }>, fetch: typeof $fetch) {
    const states = new Map<string, Ref<unknown>>();
    vi.stubGlobal('computed', computed);
    vi.stubGlobal('readonly', readonly);
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('watch', watch);
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false }, app: { baseURL: '/' } }));
    vi.stubGlobal('useRouter', () => ({
      currentRoute: ref({ path: '/test-runs/7', fullPath: '/test-runs/7', matched: [], params: {}, query: {} }),
    }));
    vi.stubGlobal('useToast', () => ({ add: vi.fn() }));
    vi.stubGlobal('useGuide', () => ({}));
    vi.stubGlobal('useAssistantDock', () => ({ docked: ref(false) }));
    vi.stubGlobal('useState', (key: string, init: () => unknown) => {
      if (!states.has(key)) states.set(key, ref(init()));
      return states.get(key);
    });
    vi.stubGlobal('errorMessage', (_error: unknown, fallback = 'Unknown error') => fallback);
    vi.stubGlobal('$fetch', fetch);
    const { useAssistant } = await import('../../app/composables/useAssistant');
    const assistant = useAssistant();
    states.get('assistant-conversation')!.value = {
      id: 3,
      title: 'Keep this run',
      messages: [{ id: 11, role: 'assistant', blocks: [block] }],
    };
    return assistant;
  }

  test('reads the run page’s run through the page, which keeps it when the read fails', async () => {
    const block = {
      kind: 'proposal',
      id: 'p1',
      action: 'keep-run',
      title: 'Keep run #7',
      change: 'Retention never deletes run #7.',
      target: { type: 'run', id: 7, label: 'Run #7' },
      projectId: 1,
      params: {},
    } as Extract<AssistantBlock, { kind: 'proposal' }>;
    const calls: string[] = [];
    const fetch = vi.fn(async (path: string, options?: { method?: string }) => {
      calls.push(`${options?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/proposal')) return { block: { ...block, outcome: { status: 'applied' } } };
      return {};
    }) as unknown as typeof $fetch;

    const { run, refreshNuxtData } = runPage(badGateway);
    const { usePageReload } = await pageReload();
    const readRun = vi.fn(refetchKeeping(run, badGateway));
    usePageReload(readRun);
    const assistant = await assistantWith(block, fetch);

    await assistant.applyProposal(11, block);

    expect(calls).toEqual(['PATCH /api/test-runs/7', 'PATCH /api/assistant/conversations/3/messages/11/proposal']);
    expect(readRun).toHaveBeenCalledOnce();
    // Only the instance's capability states are refreshed by key, never every read of the page.
    expect(refreshNuxtData.mock.calls).toEqual([['capabilities-instance']]);
    expect(run.value).toEqual({ id: 7, status: 'running', keptAt: null });
  });
});
