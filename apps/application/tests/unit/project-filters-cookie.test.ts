import { afterEach, describe, expect, test, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { defaultProjectFilters, useProjectFilters } from '../../app/composables/useProjectFilters';

/**
 * Nuxt's `useCookie`, as far as the project filters rely on it: a cookie the
 * request does not carry reads its `default` (and Nuxt then writes that value
 * back), and setting the value to `undefined` deletes the cookie.
 */
interface CookieOptions<T> {
  default?: () => T;
  decode?: (raw: string) => T;
}
let jar: Record<string, string | undefined> = {};
let lastOptions: CookieOptions<unknown> | null = null;
const refs: Record<string, Ref<unknown>> = {};
function fakeUseCookie<T>(name: string, options: CookieOptions<T> = {}): Ref<T | undefined> {
  lastOptions = options as CookieOptions<unknown>;
  const raw = jar[name];
  const cookie = ref(raw === undefined ? options.default?.() : options.decode!(raw)) as Ref<T | undefined>;
  refs[name] = cookie as Ref<unknown>;
  return cookie;
}

afterEach(() => {
  vi.unstubAllGlobals();
  jar = {};
  lastOptions = null;
});

describe('useProjectFilters', () => {
  test('keeps no cookie for a project whose filters were never changed', () => {
    vi.stubGlobal('useCookie', fakeUseCookie);
    const filters = useProjectFilters(7);
    expect(filters.value).toEqual(defaultProjectFilters());
    expect(lastOptions!.default).toBeUndefined();
    expect(refs['piwi-filters-project-7']!.value).toBeUndefined();
  });

  test('keeps a cookie while the filters differ from the defaults, and removes it on their return', () => {
    vi.stubGlobal('useCookie', fakeUseCookie);
    const filters = useProjectFilters(7);
    const picked = { ...defaultProjectFilters(), environments: ['staging'] };
    filters.value = picked;
    expect(refs['piwi-filters-project-7']!.value).toEqual(picked);
    expect(filters.value).toEqual(picked);

    filters.value = defaultProjectFilters();
    expect(refs['piwi-filters-project-7']!.value).toBeUndefined();
    expect(filters.value).toEqual(defaultProjectFilters());
  });

  test('reads a stored cookie, and removes one that holds the defaults', () => {
    vi.stubGlobal('useCookie', fakeUseCookie);
    jar['piwi-filters-project-7'] = JSON.stringify({ environments: [], branches: ['main'], fullRunsOnly: false });
    expect(useProjectFilters(7).value).toEqual({
      environments: [],
      branches: ['main'],
      fullRunsOnly: false,
      allBranches: false,
    });

    jar['piwi-filters-project-8'] = JSON.stringify(defaultProjectFilters());
    expect(useProjectFilters(8).value).toEqual(defaultProjectFilters());
    expect(refs['piwi-filters-project-8']!.value).toBeUndefined();

    jar['piwi-filters-project-9'] = '{not json';
    expect(useProjectFilters(9).value).toEqual(defaultProjectFilters());
  });
});
