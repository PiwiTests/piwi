/**
 * `piwi coverage upload` — send another tool's coverage report to the
 * dashboard: the coverage of a unit-test suite (Vitest, coverlet, Microsoft
 * code coverage) or of a backend Piwi does not instrument, read from Cobertura
 * or LCOV, keyed by the commit and a suite name.
 *
 * The command reads each report as a stream, resolves its paths against the
 * checkout, keeps the files in the project's coverage scope, names each file's
 * version by its git blob id, and sends paths, line numbers and blob ids only,
 * with the commit's file inventory (its tracked files in scope and their blob
 * ids), in requests within the dashboard's limits. Parts of one commit and
 * suite merge on the dashboard, so shards and portals upload separately.
 *
 * Exit codes: 0 uploaded, 1 nothing to upload (no report, or no file of the
 * reports in the checkout), 2 the upload could not be made.
 */
import * as path from 'node:path';
import type { CoverageReportFormat, ReportedFile } from '@piwitests/core/coverage-formats';
import {
  DEFAULT_COVERAGE_SCOPE,
  compileCoverageScope,
  parseCoverageScope,
  type CoverageScope,
} from '@piwitests/core/coverage-scope';
import { gitHashObjects } from '../internal/collect/blob-ids.js';
import { resolveScmBranch } from '../internal/collect/metadata-collector.js';
import { readCheckout, readInventory } from '../internal/coverage-upload/git-inventory.js';
import {
  expandPattern,
  readReport,
  resolveReport,
  type ResolvedReports,
} from '../internal/coverage-upload/report-files.js';
import { resolveProjectId } from '../internal/support/selection-client.js';

const EXIT_OK = 0;
const EXIT_NOTHING = 1;
const EXIT_ERROR = 2;

/** Files per request at most, under the dashboard's 20,000. */
const FILES_PER_REQUEST = 5000;
/** JSON bytes per request at most, under the dashboard's 16 MB. */
const BYTES_PER_REQUEST = 8 * 1024 * 1024;
/** Inventory entries per request at most, under the dashboard's 100,000. */
const INVENTORY_PER_REQUEST = 50_000;

const SUITE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const USAGE = `
piwi coverage upload — send a coverage report of a suite to the dashboard

Usage:
  npx @piwitests/reporter coverage upload <file or pattern>... --suite <name> [options]

Reports:
  <file or pattern>        Cobertura or LCOV files; quote patterns ("**/coverage.cobertura.xml")
  --format <format>        cobertura or lcov; detected from the content when absent
  --root <dir>             The directory the reports' relative paths start from; tried
                           against each report's <source>, the current directory, the
                           report's directory and its parent, and the repository root otherwise

Suite:
  --suite <name>           The suite the report covers, e.g. unit-back or unit-front
  --kind <kind>            unit (the default) or e2e

Connection:
  --project <name|id>      Project                 (env PIWI_PROJECT_NAME)
  --server-url <url>       Dashboard URL           (env PIWI_DASHBOARD_URL)
  --api-key <key>          API key                 (env PIWI_API_KEY)
  --branch <name>          The branch              (env PIWI_BRANCH, the CI's, else git's)

Other:
  --dry-run                Read and resolve the reports, print the summary, send nothing
  --json                   Print the summary as JSON
  -h, --help               Show this help

Exit codes: 0 uploaded, 1 nothing to upload, 2 the upload could not be made.
`.trim();

/** The arguments of an upload. */
export interface CoverageUploadArgs {
  patterns: string[];
  suite: string;
  kind: 'unit' | 'e2e';
  format?: CoverageReportFormat;
  root?: string;
  project: string;
  serverUrl: string;
  apiKey: string | null;
  branch?: string;
  dryRun: boolean;
  json: boolean;
}

/** Options that take a value; the rest of the arguments are flags or report patterns. */
const VALUE_OPTIONS = new Set([
  '--suite',
  '--kind',
  '--format',
  '--root',
  '--project',
  '--server-url',
  '--api-key',
  '--branch',
]);

