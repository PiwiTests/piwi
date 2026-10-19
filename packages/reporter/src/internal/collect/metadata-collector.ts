import { execSync } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
import { errorMessage } from '../support/errors.js';
import type { FullConfig, Suite, TestCase } from '@playwright/test/reporter';
import { Logger } from '../support/logger.js';
import type { SuiteConfigEntry } from '../../types.js';
import { isRunOriginKind, parseRunOriginRef, RUN_ORIGIN_METADATA_KEY, type RunOrigin } from '@piwitests/core/wire';
import { PIWI_ORIGIN_ENV } from '../config/env.js';

type Env = Record<string, string | undefined>;

/**
 * A git remote without the credentials a URL can carry (`https://gitlab-ci-token:<token>@host/repo`): its user name
 * and password are dropped. A remote with none, an scp-like one (`git@host:owner/repo`) and a local path come back
 * as they are.
 */
export function withoutCredentials(remoteUrl: string): string {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return remoteUrl;
  }
  if (!url.username && !url.password) return remoteUrl;
  url.username = '';
  url.password = '';
  return url.toString();
}

/** git's answer for a detached HEAD checkout — a state, not a branch name. */
const DETACHED_HEAD = 'HEAD';

/**
 * Resolve the logical branch through a fallback chain, never returning the
 * literal `HEAD` git reports on the detached checkouts CI creates:
 *
 *   1. `PIWI_BRANCH` — explicit operator override.
 *   2. CI provider branch variables, in the same provider precedence
 *      `collectCiInfo` uses (Jenkins → GitHub → GitLab → CircleCI → Travis →
 *      Azure), plus Bitbucket. Pull-request source-branch variables win over
 *      the plain ref so a PR build records the branch under test.
 *   3. git's `--abbrev-ref HEAD`, with `HEAD` treated as unknown.
 *
 * Returns `undefined` when nothing yields a real branch — callers store
 * "unknown", never `HEAD`.
 */
export function resolveScmBranch(env: Env, gitBranch?: string): string | undefined {
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) return value;
    }
    return undefined;
  };

  const override = env.PIWI_BRANCH?.trim();
  if (override) return override;

  let provider: string | undefined;
  if (env.JENKINS_URL) provider = pick('CHANGE_BRANCH', 'BRANCH_NAME');
  else if (env.GITHUB_ACTIONS) provider = pick('GITHUB_HEAD_REF', 'GITHUB_REF_NAME');
  else if (env.GITLAB_CI) provider = pick('CI_MERGE_REQUEST_SOURCE_BRANCH_NAME', 'CI_COMMIT_REF_NAME');
  else if (env.CIRCLECI) provider = pick('CIRCLE_BRANCH');
  else if (env.TRAVIS) provider = pick('TRAVIS_PULL_REQUEST_BRANCH', 'TRAVIS_BRANCH');
  else if (env.TF_BUILD) provider = pick('SYSTEM_PULLREQUEST_SOURCEBRANCH', 'BUILD_SOURCEBRANCHNAME');
  else if (env.BITBUCKET_BUILD_NUMBER) provider = pick('BITBUCKET_BRANCH');
  if (provider) return normalizeRef(provider);

  const trimmed = gitBranch?.trim();
  if (trimmed && trimmed !== DETACHED_HEAD) return trimmed;

  return undefined;
}

/**
 * Capture the pull-request number where the CI provider exposes it, so PR
 * feedback can look the PR up exactly instead of guessing by source branch.
 * GitHub carries it inside `GITHUB_REF` as `refs/pull/<n>/merge`; the others
 * expose a dedicated variable. Returned as a string to sit beside the other
 * string-valued SCM fields.
 */
export function resolveScmPrNumber(env: Env): string | undefined {
  const githubRef = env.GITHUB_ACTIONS ? env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\/(?:merge|head)$/) : undefined;
  const raw =
    githubRef?.[1] ??
    env.CI_MERGE_REQUEST_IID ??
    env.BITBUCKET_PR_ID ??
    env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER ??
    env.CHANGE_ID;
  const trimmed = raw?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Resolve the branch a pull-request build targets — the branch the run's own
 * branch forked from — so the dashboard can fall back to its history when the
 * feature branch has none of its own:
 *
 *   1. `PIWI_BASE_BRANCH` — explicit operator override.
 *   2. The CI provider's pull-request target variable, in the same provider
 *      precedence `resolveScmBranch` uses. Only pull-request builds carry one;
 *      a plain push build resolves nothing.
 *
 * Returns `undefined` outside a pull-request build — the dashboard then falls
 * back to the project's default branch.
 */
