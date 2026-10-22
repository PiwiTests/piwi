/**
 * Type declarations for the guide anchor registry.
 * See `index.mjs` for how the area files join and which checks hold every entry.
 */
import type { CapabilityId } from '#shared/capabilities';
import type { Permission } from '#shared/permissions';
import type { DemoExampleExpect } from '#shared/demo/demo-examples.mjs';

/** What the engine does on the page before the anchor shows, in order. */
export type GuideReveal =
  | { query: Readonly<Record<string, string>> } // a tab or evidence pane selected through the URL: { tab: 'flaky-tests' }
  | { unfold: string } // the anchor id of the folded section holding it (its first aria-expanded="false" toggle is clicked)
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
  /** Docs page and optional anchor, written as a single-quoted `doc: '…'` literal so docs-drift.test.ts resolves it. */
  doc?: string;
  sample: GuideAnchorSample;
}

/** Every anchor, area by area. */
export declare const GUIDE_ANCHORS: readonly GuideAnchor[];

/** The registry keyed by anchor id. */
export declare const GUIDE_ANCHOR_BY_ID: ReadonlyMap<string, GuideAnchor>;

/** The anchor with this id, or `undefined` when the registry has none. */
export declare function findGuideAnchor(id: string): GuideAnchor | undefined;
