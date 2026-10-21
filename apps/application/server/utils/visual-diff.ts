/**
 * Visual screenshot diff — pixel-compare a failing execution's screenshot
 * against the same test's last passing execution (same browser). Computed
 * lazily on first request; the overlay PNG is stored and the metrics are
 * persisted on a `files` row (`type='visual-diff'`) so later requests and the
 * AI diagnosis context reuse the cached artifact.
 */
import { and, desc, eq } from 'drizzle-orm';
import pixelmatch from 'pixelmatch';
import { files, testRuns, testRunsCases } from '../database/schema';
import { getStorage } from '../storage';
import { selectCaseScreenshots, type ScreenshotFileRow } from './case-screenshots';
import { baselineEnvironmentNote, rankBaselineCandidates } from '#shared/baseline-order';
import type { DrizzleDB } from '#shared/handlers/db';
import { eligibleRunSql } from '#shared/run-eligibility';

/** Passing executions inspected when choosing the baseline. */
const BASELINE_CANDIDATES = 20;

export interface VisualDiffMetadata {
  changedPixels: number;
  /** changedPixels / (width × height) of the compared (union) canvas. */
  changedPixelRatio: number;
  width: number;
  height: number;
  /**
   * True when the two screenshots had different dimensions (compared on a
   * padded union canvas) — the ratio is inflated and must be presented as
   * unreliable wherever it is shown.
   */
  dimensionMismatch: boolean;
  baselineTestRunsCaseId: number;
  baselineRunId: number;
  failingPath: string;
  baselinePath: string;
  /**
   * Set when no passing screenshot from the failing run's environment exists
   * and the baseline came from another one.
   */
  baselineNote?: string | null;
}

export interface VisualDiffResult {
  status: 'ok' | 'no-screenshot' | 'no-baseline' | 'not-found' | 'error';
  /** Overlay artifact path + metrics (status 'ok'). */
  diff?: { path: string } & VisualDiffMetadata;
}

interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Copy a raw RGBA image onto the top-left of a transparent width×height canvas. */
function padToCanvas(img: RawImage, width: number, height: number): Uint8Array {
  if (img.width === width && img.height === height) return img.data;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < img.height; y++) {
    out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * width * 4);
  }
  return out;
}

/**
 * Diff two raw RGBA images. Mismatched dimensions are compared on the padded
 * union canvas (never resampled — resizing would manufacture fake diffs).
 * Pure so the pixel math is unit-testable without storage or sharp.
 */
export function diffRawImages(
  a: RawImage,
  b: RawImage,
  opts?: { threshold?: number },
): { changedPixels: number; width: number; height: number; dimensionMismatch: boolean; overlay: Uint8Array } {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const dimensionMismatch = a.width !== b.width || a.height !== b.height;

  const aData = padToCanvas(a, width, height);
  const bData = padToCanvas(b, width, height);
  const overlay = new Uint8Array(width * height * 4);

  const changedPixels = pixelmatch(aData, bData, overlay, width, height, {
    threshold: opts?.threshold ?? 0.1,
    includeAA: false,
  });

  return { changedPixels, width, height, dimensionMismatch, overlay };
}

/** Strip Playwright's status prefixes and ordinal suffixes for name matching. */
function normalizeShotName(row: ScreenshotFileRow): string {
  const base = (row.subtype || row.path.split('/').pop() || '').toLowerCase();
  return base
    .replace(/\.(png|jpe?g|gif|webp)$/, '')
    .replace(/^test-(failed|finished|passed)-?/, '')
    .replace(/-?\d+$/, '');
}

/** Pick the baseline screenshot that best matches the failing one (name, else newest). */
function pickBaselineShot(failing: ScreenshotFileRow, candidates: ScreenshotFileRow[]): ScreenshotFileRow {
  const wanted = normalizeShotName(failing);
  return candidates.find((c) => normalizeShotName(c) === wanted) ?? candidates[0]!;
}

async function loadRawImage(path: string): Promise<RawImage | null> {
  try {
    const storage = getStorage();
    const buf = await storage.readFile(path);
    const { default: sharp } = await import('sharp');
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  } catch {
    return null;
  }
}

