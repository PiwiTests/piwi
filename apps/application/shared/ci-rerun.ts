/**
 * CI re-run — settings and the durable shapes shared by the server, the demo
 * and the tests.
 *
 * From a failure cluster's page, a reporter or admin can ask CI to re-run
 * exactly the affected tests, using the SCM token already configured for the
 * project. The target is provider-specific — a GitHub workflow, a GitLab
 * pipeline, a Bitbucket custom pipeline — so the settings hold one block per
 * provider; the project's repository URL decides which one is used.
 *
 * Off by default: dispatching a pipeline spends CI minutes and needs a token
 * with write scope, so it stays an explicit per-project opt-in.
 *
 * Pure + dependency-free (mirrors `shared/auto-heal.ts`): the code that talks to
 * GitHub / GitLab / Bitbucket lives in `server/utils/scm/`.
 */

import type { ScmProviderName } from '#shared/scm-urls';

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
  github?: GitHubRerunTarget;
  gitlab?: GitLabRerunTarget;
  bitbucket?: BitbucketRerunTarget;
  flakeLab?: FlakeLabCiTarget;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Merge a partial (possibly untrusted) payload onto the defaults, dropping empties. */
export function resolveCiRerunSettings(input?: Partial<CiRerunSettings> | null): CiRerunSettings {
  const out: CiRerunSettings = { enabled: input?.enabled === true };

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

/** True when the settings hold a usable target for the given provider. */
export function hasRerunTarget(settings: CiRerunSettings | null | undefined, provider: ScmProviderName): boolean {
  if (!settings?.enabled) return false;
  return Boolean(settings[provider]);
}

/**
 * The settings `dispatchRerun` sends a Flake Lab dispatch with: the provider's
 * target swapped for the Flake Lab one, on the re-run target's ref. Null when
 * the provider has no usable Flake Lab target.
 */
export function flakeLabRerunSettings(
  settings: CiRerunSettings | null | undefined,
  provider: ScmProviderName,
): CiRerunSettings | null {
  const lab = settings?.enabled ? settings.flakeLab : undefined;
  if (!settings || !lab) return null;
  if (provider === 'github' && lab.github && settings.github) {
    return {
      enabled: true,
      github: { workflow: lab.github.workflow, ref: settings.github.ref, inputName: lab.github.inputName },
    };
  }
  if (provider === 'gitlab' && lab.gitlab && settings.gitlab) {
    return { enabled: true, gitlab: { ref: settings.gitlab.ref, variableName: lab.gitlab.variableName } };
  }
  if (provider === 'bitbucket' && lab.bitbucket) return { enabled: true, bitbucket: lab.bitbucket };
  return null;
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
  /** Provider the dispatch went to. */
  provider: ScmProviderName;
  /** The provider's runs/pipeline URL to watch the re-run. */
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
  /** Bitbucket's build number of the pipeline it created. */
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
 * The dispatch a finished run answers, or null: the one whose id the run
 * carries, else the GitLab pipeline or Bitbucket build it ran in, else (for
 * GitHub, which returns no run id) the newest dispatch on the run's branch,
 * started within {@link RERUN_MATCH_WINDOW_MS} before it, whose files the run
 * executed exactly. A dispatch already matched to a run is never matched again.
 */
export function matchRerunDispatch<T extends ClusterRerunDispatch>(run: RerunCandidateRun, dispatches: T[]): T | null {
  const open = dispatches.filter((d) => d.runId == null);
  if (run.originRef) {
    const byId = open.find((d) => d.id === run.originRef);
    if (byId) return byId;
  }
  const byPipeline = open.find(
    (d) =>
      (d.provider === 'gitlab' && d.pipelineId != null && d.pipelineId === run.pipelineId) ||
      (d.provider === 'bitbucket' && d.buildNumber != null && d.buildNumber === run.buildNumber),
  );
  if (byPipeline) return byPipeline;
  const runFiles = [...new Set(run.files)].sort().join('\n');
  const candidates = open
    .filter(
      (d) =>
        d.provider === 'github' &&
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