export function parseCoverageUploadArgs(argv: string[], env: NodeJS.ProcessEnv): CoverageUploadArgs {
  const values = new Map<string, string>();
  const patterns: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_OPTIONS.has(name)) {
      const value = eq > 0 && arg.startsWith('--') ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') throw new Error(`${name} expects a value`);
      values.set(name, value);
    } else if (arg.startsWith('--')) {
      flags.add(arg);
    } else {
      patterns.push(arg);
    }
  }
  const unknown = [...flags].filter((flag) => flag !== '--dry-run' && flag !== '--json');
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown[0]}`);
  if (patterns.length === 0) throw new Error('No report — name the Cobertura or LCOV files to upload');

  const suite = values.get('--suite') ?? '';
  if (!SUITE.test(suite)) {
    throw new Error('--suite names the suite: 1 to 64 letters, digits, ".", "_" or "-", e.g. unit-back');
  }
  const kind = values.get('--kind') ?? 'unit';
  if (kind !== 'unit' && kind !== 'e2e') throw new Error('--kind is unit or e2e');
  const format = values.get('--format');
  if (format !== undefined && format !== 'cobertura' && format !== 'lcov') {
    throw new Error('--format is cobertura or lcov');
  }
  const serverUrl = (values.get('--server-url') ?? env.PIWI_DASHBOARD_URL ?? '').replace(/\/+$/, '');
  const dryRun = flags.has('--dry-run');
  if (!serverUrl && !dryRun) throw new Error('No dashboard URL — pass --server-url or set PIWI_DASHBOARD_URL');
  const project = values.get('--project') ?? env.PIWI_PROJECT_NAME ?? '';
  if (!project && !dryRun) throw new Error('No project — pass --project or set PIWI_PROJECT_NAME');
  return {
    patterns,
    suite,
    kind,
    ...(format ? { format } : {}),
    ...(values.get('--root') ? { root: values.get('--root') } : {}),
    project,
    serverUrl,
    apiKey: values.get('--api-key') ?? env.PIWI_API_KEY ?? null,
    ...(values.get('--branch') ? { branch: values.get('--branch') } : {}),
    dryRun,
    json: flags.has('--json'),
  };
}

/** One request body of an upload. */
export interface UploadPart {
  v: 1;
  commit: string;
  branch?: string;
  suite: string;
  kind: 'unit' | 'e2e';
  tool: string;
  incomplete?: boolean;
  inventory?: Array<[string, string]>;
  files: Array<{
    path: string;
    blob?: string;
    executable: ReportedFile['executable'];
    lines: ReportedFile['lines'];
    functions?: ReportedFile['functions'];
    allFunctions?: ReportedFile['allFunctions'];
  }>;
}

/**
 * The requests of an upload: the files in parts of at most 5,000 files and
 * 8 MB, the inventory in parts of at most 50,000 entries, carried by the first
 * parts (with no file when the inventory needs more parts than the files).
 */
export function splitUpload(
  head: Omit<UploadPart, 'files' | 'inventory'>,
  files: UploadPart['files'],
  inventory: Array<[string, string]>,
): UploadPart[] {
  const fileParts: Array<UploadPart['files']> = [];
  let part: UploadPart['files'] = [];
  let bytes = 0;
  for (const file of files) {
    const size = JSON.stringify(file).length + 1;
    if (part.length > 0 && (part.length >= FILES_PER_REQUEST || bytes + size > BYTES_PER_REQUEST)) {
      fileParts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(file);
    bytes += size;
  }
  if (part.length > 0) fileParts.push(part);
  const inventoryParts: Array<Array<[string, string]>> = [];
  for (let i = 0; i < inventory.length; i += INVENTORY_PER_REQUEST) {
    inventoryParts.push(inventory.slice(i, i + INVENTORY_PER_REQUEST));
  }
  const count = Math.max(fileParts.length, inventoryParts.length, 1);
  return Array.from({ length: count }, (_, i) => ({
    ...head,
    ...(inventoryParts[i] ? { inventory: inventoryParts[i] } : {}),
    files: fileParts[i] ?? [],
  }));
}

/** What an upload came to, as the summary prints it. */
export interface UploadSummary {
  commit: string;
  branch: string | null;
  suite: string;
  reports: string[];
  files: number;
  unmatched: number;
  outOfScope: number;
  inventoryFiles: number;
  requests: number;
  /** The report on the dashboard once uploaded: its files across every part so far. */
  reportFiles?: number;
}

function formatSummary(summary: UploadSummary, dryRun: boolean): string {
  const lines = [
    `${dryRun ? 'Would upload' : 'Uploaded'} ${summary.suite} for ${summary.commit.slice(0, 7)}${
      summary.branch ? ` (${summary.branch})` : ''
    }: ${summary.files} file${summary.files === 1 ? '' : 's'} from ${summary.reports.length} report${
      summary.reports.length === 1 ? '' : 's'
    }, ${summary.inventoryFiles} tracked files in scope.`,
  ];
  if (summary.reportFiles !== undefined && summary.reportFiles !== summary.files) {
    lines.push(`The dashboard's report of this commit and suite now covers ${summary.reportFiles} files.`);
  }
  if (summary.unmatched > 0) {
    lines.push(
      `${summary.unmatched} path${summary.unmatched === 1 ? '' : 's'} matched no file in the checkout: check --root.`,
    );
  }
  if (summary.outOfScope > 0) lines.push(`${summary.outOfScope} files are outside the project's coverage scope.`);
  return lines.join('\n');
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { 'X-API-Key': apiKey } : {};
}

/** The project's coverage scope from the dashboard; the default when the project names none. */
async function fetchScope(args: CoverageUploadArgs, projectId: number): Promise<CoverageScope> {
  const res = await fetch(`${args.serverUrl}/api/projects/${projectId}`, { headers: authHeaders(args.apiKey) });
  if (!res.ok) throw new Error(`Could not read the project (dashboard returned ${res.status})`);
  const body = (await res.json()) as { coverageScope?: unknown; project?: { coverageScope?: unknown } };
  const raw = body.coverageScope ?? body.project?.coverageScope;
  return (raw ? parseCoverageScope(raw) : null) ?? DEFAULT_COVERAGE_SCOPE;
}

