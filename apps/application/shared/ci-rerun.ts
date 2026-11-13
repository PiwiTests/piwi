/**
 * CI re-run — the original settings shape, and the durable shapes of a
 * dispatch shared by the server, the demo and the tests.
 *
 * From a failure cluster's page, a reporter or admin can ask CI to re-run
 * exactly the affected tests. A project's settings are a list of named
 * actions (`shared/ci-actions.ts`); {@link CiRerunSettings} is the original
 * shape, which `ciActionsFromLegacy` converts. In it, `via` says
 * where a dispatch goes: through the repository host (one block per provider,
 * decided by the project's repository URL) or through a CI server (one HTTP
 * request a preset builds, `shared/ci-server.ts`).
 *
 * Off by default: dispatching a pipeline spends CI minutes and needs a token
 * with write scope, so it stays an explicit per-project opt-in.
 *
 * Pure + dependency-free (mirrors `shared/auto-heal.ts`): the code that talks to
 * GitHub / GitLab / Bitbucket lives in `server/utils/scm/`.
 */

import type { ScmProviderName } from '#shared/scm-urls';
import { resolveCiServerTarget, type CiServerPreset, type CiServerTarget } from '#shared/ci-server';

/** Where a dispatch goes: the repository host's CI (the default) or a CI server. */
export type CiRerunVia = 'repository' | 'ci-server';

/** What a dispatch went to: a repository host, or a CI server. */
export type CiRerunProvider = ScmProviderName | 'ci-server';

/** GitHub `workflow_dispatch` target. */
export interface GitHubRerunTarget {
  /** Workflow file name (e.g. `e2e.yml`) or its numeric id. */
  workflow: string;
  /** Git ref (branch or tag) the workflow runs on when the cluster's run has no branch. */
  ref: string;
  /** The `workflow_dispatch` input that receives the Playwright arguments. */
  inputName: string;
  /**
   * The optional `workflow_dispatch` input that receives the dispatch id. GitHub
   * rejects an input the workflow does not declare, so it is sent only when
   * set; the workflow passes it to the reporter as `PIWI_ORIGIN_REF`, which
   * ties the run to its dispatch.
   */
  dispatchIdInput?: string;
}

/** GitLab pipeline target. */
export interface GitLabRerunTarget {
  /** Git ref the pipeline runs on when the cluster's run has no branch. */
  ref: string;
  /** The pipeline variable that receives the Playwright arguments. */
  variableName: string;
}

/** Bitbucket custom-pipeline target. */
export interface BitbucketRerunTarget {
  /** The `custom:` pipeline name defined in `bitbucket-pipelines.yml`. */
  pipeline: string;
  /** The pipeline variable that receives the Playwright arguments. */
  variableName: string;
}

/**
 * The optional target that runs `piwi flake` in CI for one test. It receives the
 * command's arguments (`flake 12`, `flake verify 12`), which the workflow passes
 * to `npx @piwitests/reporter`. GitHub and GitLab dispatch on the re-run
 * target's ref when the test's run has no branch, so they need that target too.
 */
export interface FlakeLabCiTarget {
  /** A `workflow_dispatch` workflow and the input that receives the arguments. */
  github?: { workflow: string; inputName: string };
  /** The pipeline variable that receives the arguments. */
  gitlab?: { variableName: string };
  /** A `custom:` pipeline and the variable that receives the arguments. */
  bitbucket?: { pipeline: string; variableName: string };
}

