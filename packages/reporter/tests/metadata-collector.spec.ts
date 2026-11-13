import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FullConfig } from '@playwright/test/reporter';
import {
  MetadataCollector,
  resolveRunOrigin,
  resolveRunRef,
  resolveScmBaseBranch,
  resolveScmBranch,
  resolveScmPrNumber,
  withoutCredentials,
} from '../src/internal/collect/metadata-collector.js';
import { readPlanStamp } from '../src/internal/support/selection-env.js';
import { detectCi } from '../src/internal/support/ci.js';

const CI_ENV_KEYS = [
  'JENKINS_URL',
  'BUILD_NUMBER',
  'BUILD_URL',
  'JOB_NAME',
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_WORKFLOW',
  'GITHUB_ACTOR',
  'GITHUB_REPOSITORY',
  'GITHUB_REF',
  'GITHUB_SHA',
  'GITHUB_SERVER_URL',
  'GITLAB_CI',
  'CI_PIPELINE_ID',
  'CI_PIPELINE_URL',
  'CI_JOB_ID',
  'CI_JOB_URL',
  'CI_JOB_NAME',
  'CIRCLECI',
  'CIRCLE_BUILD_NUM',
  'CIRCLE_BUILD_URL',
  'CIRCLE_JOB',
  'CIRCLE_WORKFLOW_ID',
  'TRAVIS',
  'TRAVIS_BUILD_NUMBER',
  'TRAVIS_BUILD_WEB_URL',
  'TRAVIS_JOB_NUMBER',
  'TF_BUILD',
  'BUILD_BUILDNUMBER',
  'BUILD_BUILDID',
  'SYSTEM_TEAMFOUNDATIONSERVERURI',
  'SYSTEM_TEAMPROJECT',
  'AGENT_JOBNAME',
  'BITBUCKET_BUILD_NUMBER',
  'BITBUCKET_PIPELINE_UUID',
  'BITBUCKET_STEP_UUID',
  'BITBUCKET_REPO_FULL_NAME',
  'CI',
  'PIWI_ORIGIN',
  'PIWI_ORIGIN_REF',
];

const SAVED_CI_ENV: Record<string, string | undefined> = {};

function fakeConfig(): FullConfig {
  return { projects: [], workers: 1, globalTimeout: 0, fullyParallel: false } as unknown as FullConfig;
}

/** Build a fake describe suite chain: root → parent → child (the test's parent). */
function fakeSuiteChain(opts: { parallelMode?: string; annotations?: any[]; titles?: string[] } = {}): any {
  const titles = opts.titles ?? ['Outer', 'Inner'];
  const make = (title: string, parent: any, mode?: string, annotations?: any[]): any => ({
    type: 'describe',
    title,
    parent,
    _parallelMode: mode,
    _staticAnnotations: annotations,
  });
  const root = make('', undefined, undefined, undefined);
  root.type = 'project'; // root is not a describe
  let current = root;
  const outer = make(titles[0], current, opts.parallelMode ?? 'serial', opts.annotations);
  current = outer;
  const inner = make(titles[1] ?? '', current, 'parallel', []);
  return { root, outer, inner };
}

