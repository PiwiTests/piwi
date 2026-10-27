import type { CommandPaletteGroup } from '@nuxt/ui';
import { AUTHORED_GUIDES } from '~/utils/guides/guides';
import { resolveGuideIds, type GuideApiGet } from '~/utils/guides/resolvers';
import { authoredGuideRun, guideAvailable, guideResolvers } from '~/utils/guides/run';
import type { AuthoredGuide } from '~/utils/guides/types';

/**
 * The authored guides (`app/utils/guides/`): those this user may start on this
 * instance, by each guide's `requires` (a capability not declined, a
 * permission held), and starting one, which first finds the entities its stops
 * open, then hands the guide to the guide engine (`useGuide`). They need no
 * model, so they are listed on every instance. Async: it reads the instance's
 * capability states, as `useInstanceCapabilities` does.
 */
export async function useAuthoredGuides() {
  const guide = useGuide();
  const { canAnywhere } = useAuth();
  const { isHidden } = await useInstanceCapabilities();

  const guides = computed(() =>
    AUTHORED_GUIDES.filter((authored) => guideAvailable(authored, { isHidden, holds: canAnywhere })),
  );

  /** Starts `authored` at its first stop, its stops' entities found first. */
  async function start(authored: AuthoredGuide): Promise<void> {
    if (import.meta.server) return;
    const get: GuideApiGet = <T>(path: string, query?: Record<string, string | number>) => $fetch<T>(path, { query });
    const ids = await resolveGuideIds(guideResolvers(authored), get);
    await guide.start(authoredGuideRun(authored, ids));
  }

  /** The command palette's Guides group, each item starting its guide; none when no guide is listed. */
  function paletteGroups(): CommandPaletteGroup[] {
    if (guides.value.length === 0) return [];
    return [
      {
        id: 'guides',
        label: 'Guides',
        items: guides.value.map((authored) => ({
          id: `guide-${authored.id}`,
          label: authored.title,
          description: authored.summary,
          icon: authored.icon,
          keywords: authored.keywords,
          onSelect: () => void start(authored),
        })),
      },
    ];
  }

  return { guides, start, paletteGroups };
}
