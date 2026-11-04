import * as fs from 'node:fs';
import * as os from 'node:os';
import { errorMessage } from '../support/errors.js';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { listArchiveFiles, writeArchive, type ArchiveFile } from './compression.js';
import { Logger } from '../support/logger.js';
import {
  ATTACHMENT_NAMES,
  INTERNAL_ATTACHMENT_NAMES,
  findPiwiAttachment,
  type AttachmentName,
} from '../capture/attachments.js';
import type { CollectedTestCase, RawAttachment, TraceHashInfo } from '../../types.js';

/**
 * Size ceiling for one uploadable attachment, path-backed or inline, and for the
 * files of a report sent in one upload with the run's other files. Matches the
 * dashboard's default multipart upload limit, so a larger file could never land
 * anyway; it is skipped here with one warning instead of failing the upload.
 */
export const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;

/**
 * How much earlier than the run's start a file's time may read and still be the run's: some file systems keep whole
 * seconds.
 */
const FILE_TIME_LEEWAY_MS = 2000;

/** File extension for the content types a test commonly attaches inline. */
const BODY_EXTENSIONS: Record<string, string> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

/** An attachment resolved to a file on disk, ready to stream into an upload form. */
export interface UploadableAttachment {
  name: string;
  path: string;
  contentType: string;
  originalName: string;
}

/**
 * File-system helpers for discovering report directories, trace files, and
 * test attachments, as well as compressing report directories and computing
 * trace-file hashes for deduplication.
 */
export class FileHandler {
  /** Temp files written for body-only attachments, keyed by attachment so repeated lookups reuse one file. */
  private readonly bodyFiles = new WeakMap<RawAttachment, string>();
  /** The temp folder of the files staged for the uploads: body-only attachments and report archives. */
  private stagedDir: string | null = null;
  private stagedCount = 0;
  /** Attachments already reported as oversized, so each one warns once per run. */
  private readonly oversizedWarned = new Set<string>();

  constructor(
    private readonly logger: Logger = new Logger(),
    private readonly maxAttachmentBytes: number = MAX_ATTACHMENT_BYTES,
  ) {}

  /**
   * The folder of the HTML report the run's html reporter wrote: `report.folder` when its `index.html` was written
   * since `report.since` (ms). Null when the run has no html reporter, or the folder holds no report, or an earlier
   * run's.
   */
  findHTMLReport(report: { folder: string; since: number } | null | undefined): string | null {
    if (!report) return null;
    let written: number;
    try {
      written = fs.statSync(path.join(report.folder, 'index.html')).mtimeMs;
    } catch {
      return null;
    }
    if (written < report.since - FILE_TIME_LEEWAY_MS) {
      this.logger.info(
        `The HTML report in ${report.folder} predates this run, so it is not uploaded: list the html reporter before Piwi's, so it writes this run's report before Piwi reads it.`,
      );
      return null;
    }
    return report.folder;
  }

