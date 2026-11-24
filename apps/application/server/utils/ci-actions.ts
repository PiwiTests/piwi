/**
 * CI actions — server-side settings access and Check.
 *
 * The settings live on the project row (`projects.ciRerun`) as a list of named
 * actions (`shared/ci-actions.ts`); a value with no `actions` list is
 * converted when read. Check says whether an action's target takes what a
 * dispatch sends, without starting anything.
 */
import { eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { projects } from '../database/schema';
import { checkCiServerTarget, type CiServerUse } from './ci-server-dispatch';
import { actionScmProvider, readGithubWorkflow } from './ci-jobs';
import {
  ciActionSentNames,
  ciServerTargetOf,
  resolveCiActionsSettings,
  type CiAction,
  type CiActionCheckResult,
  type CiActionsSettings,
} from '#shared/ci-actions';
import { githubDispatchFields, missingRequiredFields } from '#shared/ci-job-fields';
import type { DbClient } from '../database';

/** The project's CI actions (disabled and empty when unset). */
export async function getCiActionsSettings(db: DbClient, projectId: number): Promise<CiActionsSettings> {
  const [project] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  return resolveCiActionsSettings(project?.ciRerun ?? null);
}

/**
 * What a workflow file's `workflow_dispatch` trigger declares: null when the
 * file has no such trigger, else the names of its inputs. Throws on a file
 * that is not valid YAML.
 */
export function workflowDispatchInputs(workflowYaml: string): string[] | null {
  return githubDispatchFields(parseYaml(workflowYaml))?.map((f) => f.name) ?? null;
}

/**
 * Check a GitHub action: its workflow file, read at the action's ref, must
 * declare every input a dispatch sends, and a dispatch must send every input
 * the workflow requires without a default.
 */
async function checkGithubAction(
  db: DbClient,
  projectId: number,
  action: CiAction & { target: { type: 'github' } },
  use: CiServerUse,
): Promise<CiActionCheckResult> {
  const { workflow, ref } = action.target;
  // The action's own credential is the one its dispatch carries: a refusal is the answer, never a public read.
  const opened = await actionScmProvider(
    db,
    projectId,
    'github',
    action.target.credentialId ?? null,
    use.actor,
    'its workflow',
  );
  if ('message' in opened) return { ok: null, missing: [], message: opened.message };
  const read = await readGithubWorkflow(opened.scm, workflow, ref);
  if (!('fields' in read)) return { ok: read.refused ? false : null, missing: [], message: read.message };
  const sent = ciActionSentNames(action);
  const declared = read.fields.map((f) => f.name);
  const missing = sent.filter((name) => !declared.includes(name));
  const required = missingRequiredFields(read.fields, sent).map((f) => f.name);
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message: `The workflow does not declare ${missing.join(', ')}: GitHub rejects a dispatch that sends an input the workflow does not declare.`,
    };
  }
  if (required.length > 0) {
    return {
      ok: false,
      missing: [],
      message: `The workflow requires ${required.join(', ')}, with no default, which this action does not send: add ${required.length > 1 ? 'them' : 'it'} as inputs, or GitHub rejects the dispatch.`,
    };
  }
  return { ok: true, missing, message: `The workflow declares ${sent.join(', ')}.` };
}

/**
 * Check an action before its first dispatch. A GitHub action reads its
 * workflow file; a CI server preset reads its job; GitLab, Bitbucket and a
 * Custom request name nothing Piwi can read without starting a pipeline.
 */
export async function checkCiAction(
  db: DbClient,
  projectId: number,
  action: CiAction,
  use: CiServerUse,
): Promise<CiActionCheckResult> {
  const target = action.target;
  switch (target.type) {
    case 'github':
      return checkGithubAction(db, projectId, { ...action, target }, use);
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
        { ...use, actionId: action.id },
      );
      return result
        ? { ok: result.ok, missing: result.missing, message: result.message }
        : { ok: null, missing: [], message: 'Nothing was checked.' };
    }
  }
}
