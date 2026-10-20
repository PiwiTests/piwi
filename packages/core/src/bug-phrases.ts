/**
 * The words a bug report is written with, one phrasebook per language: the
 * steps in plain words, what should happen, the evidence summary and the
 * Markdown report's headings and labels.
 *
 * `bug-report.ts` reads a step into language-free parts (a {@link BugSubject},
 * a {@link BugStepValue}, a {@link BugExpectation}) and a phrasebook turns them
 * into a sentence. A flat list of messages cannot do that: French articles
 * agree with the noun and elide before a vowel, so each language writes its own
 * templates around its own role nouns. Page texts, locators and test ids reach
 * a phrasebook as they are and come out quoted, never translated.
 */
import { ENGLISH_BUG_PHRASES } from './bug-phrases.en';
import { FRENCH_BUG_PHRASES } from './bug-phrases.fr';
import { GERMAN_BUG_PHRASES } from './bug-phrases.de';
import { SPANISH_BUG_PHRASES } from './bug-phrases.es';
import { PORTUGUESE_BUG_PHRASES } from './bug-phrases.pt';

export { markdownCode } from './markdown-code';

export type NounGender = 'masculine' | 'feminine' | 'neuter';

/** An ARIA role in a language's everyday words, with the gender its articles and adjectives follow. */
export interface RoleNoun {
  noun: string;
  gender?: NounGender;
}

/**
 * How a step names the element it acts on, in order of preference: its role
 * and accessible name, its name alone, its test id, its text, its locator, or
 * only its kind. `element` is `definite` when the sentence refers to one known
 * element ("the button") rather than any ("button", "an element").
 */
export type BugSubject =
  | { kind: 'page' }
  | { kind: 'named'; role: string; name: string }
  | { kind: 'name'; name: string }
  | { kind: 'testId'; testId: string }
  | { kind: 'text'; role: string | null; tagName: string; text: string }
  | { kind: 'locator'; locator: string }
  | { kind: 'element'; role: string | null; tagName: string; definite: boolean };

/** A typed value: the text, or a password that was not recorded. */
export type BugStepValue = { kind: 'text'; text: string } | { kind: 'password' };

export type BugState = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'checked';

/** What a step expects of its subject: `contains` is part of its text, `count` how many elements its locator finds. */
export type BugExpectation =
  | { matcher: 'text' | 'value' | 'name' | 'url' | 'contains'; expected: string }
  | { matcher: 'count'; count: number }
  | { matcher: 'state'; state: BugState };

/** What a report holds besides its steps, counted for its one-line summary. */
interface BugEvidenceCounts {
  screenshots: number;
  /** Screenshots of the page as each step began. */
  stepShots: number;
  consoleErrors: number;
  consoleWarnings: number;
  failedRequests: number;
  outline: boolean;
}

/** The labels and lines of the Markdown report. Arguments arrive formatted: quoted, in code, or as times. */
interface BugReportPhrases {
  /** The title of a report nobody titled, and of one made from its page. */
  untitled: string;
  titleOnPage(pageKey: string): string;
  /** `**Page**`, before the facts about the page. */
  pageLabel: string;
  /** A path and the origin it was on. */
  pathOn(path: string, origin: string): string;
  stepsHeading: string;
  noSteps: string;
  /** Under a step: the value the page showed. */
  actual(value: string): string;
  /** Under a step: the reporter's note. */
  note(text: string): string;
  /** Under a step: the viewport size the page has from that step on, such as `390×844`, and the browser's zoom when not 100% (`1.25`). */
  viewport(size: string, zoom: number | null): string;
  /** Under a step: the test failed at this step in the run the report was made from. */
  failedInRun: string;
  expectedHeading: string;
  nothingMarked: string;
  /** A line of "Expected and actual": step number, the expectation, and what the page showed when known. */
  expectedLine(step: number, expectation: string, actual: string | null): string;
  evidenceHeading: string;
  screenshotsHeading: string;
  screenshotAfterStep(step: number): string;
  screenshotAtFinish: string;
  screenshotByHand: string;
  noScreenshot(reason: string): string;
  /** `Console (3)`, or `Console (100 of 140)` when entries were dropped. */
  consoleHeading(shown: number, total: number | null): string;
  consoleLine(entry: {
    level: 'error' | 'warn';
    source: 'console' | 'error' | 'rejection';
    page: string;
    time: string;
    message: string;
  }): string;
  requestsHeading(shown: number, total: number | null): string;
  requestLine(entry: { request: string; status: number; page: string; time: string }): string;
  outlineHeading: string;
  outlineNote: string;
  /** A report made from a test run: the calls of the test its steps leave out. */
  notReplayedHeading: string;
  notReplayedNote: string;
  /** One left-out call: its title in code, where it is in the test when known, and why. */
  notReplayedLine(entry: { call: string; location: string | null; reason: string }): string;
}

export interface BugPhrases {
  /** The language, as a BCP 47 tag: `en`, `fr`. */
  language: string;
  /** Every ARIA role a report may name. A role missing here is written as it is. */
  roles: Readonly<Record<string, RoleNoun>>;
  /** Page text inside the language's quotation marks. */
  quote(text: string): string;
  /** Code (a URL, a locator, a test id) as a Markdown code span. */
  code(text: string): string;
  /** A key or a key combination as keyboards print it: `Ctrl+A` for `ControlOrMeta+a`. */
  key(name: string): string;
  /** The first letter in upper case, for a sentence that starts with an expectation. */
  capitalize(text: string): string;
  /** One sentence per recorded action. */
  steps: {
    goto(url: string): string;
    click(subject: BugSubject): string;
    /** Hovering over an element, for what shows only while the pointer is on it. */
    hover(subject: BugSubject): string;
    fill(subject: BugSubject, value: BugStepValue): string;
    check(subject: BugSubject): string;
    uncheck(subject: BugSubject): string;
    selectOption(subject: BugSubject, value: BugStepValue): string;
    press(key: string, subject: BugSubject | null): string;
    dblclick(subject: BugSubject): string;
    /** Choosing files in a file field, by their names; none clears the field. */
    setInputFiles(subject: BugSubject, files: readonly string[]): string;
    /** Dragging one element and dropping it on another. */
    dragTo(subject: BugSubject, target: BugSubject): string;
    /** A step to do by hand, from its description (in the words of whoever wrote it). */
    manual(description: string): string;
  };
  /** What should be true of a subject, starting in lower case where the language allows. */
  expectation(subject: BugSubject, expectation: BugExpectation, negated: boolean): string;
  /** `1 screenshot · 2 console errors · page outline`. */
  evidence(counts: BugEvidenceCounts): string;
  report: BugReportPhrases;
}

/** The phrasebooks, by language code. */
export const BUG_PHRASES: Readonly<Record<string, BugPhrases>> = {
  en: ENGLISH_BUG_PHRASES,
  fr: FRENCH_BUG_PHRASES,
  de: GERMAN_BUG_PHRASES,
  es: SPANISH_BUG_PHRASES,
  // Brazilian Portuguese, the one Portuguese the extension ships.
  pt: PORTUGUESE_BUG_PHRASES,
};

/**
 * The phrasebook for a BCP 47 tag (`fr`, `fr-CA`), matched on its language;
 * English when there is none for that language.
 */
export function bugPhrases(language: string | null | undefined = 'en'): BugPhrases {
  const primary = (language ?? 'en').split(/[-_]/)[0]!.toLowerCase();
  return BUG_PHRASES[primary] ?? ENGLISH_BUG_PHRASES;
}