describe('MetadataCollector.getSuiteInfo', () => {
  it('walks the describe chain collecting titles and per-level config', () => {
    const mc = new MetadataCollector();
    const { inner } = fakeSuiteChain({
      parallelMode: 'serial',
      annotations: [{ type: 'skip', description: 'flaky' }],
      titles: ['Outer', 'Inner'],
    });
    const test = { parent: inner } as any;
    const info = mc.getSuiteInfo(test);
    expect(info.suitePath).toEqual(['Outer', 'Inner']);
    expect(info.suiteConfig.length).toBe(2);
    expect(info.suiteConfig[0].mode).toBe('serial');
    expect(info.suiteConfig[0].annotations).toEqual([{ type: 'skip', description: 'flaky' }]);
    expect(info.suiteConfig[1].mode).toBe('parallel');
  });

  it('keeps the type and description of a describe annotation and drops its location', () => {
    const mc = new MetadataCollector();
    const location = { file: '/repo/tests/a.spec.ts', line: 2, column: 6 };
    const { inner } = fakeSuiteChain({
      annotations: [
        { type: 'issue', description: 'PAY-1', location },
        { type: 'skip', location },
      ],
      titles: ['Outer', 'Inner'],
    });
    const info = mc.getSuiteInfo({ parent: inner } as any);
    expect(info.suiteConfig[0].annotations).toEqual([{ type: 'issue', description: 'PAY-1' }, { type: 'skip' }]);
  });

  it('defaults unknown mode to "default"', () => {
    const mc = new MetadataCollector();
    const { outer } = fakeSuiteChain({ parallelMode: undefined, titles: ['Solo'] });
    const inner = { type: 'describe', title: 'Inner', parent: outer, _parallelMode: undefined, _staticAnnotations: [] };
    const test = { parent: inner } as any;
    const info = mc.getSuiteInfo(test);
    expect(info.suiteConfig[info.suiteConfig.length - 1].mode).toBe('default');
  });

  it('skips suites with empty titles', () => {
    const mc = new MetadataCollector();
    const root = { type: 'project', title: '', parent: undefined };
    const empty = { type: 'describe', title: '', parent: root, _parallelMode: 'parallel', _staticAnnotations: [] };
    const named = { type: 'describe', title: 'Named', parent: empty, _parallelMode: 'serial', _staticAnnotations: [] };
    const test = { parent: named } as any;
    const info = mc.getSuiteInfo(test);
    expect(info.suitePath).toEqual(['Named']);
  });

  it('returns empty arrays when the test has no describe parents', () => {
    const mc = new MetadataCollector();
    const root = { type: 'project', title: '', parent: undefined };
    const test = { parent: root } as any;
    const info = mc.getSuiteInfo(test);
    expect(info.suitePath).toEqual([]);
    expect(info.suiteConfig).toEqual([]);
  });
});

