/**
 * CI dispatches — what a dispatch of a CI action records, how its state reads,
 * and which dispatch a CI run answers.
 *
 * Every dispatch, from any place (a cluster, an execution, Flake Lab, the MCP
 * tool), is one `ci_dispatches` row. A run is matched to it when the run
 * starts, by the dispatch id it carries (`PIWI_ORIGIN_REF`) or by the
 * provider's id for the run, and again when it finishes, where the spec files
 * it ran are known too ({@link matchCiDispatch}).
 *
 * Pure + dependency-free: the server, the demo and the tests share it.
 */

import type { CiActionKind } from '#shared/ci-actions';
import type { CiRerunProvider } from '#shared/ci-rerun';
import type { CiServerPreset } from '#shared/ci-server';

/**
 * The states of a dispatch:
 *
 * - `dispatched`: the provider took it (or it is being sent), and no run was matched to it yet;
 * - `running`: a run was matched to it when it started;
 * - `ended`: its run finished, with the run's own result;
 * - `unreported`: no run was matched to it within {@link CI_DISPATCH_MATCH_WINDOW_MS};
 * - `refused`: the provider answered with an error, kept in `detail`.
 */
export const CI_DISPATCH_STATES = ['dispatched', 'running', 'ended', 'unreported', 'refused'] as const;
export type CiDispatchState = (typeof CI_DISPATCH_STATES)[number];

/** What started a dispatch. */
export const CI_DISPATCH_ORIGINS = ['page', 'mcp', 'api'] as const;
export type CiDispatchOrigin = (typeof CI_DISPATCH_ORIGINS)[number];

/** How long after a dispatch a run may still be the run it started. */
export const CI_DISPATCH_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** How far before its dispatch a run may say it started: the CI's clock and Piwi's may differ. */
export const CI_DISPATCH_CLOCK_SLACK_MS = 60_000;

/** How long a second dispatch of the same action, arguments, branch and inputs is refused. */
export const CI_DISPATCH_GUARD_MS = 10_000;

/** How many days a dispatch is kept. */
export const CI_DISPATCH_RETENTION_DAYS = 90;

/** The run a dispatch was matched to, as a page shows it. */
export interface CiDispatchRun {
  id: number;
  /** The run's status: `running`, `passed`, `failed`, `timedout`, `interrupted`, `cancelled`… */
  status: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
}

/** A dispatch as the API answers it. */
export interface CiDispatchView {
  /** The dispatch id, which the run it starts carries as `PIWI_ORIGIN_REF` when the pipeline passes it on. */
  id: string;
  /** The CI action it went through, and its name when it was dispatched. */
  actionId: string | null;
  actionName: string | null;
  kind: CiActionKind;
  origin: CiDispatchOrigin;
  /** Where it went. */
  provider: CiRerunProvider;
  /** The CI server preset, for a `ci-server` dispatch. */
  preset?: CiServerPreset;
  /** The provider's run once known, else its runs list; null while it is being sent. */
  url: string | null;
  /** The arguments handed to CI. */
  args: string;
  /** The branch it was dispatched on; null when the target runs its configured branch. */
  ref: string | null;
  /** How many tests the arguments name. */
  tests: number | null;
  state: CiDispatchState;
  /** The provider's error, for a refused dispatch. */
  detail: string | null;
  /** The run matched to it, and that run as it stands. */
  runId: number | null;
  run: CiDispatchRun | null;
  /** Epoch ms of the dispatch. */
  at: number;
  /** Who pressed it. */
  byName: string | null;
  byUserId: number | null;
}

/** The state a dispatch reads as: a dispatch still open past the matching window is `unreported`. */
export function ciDispatchState(state: CiDispatchState, at: number, now = Date.now()): CiDispatchState {
  return state === 'dispatched' && now - at > CI_DISPATCH_MATCH_WINDOW_MS ? 'unreported' : state;
}

/** Whether a dispatch can still be matched to a run. */
export function isOpenCiDispatch(d: { state: CiDispatchState; runId: number | null }): boolean {
  return d.state === 'dispatched' && d.runId == null;
}

/** What matching reads of a dispatch. */
export interface CiDispatchCandidate {
  id: string;
  kind: CiActionKind;
  provider: CiRerunProvider;
  ref: string | null;
  /** The spec files the arguments name, POSIX separators, sorted. */
  files: string[] | null;
  /** GitHub's run id, GitLab's pipeline id, Bitbucket's or the CI server's build number. */
  providerRunId: string | null;
  /** The test of a Flake Lab dispatch, and the experiment it asks for (`flake 12` or `flake verify 12`). */
  testCaseId: number | null;
  flakeLabKind?: FlakeLabKind | null;
  state: CiDispatchState;
  runId: number | null;
  /** Epoch ms of the dispatch. */
  at: number;
}

