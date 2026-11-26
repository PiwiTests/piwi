import type { ApiResponse } from '~~/types/api';

/**
 * The dashboard's version, from `/api/version`, fetched once in the browser and shared by every caller. Empty until it
 * answers, and for a visitor the instance does not tell it to.
 */
export function useAppVersion() {
  const { data } = useFetch<ApiResponse<typeof import('~~/server/api/version.get').default>>('/api/version', {
    key: 'app-version',
    server: false,
    lazy: true,
    dedupe: 'defer',
  });
  return computed(() => data.value?.appVersion ?? '');
}
