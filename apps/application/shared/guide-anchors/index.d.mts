/**
 * Type declarations for the guide anchor registry.
 * See `index.mjs` for how the area files join and which checks hold every entry.
 */
import type { CapabilityId } from '#shared/capabilities';
import type { Permission } from '#shared/permissions';
import type { DemoExampleExpect } from '#shared/demo/demo-examples.mjs';

/**
 * What an anchor names:
 * - `page`: a page's heading area, one per file of `app/pages`;
 * - `tab`: a tab of a page, the panel its `query` reveal selects;
 * - `block`: a section or card;
 * - `row`: one row of a list, the first one shown;
 * - `field`: a settings field, whose `help` is the field's topic in `SETTINGS_PAGES`;
 * - `action`: a primary action button, or the button opening a menu;
 * - `nav`: a sidebar destination, which the command palette offers too.
 */
export type GuideAnchorKind = 'page' | 'tab' | 'block' | 'row' | 'field' | 'action' | 'nav';

/** An area of the dashboard: one file of `shared/guide-anchors/`. */
export type GuideAreaId =
  | 'layout'
  | 'home'
  | 'analytics'
  | 'projects'
  | 'runs'
  | 'executions'
  | 'clusters'
  | 'test-cases'
  | 'setup'
  | 'settings'
  | 'demo';

/** What the engine does on the page before the anchor shows, in order. */
export type GuideReveal =
  | { query: Readonly<Record<string, string>> } // a tab or evidence pane selected through the URL: { tab: 'flaky-tests' }
  | { unfold: string } // the anchor id of the toggle of the folded section holding it, clicked while it reads aria-expanded="false"
  | { open: string }; // the anchor id of the button opening the menu, drawer or modal holding it

export interface GuideAnchorSample {
  /** A demo route (seeded ids) where the anchor renders, with every query its reveal needs. */
  route: string;
  /** The demo persona to act as, by its id in `app/demo/demo-users.json`; the default persona when omitted. */
  persona?: number;
  /** What the seed must hold at that route, in the demo examples' vocabulary; required when the route opens a seeded entity. */
  expect?: DemoExampleExpect;
  /** Where the runtime check opens it; `desktop` anchors are checked in the screenshot harness's desktop mode. */
  surface?: 'demo' | 'desktop';
}

export interface GuideAnchor {
  /** The value of the element's static `data-tour` attribute. */
  id: string;
  kind: GuideAnchorKind;
  /**
   * Patterns of `app/pages` where it renders (`/test-run-cases/[id]`, `/projects/[id]`, `/`), the main one first;
   * `['*']` for the layout and the demo banner, on every page.
   */
  pages: readonly string[];
  reveal?: readonly GuideReveal[];
  /** One sentence: what the block shows and when someone needs it. Read by people and, later, by the model. */
  describes: string;
  /** When it does not always render, the condition in one sentence. */
  shownWhen?: string;
  requires?: { capability?: CapabilityId; permission?: Permission; desktop?: true; demo?: true };
  /** The key in `HELP_TOPICS` (`app/utils/help-content.ts`) of the inline help the block carries. */
  help?: string;
  /** Docs page and optional anchor, written as a single-quoted `doc: '…'` literal so docs-drift.test.ts resolves it. */
  doc?: string;
  sample: GuideAnchorSample;
}

/** A coverage rule of `tests/unit/guide-anchor-coverage.test.ts`: what it asks an anchor for. */
export type GuideCoverageRule =
  | 'page' // a file of app/pages, keyed by its pattern: `/projects/[id]`
  | 'tab' // a tab selected through the URL, keyed as its page and query: `/projects/[id]?tab=runs`
  | 'field' // a field of SETTINGS_PAGES, keyed by its id: `ai.diagnosis`
  | 'help' // a help topic a component sets statically, keyed by its HELP_TOPICS key: `case.network`
  | 'nav'; // a sidebar destination, keyed by its `to`: `/analytics`

/** An item a coverage rule reports that gets no anchor. */
export interface GuideAnchorExemption {
  rule: GuideCoverageRule;
  /** The item, as the rule's report names it. */
  key: string;
  /** One sentence: why it gets no anchor. */
  reason: string;
}

/** One area file: its anchors and the coverage exemptions it declares. */
export interface GuideArea {
  id: GuideAreaId;
  anchors: readonly GuideAnchor[];
  exemptions: readonly GuideAnchorExemption[];
}

/** Every kind an anchor can be. */
export declare const GUIDE_ANCHOR_KINDS: readonly GuideAnchorKind[];

/** The area files, in the sidebar's order. */
export declare const GUIDE_AREAS: readonly GuideArea[];

/** Every anchor, area by area. */
export declare const GUIDE_ANCHORS: readonly GuideAnchor[];

/** Every coverage exemption, area by area. */
export declare const GUIDE_ANCHOR_EXEMPTIONS: readonly GuideAnchorExemption[];

/** The registry keyed by anchor id. */
export declare const GUIDE_ANCHOR_BY_ID: ReadonlyMap<string, GuideAnchor>;

/** The anchor with this id, or `undefined` when the registry has none. */
export declare function findGuideAnchor(id: string): GuideAnchor | undefined;