describe('MetadataCollector.getBrowserConfig', () => {
  it('walks up to find a project() and returns a browser config', () => {
    const mc = new MetadataCollector();
    const project = { name: 'chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 } } };
    const suite = { parent: { project: () => project } };
    const test = { parent: suite } as any;
    const cfg = mc.getBrowserConfig(test);
    expect(cfg?.projectName).toBe('chromium');
    expect(cfg?.browserName).toBe('chromium');
    expect(cfg?.viewport).toEqual({ width: 1280, height: 720 });
  });

  it('names the engine a devices preset sets as defaultBrowserType', () => {
    const mc = new MetadataCollector();
    const project = {
      name: 'Polaris',
      use: { defaultBrowserType: 'chromium', viewport: { width: 1280, height: 720 } },
    };
    const test = { parent: { project: () => project } } as any;
    const cfg = mc.getBrowserConfig(test);
    expect(cfg?.projectName).toBe('Polaris');
    expect(cfg?.browserName).toBe('chromium');
  });

  it('prefers an explicit browserName over the preset default', () => {
    const mc = new MetadataCollector();
    const project = { name: 'Polaris', use: { browserName: 'firefox', defaultBrowserType: 'chromium' } };
    const test = { parent: { project: () => project } } as any;
    expect(mc.getBrowserConfig(test)?.browserName).toBe('firefox');
  });

  it('leaves browserName out when the project names no engine', () => {
    const mc = new MetadataCollector();
    const project = { name: 'Polaris', use: {} };
    const test = { parent: { project: () => project } } as any;
    expect(mc.getBrowserConfig(test)).not.toHaveProperty('browserName');
  });

  it('returns null when no project() is found within the depth limit', () => {
    const mc = new MetadataCollector();
    const test = { parent: { parent: { parent: undefined } } } as any;
    expect(mc.getBrowserConfig(test)).toBe(null);
  });

  it('captures the contrast preference alongside reducedMotion and forcedColors', () => {
    const mc = new MetadataCollector();
    const project = {
      name: 'chromium',
      use: { reducedMotion: 'reduce', forcedColors: 'active', contrast: 'more' },
    };
    const test = { parent: { parent: { project: () => project } } } as any;
    const cfg = mc.getBrowserConfig(test);
    expect(cfg?.reducedMotion).toBe('reduce');
    expect(cfg?.forcedColors).toBe('active');
    expect(cfg?.contrast).toBe('more');
  });

  it('omits contrast when the project does not set it', () => {
    const mc = new MetadataCollector();
    const project = { name: 'chromium', use: { browserName: 'chromium' } };
    const test = { parent: { parent: { project: () => project } } } as any;
    expect(mc.getBrowserConfig(test)).not.toHaveProperty('contrast');
  });
});

describe('MetadataCollector.collect — CI provider detection', () => {
  beforeEach(() => {
    for (const k of CI_ENV_KEYS) SAVED_CI_ENV[k] = process.env[k];
    for (const k of CI_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of CI_ENV_KEYS) {
      if (SAVED_CI_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_CI_ENV[k];
    }
  });

  function collectCi(): Record<string, unknown> | undefined {
    const mc = new MetadataCollector();
    const metadata = mc.collect(fakeConfig(), undefined as any, { collectCiInfo: true });
    return metadata.ci as Record<string, unknown> | undefined;
  }

  it('omits metadata.ci entirely outside of any known CI', () => {
    expect(collectCi()).toBeUndefined();
  });

  it('detects GitHub Actions and builds the run URL', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = '123';
    process.env.GITHUB_REPOSITORY = 'acme/widgets';
    process.env.GITHUB_SERVER_URL = 'https://github.com';
    const ci = collectCi();
    expect(ci?.provider).toBe('GitHub Actions');
    expect(ci?.buildUrl).toBe('https://github.com/acme/widgets/actions/runs/123');
  });

  it('detects GitLab CI', () => {
    process.env.GITLAB_CI = 'true';
    process.env.CI_PIPELINE_ID = '456';
    process.env.CI_JOB_NAME = 'test';
    const ci = collectCi();
    expect(ci?.provider).toBe('GitLab CI');
    expect(ci?.pipelineId).toBe('456');
    expect(ci?.jobName).toBe('test');
  });

  it('detects CircleCI, Travis CI, and Azure Pipelines', () => {
    process.env.CIRCLECI = 'true';
    expect(collectCi()?.provider).toBe('CircleCI');
    delete process.env.CIRCLECI;

    process.env.TRAVIS = 'true';
    expect(collectCi()?.provider).toBe('Travis CI');
    delete process.env.TRAVIS;

    process.env.TF_BUILD = 'true';
    expect(collectCi()?.provider).toBe('Azure Pipelines');
  });

  it('detects Bitbucket Pipelines with its build number and a link to the build', () => {
    process.env.CI = 'true';
    process.env.BITBUCKET_BUILD_NUMBER = '87';
    process.env.BITBUCKET_REPO_FULL_NAME = 'acme/widgets';
    process.env.BITBUCKET_PIPELINE_UUID = '{1234}';
    const ci = collectCi();
    expect(ci?.provider).toBe('Bitbucket Pipelines');
    expect(ci?.buildNumber).toBe('87');
    expect(ci?.pipelineId).toBe('{1234}');
    expect(ci?.buildUrl).toBe('https://bitbucket.org/acme/widgets/pipelines/results/87');
  });

  it('falls back to "Unknown CI" when only the generic CI var is set', () => {
    process.env.CI = 'true';
    const ci = collectCi();
    expect(ci?.provider).toBe('Unknown CI');
    expect(ci?.detected).toBe(true);
  });

  it('prioritizes Jenkins over other providers when multiple env vars are set', () => {
    process.env.JENKINS_URL = 'https://ci.example.com';
    process.env.GITHUB_ACTIONS = 'true';
    process.env.CI = 'true';
    expect(collectCi()?.provider).toBe('Jenkins');
  });

  it('does not collect CI info when collectCiInfo is false', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const mc = new MetadataCollector();
    const metadata = mc.collect(fakeConfig(), undefined as any, { collectCiInfo: false });
    expect(metadata.ci).toBeUndefined();
  });
});

