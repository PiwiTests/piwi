/**
 * The sentence templates of a quality report, one implementation per language
 * (`sentences.en.ts`, `sentences.fr.ts`). Every narrative line (the verdict,
 * what is being done, the risks), every fixed label and the way the language
 * writes numbers and dates come from here, and each template only repeats the
 * numbers it is given.
 *
 * A report language is its code in `languages.ts` and its sentences file,
 * registered in `REPORT_SENTENCES` below; `tests/unit/report-languages.test.ts`
 * names every label or gap title a language still lacks.
 */
import type { MetricId } from '#shared/analytics/metrics';
import type {
  AnalyticsHandbacks,
  AnalyticsListItem,
  AnalyticsProgress,
  AnalyticsRisks,
  AnalyticsTileTarget,
  VerdictFacts,
  VerdictTone,
} from '#shared/analytics/types';
import type { ProjectTargetVerdict } from '#shared/analytics/targets';
import type { InsightFacts, InsightText } from '#shared/analytics/insight-rules';
import type { ValueFormatter } from './format';
import type { ReportLanguage } from './languages';
import { EN_SENTENCES } from './sentences.en';
import { FR_SENTENCES } from './sentences.fr';

export interface ReportLabels {
  qualityReport: string;
  period: string;
  comparedWith: string;
  noComparison: string;
  projects: string;
  allProjects: string;
  branchPolicy: string;
  defaultBranch: string;
  allBranches: string;
  branches: string;
  fullRunsOnly: string;
  allRuns: string;
  testFilter: string;
  definitions: string;
  limits: string;
  generated: string;
  generatedBy: string;
  openInPiwi: string;
  dashboard: string;
  noData: string;
  previous: string;
  metric: string;
  value: string;
  change: string;
  date: string;
  unavailable: string;
  daysAreUtc: string;
  feature: string;
  gapClass: string;
  score: string;
  count: string;
  targets: string;
  /** Before the timeline markers under a chart, in the Markdown. */
  markers: string;
  /** Under the title of a live dashboard link. */
  liveDashboard: string;
  /** Beside the link to the report a share link opens without an account. */
  readWithoutAccount: string;
  /** The title of the AI-written narrative widget. */
  narrative: string;
  /** The email footer, before the instance's address. */
  automatedMessage: string;
  /** The email footer's credit, beside the Piwi mark. */
  sentBy: string;
}

/** How a language writes numbers, units and dates; `makeFormatter` applies it. */
export interface ReportTypography {
  /** BCP-47 locale of numbers and dates when the reader's own locale speaks another language. */
  locale: string;
  units: { min: string; h: string; day: string; days: string; pts: string };
  /** Whether a count takes the singular: English for exactly one, French under two (`0,5 jour`). */
  singular(count: number): boolean;
  /** Between a number and its unit: a space, a narrow no-break space in French (`7,2 min`). */
  unitSpace: string;
  /** Whether `%` takes the unit space too (`12 %` in French, `12%` in English). */
  spacedPercent: boolean;
  /** A date as the locale formats it, written as the language writes it (French `1er sept.`). */
  date(text: string): string;
}

/** The words of the status badge (`badge.svg`), kept short. */
export interface ReportBadgeWords {
  /** `tests on main` */
  label(branches: string): string;
  allBranches: string;
  defaultBranch: string;
  /** The period's length: `30 d`. */
  days(n: number): string;
  /** The verdict when there is no pass rate to show. */
  verdict: Record<VerdictTone, string>;
}

/** One line of the Hand-back outcomes section: the kind, and what became of it. */
export interface HandbackLine {
  label: string;
  text: string;
}

export interface ReportSentences {
  /** The language in itself, for the language pickers: `English`, `Français`. */
  name: string;
  /** The language in English, for the instructions of the AI narrative. */
  englishName: string;
  typography: ReportTypography;
  labels: ReportLabels;
  /** Between a label and its value: `: `, and a no-break space before the colon in French. */
  colon: string;
  /** The rule-based verdict, two or three sentences. */
  verdict(facts: VerdictFacts, f: ValueFormatter): string;
  /** What is being done, one line per fact worth saying. */
  progress(progress: AnalyticsProgress, f: ValueFormatter): string[];
  /**
   * What became of Piwi's hand-backs, one labeled line per kind with something
   * to say; empty when nothing was handed back. A rate under its sample floor
   * is named as too small, never given.
   */
  handbacks(data: AnalyticsHandbacks, f: ValueFormatter): HandbackLine[];
  /** The risks, one line each; empty when there are none. */
  risks(risks: AnalyticsRisks, f: ValueFormatter): string[];
  /** One target over the period, met, missed or with nothing to judge it on. */
  target(verdict: ProjectTargetVerdict, f: ValueFormatter): string;
  /** A tile's target mark; `target` is the formatted target for one project, null across projects. */
  tileTarget(mark: AnalyticsTileTarget, target: string | null): string;
  /** An insight's sentences, written from its facts in the language. */
  insight(facts: InsightFacts, f: ValueFormatter): InsightText;
  /** A metric's label in the language (the catalog label in English). */
  metricLabel(id: MetricId, fallback: string): string;
  /** A metric's one-sentence definition in the language. */
  metricDefinition(id: MetricId, fallback: string): string;
  /** The fixed labels in the language, keyed by their English text; empty in English. */
  titles: Readonly<Record<string, string>>;
  /** A built-in band, widget or column title in the language; other titles pass through. */
  title(text: string): string;
  /** A period's first and last days, formatted: `Aug 1, 2026 to Aug 31, 2026`. */
  dateRange(from: string, to: string): string;
  /** The period line of a report: its name and dates, or the dates of a date range (`name` null). */
  period(name: string | null, range: string): string;
  /** The period compared with, as it reads after `labels.comparedWith`. */
  comparison(name: string, range: string): string;
  /** `All projects, Last 30 days`; a date range (`name` null) is titled by its dates. */
  reportTitle(scope: string, name: string | null, range: string): string;
  /** `3 projects` */
  projectCount(n: number): string;
  /** The note of a widget the test filter does not narrow. */
  testFilterNote(title: string): string;
  /** The limit line of a test filter: where executions start. */
  testFilterLimit(dataStartsAt: string | null): string;
  /** The limit line of the test-identity lists. */
  identityLimit: string;
  /** A scenario gap class in words (`blind-spot` → `Blind spot`). */
  gapClass(cls: string): string;
  /** A scenario gap's title in the language, written again from its detector's template; unknown titles pass through. */
  gapTitle(detector: string | undefined, title: string): string;
  /** A list widget item's name and detail line in the language, from its facts. */
  listItem(item: AnalyticsListItem, f: ValueFormatter): { title: string; detail: string };
  /** The limit line of a schedule's first quality report, which covers only the days since it was created. */
  firstRunLimit(since: string): string;
  /** The label under an AI-written narrative. */
  narrativeGenerated(model: string): string;
  /** The note of a narrative that fell back to the rule-based verdict. */
  narrativeFallback: string;
  badge: ReportBadgeWords;
}

/** Each report language's sentences. */
export const REPORT_SENTENCES: Record<ReportLanguage, ReportSentences> = {
  en: EN_SENTENCES,
  fr: FR_SENTENCES,
};

export function sentencesFor(language: ReportLanguage): ReportSentences {
  return REPORT_SENTENCES[language];
}
