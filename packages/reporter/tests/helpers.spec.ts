import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { hashForProject, computeInstanceId } from '../src/internal/support/instance-id.js';
import { getSetupFilePath, readSetupInfo } from '../src/internal/support/setup-file.js';
import { resolveRunLabel } from '../src/internal/support/ci.js';
import { readSourceSnippet, collectSourceFrames } from '../src/internal/support/source-snippet.js';
import { createLimiter } from '../src/internal/support/limiter.js';
import { workerIndexOf } from '../src/internal/support/worker-index.js';
import { detectCliFileFilters } from '../src/internal/support/cli-filters.js';

const CI_KEYS = [
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_JOB',
  'GITLAB_CI',
  'CI_PIPELINE_ID',
  'CI_JOB_ID',
  'CIRCLECI',
  'CIRCLE_WORKFLOW_ID',
  'CIRCLE_BUILD_NUM',
  'TRAVIS',
  'TRAVIS_BUILD_ID',
  'TRAVIS_JOB_ID',
  'TF_BUILD',
  'BUILD_BUILDID',
  'SYSTEM_JOBID',
  'JENKINS_URL',
  'BUILD_ID',
  'BUILDKITE_BUILD_ID',
  'BUILDKITE_JOB_ID',
  'TEAMCITY_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
  'BITBUCKET_STEP_UUID',
  'SEMAPHORE_WORKFLOW_ID',
  'SEMAPHORE_JOB_ID',
  'APPVEYOR_BUILD_ID',
  'APPVEYOR_JOB_ID',
  'DRONE_BUILD_NUMBER',
];

