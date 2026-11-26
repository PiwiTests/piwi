import type { ApiResponse } from '~~/types/api';

/**
 * The dashboard's version, from `/api/version`, fetched once and shared: the public settings every page carries hold
 * none of it. Empty until it answers, and for a visitor the instance does not tell.
 */
export function useAppVersion() {
  const { data } = useFetch<ApiResponse<typeof import('~~/server/api/version.get').default>>('/api/version', {
    key: 'app-version',
    lazy: true,
  });
  return computed(() => data.value?.appVersion ?? '');
}