function toResult(row: { path: string; metadata: unknown }): VisualDiffResult {
  const meta = row.metadata as VisualDiffMetadata | null;
  if (!meta) return { status: 'error' };
  return { status: 'ok', diff: { path: row.path, ...meta } };
}

/**
 * Return the cached visual diff for an execution, computing and persisting it
 * on first request. Shared by the REST endpoint and the AI context builder.
 */
export async function getOrComputeVisualDiff(db: DrizzleDB, testRunsCaseId: number): Promise<VisualDiffResult> {
  // Cached artifact?
  const cached = await db
    .select({ path: files.path, metadata: files.metadata })
    .from(files)
    .where(and(eq(files.testRunsCaseId, testRunsCaseId), eq(files.type, 'visual-diff')))
    .limit(1);
  if (cached[0]) return toResult(cached[0]);

  const failingRows = await db
    .select({
      id: testRunsCases.id,
      testRunId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      projectId: testRuns.projectId,
      branch: testRuns.branch,
      environment: testRuns.environment,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, testRunsCaseId))
    .limit(1);
  const failing = failingRows[0];
  if (!failing || failing.testCaseId == null) return { status: 'not-found' };

  const failingShots = await selectCaseScreenshots(db, testRunsCaseId);
  if (failingShots.length === 0) return { status: 'no-screenshot' };
  const failingShot = failingShots[0]!;

  // Last passing execution (same browser) that has at least one screenshot.
  // Executions from the failing run's environment come first, then its own
  // branch (a branch that intentionally redesigns a page is diffed against its
  // own last-good state, not the pre-redesign baseline), then the most recent.
  const conds = [
    eq(testRunsCases.testCaseId, failing.testCaseId),
    eq(testRunsCases.status, 'passed'),
    eligibleRunSql('baseline'),
  ];
  if (failing.browserName) conds.push(eq(testRunsCases.browserName, failing.browserName));
  const passingRows = await db
    .select({
      id: testRunsCases.id,
      runId: testRunsCases.testRunId,
      branch: testRuns.branch,
      environment: testRuns.environment,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conds))
    .orderBy(desc(testRuns.startTime), desc(testRunsCases.id))
    .limit(BASELINE_CANDIDATES);

  const failingScope = { environment: failing.environment ?? null, branch: failing.branch ?? null };
  const passings = rankBaselineCandidates(failingScope, passingRows);

  let baseline: (typeof passingRows)[number] | null = null;
  let baselineShot: ScreenshotFileRow | null = null;
  for (const p of passings) {
    const shots = await selectCaseScreenshots(db, p.id);
    if (shots.length > 0) {
      baseline = p;
      baselineShot = pickBaselineShot(failingShot, shots);
      break;
    }
  }
  if (!baseline || !baselineShot) return { status: 'no-baseline' };

  const [failingImg, baselineImg] = await Promise.all([
    loadRawImage(failingShot.path),
    loadRawImage(baselineShot.path),
  ]);
  if (!failingImg || !baselineImg) return { status: 'error' };

  try {
    const { changedPixels, width, height, dimensionMismatch, overlay } = diffRawImages(failingImg, baselineImg);

    const { default: sharp } = await import('sharp');
    const overlayPng = await sharp(Buffer.from(overlay), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();

    const storage = getStorage();
    const dir = `project-${failing.projectId}/run-${failing.testRunId}/visual-diffs`;
    const path = `${dir}/${testRunsCaseId}-vs-${baseline.id}.png`;
    await storage.mkdir(dir);
    await storage.writeFile(path, overlayPng);

    const metadata: VisualDiffMetadata = {
      changedPixels,
      changedPixelRatio: Math.round((changedPixels / (width * height)) * 10000) / 10000,
      width,
      height,
      dimensionMismatch,
      baselineTestRunsCaseId: baseline.id,
      baselineRunId: baseline.runId,
      failingPath: failingShot.path,
      baselinePath: baselineShot.path,
      baselineNote: baselineEnvironmentNote(failingScope, baseline),
    };

    await db.insert(files).values({
      testRunId: failing.testRunId,
      testRunsCaseId,
      type: 'visual-diff',
      subtype: 'overlay',
      label: 'Visual diff vs last pass',
      path,
      size: overlayPng.length,
      metadata,
    });

    return { status: 'ok', diff: { path, ...metadata } };
  } catch {
    return { status: 'error' };
  }
}
