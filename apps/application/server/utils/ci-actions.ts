/**
 * CI actions — server-side settings access and Check.
 *
 * The settings live on the project row (`projects.ciRerun`) as a list of named
 * actions (`shared/ci-actions.ts`); a value in the original shape is
 * converted when read. Check says whether an action's target takes what a
 * dispatch sends, without starting anything.
 */
import { eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { projects } from '../database/schema';
import { checkCiServerTarget } from './ci-server-dispatch';
import { createScmProvider } from './scm';
import { readProjectRepositoryUrl } from './scm/project-repository';
import {
  ciActionSentNames,
  ciServerTargetOf,
  resolveCiActionsSettings,
  type CiAction,
  type CiActionCheckResult,
  type CiActionsSettings,
} from '#shared/ci-actions';
import type { DbClient } from '../database';

/** The project's CI actions (disabled and empty when unset). */
export async function getCiActionsSettings(db: DbClient, projectId: number): Promise<CiActionsSettings> {
  const [project] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  return resolveCiActionsSettings(project?.ciRerun ?? null);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What a workflow file's `workflow_dispatch` trigger declares: null when the
 * file has no such trigger, else the names of its inputs. `on` may be the
 * event name, a list of events, or a map of them.
 */
export function workflowDispatchInputs(workflowYaml: string): string[] | null {
  const document: unknown = parseYaml(workflowYaml);
  const on = isRecord(document) ? document.on : undefined;
  if (on === 'workflow_dispatch') return [];
  if (Array.isArray(on)) return on.includes('workflow_dispatch') ? [] : null;
  if (!isRecord(on) || !('workflow_dispatch' in on)) return null;
  const trigger = on.workflow_dispatch;
  const inputs = isRecord(trigger) && isRecord(trigger.inputs) ? Object.keys(trigger.inputs) : [];
  return inputs;
}

/** Check a GitHub action: its workflow file, read at the action's ref, must declare every input a dispatch sends. */
async function checkGithubAction(
  db: DbClient,
  projectId: number,
  action: CiAction & { target: { type: 'github' } },
): Promise<CiActionCheckResult> {
  const { workflow, ref } = action.target;
  if (/^\d+$/.test(workflow)) {
    return {
      ok: null,
      missing: [],
      message: `A workflow named by its numeric id (${workflow}) can't be checked by id: name its file, such as e2e.yml.`,
    };
  }
  if (!/^[\w.-]+\.ya?ml$/i.test(workflow)) {
    return { ok: null, missing: [], message: `"${workflow}" is not a workflow file name, such as e2e.yml.` };
  }
  const repositoryUrl = await readProjectRepositoryUrl(db, projectId);
  const scm = repositoryUrl ? await createScmProvider(repositoryUrl, db, projectId) : null;
  if (!scm || scm.provider !== 'github') {
    return {
      ok: null,
      missing: [],
      message: "This project's repository is not on GitHub, so its workflow can't be read.",
    };
  }
  const path = `.github/workflows/${workflow}`;
  let file: Awaited<ReturnType<typeof scm.fetchFileAtRef>>;
  try {
    file = await scm.fetchFileAtRef(path, ref);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: null, missing: [], message: `${path} could not be read at ${ref}: ${reason}.` };
  }
  if (!file) {
    return {
      ok: null,
      missing: [],
      message: `${path} could not be read at ${ref}: it is missing there, or the SCM token cannot read it.`,
    };
  }
  let declared: string[] | null;
  try {
    declared = workflowDispatchInputs(file.content);
  } catch {
    return { ok: null, missing: [], message: `${path} is not valid YAML at ${ref}.` };
  }
  if (!declared) {
    return {
      ok: false,
      missing: [],
      message: `The workflow has no workflow_dispatch trigger, so GitHub rejects a dispatch of ${workflow}.`,
    };
  }
  const missing = ciActionSentNames(action).filter((name) => !declared.includes(name));
  if (missing.length === 0) {
    return { ok: true, missing, message: `The workflow declares ${ciActionSentNames(action).join(', ')}.` };
  }
  return {
    ok: false,
    missing,
    message: `The workflow does not declare ${missing.join(', ')}: GitHub rejects a dispatch that sends an input the workflow does not declare.`,
  };
}

/**
 * Check an action before its first dispatch. A GitHub action reads its
 * workflow file; a CI server preset reads its job; GitLab, Bitbucket and a
 * Custom request name nothing Piwi can read without starting a pipeline.
 */
export async function checkCiAction(db: DbClient, projectId: number, action: CiAction): Promise<CiActionCheckResult> {
  const target = action.target;
  switch (target.type) {
    case 'github':
      return checkGithubAction(db, projectId, { ...action, target });
    case 'gitlab':
      return {
        ok: null,
        missing: [],
        message:
          "GitLab pipelines can't be checked: GitLab reports no variable declarations without starting a pipeline. Dispatch it once to confirm.",
      };
    case 'bitbucket':
      return {
        ok: null,
        missing: [],
        message:
          "Bitbucket pipelines can't be checked: Bitbucket reports no variable declarations without starting a pipeline. Dispatch it once to confirm.",
      };
    case 'ci-server': {
      if (target.preset === 'custom') {
        return {
          ok: null,
          missing: [],
          message: "A Custom request can't be checked: it names no job Piwi can read.",
        };
      }
      const [result] = await checkCiServerTarget(
        db,
        projectId,
        ciServerTargetOf(target),
        action.inputs.map((i) => i.name),
      );
      return result
        ? { ok: result.ok, missing: result.missing, message: result.message }
        : { ok: null, missing: [], message: 'Nothing was checked.' };
    }
  }
}
