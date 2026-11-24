/**
 * The CI providers, one per kind of target (`#shared/ci-targets`): what
 * reaches a CI action's target. The dispatch (`../ci-rerun.ts`), Check
 * (`../ci-actions.ts`) and the action editor's listings (`../ci-jobs.ts`) go
 * through the provider of the target's type.
 */
import type { CiTargetType } from '#shared/ci-targets';
import { bitbucketProvider } from './bitbucket';
import { ciServerProvider } from './ci-server';
import { githubProvider } from './github';
import { gitlabProvider } from './gitlab';
import type { CiProvider } from './types';

export type { CiProvider, CiReadiness } from './types';

const CI_PROVIDERS: { [K in CiTargetType]: CiProvider<K> } = {
  github: githubProvider,
  gitlab: gitlabProvider,
  bitbucket: bitbucketProvider,
  'ci-server': ciServerProvider,
};

/** The provider of a kind of target: pass the target's `type` with the action or target it serves. */
export function ciProvider<K extends CiTargetType>(type: K): CiProvider<K> {
  return CI_PROVIDERS[type];
}