/** Read, resolve and send an upload; resolves with the summary. */
export async function uploadCoverage(
  args: CoverageUploadArgs,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ summary: UploadSummary; code: number }> {
  const checkout = await readCheckout(cwd);
  const projectId = args.dryRun
    ? null
    : await resolveProjectId({ serverUrl: args.serverUrl, apiKey: args.apiKey, project: args.project, key: '' });
  const scope = projectId === null ? DEFAULT_COVERAGE_SCOPE : await fetchScope(args, projectId);
  const inScope = compileCoverageScope(scope);
  const branch = args.branch ?? resolveScmBranch(env, checkout.gitBranch) ?? null;

  const reports = [...new Set(args.patterns.flatMap((pattern) => expandPattern(pattern, cwd)))];
  const inventory = await readInventory(checkout.root);
  const resolved: ResolvedReports = { files: new Map(), unmatched: [], outOfScope: 0 };
  const formats = new Set<string>();
  for (const report of reports) {
    const read = await readReport(report, args.format);
    formats.add(read.format);
    resolveReport(read, report, { repoRoot: checkout.root, cwd, root: args.root, inventory, inScope }, resolved);
  }

  // A file the checkout holds but does not track (generated, not yet added) is named by the blob of its content.
  const untracked = [...resolved.files.keys()].filter((file) => !inventory.has(file));
  const hashed = new Map<string, string>();
  if (untracked.length > 0) {
    const ids = await gitHashObjects(checkout.root, untracked);
    untracked.forEach((file, i) => {
      if (ids?.[i]) hashed.set(file, ids[i]!);
    });
  }
  const files: UploadPart['files'] = [...resolved.files.values()]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((file) => {
      const blob = inventory.get(file.path) ?? hashed.get(file.path);
      return {
        path: file.path,
        ...(blob ? { blob } : {}),
        executable: file.executable,
        lines: file.lines,
        ...(file.functions.length > 0 ? { functions: file.functions } : {}),
        ...(file.allFunctions.length > 0 ? { allFunctions: file.allFunctions } : {}),
      };
    });
  const inScopeInventory = [...inventory]
    .filter(([file]) => inScope(file))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const parts = splitUpload(
    {
      v: 1,
      commit: checkout.commit,
      ...(branch ? { branch } : {}),
      suite: args.suite,
      kind: args.kind,
      tool: [...formats].sort().join('+') || 'unknown',
      ...(resolved.unmatched.length > 0 ? { incomplete: true } : {}),
    },
    files,
    inScopeInventory,
  );
  const summary: UploadSummary = {
    commit: checkout.commit,
    branch,
    suite: args.suite,
    reports: reports.map((report) => path.relative(cwd, report) || report),
    files: files.length,
    unmatched: resolved.unmatched.length,
    outOfScope: resolved.outOfScope,
    inventoryFiles: inScopeInventory.length,
    requests: parts.length,
  };
  if (reports.length === 0 || files.length === 0 || args.dryRun || projectId === null) {
    return { summary, code: reports.length === 0 || files.length === 0 ? EXIT_NOTHING : EXIT_OK };
  }

  for (const part of parts) {
    const res = await fetch(`${args.serverUrl}/api/projects/${projectId}/coverage-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(args.apiKey) },
      body: JSON.stringify(part),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`The dashboard refused the upload (${res.status})${text ? `: ${text.slice(0, 400)}` : ''}`);
    }
    const answer = (await res.json()) as { report?: { files?: number } };
    if (typeof answer.report?.files === 'number') summary.reportFiles = answer.report.files;
  }
  return { summary, code: EXIT_OK };
}

/** `piwi coverage <subcommand>`. */
export async function runCoverage(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (
    subcommand === undefined ||
    subcommand === '-h' ||
    subcommand === '--help' ||
    rest.includes('--help') ||
    rest.includes('-h')
  ) {
    console.log(USAGE);
    return subcommand === undefined ? EXIT_ERROR : EXIT_OK;
  }
  if (subcommand !== 'upload') {
    console.error(`piwi coverage: unknown subcommand "${subcommand}"\n\n${USAGE}`);
    return EXIT_ERROR;
  }
  let args: CoverageUploadArgs;
  try {
    args = parseCoverageUploadArgs(rest, env);
  } catch (error) {
    console.error(`piwi coverage upload: ${(error as Error).message}`);
    return EXIT_ERROR;
  }
  try {
    const { summary, code } = await uploadCoverage(args, env, process.cwd());
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else if (summary.reports.length === 0) console.error('piwi coverage upload: no report matched the files named');
    else if (summary.files === 0) {
      console.error(
        `piwi coverage upload: none of the ${summary.unmatched + summary.outOfScope} files the reports name is a file of the checkout in the coverage scope: check --root`,
      );
    } else console.log(formatSummary(summary, args.dryRun));
    return code;
  } catch (error) {
    console.error(`piwi coverage upload: ${(error as Error).message}`);
    return EXIT_ERROR;
  }
}