describe('the working directory a run names', () => {
  it("is the folder its spec paths are relative to: the Playwright config's", () => {
    const config = { ...fakeConfig(), configFile: '/repo/e2e/playwright.config.ts' } as unknown as FullConfig;
    expect(new MetadataCollector().collect(config, undefined as any, {}).workingDir).toBe('/repo/e2e');
    expect(new MetadataCollector().collect(fakeConfig(), undefined as any, {}).workingDir).toBe(process.cwd());
  });
});

describe("the Playwright config's and project's metadata", () => {
  /** A suite whose first test's project carries `metadata`. */
  const suiteOfProject = (metadata: unknown): any => ({
    allTests: () => [{ parent: { project: () => ({ metadata }) } }],
  });

  it("go once each: a project that shares the config's, Playwright's git diff included, sends none of its own", () => {
    const configMetadata = { gitDiff: 'diff --git a/app.ts b/app.ts', gitCommit: { hash: 'abc123' } };
    const config = { ...fakeConfig(), metadata: configMetadata } as unknown as FullConfig;

    const shared = new MetadataCollector().collect(config, suiteOfProject(configMetadata), {});
    expect(shared.playwrightConfig).toEqual(configMetadata);
    expect(shared.playwrightProject).toBeUndefined();

    const copied = new MetadataCollector().collect(config, suiteOfProject(structuredClone(configMetadata)), {});
    expect(copied.playwrightProject).toBeUndefined();

    const own = new MetadataCollector().collect(config, suiteOfProject({ team: 'checkout' }), {});
    expect(own.playwrightProject).toEqual({ team: 'checkout' });
  });
});

describe('the run origin', () => {
  it('is local outside CI, with nothing set', () => {
    expect(resolveRunOrigin({})).toEqual({ kind: 'local' });
    expect(detectCi({ CI: 'false' })).toBe(false);
    expect(detectCi({ CI: 'False' })).toBe(false);
  });

  it('is ci when a CI provider is detected', () => {
    expect(resolveRunOrigin({ GITHUB_ACTIONS: 'true' })).toEqual({ kind: 'ci' });
    expect(resolveRunOrigin({ BITBUCKET_BUILD_NUMBER: '3' })).toEqual({ kind: 'ci' });
    expect(resolveRunOrigin({ TEAMCITY_VERSION: '2026.1' })).toEqual({ kind: 'ci' });
    expect(resolveRunOrigin({ CODEBUILD_BUILD_ID: 'build:1' })).toEqual({ kind: 'ci' });
    expect(resolveRunOrigin({ bamboo_buildKey: 'PROJ-PLAN-JOB1' })).toEqual({ kind: 'ci' });
    expect(resolveRunOrigin({ CI: 'true' })).toEqual({ kind: 'ci' });
  });

  it('is what PIWI_ORIGIN names, with its ref, in CI or not', () => {
    expect(resolveRunOrigin({ PIWI_ORIGIN: 'bisect', PIWI_ORIGIN_REF: '214' })).toEqual({ kind: 'bisect', ref: '214' });
    expect(resolveRunOrigin({ GITLAB_CI: 'true', PIWI_ORIGIN: 'ci-rerun', PIWI_ORIGIN_REF: 'a1b2' })).toEqual({
      kind: 'ci-rerun',
      ref: 'a1b2',
    });
  });

  it('ignores an unknown PIWI_ORIGIN with a warning, and a ref it cannot store', () => {
    const warnings: string[] = [];
    expect(resolveRunOrigin({ CI: 'true', PIWI_ORIGIN: 'nightly' }, (m) => warnings.push(m))).toEqual({ kind: 'ci' });
    expect(warnings[0]).toContain('nightly');
    expect(resolveRunOrigin({ PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: 'a b' })).toEqual({ kind: 'editor' });
  });

  it('is stamped on every run, whatever the collectors', () => {
    const saved = { origin: process.env.PIWI_ORIGIN, ref: process.env.PIWI_ORIGIN_REF };
    process.env.PIWI_ORIGIN = 'desktop';
    delete process.env.PIWI_ORIGIN_REF;
    try {
      const metadata = new MetadataCollector().collect(fakeConfig(), undefined as any, { collectCiInfo: false });
      expect(metadata.piwiOrigin).toEqual({ kind: 'desktop' });
    } finally {
      if (saved.origin === undefined) delete process.env.PIWI_ORIGIN;
      else process.env.PIWI_ORIGIN = saved.origin;
      if (saved.ref !== undefined) process.env.PIWI_ORIGIN_REF = saved.ref;
    }
  });
});