const SAVED_ENV: Record<string, string | undefined> = {};
function saveEnv(): void {
  for (const k of CI_KEYS) SAVED_ENV[k] = process.env[k];
}
function clearCiEnv(): void {
  for (const k of CI_KEYS) delete process.env[k];
}
function restoreEnv(): void {
  for (const k of CI_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

describe('hashForProject', () => {
  it('returns a deterministic 16-char sha1 prefix', () => {
    const h = hashForProject('my-project');
    expect(h.length).toBe(16);
    expect(hashForProject('my-project')).toBe(h);
    expect(hashForProject('other-project')).not.toBe(h);
  });
});

describe('getSetupFilePath', () => {
  it('lives in os.tmpdir() and embeds the project hash', () => {
    const p = getSetupFilePath('my-project');
    expect(path.dirname(p)).toBe(os.tmpdir());
    const base = path.basename(p);
    expect(base.startsWith('piwi-dashboard-setup-'), base).toBeTruthy();
    expect(base.includes(hashForProject('my-project'))).toBeTruthy();
    expect(base.endsWith('.json')).toBeTruthy();
  });
});

describe('detectCliFileFilters', () => {
  const N = ['node', 'playwright'];
  it('returns [] for a full-suite run with no positional args', () => {
    expect(detectCliFileFilters([...N, 'test'])).toEqual([]);
    expect(detectCliFileFilters([...N, 'test', '--workers=4', '--headed'])).toEqual([]);
  });
  it('captures positional file/path filters', () => {
    expect(detectCliFileFilters([...N, 'test', 'tests/login.spec.ts'])).toEqual(['tests/login.spec.ts']);
    expect(detectCliFileFilters([...N, 'test', 'auth/', 'checkout/'])).toEqual(['auth/', 'checkout/']);
  });
  it('does not mistake value-taking flag values for files', () => {
    expect(detectCliFileFilters([...N, 'test', '-g', '@smoke'])).toEqual([]);
    expect(detectCliFileFilters([...N, 'test', '--grep', '@smoke', 'tests/a.spec.ts'])).toEqual(['tests/a.spec.ts']);
    expect(detectCliFileFilters([...N, 'test', '-j', '4', '--project', 'chromium', 'a.spec.ts'])).toEqual([
      'a.spec.ts',
    ]);
  });
  it('handles --flag=value forms (no extra token consumed)', () => {
    expect(detectCliFileFilters([...N, 'test', '--project=chromium', 'a.spec.ts'])).toEqual(['a.spec.ts']);
  });
  it('works when no explicit test subcommand is present', () => {
    expect(detectCliFileFilters([...N, 'a.spec.ts'])).toEqual(['a.spec.ts']);
  });
});

describe('computeInstanceId', () => {
  it('derives from hostname|projectName when no runLabel', () => {
    const a = computeInstanceId('proj-a', null);
    const b = computeInstanceId('proj-b', null);
    expect(a.length).toBe(16);
    expect(a).not.toBe(b);
    // deterministic
    expect(computeInstanceId('proj-a', null)).toBe(a);
  });

  it('derives from projectName|runLabel when runLabel is set', () => {
    const sharded = computeInstanceId('proj-a', 'run-1');
    const unsharded = computeInstanceId('proj-a', null);
    expect(sharded).not.toBe(unsharded);
    // same label + project → same instanceId (all shards share it)
    expect(computeInstanceId('proj-a', 'run-1')).toBe(sharded);
  });
});

describe('resolveRunLabel: CI pipeline label', () => {
  beforeEach(() => {
    saveEnv();
    clearCiEnv();
  });
  afterEach(() => restoreEnv());

  it('returns null outside CI', () => {
    expect(resolveRunLabel(null, true)).toBe(null);
  });

  it('detects GitHub Actions', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = 'gh-123';
    expect(resolveRunLabel(null, true)).toBe('gh-123');
  });

  it('gives each GitHub Actions attempt its own label', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = 'gh-123';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    expect(resolveRunLabel(null, true)).toBe('gh-123-1');
    process.env.GITHUB_RUN_ATTEMPT = '2';
    expect(resolveRunLabel(null, true)).toBe('gh-123-2');
  });

  it('detects GitLab CI', () => {
    process.env.GITLAB_CI = 'true';
    process.env.CI_PIPELINE_ID = 'gl-456';
    expect(resolveRunLabel(null, true)).toBe('gl-456');
  });

  it('detects CircleCI', () => {
    process.env.CIRCLECI = 'true';
    process.env.CIRCLE_WORKFLOW_ID = 'cc-789';
    expect(resolveRunLabel(null, true)).toBe('cc-789');
  });

  it('detects Travis', () => {
    process.env.TRAVIS = 'true';
    process.env.TRAVIS_BUILD_ID = 'tv-1';
    expect(resolveRunLabel(null, true)).toBe('tv-1');
  });

  it('detects Azure Pipelines (TF_BUILD)', () => {
    process.env.TF_BUILD = 'true';
    process.env.BUILD_BUILDID = 'az-1';
    expect(resolveRunLabel(null, true)).toBe('az-1');
  });

  it('detects Jenkins', () => {
    process.env.JENKINS_URL = 'https://jenkins.example.com';
    process.env.BUILD_ID = 'jk-1';
    expect(resolveRunLabel(null, true)).toBe('jk-1');
  });

  it('detects Buildkite / TeamCity / Bitbucket / Semaphore / AppVeyor / Drone', () => {
    process.env.BUILDKITE_BUILD_ID = 'bk-1';
    expect(resolveRunLabel(null, true)).toBe('bk-1');
    clearCiEnv();

    process.env.TEAMCITY_BUILD_ID = 'tc-1';
    expect(resolveRunLabel(null, true)).toBe('tc-1');
    clearCiEnv();

    process.env.BITBUCKET_BUILD_NUMBER = 'bb-1';
    expect(resolveRunLabel(null, true)).toBe('bb-1');
    clearCiEnv();

    process.env.SEMAPHORE_WORKFLOW_ID = 'sm-1';
    expect(resolveRunLabel(null, true)).toBe('sm-1');
    clearCiEnv();

    process.env.APPVEYOR_BUILD_ID = 'ap-1';
    expect(resolveRunLabel(null, true)).toBe('ap-1');
    clearCiEnv();

    process.env.DRONE_BUILD_NUMBER = 'dr-1';
    expect(resolveRunLabel(null, true)).toBe('dr-1');
  });
});

