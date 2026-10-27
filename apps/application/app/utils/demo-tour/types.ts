import type { DemoExampleExpect } from '#shared/demo/demo-examples.mjs';

/** The roles a demo visitor picks from; each has its own tour. */
export type TourProfileId = 'developer' | 'qa' | 'product' | 'platform';

/**
 * One stop of a tour: a screen of the demo and the guide anchor on it the
 * popover points at. What the popover says is in the copy files
 * (`copy.<code>.ts`), under the stop's `id`.
 */
export interface TourStop {
  /** Stable, kebab-case, unique within its tour; the key of its copy. */
  id: string;
  /**
   * The demo route the stop opens, from the demo's root (`/test-run-cases/37`).
   * Omitted, the stop stays on the page the previous stop opened: it points at
   * a control of the demo banner, which every page shows.
   */
  route?: string;
  /**
   * What the seed must hold for `route` to show what the stop says, in the
   * vocabulary of the demo examples (`shared/demo/demo-examples.mjs`). Required
   * when the route opens a seeded entity; `tests/unit/demo-seed-consistency.test.ts`
   * checks it against the generated seed.
   */
  expect?: DemoExampleExpect;
  /**
   * The id of the guide anchor the stop points at (`shared/guide-anchors/`); its
   * reveal unfolds or opens what holds it. Omitted, the popover is centered on
   * the page.
   */
  anchor?: string;
  /** Where the popover sits against the target from `sm` up; below it, the popover goes where it fits. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** The docs page (and `#anchor`) the stop links to; `docs-drift.test.ts` resolves it like every `doc` field. */
  doc?: string;
}

export interface TourProfile {
  id: TourProfileId;
  /** A lucide icon for the role. */
  icon: string;
  stops: readonly TourStop[];
}

/** What the popover of one stop says. */
export interface TourStopCopy {
  title: string;
  /** One to three sentences. A dashboard label is `**bold**` and stays in English, as the screen shows it. */
  body: string;
}

/** A role's words: its name, the line under it in the prompt, and each stop's popover by stop id. */
export interface TourProfileCopy {
  label: string;
  hint: string;
  stops: Record<string, TourStopCopy>;
}

/** The shape of a copy file: the tour's own words (`ui`) and every role's. */
export interface TourCopyShape {
  ui: Record<string, string>;
  profiles: Record<TourProfileId, TourProfileCopy>;
}
