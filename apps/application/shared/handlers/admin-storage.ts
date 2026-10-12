import { files, traceBlobs, traceResources, testRuns, projects } from '../../server/database/schema';
import { classifyEvidenceFile } from '../file-classify';
import type { DrizzleDB } from './db';
import type {
  StorageAnalysisData,
  StorageKind,
  StorageKindUsage,
  StorageProjectUsage,
  StorageTimeBucket,
} from '../../types/api';

const DAY_MS = 24 * 60 * 60 * 1000;
const TARGET_BUCKETS = 30;

/** Stable display order for the evidence families. */
const KIND_ORDER: StorageKind[] = ['trace', 'screenshot', 'video', 'report', 'attachment', 'visual-diff'];

/** The storage family a files row belongs to (reports and visual diffs by type; the rest via the shared classifier). */
function storageKindOf(row: { type: string; subtype: string | null; label: string | null; path: string }): StorageKind {
  if (row.type === 'report') return 'report';
  if (row.type === 'visual-diff') return 'visual-diff';
  if (row.type === 'trace') return 'trace';
  return classifyEvidenceFile(row);
}

/**
 * Compute the storage breakdown by evidence family, by project and over time.
 *
 * Physical footprint is counted honestly: a deduplicated trace is stored once
 * in `trace_blobs` (with its shared `trace_resources`), so the many `files`
 * rows that reference a blob contribute to the file *count* but their bytes
 * come from the blob, never from each per-case row. A blob counts what its own
 * files occupy (`stored_size`: the slim ZIP and its manifest), not the size of
 * the trace as uploaded, whose pooled parts the `trace_resources` rows already
 * count; a blob not yet measured by the startup backfill falls back to that
 * uploaded size.
 *
 * Admin-only and computed on demand, so it reads the storage-bearing tables in
 * full and aggregates in one pass — reusing the canonical file classifier
 * rather than re-deriving evidence kinds in SQL, and bucketing time in JS so it
 * runs unchanged on SQLite, PostgreSQL and the in-browser demo database.
 */