describe('resolveRunLabel: per-run scoping', () => {
  beforeEach(() => {
    saveEnv();
    clearCiEnv();
  });
  afterEach(() => restoreEnv());

  it('returns a configured label verbatim, sharded or not', () => {
    process.env.GITLAB_CI = 'true';
    process.env.CI_PIPELINE_ID = 'gl-456';
    process.env.CI_JOB_ID = '9';
    expect(resolveRunLabel('my-label', true)).toBe('my-label');
    expect(resolveRunLabel('my-label', false)).toBe('my-label');
  });

  it('adds the CI job id to the label of a run that is not sharded', () => {
    process.env.GITLAB_CI = 'true';
    process.env.CI_PIPELINE_ID = 'gl-456';
    process.env.CI_JOB_ID = '9';
    expect(resolveRunLabel(null, false)).toBe('gl-456|9');
    expect(resolveRunLabel(null, true)).toBe('gl-456');

    clearCiEnv();
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = 'gh-123';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.GITHUB_JOB = 'e2e';
    expect(resolveRunLabel(null, false)).toBe('gh-123-1|e2e');
    expect(resolveRunLabel(null, true)).toBe('gh-123-1');
  });

  it('keeps the pipeline label when the CI exposes no job id', () => {
    process.env.JENKINS_URL = 'https://jenkins.example.com';
    process.env.BUILD_ID = 'jk-1';
    expect(resolveRunLabel(null, false)).toBe('jk-1');
  });

  it('returns null outside CI without a configured label', () => {
    expect(resolveRunLabel(undefined, false)).toBe(null);
  });

  it('merges the shards of a pipeline, and keeps its unsharded jobs apart', () => {
    process.env.GITLAB_CI = 'true';
    process.env.CI_PIPELINE_ID = 'gl-456';
    const instanceOfJob = (jobId: string, sharded: boolean) => {
      process.env.CI_JOB_ID = jobId;
      return computeInstanceId('proj', resolveRunLabel(null, sharded));
    };
    // Each shard runs as its own job.
    expect(instanceOfJob('1', true)).toBe(instanceOfJob('2', true));
    expect(instanceOfJob('3', false)).not.toBe(instanceOfJob('4', false));
  });
});

