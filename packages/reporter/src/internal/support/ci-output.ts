import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './logger.js';
import type { FailureLink } from './failure-links.js';
import { errorMessage } from './errors.js';
import { terminalFeatures, terminalLink } from './terminal.js';

/**
 * The facts about a just-submitted run that CI pipelines want to consume: the
 * clickable dashboard URL plus the identifiers and status behind it, and the
 * failed tests with their execution links. Produced by the submit ladder once
 * a run lands, and rendered into CI-native channels by `emitRunOutputs`.
 */
export interface RunOutput {
  /** Clickable dashboard URL for the run (`<serverUrl>/test-runs/<id>`). */
  runUrl: string;
  /** Dashboard run id. */
  runId: number | string;
  /** Dashboard project id, when the submit response carried one. */
  projectId?: number | string | null;
  /** Project name the run was reported under. */
  projectName: string;
  /** Overall run status (`"passed"` / `"failed"`). */
  status: string;
  /** Link back to the CI build/job that produced the run, when detected. */
  ciBuildUrl?: string | null;
  /** Tests whose final attempt failed, each with its dashboard link. */
  failures: FailureLink[];
}

/** The GitHub job summary lists at most this many failed tests; the rest are counted. */
export const SUMMARY_MAX_FAILURES = 20;

/**
 * Surface the dashboard run URL wherever a CI pipeline can pick it up, so a
 * downstream step (a custom email, a Slack post, a deploy gate) can consume it
 * without scraping the reporter's stdout.
 *
 * Layered, best-effort — a failure in any channel is logged and swallowed so it
 * never fails the run:
 *  1. Always logs `View run: <url>` for a human reading the CI log.
 *  2. `outputFile` (opt-in): a portable JSON file every CI can read
 *     (`cat piwi-run.json`, Jenkins `readJSON`, etc.).
 *  3. GitHub Actions (auto): step outputs on `$GITHUB_OUTPUT`
 *     (`steps.<id>.outputs.piwi_run_url`), a markdown link plus the failed
 *     tests with their headlines on `$GITHUB_STEP_SUMMARY`, and a `::notice::`
 *     workflow annotation.
 *  4. GitLab CI (auto): a dotenv report file (default `piwi.env`) to be wired as
 *     `artifacts:reports:dotenv:` so later jobs inherit `$PIWI_RUN_URL`.
 */
export function emitRunOutputs(
  output: RunOutput,
  logger: Logger,
  outputFile?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  logger.info(`View run: ${shownUrl(output.runUrl, env)}`);

  if (outputFile) writeOutputFile(outputFile, output, logger);
  if (env.GITHUB_ACTIONS) emitGitHubActions(output, env, logger);
  if (env.GITLAB_CI) emitGitLabDotenv(output, env, logger);
}

/**
 * The run's page as it starts: `View live progress: <url>` once, a link in a terminal outside CI (`terminalLink`), and on
 * GitHub Actions a `::notice` with it too, so the job's log and its summary link the run while it runs.
 */
export function announceLiveRun(runUrl: string, logger: Logger, env: NodeJS.ProcessEnv = process.env): void {
  logger.info(`View live progress: ${shownUrl(runUrl, env)}`);
  if (env.GITHUB_ACTIONS) process.stdout.write(`::notice title=Piwi live run::${workflowCommandValue(runUrl)}\n`);
}

/** A URL as the run's own terminal shows it: a link (OSC 8) where `terminalFeatures` allows one. */
function shownUrl(url: string, env: NodeJS.ProcessEnv): string {
  return terminalFeatures(env, !!process.stdout.isTTY).links ? terminalLink(url) : url;
}

/** A value of a GitHub Actions workflow command, its `%`, carriage returns and line feeds escaped. */
function workflowCommandValue(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Portable machine-readable output: a JSON file readable by any CI system. */
function writeOutputFile(file: string, output: RunOutput, logger: Logger): void {
  try {
    const dir = path.dirname(file);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          runUrl: output.runUrl,
          runId: output.runId,
          projectId: output.projectId ?? null,
          projectName: output.projectName,
          status: output.status,
          ciBuildUrl: output.ciBuildUrl ?? null,
          failedCount: output.failures.length,
          failures: output.failures,
        },
        null,
        2,
      ) + '\n',
    );
    logger.info(`Wrote run output to ${file}`);
  } catch (error) {
    logger.warn(`Failed to write run output file '${file}': ${errorMessage(error)}`);
  }
}

