import type { AvatarProps } from '@nuxt/ui';

/**
 * The avatar a picker shows for a tracker icon (an issue type's, a project's),
 * served through the connection since Jira keeps its icons behind its own
 * sign-in. Square and unframed, as Jira draws them; undefined without an icon.
 */
export function useTrackerIcon() {
  const base = (useRuntimeConfig().app?.baseURL ?? '/').replace(/\/$/, '');
  return (connectionId: number | null | undefined, icon: string | null | undefined): AvatarProps | undefined => {
    if (!connectionId || !icon) return undefined;
    return {
      src: `${base}/api/integrations/connections/${connectionId}/icon?path=${encodeURIComponent(icon)}`,
      alt: '',
      loading: 'lazy',
      ui: { root: 'rounded-sm bg-transparent', image: 'rounded-sm' },
    };
  };
}
