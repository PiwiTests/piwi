import type { CapabilityId } from '#shared/capabilities';
import type { Permission } from '#shared/permissions';
import type { GuideResolverId } from './resolvers';

/**
 * One stop of an authored guide: a guide anchor (`shared/guide-anchors/`) on
 * the page it renders on, and what the popover says. Its docs link is the
 * anchor's `doc`.
 */
export interface AuthoredGuideStop {
  /** Stable, kebab-case, unique within its guide. */
  id: string;
  /** The id of the guide anchor the popover points at. */
  anchor: string;
  /**
   * The entity whose page the stop opens, for an anchor on a page with an
   * `[id]`: a resolver of `GUIDE_RESOLVERS` finds it on this instance. Omitted,
   * the stop opens its anchor's main page, a fixed path.
   */
  resolve?: GuideResolverId;
  /** The page pattern the resolved id fills, one of the anchor's and the resolver's pages; the anchor's main page when omitted. */
  page?: string;
  /** Plain text, at most 60 characters; `**bold**` is the only markup. */
  title: string;
  /** Plain text, at most 360 characters; a dashboard label is `**bold**`, spelled as the screen shows it. */
  body: string;
  /** Where the popover sits against the anchor from `sm` up. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

/** A guide written for a task people ask about often, run by the guide engine on any instance. */
export interface AuthoredGuide {
  /** Stable, kebab-case, unique; the popover's `data-guide` is `guide-<id>`. */
  id: string;
  /** The task, at most 60 characters, as the command palette and the assistant panel list it. */
  title: string;
  /** One line under the title: what the guide shows. */
  summary: string;
  /** A lucide icon (`i-lucide-…`). */
  icon: string;
  /** More words the command palette finds it by, lower case. */
  keywords: readonly string[];
  /** What a user and the instance need for the guide to be listed, in the anchor registry's vocabulary. */
  requires: { capability?: CapabilityId; permission?: Permission };
  /** 3 to 7 stops. */
  stops: readonly AuthoredGuideStop[];
}