export async function getStorageAnalysis(db: DrizzleDB): Promise<StorageAnalysisData> {
  const [fileRows, blobRows, resourceRows, runRows, projectRows] = await Promise.all([
    db
      .select({
        type: files.type,
        subtype: files.subtype,
        label: files.label,
        path: files.path,
        size: files.size,
        blobId: files.blobId,
        testRunId: files.testRunId,
        createdAt: files.createdAt,
      })
      .from(files),
    db
      .select({
        projectId: traceBlobs.projectId,
        size: traceBlobs.size,
        storedSize: traceBlobs.storedSize,
        createdAt: traceBlobs.createdAt,
      })
      .from(traceBlobs),
    db
      .select({ projectId: traceResources.projectId, size: traceResources.size, createdAt: traceResources.createdAt })
      .from(traceResources),
    db.select({ id: testRuns.id, projectId: testRuns.projectId, keptAt: testRuns.keptAt }).from(testRuns),
    db.select({ id: projects.id, name: projects.name, label: projects.label }).from(projects),
  ]);

  // `files` carries no project id; every row does carry the run it belongs to.
  const runToProject = new Map<number, number>();
  const keptRunIds = new Set<number>();
  for (const r of runRows) {
    runToProject.set(r.id, r.projectId);
    if (r.keptAt) keptRunIds.add(r.id);
  }
  let keptBytes = 0;
  let keptFiles = 0;

  const kindBytes = new Map<StorageKind, number>();
  const kindFiles = new Map<StorageKind, number>();
  const projectBytes = new Map<number, number>();
  const projectFiles = new Map<number, number>();
  const timePoints: { t: number; bytes: number }[] = [];

  let totalBytes = 0;
  const totalFiles = fileRows.length;

  const addKind = (kind: StorageKind, bytes: number, count: number) => {
    kindBytes.set(kind, (kindBytes.get(kind) ?? 0) + bytes);
    kindFiles.set(kind, (kindFiles.get(kind) ?? 0) + count);
  };
  const addProject = (projectId: number | undefined, bytes: number, count: number) => {
    if (projectId == null) return;
    projectBytes.set(projectId, (projectBytes.get(projectId) ?? 0) + bytes);
    projectFiles.set(projectId, (projectFiles.get(projectId) ?? 0) + count);
  };

  for (const f of fileRows) {
    const kind = storageKindOf(f);
    const bytes = f.blobId != null ? 0 : (f.size ?? 0);
    totalBytes += bytes;
    addKind(kind, bytes, 1);
    addProject(f.testRunId != null ? runToProject.get(f.testRunId) : undefined, bytes, 1);
    if (bytes > 0) timePoints.push({ t: new Date(f.createdAt).getTime(), bytes });
    if (f.testRunId != null && keptRunIds.has(f.testRunId)) {
      keptBytes += bytes;
      keptFiles += 1;
    }
  }
  for (const b of blobRows) {
    const bytes = b.storedSize ?? b.size;
    totalBytes += bytes;
    addKind('trace', bytes, 0);
    addProject(b.projectId, bytes, 0);
    timePoints.push({ t: new Date(b.createdAt).getTime(), bytes });
  }
  for (const r of resourceRows) {
    totalBytes += r.size;
    addKind('trace', r.size, 0);
    addProject(r.projectId, r.size, 0);
    timePoints.push({ t: new Date(r.createdAt).getTime(), bytes: r.size });
  }

  const byKind: StorageKindUsage[] = KIND_ORDER.map((kind) => ({
    kind,
    bytes: kindBytes.get(kind) ?? 0,
    files: kindFiles.get(kind) ?? 0,
  }))
    .filter((k) => k.bytes > 0 || k.files > 0)
    .sort((a, b) => b.bytes - a.bytes);

  const projectMeta = new Map<number, { name: string; label: string | null }>();
  for (const p of projectRows) projectMeta.set(p.id, { name: p.name, label: p.label });
  const byProject: StorageProjectUsage[] = [...projectBytes.keys()]
    .map((projectId) => ({
      projectId,
      name: projectMeta.get(projectId)?.name ?? `Project ${projectId}`,
      label: projectMeta.get(projectId)?.label ?? null,
      bytes: projectBytes.get(projectId) ?? 0,
      files: projectFiles.get(projectId) ?? 0,
    }))
    .filter((p) => p.bytes > 0 || p.files > 0)
    .sort((a, b) => b.bytes - a.bytes);

  const { overTime, bucketDays } = buildTimeSeries(timePoints);

  return {
    totalBytes,
    totalFiles,
    projectCount: byProject.length,
    byKind,
    byProject,
    overTime,
    bucketDays,
    kept: { runs: keptRunIds.size, files: keptFiles, bytes: keptBytes },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Bucket byte contributions across the real span of the retained data (min to
 * max creation time), aiming for ~`TARGET_BUCKETS` whole-day buckets. Anchored
 * to a UTC-midnight boundary so labels are clean days. The cumulative series
 * ends at the current total footprint.
 */
function buildTimeSeries(points: { t: number; bytes: number }[]): {
  overTime: StorageTimeBucket[];
  bucketDays: number;
} {
  const valid = points.filter((p) => Number.isFinite(p.t));
  if (valid.length === 0) return { overTime: [], bucketDays: 1 };

  let minT = Infinity;
  let maxT = -Infinity;
  for (const p of valid) {
    if (p.t < minT) minT = p.t;
    if (p.t > maxT) maxT = p.t;
  }

  const span = Math.max(DAY_MS, maxT - minT);
  const bucketDays = Math.max(1, Math.ceil(span / TARGET_BUCKETS / DAY_MS));
  const bucketMs = bucketDays * DAY_MS;
  const start = Math.floor(minT / DAY_MS) * DAY_MS;
  const bucketCount = Math.floor((maxT - start) / bucketMs) + 1;

  const bytesByBucket = new Array<number>(bucketCount).fill(0);
  for (const p of valid) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((p.t - start) / bucketMs)));
    bytesByBucket[index] = (bytesByBucket[index] ?? 0) + p.bytes;
  }

  const overTime: StorageTimeBucket[] = [];
  let cumulative = 0;
  for (let i = 0; i < bucketCount; i++) {
    const bucketBytes = bytesByBucket[i] ?? 0;
    cumulative += bucketBytes;
    overTime.push({
      date: new Date(start + i * bucketMs).toISOString().slice(0, 10),
      bytes: bucketBytes,
      cumulativeBytes: cumulative,
    });
  }
  return { overTime, bucketDays };
}