describe('readSourceSnippet', () => {
  it('returns null when the file does not exist', () => {
    expect(readSourceSnippet('/nonexistent/file.ts', 5, 3)).toBe(null);
  });

  it('returns a formatted snippet with a marker on the target line', () => {
    const tmp = path.join(os.tmpdir(), `piwi-snippet-${Date.now()}.ts`);
    fs.writeFileSync(tmp, ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'), 'utf8');
    try {
      const snippet = readSourceSnippet(tmp, 3, 1);
      expect(snippet).toBeTruthy();
      const lines = snippet!.split('\n');
      // context=1 → start=max(0, 3-1-1)=1, end=min(5, 3+1)=4 → lines[1..3]
      expect(lines.length).toBe(3);
      expect(lines.some((l) => l.startsWith('> ') && l.includes('3 | line3'))).toBeTruthy();
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('clamps start to 0 for early lines', () => {
    const tmp = path.join(os.tmpdir(), `piwi-snippet-${Date.now()}.ts`);
    fs.writeFileSync(tmp, ['a', 'b', 'c'].join('\n'), 'utf8');
    try {
      const snippet = readSourceSnippet(tmp, 1, 30);
      expect(snippet).toBeTruthy();
      expect(snippet!.includes('> ')).toBeTruthy();
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('collectSourceFrames', () => {
  function makeProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-frames-'));
    const nm = path.join(root, 'node_modules', 'pw');
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.mkdirSync(nm, { recursive: true });
    const spec = path.join(root, 'tests', 'checkout.spec.ts');
    const helper = path.join(root, 'tests', 'helper.ts');
    const lib = path.join(nm, 'index.js');
    fs.writeFileSync(spec, Array.from({ length: 50 }, (_, i) => `spec line ${i + 1}`).join('\n'));
    fs.writeFileSync(helper, Array.from({ length: 30 }, (_, i) => `helper line ${i + 1}`).join('\n'));
    fs.writeFileSync(lib, Array.from({ length: 10 }, (_, i) => `lib line ${i + 1}`).join('\n'));
    return { root, spec, helper, lib };
  }

  it('collects in-project frames innermost-first and drops node_modules', () => {
    const { root, spec, helper, lib } = makeProject();
    try {
      const error = [
        'Error: boom',
        `    at doClick (${lib}:5:3)`,
        `    at checkout (${helper}:15:10)`,
        `    at Object.<anonymous> (${spec}:42:5)`,
      ].join('\n');
      const frames = collectSourceFrames(error, spec, 40, { projectRoot: root, context: 2 });
      // The node_modules frame is dropped; helper (innermost in-project) comes before the spec.
      expect(frames.map((f) => f.file)).toEqual([
        path.join('tests', 'helper.ts'),
        path.join('tests', 'checkout.spec.ts'),
      ]);
      expect(frames[0]!.line).toBe(15);
      expect(frames[0]!.snippet).toContain('> ');
      expect(frames[0]!.file.startsWith('..')).toBe(false); // project-relative
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the test file when the stack has no in-project frame', () => {
    const { root, spec, lib } = makeProject();
    try {
      const error = `Error: boom\n    at internal (${lib}:5:3)`;
      const frames = collectSourceFrames(error, spec, 42, { projectRoot: root, context: 2 });
      expect(frames).toHaveLength(1);
      expect(frames[0]!.file).toBe(path.join('tests', 'checkout.spec.ts'));
      expect(frames[0]!.line).toBe(42);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a long run of blank lines in linear time', () => {
    const { root, spec, helper } = makeProject();
    try {
      const error = `Error: boom${'\n'.repeat(200_000)}    at checkout (${helper}:15:10)`;
      const started = performance.now();
      const frames = collectSourceFrames(error, spec, 42, { projectRoot: root, context: 1 });
      expect(performance.now() - started).toBeLessThan(1000);
      // The frame sits past the scanned start of the text, so the test file stands in.
      expect(frames.map((f) => f.file)).toEqual([path.join('tests', 'checkout.spec.ts')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps the number of frames', () => {
    const { root, spec, helper } = makeProject();
    try {
      const error = [
        'Error: boom',
        `    at a (${helper}:1:1)`,
        `    at b (${helper}:5:1)`,
        `    at c (${helper}:9:1)`,
        `    at d (${spec}:20:1)`,
        `    at e (${spec}:42:1)`,
      ].join('\n');
      const frames = collectSourceFrames(error, spec, 42, { projectRoot: root, context: 1, maxFrames: 3 });
      expect(frames).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readSetupInfo', () => {
  it('returns null when no setup file exists', () => {
    expect(readSetupInfo('definitely-no-such-project-' + Date.now())).toBe(null);
  });

  it('round-trips setup info and deletes the file', () => {
    const projectName = 'piwi-setup-roundtrip-' + Date.now();
    const file = getSetupFilePath(projectName);
    fs.writeFileSync(file, JSON.stringify({ runId: 42, setupToken: 'tok', projectName }), 'utf8');
    try {
      const info = readSetupInfo(projectName);
      expect(info).toEqual({ runId: 42, setupToken: 'tok', projectName });
      // second read returns null (file consumed)
      expect(readSetupInfo(projectName)).toBe(null);
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  it('returns null when projectName does not match', () => {
    const projectName = 'piwi-setup-mismatch-' + Date.now();
    const file = getSetupFilePath(projectName);
    fs.writeFileSync(file, JSON.stringify({ runId: 1, setupToken: 't', projectName: 'other-project' }), 'utf8');
    try {
      expect(readSetupInfo(projectName)).toBe(null);
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });
});

describe('workerIndexOf', () => {
  it('returns workerIndex when present', () => {
    expect(workerIndexOf({ workerIndex: 3, parallelIndex: 1 })).toBe(3);
  });

  it('falls back to parallelIndex when workerIndex is absent', () => {
    expect(workerIndexOf({ parallelIndex: 1 })).toBe(1);
  });

  it('returns null when neither is set', () => {
    expect(workerIndexOf({})).toBe(null);
    expect(workerIndexOf(null)).toBe(null);
    expect(workerIndexOf(undefined)).toBe(null);
  });

  it('returns null when both are null', () => {
    expect(workerIndexOf({ workerIndex: null, parallelIndex: null })).toBe(null);
  });
});

describe('createLimiter', () => {
  it('runs tasks with at most maxConcurrent in flight', async () => {
    let active = 0;
    let maxActive = 0;
    const limiter = createLimiter(2);
    const track = async (ms: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter(() => track(10))));
    expect(maxActive, `maxActive was ${maxActive}`).toBeLessThanOrEqual(2);
    expect(maxActive, `maxActive was ${maxActive}`).toBeGreaterThanOrEqual(2);
  });

  it('coerces maxConcurrent < 1 to 1', async () => {
    const limiter = createLimiter(0);
    let count = 0;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        limiter(async () => {
          count++;
        }),
      ),
    );
    expect(count).toBe(3);
  });

  it('preserves return values and propagates rejections', async () => {
    const limiter = createLimiter(3);
    const ok = await limiter(async () => 7);
    expect(ok).toBe(7);
    await expect(
      limiter(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
  });
});