/** The two experiments a Flake Lab dispatch asks for. */
export type FlakeLabKind = 'reproduce' | 'verify';

/** The experiment a Flake Lab dispatch's arguments ask for. */
export function flakeLabKindOfArgs(args: string): FlakeLabKind {
  return /^flake verify\b/.test(args.trim()) ? 'verify' : 'reproduce';
}

/** What a run tells about the dispatch that may have started it. */
export interface CiDispatchRunFacts {
  /** The run's origin ref (`PIWI_ORIGIN_REF`). */
  originRef: string | null;
  /**
   * The CI's ids for the run, from its CI metadata, each only from a run that CI reported: GitHub's run id, GitLab's
   * pipeline id, Bitbucket's build number.
   */
  githubRunId: string | null;
  pipelineId: string | null;
  bitbucketBuildNumber?: string | null;
  /** The build number any other CI reported, which a CI server's answer may name. */
  buildNumber: string | null;
  branch: string | null;
  /** Epoch ms of the run's start. */
  startedAt: number;
  /** The spec files the run executed, POSIX separators; null when the run has just started and they are not known. */
  files: string[] | null;
  /**
   * For a Flake Lab run in CI, its experiment: the test it is about, its kind and when it was created. `piwi flake`
   * names the run after the experiment, so the dispatch id never reaches it.
   */
  flakeLab?: { testCaseId: number; kind: FlakeLabKind; at: number } | null;
}

const sameFiles = (d: CiDispatchCandidate, runFiles: string) => !!d.files?.length && d.files.join('\n') === runFiles;

/**
 * The dispatch a run answers, or null, strongest identifier first:
 *
 * 1. the dispatch id the run carries;
 * 2. the provider's id for the run: GitHub's run id (when the dispatch answered one), GitLab's pipeline id,
 *    Bitbucket's build number; then, for a Flake Lab run in CI, the newest Flake Lab dispatch of its experiment's test
 *    and kind made before the experiment, on the run's branch;
 * 3. once the run's files are known, for a re-run or a Flake Lab experiment (never a whole suite): a CI server's
 *    build number on the dispatch's branch, with exactly its spec files; else the newest CI server dispatch, or
 *    GitHub dispatch that answered no run id, on the run's branch, started before the run, whose spec files the run
 *    executed exactly.
 *
 * A dispatch already matched, refused or past its window is never matched.
 */
export function matchCiDispatch<T extends CiDispatchCandidate>(run: CiDispatchRunFacts, dispatches: T[]): T | null {
  const open = dispatches.filter(
    (d) =>
      isOpenCiDispatch(d) &&
      run.startedAt >= d.at - CI_DISPATCH_CLOCK_SLACK_MS &&
      run.startedAt - d.at <= CI_DISPATCH_MATCH_WINDOW_MS,
  );
  if (run.originRef) {
    const byId = open.find((d) => d.id === run.originRef);
    if (byId) return byId;
  }
  const byProviderId = open.find(
    (d) =>
      d.providerRunId != null &&
      ((d.provider === 'github' && d.providerRunId === run.githubRunId) ||
        (d.provider === 'gitlab' && d.providerRunId === run.pipelineId) ||
        (d.provider === 'bitbucket' && d.providerRunId === run.bitbucketBuildNumber)),
  );
  if (byProviderId) return byProviderId;
  const lab = run.flakeLab;
  if (lab) {
    const byExperiment = open
      .filter(
        (d) =>
          d.kind === 'flakeLab' &&
          d.testCaseId === lab.testCaseId &&
          d.flakeLabKind === lab.kind &&
          lab.at >= d.at - CI_DISPATCH_CLOCK_SLACK_MS &&
          (d.ref == null || d.ref === run.branch),
      )
      .sort((a, b) => b.at - a.at)[0];
    if (byExperiment) return byExperiment;
  }
  if (run.files == null) return null;

  const runFiles = [...new Set(run.files)].sort().join('\n');
  const byFiles = open.filter((d) => d.kind !== 'suite' && d.ref != null && d.ref === run.branch);
  const byBuild = byFiles.find(
    (d) =>
      d.provider === 'ci-server' &&
      d.providerRunId != null &&
      d.providerRunId === run.buildNumber &&
      sameFiles(d, runFiles),
  );
  if (byBuild) return byBuild;
  const candidates = byFiles
    .filter(
      (d) =>
        ((d.provider === 'github' && d.providerRunId == null) || d.provider === 'ci-server') &&
        run.startedAt >= d.at &&
        sameFiles(d, runFiles),
    )
    .sort((a, b) => b.at - a.at);
  return candidates[0] ?? null;
}
