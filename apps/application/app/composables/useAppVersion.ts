import type { ApiResponse } from '~~/types/api';

/**
 * Whether the server render may name the version: authentication is off, or the visitor is signed in. Authentication
 * counts as on when either the page's or the server's setting says so.
 */
function toldInServerRender(): boolean {
  const config = useRuntimeConfig();
  const authOn =
    Boolean(config.public.authEnabled) ||
    String(config.authEnabled) === 'true' ||
    process.env.PIWI_AUTH_ENABLED === 'true';
  return !authOn || useAuth().authState.value.authenticated;
}

/**
 * The dashboard's version, shared by every caller of the page. The server render names it from the private runtime
 * config to a visitor it may tell; otherwise the browser asks `/api/version`, which tells it to a signed-in caller only.
 * Empty until known, and for a visitor the instance does not tell it to.
 */
export function useAppVersion() {
  const version = useState<string | null>('app-version', () =>
    import.meta.server && toldInServerRender() ? String(useRuntimeConfig().appVersion ?? '') : null,
  );
  if (import.meta.client && version.value === null) {
    version.value = '';
    $fetch<ApiResponse<typeof import('~~/server/api/version.get').default>>('/api/version')
      .then((info) => {
        version.value = info.appVersion ?? '';
      })
      .catch(() => {});
  }
  return computed(() => version.value ?? '');
}
