/**
 * The CI server provider: a request a preset builds (a Jenkins job) or a
 * Custom request, sent under the target's base URL with the credential its
 * action names, else the instance's (`../ci-server-dispatch.ts`). It has no
 * repository: its branch is typed into the request or is the job's own.
 */
import { ciActionInputValues } from '#shared/ci-actions';
import { ciServerRequestTemplate } from '#shared/ci-server';
import { ciServerTargetOf, ciServerTargetOfListing } from '#shared/ci-targets';
import { ciServerTemplateValues } from '#shared/handlers/ci-rerun-target';
import { loadCredentialRecord } from '#shared/handlers/credentials';
import { credentialRefusal } from '#shared/credentials';
import {
  checkCiServerTarget,
  ciServerBaseUrl,
  ciServerBaseUrlProblem,
  ciServerCredential,
  dispatchToCiServer,
  listCiServerJobs,
  prepareCiServerRequest,
  readCiServerJobFields,
  type CiServerCredential,
} from '../ci-server-dispatch';
import { credentialEnvRefusal } from '../credentials';
import type { CiProvider } from './types';

export const ciServerProvider: CiProvider<'ci-server'> = {
  /**
   * Whether the action can be dispatched on this branch, and whether it would
   * carry a credential: a request its target builds, a base URL that is https
   * (or http on a listed place), a request its values fill, built as the
   * dispatch builds it, and a credential that allows it. DNS is checked at
   * dispatch.
   */
  async readiness(db, place, action, ref) {
    const target = ciServerTargetOf(action.target);
    if (!ciServerRequestTemplate(target, 'rerun')) {
      return { available: false, reason: 'No CI server is configured for this project.' };
    }
    let credential: CiServerCredential | null;
    try {
      credential = await ciServerCredential(db, target);
    } catch (e) {
      return { available: false, reason: e instanceof Error ? e.message : 'The credential cannot be read.' };
    }
    const baseUrl = ciServerBaseUrl(target, credential);
    const problem = ciServerBaseUrlProblem(baseUrl);
    if (problem || !baseUrl) return { available: false, reason: problem };
    try {
      const request = prepareCiServerRequest({
        target,
        kind: 'rerun',
        baseUrl,
        values: ciServerTemplateValues(target, 'args', 'dispatch', ref, place.commit),
        inputs: ciActionInputValues(action),
        credential,
      });
      if (request.credential?.source === 'action') {
        const record = await loadCredentialRecord(db, request.credential.id);
        const refusal = record
          ? (credentialRefusal(record, { projectId: place.projectId, url: request.url, custom: request.custom }) ??
            credentialEnvRefusal(record))
          : 'The credential this CI action names does not exist: pick another one.';
        // A dispatch still goes to `withCredential`, which refuses it again and logs the refusal.
        if (refusal) return { available: false, reason: refusal, credentialRefused: Boolean(record) };
      }
      return { available: true, reason: null };
    } catch (e) {
      return { available: false, reason: e instanceof Error ? e.message : 'The CI server request cannot be built.' };
    }
  },

  prepareDispatch(db, { place, action, id, ref, inputs, actor }) {
    const server = ciServerTargetOf(action.target);
    const values = ciServerTemplateValues(server, place.args, id, ref, place.commit);
    const recorded = values.ref || null;
    return {
      ref: recorded,
      send: async () => {
        const sent = await dispatchToCiServer(db, place.projectId, server, 'rerun', values, inputs, {
          actor,
          actionId: action.id,
        });
        return { url: sent.url, ref: recorded, providerRunId: sent.buildNumber ?? null };
      },
    };
  },

  repositoryBranches: async () => [],

  /** A preset reads its job, which must declare the parameters a dispatch sends; a Custom request names no job. */
  async check(db, projectId, action, use) {
    if (action.target.preset === 'custom') {
      return { ok: null, missing: [], message: "A Custom request can't be checked: it names no job Piwi can read." };
    }
    const [result] = await checkCiServerTarget(
      db,
      projectId,
      ciServerTargetOf(action.target),
      action.inputs.map((i) => i.name),
      { ...use, actionId: action.id },
    );
    return result
      ? { ok: result.ok, missing: result.missing, message: result.message }
      : { ok: null, missing: [], message: 'Nothing was checked.' };
  },

  async listJobs(db, projectId, target, use) {
    const listing = await listCiServerJobs(db, projectId, ciServerTargetOfListing(target), use);
    return { ...listing, complete: listing.jobs !== null };
  },

  listFields: async (db, projectId, target, use) =>
    target.job
      ? readCiServerJobFields(db, projectId, ciServerTargetOfListing(target), use)
      : { fields: null, message: 'Pick a job first.' },
};
