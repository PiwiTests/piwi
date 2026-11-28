/**
 * What the three repository hosts' providers share (GitHub, GitLab,
 * Bitbucket): their CI runs on the project's pinned repository, through the
 * SCM provider and its credential (the action's own, else the project's). A
 * dispatch is ready when that credential is set, goes through the SCM
 * provider's `dispatchRerun`, and the branches are the repository's. A file is
 * read at the commit its branch names now, past what the SCM provider keeps by
 * branch name.
 */
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { createScmProvider, detectScmProvider, hasScmCredential } from '../scm';
import { projectRepositoryFor, readProjectRepositoryUrl } from '../scm/project-repository';
import { CredentialRefusedError, type CredentialActor } from '../credentials';
import { ciTargetDefinition } from '#shared/ci-targets';
import { SCM_PROVIDER_LABELS, type ScmProviderName } from '#shared/scm-urls';
import type { CiActionKind } from '#shared/ci-actions';
import type { CiDispatchPlace } from '#shared/handlers/ci-rerun-target';
import type { CiProvider } from './types';
import type { DbClient } from '../../database';

export type ActionScm = NonNullable<Awaited<ReturnType<typeof createScmProvider>>>;

/**
 * How many alias uses a CI file may resolve: a pipeline file reuses its anchors
 * a lot (`<<: *defaults` in every job), and the limit still stops a file whose
 * aliases nest to expand without end.
 */
const MAX_YAML_ALIASES = 10_000;

/** What a dispatch of each kind is called, in a sentence about what it lacks. */
const DISPATCH_NOUN: Record<CiActionKind, string> = {
  tests: 're-run',
  suite: 'run',
  tags: 'run',
  flakeLab: 'experiment',
};

/**
 * The SCM provider an action on `host` reads through: the action's own
 * credential when it names one (a refusal is the answer, never a public read),
 * else the project's. Or why it cannot read, for the user: `what` names what
 * would have been read ("its workflow").
 */
export async function actionScmProvider(
  db: DbClient,
  projectId: number,
  host: ScmProviderName,
  credentialId: number | null,
  actor: CredentialActor,
  what: string,
): Promise<{ scm: ActionScm } | { message: string }> {
  const repositoryUrl = await readProjectRepositoryUrl(db, projectId);
  let scm: Awaited<ReturnType<typeof createScmProvider>>;
  try {
    scm = repositoryUrl
      ? await createScmProvider(repositoryUrl, db, projectId, { actor, credentialId, strict: !!credentialId })
      : null;
  } catch (e) {
    if (!(e instanceof CredentialRefusedError)) throw e;
    return { message: e.message };
  }
  if (!scm || scm.provider !== host) {
    return { message: `This project's repository is not on ${SCM_PROVIDER_LABELS[host]}, so ${what} can't be read.` };
  }
  return { scm };
}

/** Where a read goes: the ref as the user named it, and the commit it names now (the ref itself when not a branch). */
export interface ReadAt {
  ref: string;
  commit: string;
}

/**
 * The commit a branch names now, so a file is read as it is after the last
 * push, past what the provider keeps by ref; a tag, a commit or a branch that
 * cannot be resolved is read as it is named.
 */
export async function readAt(scm: ActionScm, ref: string): Promise<ReadAt> {
  try {
    return { ref, commit: (await scm.getBranchHead(ref)) ?? ref };
  } catch {
    return { ref, commit: ref };
  }
}

/** A file's text at a ref, or why it could not be read, for the user. */
export async function readFile(
  scm: ActionScm,
  path: string,
  at: ReadAt,
): Promise<{ text: string } | { message: string }> {
  try {
    const file = await scm.fetchFileAtRef(path, at.commit);
    if (file) return { text: file.content };
    return {
      message: `${path} could not be read at ${at.ref}: it is missing there, or the SCM credential cannot read it.`,
    };
  } catch (e) {
    return { message: `${path} could not be read at ${at.ref}: ${e instanceof Error ? e.message : String(e)}.` };
  }
}