describe('resolveRunRef', () => {
  it("is the launcher's name for the run, beside the shared origin ref", () => {
    expect(resolveRunRef({ PIWI_ORIGIN: 'reproduce', PIWI_ORIGIN_REF: '42', PIWI_RUN_REF: 'desktop-7' })).toBe(
      'desktop-7',
    );
    expect(resolveRunRef({ PIWI_ORIGIN: 'bisect', PIWI_RUN_REF: 'desktop-8-unattended' })).toBe('desktop-8-unattended');
  });

  it('is the one a terminal run following an editor was given, and an editor run’s origin ref', () => {
    expect(resolveRunRef({ PIWI_RUN_REF: 'terminal-12-34' })).toBe('terminal-12-34');
    expect(resolveRunRef({ PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: 'ed-0a1b2c3d' })).toBe('ed-0a1b2c3d');
    // Another launcher's origin ref names what it is about, not the run.
    expect(resolveRunRef({ PIWI_ORIGIN: 'reproduce', PIWI_ORIGIN_REF: '42' })).toBeUndefined();
  });

  it('is one of its own outside CI when nothing named the run, and none in a CI job no launcher started', () => {
    const own = () => 'local-1-2';
    expect(resolveRunRef({}, own)).toBe('local-1-2');
    expect(resolveRunRef({ PIWI_ORIGIN: 'nightly', PIWI_RUN_REF: 'a b' }, own)).toBe('local-1-2');
    expect(resolveRunRef({ CI: 'true' }, own)).toBeUndefined();
    expect(resolveRunRef({ CI: 'true', PIWI_RUN_REF: 'terminal-12-34' }, own)).toBeUndefined();
    expect(resolveRunRef({ CI: 'true', PIWI_ORIGIN: 'bisect', PIWI_RUN_REF: 'desktop-8' }, own)).toBe('desktop-8');
    // A launcher whose name for the run cannot be stored.
    expect(resolveRunRef({ PIWI_ORIGIN: 'desktop', PIWI_RUN_REF: 'a b' }, own)).toBeUndefined();
    expect(resolveRunRef({ PIWI_ORIGIN: 'desktop' }, own)).toBeUndefined();
  });
});

describe('withoutCredentials', () => {
  it('drops the user name and the password a remote URL carries', () => {
    expect(withoutCredentials('https://gitlab-ci-token:glcbt-secret@gitlab.example.com/group/app.git')).toBe(
      'https://gitlab.example.com/group/app.git',
    );
    expect(withoutCredentials('https://ghp_secret@github.com/acme/app')).toBe('https://github.com/acme/app');
    expect(withoutCredentials('ssh://git:secret@host.example.com/acme/app.git')).toBe(
      'ssh://host.example.com/acme/app.git',
    );
  });

  it('keeps a remote without credentials, an scp-like remote and a local path as they are', () => {
    for (const remote of [
      'https://github.com/acme/app.git',
      'git@github.com:acme/app.git',
      '/srv/git/app.git',
      'C:\\repos\\app',
    ]) {
      expect(withoutCredentials(remote)).toBe(remote);
    }
  });
});