export function resolveScmBaseBranch(env: Env): string | undefined {
  const override = env.PIWI_BASE_BRANCH?.trim();
  if (override) return override;

  let target: string | undefined;
  if (env.JENKINS_URL) target = env.CHANGE_TARGET;
  else if (env.GITHUB_ACTIONS) target = env.GITHUB_BASE_REF;
  else if (env.GITLAB_CI) target = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  else if (env.TRAVIS)
    target = env.TRAVIS_PULL_REQUEST && env.TRAVIS_PULL_REQUEST !== 'false' ? env.TRAVIS_BRANCH : undefined;
  else if (env.TF_BUILD) target = env.SYSTEM_PULLREQUEST_TARGETBRANCH;
  else if (env.BITBUCKET_BUILD_NUMBER) target = env.BITBUCKET_PR_DESTINATION_BRANCH;

  const trimmed = target?.trim();
  return trimmed ? normalizeRef(trimmed) : undefined;
}

/**
 * True when the environment is a CI job: one of the providers `collectCiInfo`
 * names, or any system that sets `CI`.
 */
export function detectCi(env: Env): boolean {
  return Boolean(
    env.JENKINS_URL ||
    env.GITHUB_ACTIONS ||
    env.GITLAB_CI ||
    env.CIRCLECI ||
    env.TRAVIS ||
    env.TF_BUILD ||
    env.BITBUCKET_BUILD_NUMBER ||
    (env.CI && env.CI !== 'false' && env.CI !== '0'),
  );
}

/**
 * What launched the run: `PIWI_ORIGIN` when it names a known kind, else `ci`
 * in a CI job and `local` elsewhere. `PIWI_ORIGIN_REF` rides along when it is a
 * valid ref. `warn` hears about a `PIWI_ORIGIN` that names no known kind.
 */
export function resolveRunOrigin(env: Env, warn?: (message: string) => void): RunOrigin {
  const raw = env[PIWI_ORIGIN_ENV.kind]?.trim();
  let kind: RunOrigin['kind'] = detectCi(env) ? 'ci' : 'local';
  if (raw && isRunOriginKind(raw)) kind = raw;
  else if (raw) warn?.(`Ignoring ${PIWI_ORIGIN_ENV.kind}=${raw}: not a known run origin, recording "${kind}"`);
  const ref = parseRunOriginRef(env[PIWI_ORIGIN_ENV.ref]);
  return ref === undefined ? { kind } : { kind, ref };
}

/** Strip a leading `refs/heads/` a provider may prefix onto a branch variable. */
function normalizeRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Collects CI/CD environment metadata, SCM (git) information, and Playwright
 * config metadata to attach to each test run submission.
 *
 * Also owns all reach-through access to Playwright-internal suite fields
 * (`_parallelMode`, `_staticAnnotations`, `project()`) so the surface area that
 * breaks when Playwright renames those internals is guarded behind one class.
 */
export class MetadataCollector {
  constructor(private readonly logger: Logger = new Logger()) {}

  /** Collect all available metadata from the environment, config, and suite */
  collect(config: FullConfig, suite: Suite, options: any): Record<string, unknown> {
    // The directory spec paths are made relative to (see `testFile` in the reporter); the
    // dashboard strips it from the absolute locations Playwright gives steps.
    const metadata: Record<string, unknown> = {
      workingDir: process.cwd(),
      [RUN_ORIGIN_METADATA_KEY]: resolveRunOrigin(process.env, (message) => this.logger.warn(message)),
    };

    if (options.projectDescription) metadata.projectDescription = options.projectDescription;
    if (options.relatedIssue) metadata.relatedIssue = options.relatedIssue;
    if (options.ciInfo) metadata.ciInfo = options.ciInfo;
    if (options.tags && Array.isArray(options.tags)) metadata.tags = options.tags;
    if (options.customData) metadata.customData = options.customData;

    if (options.collectScmInfo) {
      const scm = this.collectScmInfo();
      if (scm) metadata.scm = scm;
    }

    if (options.collectCiInfo) {
      const ci = this.collectCiInfo();
      if (ci) metadata.ci = ci;
    }

    const htmlMeta = this.extractPlaywrightConfigMetadata(config);
    if (htmlMeta && Object.keys(htmlMeta).length > 0) metadata.htmlReport = htmlMeta;
    if (config.metadata) metadata.playwrightConfig = config.metadata;

    if (suite?.allTests) {
      const all = suite.allTests();
      if (all.length > 0) {
        const first = all[0];
        if (first?.parent) {
          const proj = (first.parent as any).project();
          if (proj?.metadata) metadata.playwrightProject = proj.metadata;
        }
      }
    }

    return metadata;
  }

