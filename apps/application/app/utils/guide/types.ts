/**
 * One stop of a guide: a guide anchor (`shared/guide-anchors/`) and what the
 * popover pointing at it says.
 */
export interface GuideStop {
  /** Stable, kebab-case, unique within its guide. */
  id: string;
  /** The id of the guide anchor the popover points at. Omitted, the popover is centered on the page. */
  anchor?: string;
  /**
   * The route the stop opens, from the app's root (`/test-run-cases/37`); the
   * values of its anchor's `query` reveal are added when it leaves them out.
   * Omitted, the stop opens its anchor's main page when that is a fixed path,
   * and stays on the current page otherwise.
   */
  route?: string;
  /** Plain text; `**bold**` is the only markup. */
  title: string;
  /** Plain text; `**bold**` is the only markup. */
  body: string;
  /** The docs page (and `#anchor`) the popover links to. */
  doc?: string;
  /** Where the popover sits against the anchor from `sm` up; below it, the popover goes where it fits. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

/** The words of the popover's controls, in the guide's language. */
export interface GuideWords {
  next: string;
  back: string;
  done: string;
  /** The close button's accessible name. */
  close: string;
  /** The docs link. */
  docs: string;
  /** driver.js's progress line, with its `{{current}}` and `{{total}}` placeholders. */
  progress: string;
}

/** A guide to run: its stops in order, and the words around them. */
export interface GuideRun {
  /** Names the guide: on its popover (`data-guide`) and in `useGuide().activeGuideId`. */
  id: string;
  /** The language of its copy, set as the popover's `lang`. */
  lang: string;
  stops: readonly GuideStop[];
  words: GuideWords;
  /** More data attributes for the popover, by `dataset` key: `{ tourProfile: 'qa' }` sets `data-tour-profile="qa"`. */
  dataset?: Readonly<Record<string, string>>;
  /** Called once **Done** on the last stop has ended the guide. */
  onFinish?: () => void;
}
