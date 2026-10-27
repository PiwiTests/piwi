/**
 * True when the environment is a CI job: one of the providers `collectCiInfo`
 * names, a provider that sets no `CI` (TeamCity, AWS CodeBuild, Bamboo), or any
 * system that sets `CI` to anything but `false` or `0`.
 */
export function detectCi(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return Boolean(
    env.JENKINS_URL ||
    env.GITHUB_ACTIONS ||
    env.GITLAB_CI ||
    env.CIRCLECI ||
    env.TRAVIS ||
    env.TF_BUILD ||
    env.BITBUCKET_BUILD_NUMBER ||
    env.TEAMCITY_VERSION ||
    env.CODEBUILD_BUILD_ID ||
    env.bamboo_buildKey ||
    (env.CI && env.CI.toLowerCase() !== 'false' && env.CI !== '0'),
  );
}

/** A CI provider's id for the current pipeline and, where it exposes one, for the current job. */
interface CiIds {
  run: string;
  job: string | null;
}

/** Detect the current pipeline and job from well-known environment variables. Returns null outside CI. */
function detectCiIds(env: NodeJS.ProcessEnv): CiIds | null {
  if (env.GITHUB_ACTIONS && env.GITHUB_RUN_ID) {
    // A re-run keeps the run id and counts up the attempt.
    const run = env.GITHUB_RUN_ATTEMPT ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` : env.GITHUB_RUN_ID;
    return { run, job: env.GITHUB_JOB || null };
  }
  if (env.GITLAB_CI && env.CI_PIPELINE_ID) return { run: env.CI_PIPELINE_ID, job: env.CI_JOB_ID || null };
  if (env.CIRCLECI && env.CIRCLE_WORKFLOW_ID) return { run: env.CIRCLE_WORKFLOW_ID, job: env.CIRCLE_BUILD_NUM || null };
  if (env.TRAVIS && env.TRAVIS_BUILD_ID) return { run: env.TRAVIS_BUILD_ID, job: env.TRAVIS_JOB_ID || null };
  if (env.TF_BUILD && env.BUILD_BUILDID) return { run: env.BUILD_BUILDID, job: env.SYSTEM_JOBID || null };
  if (env.JENKINS_URL && env.BUILD_ID) return { run: env.BUILD_ID, job: null };
  if (env.BUILDKITE_BUILD_ID) return { run: env.BUILDKITE_BUILD_ID, job: env.BUILDKITE_JOB_ID || null };
  if (env.TEAMCITY_BUILD_ID) return { run: env.TEAMCITY_BUILD_ID, job: null };
  if (env.BITBUCKET_BUILD_NUMBER) return { run: env.BITBUCKET_BUILD_NUMBER, job: env.BITBUCKET_STEP_UUID || null };
  if (env.SEMAPHORE_WORKFLOW_ID) return { run: env.SEMAPHORE_WORKFLOW_ID, job: env.SEMAPHORE_JOB_ID || null };
  if (env.APPVEYOR_BUILD_ID) return { run: env.APPVEYOR_BUILD_ID, job: env.APPVEYOR_JOB_ID || null };
  if (env.DRONE_BUILD_NUMBER) return { run: env.DRONE_BUILD_NUMBER, job: null };
  return null;
}

/**
 * The run label a run's instance id is derived from: the configured
 * `runLabel`, else the CI pipeline's id, which every shard of the pipeline
 * shares so the shards merge into one run. A run that is not sharded also
 * carries the CI job's id where the provider exposes one, so parallel jobs of
 * one pipeline stay separate runs. Returns null outside CI without a label.
 */
export function resolveRunLabel(configured: string | null | undefined, sharded: boolean): string | null {
  if (configured) return configured;
  const ci = detectCiIds(process.env);
  if (!ci) return null;
  return !sharded && ci.job ? `${ci.run}|${ci.job}` : ci.run;
}