  /** Walk the test's parent hierarchy to extract the resolved browser/project configuration */
  getBrowserConfig(test: TestCase): Record<string, any> | null {
    try {
      let suite: Suite | undefined = test.parent;
      let depth = 0;
      while (suite && depth < 20) {
        depth++;
        const project = (suite as any).project?.();
        if (project) {
          const use = project.use ?? {};
          const config: Record<string, any> = { projectName: project.name };
          if (use.browserName) config.browserName = use.browserName;
          if (use.channel) config.channel = use.channel;
          if (use.viewport) config.viewport = { width: use.viewport.width, height: use.viewport.height };
          if (use.deviceScaleFactor != null) config.deviceScaleFactor = use.deviceScaleFactor;
          if (use.isMobile != null) config.isMobile = use.isMobile;
          if (use.hasTouch != null) config.hasTouch = use.hasTouch;
          if (use.locale) config.locale = use.locale;
          if (use.timezoneId) config.timezoneId = use.timezoneId;
          if (use.geolocation) {
            config.geolocation = {
              longitude: use.geolocation.longitude,
              latitude: use.geolocation.latitude,
              ...(use.geolocation.accuracy != null && { accuracy: use.geolocation.accuracy }),
            };
          }
          if (use.colorScheme) config.colorScheme = use.colorScheme;
          if (use.reducedMotion) config.reducedMotion = use.reducedMotion;
          if (use.forcedColors) config.forcedColors = use.forcedColors;
          if (use.contrast) config.contrast = use.contrast;
          if (use.offline) config.offline = use.offline;
          if (use.bypassCSP) config.bypassCSP = use.bypassCSP;
          if (use.javaScriptEnabled === false) config.javaScriptEnabled = false;
          if (use.serviceWorkers) config.serviceWorkers = use.serviceWorkers;
          if (use.userAgent) config.userAgent = use.userAgent;
          return config;
        }
        suite = suite.parent;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Walk the test's parent `describe` suites to extract the suite path (titles)
   * and per-level config (parallel mode + annotations). Reaches into Playwright
   * suite internals (`_parallelMode`, `_staticAnnotations`) — kept here next to
   * `getBrowserConfig` so all such access is guarded behind one class.
   */
  getSuiteInfo(test: TestCase): { suitePath: string[]; suiteConfig: SuiteConfigEntry[] } {
    const suitePath: string[] = [];
    const suiteConfig: SuiteConfigEntry[] = [];
    const suites: Suite[] = [];

    let suite: Suite | undefined = test.parent;
    while (suite && suite.type === 'describe') {
      suites.unshift(suite);
      suite = suite.parent;
    }

    for (const s of suites) {
      if (!s.title) continue;
      suitePath.push(s.title);
      const rawMode = (s as any)._parallelMode as string | undefined;
      const mode: SuiteConfigEntry['mode'] =
        rawMode === 'parallel' ? 'parallel' : rawMode === 'serial' ? 'serial' : 'default';
      // Playwright stores a describe's annotations with their source location;
      // the wire carries the type and description only.
      const staticAnnotations: Array<{ type: string; description?: string }> = (s as any)._staticAnnotations ?? [];
      const annotations = staticAnnotations.map((a) =>
        a.description === undefined ? { type: a.type } : { type: a.type, description: a.description },
      );
      suiteConfig.push({ mode, annotations });
    }

    return { suitePath, suiteConfig };
  }

  private collectScmInfo(): Record<string, string> | undefined {
    const scm: Record<string, string> = {};
    let gitBranch: string | undefined;
    try {
      const execOpts: { encoding: 'utf8'; timeout: number; maxBuffer: number; stdio: StdioOptions } = {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      };
      scm.commit = execSync('git rev-parse HEAD', execOpts).trim();
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim();
      scm.author = execSync('git log -1 --pretty=format:"%an"', execOpts).trim();
      scm.commitMessage = execSync('git log -1 --pretty=format:"%s"', execOpts).trim();
      try {
        scm.remoteUrl = withoutCredentials(execSync('git config --get remote.origin.url', execOpts).trim());
      } catch {
        /* optional */
      }
    } catch (error) {
      this.logger.debug(`Git info not available: ${errorMessage(error)}`);
    }

    // Resolve the logical branch (plus the PR number and the branch it targets)
    // from the operator override and CI provider variables even when git is
    // unavailable or detached, so a CI pull-request build never records the
    // literal `HEAD` git reports.
    const branch = resolveScmBranch(process.env, gitBranch);
    if (branch) scm.branch = branch;
    const prNumber = resolveScmPrNumber(process.env);
    if (prNumber) scm.prNumber = prNumber;
    const baseBranch = resolveScmBaseBranch(process.env);
    if (baseBranch) scm.baseBranch = baseBranch;

    return Object.keys(scm).length > 0 ? scm : undefined;
  }

  private collectCiInfo(): Record<string, string | boolean | undefined> | undefined {
    // Env vars are `string | undefined`; undefined values are dropped on JSON
    // serialization, so they are collected as-is.
    const ci: Record<string, string | boolean | undefined> = {};
    const env = process.env;

    if (env.JENKINS_URL) {
      ci.provider = 'Jenkins';
      ci.buildNumber = env.BUILD_NUMBER;
      ci.buildUrl = env.BUILD_URL;
      ci.jobName = env.JOB_NAME;
    } else if (env.GITHUB_ACTIONS) {
      ci.provider = 'GitHub Actions';
      ci.runId = env.GITHUB_RUN_ID;
      ci.runNumber = env.GITHUB_RUN_NUMBER;
      ci.workflow = env.GITHUB_WORKFLOW;
      ci.actor = env.GITHUB_ACTOR;
      ci.repository = env.GITHUB_REPOSITORY;
      ci.ref = env.GITHUB_REF;
      ci.sha = env.GITHUB_SHA;
      ci.serverUrl = env.GITHUB_SERVER_URL;
      if (ci.serverUrl && ci.repository && ci.runId) {
        ci.buildUrl = `${ci.serverUrl}/${ci.repository}/actions/runs/${ci.runId}`;
      }
    } else if (env.GITLAB_CI) {
      ci.provider = 'GitLab CI';
      ci.pipelineId = env.CI_PIPELINE_ID;
      ci.pipelineUrl = env.CI_PIPELINE_URL;
      ci.jobId = env.CI_JOB_ID;
      ci.jobUrl = env.CI_JOB_URL;
      ci.jobName = env.CI_JOB_NAME;
    } else if (env.CIRCLECI) {
      ci.provider = 'CircleCI';
      ci.buildNumber = env.CIRCLE_BUILD_NUM;
      ci.buildUrl = env.CIRCLE_BUILD_URL;
      ci.jobName = env.CIRCLE_JOB;
      ci.workflow = env.CIRCLE_WORKFLOW_ID;
    } else if (env.TRAVIS) {
      ci.provider = 'Travis CI';
      ci.buildNumber = env.TRAVIS_BUILD_NUMBER;
      ci.buildUrl = env.TRAVIS_BUILD_WEB_URL;
      ci.jobNumber = env.TRAVIS_JOB_NUMBER;
    } else if (env.TF_BUILD) {
      ci.provider = 'Azure Pipelines';
      ci.buildNumber = env.BUILD_BUILDNUMBER;
      ci.buildId = env.BUILD_BUILDID;
      if (env.SYSTEM_TEAMFOUNDATIONSERVERURI && env.SYSTEM_TEAMPROJECT && env.BUILD_BUILDID) {
        ci.buildUrl = `${env.SYSTEM_TEAMFOUNDATIONSERVERURI}${env.SYSTEM_TEAMPROJECT}/_build/results?buildId=${env.BUILD_BUILDID}`;
      }
      ci.jobName = env.AGENT_JOBNAME;
    } else if (env.BITBUCKET_BUILD_NUMBER) {
      ci.provider = 'Bitbucket Pipelines';
      ci.buildNumber = env.BITBUCKET_BUILD_NUMBER;
      ci.pipelineId = env.BITBUCKET_PIPELINE_UUID;
      ci.jobId = env.BITBUCKET_STEP_UUID;
      ci.repository = env.BITBUCKET_REPO_FULL_NAME;
      if (env.BITBUCKET_REPO_FULL_NAME) {
        ci.buildUrl = `https://bitbucket.org/${env.BITBUCKET_REPO_FULL_NAME}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}`;
      }
    } else if (env.CI) {
      ci.provider = 'Unknown CI';
      ci.detected = true;
    }

    return Object.keys(ci).length > 0 ? ci : undefined;
  }

  private extractPlaywrightConfigMetadata(config: FullConfig): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    if (config.projects?.length > 0) {
      meta.projects = config.projects.map((p: any) => ({
        name: p.name,
        testDir: p.testDir,
        use: {
          browserName: p.use?.browserName || p.name,
          // The origin of `baseURL` is what the graph treats as the run's own
          // surface, so only requests to it become route nodes.
          baseURL: p.use?.baseURL,
          // The attribute `getByTestId` reads, so the locator index can resolve those locators on a live page.
          testIdAttribute: p.use?.testIdAttribute,
          viewport: p.use?.viewport,
          deviceScaleFactor: p.use?.deviceScaleFactor,
        },
      }));
    }
    meta.workers = config.workers;
    meta.timeout = config.globalTimeout;
    meta.fullyParallel = config.fullyParallel;
    return meta;
  }
}
