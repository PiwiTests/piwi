/**
 * CI re-run — the stored settings of a value with no `actions` list, and the
 * arguments of a Flake Lab dispatch. What a dispatch records is
 * `shared/ci-dispatches.ts`.
 *
 * From a failure cluster's page, a reporter or admin can ask CI to re-run
 * exactly the affected tests. A project's settings are a list of named
 * actions (`shared/ci-actions.ts`); a value with no `actions` list is a
 * {@link CiRerunSettings}, which `ciActionsFromLegacy` converts. In it, `via`
 * says where a dispatch goes: through the repository host (one block per provider,
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
import { resolveCiServerTarget, type CiServerTarget } from '#shared/ci-server';

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