describe('resolveScmBranch — branch fallback chain', () => {
  it('returns undefined when nothing points at a branch', () => {
    expect(resolveScmBranch({})).toBeUndefined();
  });

  it("treats git's literal HEAD (detached checkout) as unknown", () => {
    expect(resolveScmBranch({}, 'HEAD')).toBeUndefined();
  });

  it('uses the git branch when it is a real name', () => {
    expect(resolveScmBranch({}, 'feature/login')).toBe('feature/login');
  });

  it('PIWI_BRANCH overrides everything, including a real git branch and CI vars', () => {
    const env = { PIWI_BRANCH: 'override', GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'main' };
    expect(resolveScmBranch(env, 'local-branch')).toBe('override');
  });

  it('GitHub Actions: prefers GITHUB_HEAD_REF (PR events) over GITHUB_REF_NAME', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: 'feature/x', GITHUB_REF_NAME: '5/merge' };
    expect(resolveScmBranch(env, 'HEAD')).toBe('feature/x');
  });

  it('GitHub Actions: falls back to GITHUB_REF_NAME on push events', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'main' };
    expect(resolveScmBranch(env, 'HEAD')).toBe('main');
  });

  it('GitLab: prefers the merge-request source branch over CI_COMMIT_REF_NAME', () => {
    const env = {
      GITLAB_CI: 'true',
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feature/y',
      CI_COMMIT_REF_NAME: 'detached',
    };
    expect(resolveScmBranch(env, 'HEAD')).toBe('feature/y');
  });

  it('GitLab: falls back to CI_COMMIT_REF_NAME', () => {
    expect(resolveScmBranch({ GITLAB_CI: 'true', CI_COMMIT_REF_NAME: 'develop' }, 'HEAD')).toBe('develop');
  });

  it('CircleCI reads CIRCLE_BRANCH', () => {
    expect(resolveScmBranch({ CIRCLECI: 'true', CIRCLE_BRANCH: 'topic' }, 'HEAD')).toBe('topic');
  });

  it('Travis prefers the PR branch over TRAVIS_BRANCH', () => {
    const env = { TRAVIS: 'true', TRAVIS_PULL_REQUEST_BRANCH: 'pr-branch', TRAVIS_BRANCH: 'main' };
    expect(resolveScmBranch(env, 'HEAD')).toBe('pr-branch');
    expect(resolveScmBranch({ TRAVIS: 'true', TRAVIS_BRANCH: 'main' }, 'HEAD')).toBe('main');
  });

  it('Azure Pipelines prefers the PR source branch, stripping refs/heads/', () => {
    const env = { TF_BUILD: 'true', SYSTEM_PULLREQUEST_SOURCEBRANCH: 'refs/heads/feature/z' };
    expect(resolveScmBranch(env, 'HEAD')).toBe('feature/z');
    expect(resolveScmBranch({ TF_BUILD: 'true', BUILD_SOURCEBRANCHNAME: 'main' }, 'HEAD')).toBe('main');
  });

  it('Jenkins prefers CHANGE_BRANCH over BRANCH_NAME', () => {
    const env = { JENKINS_URL: 'x', CHANGE_BRANCH: 'pr-src', BRANCH_NAME: 'PR-42' };
    expect(resolveScmBranch(env, 'HEAD')).toBe('pr-src');
  });

  it('Bitbucket reads BITBUCKET_BRANCH', () => {
    const env = { BITBUCKET_BUILD_NUMBER: '9', BITBUCKET_BRANCH: 'bb-branch' };
    expect(resolveScmBranch(env, 'HEAD')).toBe('bb-branch');
  });

  it('follows the same provider precedence as CI detection (Jenkins wins over GitHub)', () => {
    const env = { JENKINS_URL: 'x', BRANCH_NAME: 'jenkins-branch', GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'gh' };
    expect(resolveScmBranch(env, 'HEAD')).toBe('jenkins-branch');
  });

  it('falls back to git when the detected provider exposes no branch var', () => {
    expect(resolveScmBranch({ GITHUB_ACTIONS: 'true' }, 'local-work')).toBe('local-work');
  });
});