export interface CiRerunSettings {
  /** Master switch. Off by default — dispatching CI needs an explicit opt-in. */
  enabled: boolean;
  /** Where a dispatch goes; absent means `repository`. */
  via?: CiRerunVia;
  /** The CI server a `ci-server` dispatch goes to. */
  ciServer?: CiServerTarget;
  github?: GitHubRerunTarget;
  gitlab?: GitLabRerunTarget;
  bitbucket?: BitbucketRerunTarget;
  flakeLab?: FlakeLabCiTarget;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Merge a partial (possibly untrusted) payload onto the defaults, dropping empties. */
export function resolveCiRerunSettings(input?: Partial<CiRerunSettings> | null): CiRerunSettings {
  const out: CiRerunSettings = { enabled: input?.enabled === true };
  if (input?.via === 'ci-server') out.via = 'ci-server';
  const ciServer = resolveCiServerTarget(input?.ciServer);
  if (ciServer) out.ciServer = ciServer;

  const gh = input?.github;
  if (gh) {
    const workflow = str(gh.workflow);
    const ref = str(gh.ref);
    const inputName = str(gh.inputName);
    const dispatchIdInput = str(gh.dispatchIdInput);
    if (workflow && ref && inputName) {
      out.github = { workflow, ref, inputName, ...(dispatchIdInput ? { dispatchIdInput } : {}) };
    }
  }

  const gl = input?.gitlab;
  if (gl) {
    const ref = str(gl.ref);
    const variableName = str(gl.variableName);
    if (ref && variableName) out.gitlab = { ref, variableName };
  }

  const bb = input?.bitbucket;
  if (bb) {
    const pipeline = str(bb.pipeline);
    const variableName = str(bb.variableName);
    if (pipeline && variableName) out.bitbucket = { pipeline, variableName };
  }

  const lab = input?.flakeLab;
  if (lab) {
    const flakeLab: FlakeLabCiTarget = {};
    const workflow = str(lab.github?.workflow);
    const inputName = str(lab.github?.inputName);
    if (workflow && inputName) flakeLab.github = { workflow, inputName };
    const glVariable = str(lab.gitlab?.variableName);
    if (glVariable) flakeLab.gitlab = { variableName: glVariable };
    const pipeline = str(lab.bitbucket?.pipeline);
    const bbVariable = str(lab.bitbucket?.variableName);
    if (pipeline && bbVariable) flakeLab.bitbucket = { pipeline, variableName: bbVariable };
    if (Object.keys(flakeLab).length) out.flakeLab = flakeLab;
  }

  return out;
}

/** The `npx @piwitests/reporter` arguments a Flake Lab dispatch hands CI. */
export function flakeLabCiArgs(testCaseId: number, kind: 'reproduce' | 'verify'): string {
  return kind === 'verify' ? `flake verify ${testCaseId}` : `flake ${testCaseId}`;
}

/**
 * One recorded CI re-run dispatch, kept on the cluster so the page can show the
 * last one, and so the run it started is recognized when it finishes: by its
 * dispatch id (`PIWI_ORIGIN_REF`), GitLab's pipeline id, Bitbucket's build
 * number, or else its branch, start time and test files.
 */
export interface ClusterRerunDispatch {
  /** The dispatch's own id, which the run it starts carries as `PIWI_ORIGIN_REF` when the pipeline passes it on. */
  id?: string;
  /** The CI action the dispatch went through (`shared/ci-actions.ts`); absent on a record of the original shape. */
  actionId?: string;
  /** Provider the dispatch went to. */
  provider: CiRerunProvider;
  /** The CI server preset, for a `ci-server` dispatch. */
  preset?: CiServerPreset;
  /** The provider's runs/pipeline URL to watch the re-run; once matched, the build the run recorded. */
  url: string;
  /** The Playwright arguments handed to CI. */
  args: string;
  /** The branch the pipeline was dispatched on. */
  ref?: string | null;
  /** The spec files the arguments name, POSIX separators, without lines. */
  files?: string[];
  /** How many tests the arguments name. */
  tests?: number;
  /** GitLab's id of the pipeline it created. */
  pipelineId?: string | null;
  /** The build number Bitbucket, or the CI server, answered for the build it started. */
  buildNumber?: string | null;
  /** The run the dispatch was matched to, once it finished. */
  runId?: number | null;
  /** Epoch ms of the dispatch. */
  at: number;
  /** Display name of the user who triggered it. */
  byName: string | null;
  /** Id of the user who triggered it. */
  byUserId: number | null;
}

/** How long after a dispatch a finished run may still be the run it started. */
export const RERUN_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** How far before its dispatch a CI server build may say it started: the CI's clock and Piwi's may differ. */
export const RERUN_CLOCK_SLACK_MS = 60_000;

/** What a finished run tells about the dispatch that may have started it. */
export interface RerunCandidateRun {
  /** The run's origin ref (`PIWI_ORIGIN_REF`). */
  originRef: string | null;
  /** The CI provider's pipeline id and build number, from the run's CI metadata. */
  pipelineId: string | null;
  buildNumber: string | null;
  branch: string | null;
  /** Epoch ms of the run's start. */
  startedAt: number;
  /** The spec files the run executed, POSIX separators. */
  files: string[];
}

/**
 * Whether a run is the build a CI server answered for a dispatch. A CI server
 * numbers builds per job, and a project may run several jobs, so the number
 * counts only for a run of the dispatch's branch, started after it (within
 * {@link RERUN_CLOCK_SLACK_MS}), that ran exactly its spec files. Among open
 * dispatches of the same branch and files, the number picks the one the run
 * answers.
 */
function ciServerBuildMatches(d: ClusterRerunDispatch, run: RerunCandidateRun, runFiles: string): boolean {
  if (d.buildNumber == null || d.buildNumber !== run.buildNumber) return false;
  if (d.ref == null || d.ref !== run.branch || run.startedAt < d.at - RERUN_CLOCK_SLACK_MS) return false;
  return !!d.files?.length && d.files.join('\n') === runFiles;
}

/**
 * The dispatch a finished run answers, or null: the one whose id the run
 * carries, else the GitLab pipeline, Bitbucket build or CI server build it ran
 * in, else (for GitHub and a CI server, which may return no build) the newest
 * dispatch on the run's branch, started within {@link RERUN_MATCH_WINDOW_MS}
 * before it, whose files the run executed exactly. A dispatch already matched
 * to a run is never matched again.
 */
export function matchRerunDispatch<T extends ClusterRerunDispatch>(run: RerunCandidateRun, dispatches: T[]): T | null {
  const open = dispatches.filter((d) => d.runId == null);
  const runFiles = [...new Set(run.files)].sort().join('\n');
  if (run.originRef) {
    const byId = open.find((d) => d.id === run.originRef);
    if (byId) return byId;
  }
  const byPipeline = open.find(
    (d) =>
      (d.provider === 'gitlab' && d.pipelineId != null && d.pipelineId === run.pipelineId) ||
      (d.provider === 'bitbucket' && d.buildNumber != null && d.buildNumber === run.buildNumber) ||
      (d.provider === 'ci-server' && ciServerBuildMatches(d, run, runFiles)),
  );
  if (byPipeline) return byPipeline;
  const candidates = open
    .filter(
      (d) =>
        (d.provider === 'github' || d.provider === 'ci-server') &&
        d.ref != null &&
        d.ref === run.branch &&
        run.startedAt >= d.at &&
        run.startedAt - d.at <= RERUN_MATCH_WINDOW_MS &&
        !!d.files?.length &&
        d.files.join('\n') === runFiles,
    )
    .sort((a, b) => b.at - a.at);
  return candidates[0] ?? null;
}