  /** Check if `dir` exists and is a directory; also checks `path.join(process.cwd(), dir)` */
  findReportDirectory(dir: string): string | null {
    const candidates = [dir, path.join(process.cwd(), dir)];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    }
    return null;
  }

  /**
   * The files of a report folder, or null when it cannot be read. A report of any size is listed: the dashboard's
   * upload limit, which its operator sets, decides whether the upload that carries it is taken.
   */
  listReport(reportDir: string): ArchiveFile[] | null {
    try {
      return listArchiveFiles(reportDir);
    } catch (error) {
      this.logger.warn(`Could not read the report in ${reportDir}: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * Whether a report's files together fit the upload limit (`maxAttachmentBytes`), for an upload that carries the
   * report with the run's other files: one over it is left out of that upload, with one warning.
   */
  fitsOneUpload(report: { dir: string; files: ArchiveFile[] }): boolean {
    const bytes = report.files.reduce((sum, file) => sum + file.size, 0);
    if (bytes <= this.maxAttachmentBytes) return true;
    this.logger.warn(
      `Skipping the report in ${report.dir}: its files hold ${formatMiB(bytes)}, over the ${formatMiB(this.maxAttachmentBytes)} upload limit.`,
    );
    return false;
  }

  /**
   * The gzip-compressed archive of a report's files, streamed into a temp file that `cleanupBodyAttachments`
   * deletes. Returns its path, or `null` on failure.
   */
  async compressReport(reportDir: string, files: ArchiveFile[]): Promise<string | null> {
    let target: string | null = null;
    try {
      target = path.join(this.stagingDir(), `${++this.stagedCount}-report.gz`);
      await writeArchive(files, target);
      return target;
    } catch (error) {
      if (target) fs.rmSync(target, { force: true });
      this.logger.warn(`Failed to compress report directory ${reportDir}: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Return resolved paths for all trace attachments on a test case */
  findTraceFiles(testCase: CollectedTestCase): string[] {
    const set = new Set<string>();
    if (testCase.attachments) {
      for (const a of testCase.attachments) {
        if (a.name === 'trace' && a.path) set.add(path.resolve(a.path));
      }
    }
    return Array.from(set);
  }

  /**
   * Return all non-trace, non-internal attachments from a test case as files
   * on disk. Skips `trace` and `piwi-*` attachments. A body-only attachment
   * (`testInfo.attach(name, { body })`) is written to a temp file under
   * `os.tmpdir()` once and reused by later calls; anything above
   * `maxAttachmentBytes` is skipped with a single warning.
   */
  findAllAttachments(testCase: CollectedTestCase): UploadableAttachment[] {
    const result: UploadableAttachment[] = [];
    if (testCase.attachments) {
      for (const a of testCase.attachments) {
        if (a.name === 'trace') continue;
        if (a.name && INTERNAL_ATTACHMENT_NAMES.has(a.name)) continue;
        const resolved = a.path ? this.resolvePathAttachment(a, testCase) : this.resolveBodyAttachment(a, testCase);
        if (resolved) result.push(resolved);
      }
    }
    return result;
  }

  /**
   * Delete the temp files staged for the uploads: those written for body-only attachments, and the report archives.
   * Call once the run's uploads are done.
   */
  cleanupBodyAttachments(): void {
    if (!this.stagedDir) return;
    try {
      fs.rmSync(this.stagedDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.debug(`Could not remove temp attachments at ${this.stagedDir}: ${errorMessage(error)}`);
    }
    this.stagedDir = null;
  }

  private resolvePathAttachment(a: RawAttachment, testCase: CollectedTestCase): UploadableAttachment | null {
    if (!a.path || !fs.existsSync(a.path)) return null;
    const size = fs.statSync(a.path).size;
    if (size > this.maxAttachmentBytes) {
      this.warnOversized(a, testCase, size);
      return null;
    }
    return {
      name: a.name || 'attachment',
      path: path.resolve(a.path),
      contentType: a.contentType || 'application/octet-stream',
      originalName: path.basename(a.path),
    };
  }

  private resolveBodyAttachment(a: RawAttachment, testCase: CollectedTestCase): UploadableAttachment | null {
    if (!a.body) return null;
    const body = Buffer.isBuffer(a.body) ? a.body : Buffer.from(a.body as Uint8Array);
    if (body.length > this.maxAttachmentBytes) {
      this.warnOversized(a, testCase, body.length);
      return null;
    }
    const contentType = a.contentType || 'application/octet-stream';
    const baseName = safeFileName(a.name || 'attachment');
    const extension = BODY_EXTENSIONS[contentType] ?? '';
    // A name that already ends in its type's extension (`notes.txt`) keeps it once.
    const originalName = baseName.toLowerCase().endsWith(extension) ? baseName : `${baseName}${extension}`;
    let filePath = this.bodyFiles.get(a);
    if (!filePath) {
      try {
        filePath = path.join(this.stagingDir(), `${++this.stagedCount}-${originalName}`);
        fs.writeFileSync(filePath, body);
        this.bodyFiles.set(a, filePath);
      } catch (error) {
        this.logger.warn(`Could not stage attachment "${a.name}" for upload: ${errorMessage(error)}`);
        return null;
      }
    }
    return { name: a.name || 'attachment', path: filePath, contentType, originalName };
  }

  private stagingDir(): string {
    if (!this.stagedDir) this.stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-dashboard-attachments-'));
    return this.stagedDir;
  }

  private warnOversized(a: RawAttachment, testCase: CollectedTestCase, size: number): void {
    const key = `${testCase.location}\x00${a.name}`;
    if (this.oversizedWarned.has(key)) return;
    this.oversizedWarned.add(key);
    this.logger.warn(
      `Skipping attachment "${a.name}" on "${testCase.title}": ${formatMiB(size)} exceeds the ${formatMiB(this.maxAttachmentBytes)} upload limit.`,
    );
  }

  /** Mapping of well-known report type names to their default output directories */
  getDefaultReportDirs(): Record<string, string> {
    return {
      html: 'playwright-report',
      monocart: 'monocart-report',
      allure: 'allure-report',
      blob: 'blob-report',
    };
  }

  /** Parse Piwi-internal attachment bodies (`piwi-network`, `piwi-web-vitals`, `piwi-console`, `piwi-aria-snapshot`, `piwi-aria-snapshot-json`) into structured fields on the test case */
  parsePerformanceAttachments(testCase: CollectedTestCase, attachments: RawAttachment[]): void {
    const find = (name: AttachmentName) => findPiwiAttachment(attachments, name);

    const net = find(ATTACHMENT_NAMES.network);
    if (net?.body) {
      try {
        testCase.networkRequests = JSON.parse((net.body as Buffer).toString());
      } catch {
        /* ignore */
      }
    }

    const vitals = find(ATTACHMENT_NAMES.webVitals);
    if (vitals?.body) {
      try {
        testCase.webVitals = JSON.parse((vitals.body as Buffer).toString());
      } catch {
        /* ignore */
      }
    }

    const consoleLog = find(ATTACHMENT_NAMES.console);
    if (consoleLog?.body) {
      try {
        testCase.consoleLogs = JSON.parse((consoleLog.body as Buffer).toString());
      } catch {
        /* ignore */
      }
    }

    const dialogs = find(ATTACHMENT_NAMES.dialogs);
    if (dialogs?.body) {
      try {
        testCase.dialogs = JSON.parse((dialogs.body as Buffer).toString());
      } catch {
        /* ignore */
      }
    }

    const aria = find(ATTACHMENT_NAMES.ariaSnapshot);
    if (aria?.body) testCase.ariaSnapshot = (aria.body as Buffer).toString();

    const ariaJson = find(ATTACHMENT_NAMES.ariaSnapshotJson);
    if (ariaJson?.body) testCase.ariaSnapshotJson = (ariaJson.body as Buffer).toString();

    const pageState = find(ATTACHMENT_NAMES.pageState);
    if (pageState?.body) {
      try {
        testCase.pageState = JSON.parse((pageState.body as Buffer).toString());
      } catch {
        /* ignore */
      }
    }

    const pageInventory = find(ATTACHMENT_NAMES.pageInventory);
    if (pageInventory?.body) {
      try {
        testCase.pageInventory = JSON.parse((pageInventory.body as Buffer).toString());
      } catch {
        /* ignore */
      }
    }

    // The AI-step usage manifest ({ entries: string[] }) — an internal
    // attachment (never file-uploaded), read here so the dashboard can track
    // which committed AI-step artifacts a run actually replayed.
    const aiUsage = find(ATTACHMENT_NAMES.aiUsage);
    if (aiUsage?.body) {
      try {
        testCase.aiUsage = JSON.parse((aiUsage.body as Buffer).toString());
      } catch {
        /* ignore */
      }
    }
  }

  /** Compute SHA-256 hash and size for a single test case's trace file. Returns `null` when the case has no trace on disk. */
  async computeSingleTraceHash(testCase: CollectedTestCase): Promise<TraceHashInfo | null> {
    const tracePaths = this.findTraceFiles(testCase);
    let lastPath: string | null = null;
    for (const tp of tracePaths) {
      if (fs.existsSync(tp)) lastPath = tp;
    }
    if (!lastPath) return null;

    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(lastPath!)
        .on('data', (chunk: Buffer) => hash.update(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
    return {
      tracePath: lastPath,
      hash: hash.digest('hex'),
      size: fs.statSync(lastPath).size,
    };
  }

  /**
   * Ask the server which trace hashes it already has, returning the set of hashes that are missing: all of them when
   * it does not say. `signal` ends the check, and once it is aborted no check is made.
   */
  async checkMissingTraces(
    httpClient: { postJSON(path: string, payload: any, auth?: string | null, signal?: AbortSignal): Promise<any> },
    projectName: string,
    traceHashMap: Map<number, { hash: string }>,
    auth: string | null,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    if (traceHashMap.size === 0) return new Set();
    const hashes = [...traceHashMap.values()].map((h) => h.hash);
    if (signal?.aborted) return new Set(hashes);

    try {
      const response = await httpClient.postJSON('/api/traces/check', { projectName, hashes }, auth, signal);
      const missing = Array.isArray(response.missing) ? response.missing : hashes;
      return new Set(missing);
    } catch {
      return new Set(hashes);
    }
  }
}

/**
 * Longest base name a body attachment is staged and stored under. The name is ASCII, so this is its byte count: with
 * its extension and the staging prefix, it stays within the 255-byte file-name limit of common file systems.
 */
const MAX_BASE_NAME_LENGTH = 200;

/**
 * Attachment name reduced to characters safe in a file name, holding no `..` and neither starting nor ending in `.`
 * or `-`, so the extension the caller appends never forms `..` (`expired one.` gives `expired-one`). A name longer
 * than `MAX_BASE_NAME_LENGTH` keeps its head, then the first 8 hex digits of the full name's SHA-256, so two long
 * names stay apart, then its own extension (`.gif`), which the dashboard serves the file by.
 */
function safeFileName(name: string): string {
  const safe =
    name
      .replace(/[^\w.-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+|[-.]+$/g, '') || 'attachment';
  if (safe.length <= MAX_BASE_NAME_LENGTH) return safe;
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(safe)?.[0] ?? '';
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  const head = safe.slice(0, MAX_BASE_NAME_LENGTH - extension.length - hash.length - 1).replace(/[-.]+$/, '');
  return `${head}-${hash}${extension}`;
}

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}