describe('resolveScmPrNumber — pull-request number capture', () => {
  it('returns undefined when no provider exposes a PR number', () => {
    expect(resolveScmPrNumber({})).toBeUndefined();
  });

  it("parses the PR number out of GitHub's refs/pull/N/merge ref", () => {
    expect(resolveScmPrNumber({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/42/merge' })).toBe('42');
    expect(resolveScmPrNumber({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/7/head' })).toBe('7');
  });

  it('ignores GitHub branch refs that are not pull requests', () => {
    expect(resolveScmPrNumber({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' })).toBeUndefined();
  });

  it('reads GitLab CI_MERGE_REQUEST_IID', () => {
    expect(resolveScmPrNumber({ CI_MERGE_REQUEST_IID: '13' })).toBe('13');
  });

  it('reads Bitbucket BITBUCKET_PR_ID, Azure, and Jenkins CHANGE_ID', () => {
    expect(resolveScmPrNumber({ BITBUCKET_PR_ID: '21' })).toBe('21');
    expect(resolveScmPrNumber({ SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '34' })).toBe('34');
    expect(resolveScmPrNumber({ CHANGE_ID: '55' })).toBe('55');
  });

  it('rejects non-numeric PR values', () => {
    expect(resolveScmPrNumber({ CHANGE_ID: 'not-a-number' })).toBeUndefined();
  });
});

describe('resolveScmBaseBranch — pull-request target branch capture', () => {
  it('returns undefined outside a pull-request build', () => {
    expect(resolveScmBaseBranch({})).toBeUndefined();
    expect(resolveScmBaseBranch({ GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'main' })).toBeUndefined();
    expect(
      resolveScmBaseBranch({ TRAVIS: 'true', TRAVIS_PULL_REQUEST: 'false', TRAVIS_BRANCH: 'main' }),
    ).toBeUndefined();
  });

  it('PIWI_BASE_BRANCH overrides the provider variable', () => {
    const env = { PIWI_BASE_BRANCH: 'release/2', GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' };
    expect(resolveScmBaseBranch(env)).toBe('release/2');
  });

  it('GitHub Actions reads GITHUB_BASE_REF', () => {
    expect(resolveScmBaseBranch({ GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'develop' })).toBe('develop');
  });

  it('GitLab reads the merge-request target branch', () => {
    const env = { GITLAB_CI: 'true', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main' };
    expect(resolveScmBaseBranch(env)).toBe('main');
  });

  it('Travis uses TRAVIS_BRANCH only on a pull-request build', () => {
    expect(resolveScmBaseBranch({ TRAVIS: 'true', TRAVIS_PULL_REQUEST: '12', TRAVIS_BRANCH: 'main' })).toBe('main');
  });

  it('Azure Pipelines strips refs/heads/ from the target branch', () => {
    const env = { TF_BUILD: 'true', SYSTEM_PULLREQUEST_TARGETBRANCH: 'refs/heads/main' };
    expect(resolveScmBaseBranch(env)).toBe('main');
  });

  it('Jenkins and Bitbucket read their destination variables', () => {
    expect(resolveScmBaseBranch({ JENKINS_URL: 'x', CHANGE_TARGET: 'main' })).toBe('main');
    expect(resolveScmBaseBranch({ BITBUCKET_BUILD_NUMBER: '9', BITBUCKET_PR_DESTINATION_BRANCH: 'trunk' })).toBe(
      'trunk',
    );
  });
});

describe('MetadataCollector.collect — passthrough options and config metadata', () => {
  it('copies projectDescription/relatedIssue/ciInfo/tags/customData into metadata', () => {
    const mc = new MetadataCollector();
    const metadata = mc.collect(fakeConfig(), undefined as any, {
      projectDescription: 'desc',
      relatedIssue: 'JIRA-1',
      ciInfo: 'custom ci blurb',
      tags: ['smoke'],
      customData: { team: 'checkout' },
    });
    expect(metadata.projectDescription).toBe('desc');
    expect(metadata.relatedIssue).toBe('JIRA-1');
    expect(metadata.ciInfo).toBe('custom ci blurb');
    expect(metadata.tags).toEqual(['smoke']);
    expect(metadata.customData).toEqual({ team: 'checkout' });
  });

  it('extracts project/workers/timeout config into metadata.htmlReport', () => {
    const mc = new MetadataCollector();
    const config = {
      projects: [{ name: 'chromium', testDir: 'tests', use: { browserName: 'chromium' } }],
      workers: 4,
      globalTimeout: 60_000,
      fullyParallel: true,
    } as unknown as FullConfig;
    const metadata = mc.collect(config, undefined as any, {});
    expect(metadata.htmlReport).toMatchObject({ workers: 4, timeout: 60_000, fullyParallel: true });
    expect((metadata.htmlReport as any).projects[0]).toMatchObject({ name: 'chromium', testDir: 'tests' });
  });

  it("records each project's baseURL and testIdAttribute", () => {
    const mc = new MetadataCollector();
    const config = {
      projects: [
        { name: 'web', testDir: 'tests', use: { baseURL: 'https://shop.test', testIdAttribute: 'data-qa' } },
        { name: 'api', testDir: 'tests', use: {} },
      ],
    } as unknown as FullConfig;
    const projects = (mc.collect(config, undefined as any, {}).htmlReport as any).projects;
    expect(projects[0].use).toMatchObject({ baseURL: 'https://shop.test', testIdAttribute: 'data-qa' });
    expect(projects[1].use.testIdAttribute).toBeUndefined();
  });

  it("records each project's engine, never its name, whatever names it", () => {
    const mc = new MetadataCollector();
    const config = {
      projects: [
        { name: 'Desktop Firefox', testDir: 'tests', use: { browserName: 'firefox' } },
        { name: 'Mobile Safari', testDir: 'tests', use: { defaultBrowserType: 'webkit', isMobile: true } },
        { name: 'Polaris', testDir: 'tests', use: { browserName: 'firefox', defaultBrowserType: 'chromium' } },
        { name: 'smoke', testDir: 'tests', use: {} },
      ],
    } as unknown as FullConfig;
    const projects = (mc.collect(config, undefined as any, {}).htmlReport as any).projects;
    expect(projects.map((p: any) => p.use.browserName)).toEqual(['firefox', 'webkit', 'firefox', 'chromium']);
  });

  it('copies config.metadata through as playwrightConfig', () => {
    const mc = new MetadataCollector();
    const config = { ...fakeConfig(), metadata: { custom: true } } as unknown as FullConfig;
    const metadata = mc.collect(config, undefined as any, {});
    expect(metadata.playwrightConfig).toEqual({ custom: true });
  });
});

describe('MetadataCollector.collect — what pass reuse reads', () => {
  it('records Playwright’s root from the config folder and the spec files holding a serial group', () => {
    const root = '/repo';
    const file = (name: string, mode?: string) => ({
      type: 'file',
      title: name,
      _parallelMode: mode,
      parent: undefined,
      project: () => undefined,
    });
    const test = (parent: any, name: string) => ({ parent, location: { file: `${root}/tests/${name}` } });
    const serialFile = file('a.spec.ts', 'serial');
    const plainFile = file('b.spec.ts');
    const anonymousSerial = { type: 'describe', title: '', _parallelMode: 'serial', parent: file('c.spec.ts') };
    const suite = {
      allTests: () => [test(serialFile, 'a.spec.ts'), test(plainFile, 'b.spec.ts'), test(anonymousSerial, 'c.spec.ts')],
    };
    const config = { ...fakeConfig(), configFile: `${root}/playwright.config.ts`, rootDir: `${root}/tests` };
    const metadata = new MetadataCollector().collect(config as FullConfig, suite as any, {});
    expect(metadata.htmlReport).toMatchObject({
      rootDir: 'tests',
      serialFiles: ['tests/a.spec.ts', 'tests/c.spec.ts'],
    });
  });
});

describe('MetadataCollector.collect — the pass reuse plan', () => {
  const saved = process.env.PIWI_PLAN;
  afterEach(() => {
    if (saved === undefined) delete process.env.PIWI_PLAN;
    else process.env.PIWI_PLAN = saved;
  });

  it('reads the plan only with a plan id and the plan’s skip list passed to Playwright', () => {
    const invert = ['test-list-invert'];
    expect(readPlanStamp({ PIWI_PLAN: '9' }, invert)).toEqual({ id: 9 });
    expect(readPlanStamp({ PIWI_PLAN: 'nine' }, invert)).toBeNull();
    // A PIWI_PLAN left in a shell for a run that skipped nothing.
    expect(readPlanStamp({ PIWI_PLAN: '9' }, [])).toBeNull();
  });

  it('records no plan for a run of this process, which passed Playwright no skip list', () => {
    process.env.PIWI_PLAN = '9';
    expect(new MetadataCollector().collect(fakeConfig(), undefined as any, {}).piwiPlan).toBeUndefined();
  });
});
