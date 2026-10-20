import { sessionFromEvents, type RawCaptureEvent, type RecordedStep } from '@piwitests/core/recording';
import { toStepsDocument } from '@piwitests/core/steps';
import { bugPhrases, type BugPhrases } from '@piwitests/core/bug-phrases';
import {
  BUG_EVIDENCE_LIMITS,
  BUG_REPORT_VERSION,
  bugReportTextFiles,
  renderBugMarkdown,
  stepShotFile,
  type BugContext,
  type BugReport,
  type BugScreenshot,
  type BugStepShot,
} from '@piwitests/core/bug-report';
import type { StoredBugEvidence, StoredBugScreenshot } from '../shared/bug-storage.js';
import type { StoredStepView } from '../shared/step-views.js';
import { createZip, dataUrlBytes, type ZipEntry } from '../shared/zip.js';

/** The note a report carries when no screenshot was taken and nothing said why. */
export const NO_SCREENSHOT_TAKEN = 'none was taken';

export function screenshotFile(shot: Pick<StoredBugScreenshot, 'moment'>, index: number): string {
  return `screenshots/${index + 1}-${shot.moment}.png`;
}

/** The screenshot of the page as each step began that the worker kept, with its image, at most one per step. */
export function stepShotsOf(
  steps: RecordedStep[],
  views: StoredStepView[],
): Array<{ shot: BugStepShot; dataUrl: string }> {
  const byId = new Map(views.map((view) => [view.id, view]));
  return steps
    .flatMap((step, i) => {
      const view = step.view ? byId.get(step.view.id) : undefined;
      if (!view) return [];
      const shot = {
        step: i,
        file: stepShotFile(i),
        box: step.view!.box,
        viewport: view.viewport,
        takenAt: view.takenAt,
      };
      return [{ shot, dataUrl: view.dataUrl }];
    })
    .slice(0, BUG_EVIDENCE_LIMITS.stepShots);
}

/** The ids of the views a recording's steps began from, for the worker to hand back. */
export function stepViewIds(events: RawCaptureEvent[]): string[] {
  return [...new Set(events.flatMap((event) => (event.view ? [event.view.id] : [])))];
}

/**
 * The report a bug recording makes: its steps as a steps document, its
 * evidence and its context, with the screenshot of each step among `views`.
 */
export function assembleBugReport(input: {
  events: RawCaptureEvent[];
  startedAt: number;
  evidence: StoredBugEvidence;
  screenshots: StoredBugScreenshot[];
  context: BugContext;
  views?: StoredStepView[];
}): BugReport {
  const { evidence } = input;
  const session = sessionFromEvents(input.events, input.startedAt);
  const stepShots = stepShotsOf(session.steps, input.views ?? []).map((s) => s.shot);
  const screenshots: BugScreenshot[] = input.screenshots.map((shot, i) => ({
    file: screenshotFile(shot, i),
    step: shot.step,
    moment: shot.moment,
    takenAt: shot.takenAt,
  }));
  return {
    v: BUG_REPORT_VERSION,
    steps: toStepsDocument(session, { title: evidence.title?.trim() || null }),
    evidence: {
      console: evidence.console,
      consoleDropped: evidence.consoleDropped,
      requests: evidence.requests,
      requestsDropped: evidence.requestsDropped,
      screenshots,
      screenshotNote: screenshots.length > 0 ? null : (evidence.screenshotNote ?? NO_SCREENSHOT_TAKEN),
      outline: evidence.outline,
      ...(stepShots.length > 0 ? { stepShots } : {}),
    },
    context: input.context,
  };
}

/**
 * The language a report's Markdown is written in: core's phrasebook, and the
 * screenshot note (stored in English) in that language.
 */
export interface ReportLanguage {
  phrases: BugPhrases;
  screenshotNote(note: string): string;
}

const ENGLISH_REPORT: ReportLanguage = { phrases: bugPhrases('en'), screenshotNote: (note) => note };

/** The report as Markdown, in `language`. The steps document, the spec and the evidence stay as they are stored. */
export function bugReportMarkdown(report: BugReport, language: ReportLanguage = ENGLISH_REPORT): string {
  const note = report.evidence.screenshotNote;
  const evidence = { ...report.evidence, screenshotNote: note ? language.screenshotNote(note) : null };
  return renderBugMarkdown({ ...report, evidence }, language.phrases);
}

/** The report without its step screenshots, as the reporter chose to share it. */
export function withoutStepShots(report: BugReport): BugReport {
  const { stepShots: _stepShots, ...evidence } = report.evidence;
  return { ...report, evidence };
}

/**
 * Every file of the report's archive: its media type first, then the steps
 * document, the failing test, the Markdown in `language`, the evidence with
 * the context, the screenshots, and the screenshot of each step its evidence
 * names, from `stepImages` (data URLs by file name).
 */
export function bugReportEntries(
  report: BugReport,
  screenshots: StoredBugScreenshot[],
  language: ReportLanguage = ENGLISH_REPORT,
  stepImages: ReadonlyMap<string, string> = new Map(),
): ZipEntry[] {
  return [
    ...bugReportTextFiles(report, bugReportMarkdown(report, language)),
    ...screenshots.map((shot, i) => ({ name: screenshotFile(shot, i), data: dataUrlBytes(shot.dataUrl) })),
    ...(report.evidence.stepShots ?? []).flatMap((shot) => {
      const dataUrl = stepImages.get(shot.file);
      return dataUrl ? [{ name: shot.file, data: dataUrlBytes(dataUrl) }] : [];
    }),
  ];
}

/** The report's `.piwibug` archive. */
export function bugReportArchive(
  report: BugReport,
  screenshots: StoredBugScreenshot[],
  language: ReportLanguage = ENGLISH_REPORT,
  stepImages: ReadonlyMap<string, string> = new Map(),
): Uint8Array {
  return createZip(
    bugReportEntries(report, screenshots, language, stepImages),
    new Date(report.context.time || Date.now()),
  );
}
