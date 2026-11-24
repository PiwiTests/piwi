/**
 * What a CI provider does for one kind of target (`#shared/ci-targets`): it
 * says whether a dispatch can be sent, sends it, lists the branches its
 * repository offers, checks an action, and lists the jobs and fields the
 * action editor offers. `ciProvider` (`./index.ts`) gives a target's.
 */
import type { CiAction, CiActionCheckResult } from '#shared/ci-actions';
import type { CiJobFieldListing, CiJobListing } from '#shared/ci-job-fields';
import type { CiListingTargetOf, CiTargetOf, CiTargetType } from '#shared/ci-targets';
import type { CiDispatchPlace } from '#shared/handlers/ci-rerun-target';
import type { CiServerUse } from '../ci-server-dispatch';
import type { CredentialActor } from '../credentials';
import type { DbClient } from '../../database';

export type CiActionOf<K extends CiTargetType> = CiAction & { target: CiTargetOf<K> };

/** Whether a dispatch can be sent, and why not. */
export interface CiReadiness {
  available: boolean;
  reason: string | null;
  /** Unavailable only because the action's credential refuses the request, which a dispatch then logs. */
  credentialRefused?: boolean;
}

/** What a provider's answer to a dispatch names: the page to watch, the branch it runs, the provider's id for it. */
export interface CiDispatchSent {
  url: string;
  ref: string | null;
  providerRunId: string | null;
}

/** A dispatch ready to go: the branch it records before it is sent (null when the CI names it), and its send. */
export interface CiPreparedDispatch {
  ref: string | null;
  send: () => Promise<CiDispatchSent>;
}

/** A job listing, and whether every read behind it succeeded, so it may be kept. */
export type CiProviderJobListing = CiJobListing & { complete: boolean };

export interface CiProvider<K extends CiTargetType> {
  /** Whether a dispatch through the action can be sent from the place, on `ref` (the target's own when null). */
  readiness(db: DbClient, place: CiDispatchPlace, action: CiActionOf<K>, ref: string | null): Promise<CiReadiness>;
  /**
   * The dispatch of the action from the place, with dispatch id `id`, on `ref`
   * (the target's own when null), these input values beside the arguments.
   * Throws when it cannot go at all.
   */
  prepareDispatch(
    db: DbClient,
    input: {
      place: CiDispatchPlace;
      action: CiActionOf<K>;
      id: string;
      ref: string | null;
      inputs: Record<string, string>;
      actor: CredentialActor;
    },
  ): CiPreparedDispatch;
  /** The live branches of the project's repository the action may run on: none for a target with no repository. */
  repositoryBranches(db: DbClient, projectId: number, action: CiActionOf<K>, actor: CredentialActor): Promise<string[]>;
  /** Whether the action's target takes what a dispatch sends, without starting anything. */
  check(db: DbClient, projectId: number, action: CiActionOf<K>, use: CiServerUse): Promise<CiActionCheckResult>;
  /** The jobs the target lists, for the action editor. */
  listJobs(
    db: DbClient,
    projectId: number,
    target: CiListingTargetOf<K>,
    use: CiServerUse,
  ): Promise<CiProviderJobListing>;
  /** The fields the target's job declares, for the action editor. */
  listFields(
    db: DbClient,
    projectId: number,
    target: CiListingTargetOf<K>,
    use: CiServerUse,
  ): Promise<CiJobFieldListing>;
}
