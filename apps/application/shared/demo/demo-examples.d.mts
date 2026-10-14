/**
 * Type declarations for the demo examples registry.
 * See `demo-examples.mjs` for the entries and the `expect` vocabulary.
 */

/** What the generated seed must hold for an example's route to show what it promises. */
export interface DemoExampleExpect {
  testCase?: { id: number; title: string };
  execution?: { id: number; title: string };
  project?: { id: number; name: string };
  cluster?: { id: number; story: string };
  run?: { id: number; project: string };
  diagnosis?: 'with-patch' | 'none';
  fixLanded?: true;
  issue?: { key: string; status: string };
  lab?:
    | 'untested'
    | 'not-reproduced'
    | 'amplified'
    | 'reproduced'
    | 'still-fails'
    | 'inconclusive'
    | 'verified'
    | 'flaked-again';
  resources?: 'leaky';
  incident?: true;
  gaps?: { detectors: string[] };
  suspects?: { path: string; granularity?: 'lines' | 'functions' | 'files' };
}

export interface DemoExample {
  /** Stable, kebab-case. */
  id: string;
  /** The docs page that renders it, as a path under `apps/docs/` without `.md` (`features/flake-lab`). */
  doc: string;
  /** The link text: where it is, `Project › test`. */
  title: string;
  /** One sentence on what the screen shows, plain text. */
  shows: string;
  /** The demo route, from the demo's root (`/test-cases/35?tab=flakiness`). */
  route: string;
  expect: DemoExampleExpect;
}

export declare const DEMO_EXAMPLES: readonly DemoExample[];

/** The examples a docs page renders, in registry order. */
export declare function demoExamplesFor(doc: string): DemoExample[];