/** GitHub Actions: step outputs, a job summary with the failed tests, and a workflow annotation. */
function emitGitHubActions(output: RunOutput, env: NodeJS.ProcessEnv, logger: Logger): void {
  const pairs: Array<[string, string]> = [
    ['piwi_run_url', output.runUrl],
    ['piwi_run_id', String(output.runId)],
    ['piwi_run_status', output.status],
    ['piwi_failed_count', String(output.failures.length)],
  ];
  if (output.projectId != null) pairs.push(['piwi_project_id', String(output.projectId)]);

  // Values are single-line (URL / id / status / count), so the plain
  // `key=value` form is safe — no heredoc delimiter needed.
  if (env.GITHUB_OUTPUT) {
    appendFileLines(
      env.GITHUB_OUTPUT,
      pairs.map(([k, v]) => `${k}=${v}`),
      logger,
      'step output',
    );
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileLines(
      env.GITHUB_STEP_SUMMARY,
      [
        '### Piwi test run',
        '',
        `[View run](${output.runUrl}) — **${output.status}**`,
        '',
        ...summaryFailureLines(output),
      ],
      logger,
      'step summary',
    );
  }
  // A workflow annotation must be a bare stdout line (no logger prefix).
  process.stdout.write(`::notice title=Piwi test run::${workflowCommandValue(output.runUrl)}\n`);
}

/** Markdown list of the failed tests for the job summary, capped at `SUMMARY_MAX_FAILURES`. */
function summaryFailureLines(output: RunOutput): string[] {
  if (output.failures.length === 0) return [];
  const lines = output.failures.slice(0, SUMMARY_MAX_FAILURES).map((f) => {
    const headline = f.headline ? ` — ${escapeMarkdown(f.headline)}` : '';
    return `- ❌ [${escapeMarkdown(f.title)}](${f.url})${headline} — \`${f.file}\``;
  });
  const hidden = output.failures.length - SUMMARY_MAX_FAILURES;
  if (hidden > 0) lines.push(`- +${hidden} more`);
  lines.push('');
  return lines;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]]/g, (ch) => `\\${ch}`);
}

/** GitLab CI: a dotenv report file so later jobs inherit the run URL as a variable. */
function emitGitLabDotenv(output: RunOutput, env: NodeJS.ProcessEnv, logger: Logger): void {
  const file = env.PIWI_DOTENV_FILE || 'piwi.env';
  const lines = [
    `PIWI_RUN_URL=${output.runUrl}`,
    `PIWI_RUN_ID=${output.runId}`,
    `PIWI_RUN_STATUS=${output.status}`,
    `PIWI_FAILED_COUNT=${output.failures.length}`,
  ];
  if (output.projectId != null) lines.push(`PIWI_PROJECT_ID=${output.projectId}`);
  if (output.ciBuildUrl) lines.push(`PIWI_CI_BUILD_URL=${output.ciBuildUrl}`);
  try {
    fs.writeFileSync(file, lines.join('\n') + '\n');
    logger.info(`Wrote GitLab dotenv report to ${file} (declare it as artifacts:reports:dotenv)`);
  } catch (error) {
    logger.warn(`Failed to write GitLab dotenv file '${file}': ${errorMessage(error)}`);
  }
}

/**
 * GitHub Actions: the end-of-run resource summary (`formatResourceSummary`) as
 * a section of the job summary, next to the run's. A no-op outside GitHub
 * Actions or with nothing to report; best-effort like the run outputs.
 */
export function emitResourceSummary(lines: string[], logger: Logger, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.GITHUB_ACTIONS || !env.GITHUB_STEP_SUMMARY || lines.length === 0) return;
  appendFileLines(
    env.GITHUB_STEP_SUMMARY,
    ['### Piwi resources', '', '```text', ...lines, '```', ''],
    logger,
    'step summary',
  );
}

/** Append newline-terminated lines to a file, swallowing (but logging) failures. */
function appendFileLines(file: string, lines: string[], logger: Logger, label: string): void {
  try {
    fs.appendFileSync(file, lines.join('\n') + '\n');
  } catch (error) {
    logger.warn(`Failed to write GitHub Actions ${label}: ${errorMessage(error)}`);
  }
}

/** Pick the most specific CI build/job URL from collected CI metadata, if any. */
export function ciBuildUrlFromMetadata(metadata: Record<string, any> | undefined): string | undefined {
  const ci = metadata?.ci;
  if (!ci) return undefined;
  return ci.buildUrl || ci.pipelineUrl || ci.jobUrl || undefined;
}