/** One YAML document, or undefined when the text is not valid YAML or its aliases expand past the limit. */
export function yamlDocument(text: string): unknown {
  try {
    return parseYaml(text, { maxAliasCount: MAX_YAML_ALIASES });
  } catch {
    return undefined;
  }
}

/** Every YAML document of a file, or undefined when one is not valid YAML or its aliases expand past the limit. */
export function yamlDocuments(text: string): unknown[] | undefined {
  try {
    const documents = parseAllDocuments(text);
    const list = Array.isArray(documents) ? documents : [];
    if (list.some((d) => d.errors.length > 0)) return undefined;
    return list.map((d) => d.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown);
  } catch {
    return undefined;
  }
}

/** The SCM credential a repository host's target names, null for the project's. */
const credentialOf = (target: { credentialId?: number }): number | null => target.credentialId ?? null;

/** Why a repository host's action cannot dispatch from a place whose repository is not the project's. */
function repositoryReason(place: CiDispatchPlace): string {
  if (!place.repositoryUrl) {
    return place.runId == null
      ? 'The project has no repository to dispatch to: set it in the project’s Source control settings.'
      : 'Its run reported no repository to dispatch to.';
  }
  return `Its run reported ${place.repositoryUrl}, not the project’s repository, the only one its SCM credentials reach.`;
}

/**
 * A repository host's provider: `own` holds what only that host does (Check
 * and the listings), the rest is the same for the three.
 */
export function repositoryHostProvider<K extends ScmProviderName>(
  host: K,
  own: Pick<CiProvider<K>, 'check' | 'listJobs' | 'listFields'>,
): CiProvider<K> {
  return {
    ...own,

    // An SCM credential reaches only the project's repository, where the place's must be.
    async readiness(db, place, action) {
      const repositoryUrl = await projectRepositoryFor(db, place.projectId, place.repositoryUrl);
      if (!repositoryUrl) return { available: false, reason: repositoryReason(place) };
      if (await hasScmCredential(db, place.projectId, repositoryUrl, credentialOf(action.target))) {
        return { available: true, reason: null };
      }
      return {
        available: false,
        reason: `No SCM credential is set to dispatch the ${DISPATCH_NOUN[place.kind]}: pick one in the project’s Source control settings.`,
      };
    },

    prepareDispatch(db, { place, action, id, ref, inputs, actor }) {
      const target = action.target;
      const repositoryUrl = place.repositoryUrl;
      if (!repositoryUrl || detectScmProvider(repositoryUrl) !== host) {
        throw new Error('No supported repository to dispatch to');
      }
      // The branch it goes to: the one asked, else the target's own; Bitbucket's default branch is known only once sent.
      const recorded = ref ?? ciTargetDefinition(host).defaultRef(target);
      return {
        ref: recorded,
        send: async () => {
          // The credential opens only for a dispatch that goes out, never for a refused repeat.
          const scm = await createScmProvider(repositoryUrl, db, place.projectId, {
            actor,
            credentialId: credentialOf(target),
            strict: true,
          });
          if (!scm?.provider) throw new Error('Could not build an SCM client for this repository');
          const sent = await scm.dispatchRerun(target, place.args, {
            ref,
            dispatchId: id,
            inputs,
            actionId: action.id,
          });
          return {
            url: sent.url,
            ref: sent.ref ?? recorded,
            providerRunId: sent.runId ?? sent.pipelineId ?? sent.buildNumber ?? null,
          };
        },
      };
    },

    async repositoryBranches(db, projectId, action, actor) {
      const pinned = await readProjectRepositoryUrl(db, projectId);
      if (!pinned || detectScmProvider(pinned) !== host) return [];
      try {
        const scm = await createScmProvider(pinned, db, projectId, {
          actor,
          credentialId: credentialOf(action.target),
        });
        return scm ? await scm.listBranches() : [];
      } catch {
        // A repository that cannot be read leaves the run branches.
        return [];
      }
    },
  };
}
