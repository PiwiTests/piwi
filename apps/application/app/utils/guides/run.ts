/** An authored guide as the guide engine (`useGuide`) runs it, and who it is listed for. */
import type { CapabilityId } from '#shared/capabilities';
import { findGuideAnchor } from '#shared/guide-anchors/index.mjs';
import type { Permission } from '#shared/permissions';
import type { GuideRun, GuideWords } from '~/utils/guide/types';
import type { GuideResolverId } from './resolvers';
import type { AuthoredGuide, AuthoredGuideStop } from './types';

/** The words of an authored guide's popover; the dashboard and its guides speak English. */
export const AUTHORED_GUIDE_WORDS: GuideWords = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  close: 'End the guide',
  docs: 'Read the docs',
  progress: '{{current}} of {{total}}',
};

/** The popover's `data-guide` of a guide: `guide-<id>`. */
export function authoredGuideRunId(guide: AuthoredGuide): string {
  return `guide-${guide.id}`;
}

/** What decides whether a guide is listed: the instance's capability states and the user's permissions. */
export interface GuideViewer {
  /** The capability is declined or not applicable on this instance. */
  isHidden: (capability: CapabilityId) => boolean;
  /** The user holds the permission on at least one project, or on the instance. */
  holds: (permission: Permission) => boolean;
}

/** Whether `guide` is listed for `viewer`: its capability is not hidden and the user holds its permission. */
export function guideAvailable(guide: AuthoredGuide, viewer: GuideViewer): boolean {
  const { capability, permission } = guide.requires;
  return !(capability && viewer.isHidden(capability)) && !(permission && !viewer.holds(permission));
}

/** The page a stop opens, as a pattern of `app/pages`: its own, else its anchor's main page. */
export function stopPage(stop: AuthoredGuideStop): string | undefined {
  return stop.page ?? findGuideAnchor(stop.anchor)?.pages[0];
}

/** The resolvers the stops of `guide` name. */
export function guideResolvers(guide: AuthoredGuide): GuideResolverId[] {
  return [...new Set(guide.stops.flatMap((stop) => (stop.resolve ? [stop.resolve] : [])))];
}

/**
 * The guide run of `guide`, with the ids its resolvers found: a stop on an
 * entity's page opens it with the id filled in, and one whose resolver found
 * nothing is `absent`, shown centered at once. Each stop links its anchor's
 * docs page.
 */
export function authoredGuideRun(
  guide: AuthoredGuide,
  ids: Partial<Record<GuideResolverId, number | string | null>>,
): GuideRun {
  return {
    id: authoredGuideRunId(guide),
    lang: 'en',
    stops: guide.stops.map((stop) => {
      const id = stop.resolve ? ids[stop.resolve] : undefined;
      const absent = Boolean(stop.resolve) && (id === null || id === undefined);
      const page = stopPage(stop);
      return {
        id: stop.id,
        anchor: stop.anchor,
        route: stop.resolve && !absent && page ? page.replace('[id]', String(id)) : undefined,
        absent: absent || undefined,
        title: stop.title,
        body: stop.body,
        doc: findGuideAnchor(stop.anchor)?.doc,
        side: stop.side,
        align: stop.align,
      };
    }),
    words: AUTHORED_GUIDE_WORDS,
  };
}
