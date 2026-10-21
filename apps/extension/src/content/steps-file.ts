import { BUG_REPORT_FILES, bugReportFromFiles } from '@piwitests/core/bug-report';
import { parseSteps, type PiwiSteps } from '@piwitests/core/steps';
import { t } from '../shared/i18n.js';
import type { ReplayStepView } from '../shared/step-views.js';
import { readZipEntry } from '../shared/zip.js';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * What a bug report archive's evidence adds to its steps: the screenshot of
 * each step it names (none of an image that cannot be read), and, in a report
 * made from a test run, the step the test failed at there. Nothing when its
 * evidence cannot be read.
 */
async function evidenceOf(
  bytes: Uint8Array,
  steps: string,
  stepCount: number,
): Promise<{ views: ReplayStepView[]; runFailedStep: number | null }> {
  const evidence = await readZipEntry(bytes, BUG_REPORT_FILES.evidence).catch(() => null);
  if (!evidence) return { views: [], runFailedStep: null };
  const report = bugReportFromFiles({ steps, evidence: new TextDecoder().decode(evidence) });
  if (!report.ok) return { views: [], runFailedStep: null };
  const views: ReplayStepView[] = [];
  for (const shot of report.report.evidence.stepShots ?? []) {
    if (shot.step >= stepCount) continue;
    const image = await readZipEntry(bytes, shot.file).catch(() => null);
    if (!image) continue;
    views.push({
      step: shot.step,
      dataUrl: `data:image/jpeg;base64,${base64(image)}`,
      box: shot.box,
      viewport: shot.viewport,
    });
  }
  return { views, runFailedStep: report.report.export?.failedStep ?? null };
}

/**
 * The steps inside a file someone chose, a steps document or the bug report
 * archive that holds one as `steps.json`, the screenshot of each step the
 * archive holds, and the step a report made from a test run failed at there.
 */
export async function readReportFile(
  name: string,
  bytes: Uint8Array,
): Promise<{ steps: PiwiSteps; views: ReplayStepView[]; runFailedStep: number | null }> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let text: string;
  if (isZip) {
    let entry: Uint8Array | null;
    try {
      entry = await readZipEntry(bytes, BUG_REPORT_FILES.steps);
    } catch {
      throw new Error(t('replay_zipUnreadable', { file: name }));
    }
    if (!entry) throw new Error(t('replay_zipNoSteps', { file: name }));
    text = new TextDecoder().decode(entry);
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const parsed = parseSteps(text);
  if (!parsed.ok) throw new Error(t('replay_fileNotSteps', { file: name, error: parsed.errors[0] ?? '' }));
  const extras = isZip ? await evidenceOf(bytes, text, parsed.steps.steps.length) : { views: [], runFailedStep: null };
  return { steps: parsed.steps, ...extras };
}

/** The steps inside a file someone chose; see {@link readReportFile}. */
export async function readStepsFile(name: string, bytes: Uint8Array): Promise<PiwiSteps> {
  return (await readReportFile(name, bytes)).steps;
}
