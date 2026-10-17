import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseGateArgs, runGate } from '../src/cli/gate.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-gate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeOutputFile(contents: unknown): string {
  const file = path.join(tmpDir, 'piwi-run.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

describe('parseGateArgs', () => {
  it('reads the server URL and run id from flags', () => {
    const args = parseGateArgs(
      ['--server-url', 'https://piwi.example.com', '--run-id', '42', '--max-failed', '0'],
      EMPTY_ENV,
    );
    expect(args.serverUrl).toBe('https://piwi.example.com');
    expect(args.runId).toBe(42);
  });

  it('accepts the --flag=value form', () => {
    const args = parseGateArgs(['--server-url=https://piwi.example.com', '--run-id=7'], EMPTY_ENV);
    expect(args.serverUrl).toBe('https://piwi.example.com');
    expect(args.runId).toBe(7);
  });

  it('strips a trailing slash so the request path is not doubled', () => {
    const args = parseGateArgs(['--server-url', 'https://piwi.example.com/', '--run-id', '1'], EMPTY_ENV);
    expect(args.serverUrl).toBe('https://piwi.example.com');
  });

  it('falls back to the environment for the URL and API key', () => {
    const args = parseGateArgs(['--run-id', '3'], {
      PIWI_DASHBOARD_URL: 'https://env.example.com',
      PIWI_API_KEY: 'secret',
    } as NodeJS.ProcessEnv);
    expect(args.serverUrl).toBe('https://env.example.com');
    expect(args.apiKey).toBe('secret');
  });

  it('a flag beats the environment', () => {
    const args = parseGateArgs(['--server-url', 'https://flag.example.com', '--run-id', '3'], {
      PIWI_DASHBOARD_URL: 'https://env.example.com',
    } as NodeJS.ProcessEnv);
    expect(args.serverUrl).toBe('https://flag.example.com');
  });

  it('reads the run id from the file the reporter wrote', () => {
    const file = writeOutputFile({ runId: 99, runUrl: 'https://piwi.example.com/test-runs/99' });
    const args = parseGateArgs(['--server-url', 'https://x.example.com', '--from-file', file], EMPTY_ENV);
    expect(args.runId).toBe(99);
  });

  it('reads the run id from PIWI_OUTPUT_FILE', () => {
    const file = writeOutputFile({ runId: 12 });
    const args = parseGateArgs(['--server-url', 'https://x.example.com'], {
      PIWI_OUTPUT_FILE: file,
    } as NodeJS.ProcessEnv);
    expect(args.runId).toBe(12);
  });

  it('normalizes required tags, with or without the @', () => {
    const args = parseGateArgs(
      ['--server-url', 'https://x.example.com', '--run-id', '1', '--require-tag', '@critical, smoke'],
      EMPTY_ENV,
    );
    expect(args.policy.requireTags).toEqual(['critical', 'smoke']);
  });

  it('collects the threshold rules', () => {
    const args = parseGateArgs(
      [
        '--server-url',
        'https://x.example.com',
        '--run-id',
        '1',
        '--max-failed',
        '3',
        '--max-new-regressions',
        '0',
        '--max-new-flaky',
        '2',
        '--fail-on-new-cluster',
        '--fail-on-flaky',
        '--max-leaks',
        '4',
        '--max-new-leaks=0',
      ],
      EMPTY_ENV,
    );
    expect(args.policy).toMatchObject({
      maxFailed: 3,
      maxNewRegressions: 0,
      maxNewFlaky: 2,
      failOnNewCluster: true,
      failOnFlaky: true,
      maxLeaks: 4,
      maxNewLeaks: 0,
    });
  });

  it('leaves an unset threshold undefined rather than defaulting it to zero', () => {
    const args = parseGateArgs(['--server-url', 'https://x.example.com', '--run-id', '1'], EMPTY_ENV);
    expect(args.policy.maxFailed).toBeUndefined();
    expect(args.policy.failOnNewCluster).toBe(false);
    expect(args.policy.failOnFlaky).toBe(false);
  });

  it('rejects a negative or non-numeric threshold', () => {
    const base = ['--server-url', 'https://x.example.com', '--run-id', '1'];
    expect(() => parseGateArgs([...base, '--max-failed', '-1'], EMPTY_ENV)).toThrow(/non-negative/);
    expect(() => parseGateArgs([...base, '--max-failed', 'lots'], EMPTY_ENV)).toThrow(/non-negative/);
  });

  it('reads the warn-only patch coverage minimum as a percentage', () => {
    const base = ['--server-url', 'https://x.example.com', '--run-id', '1'];
    expect(parseGateArgs([...base, '--min-patch-coverage', '80'], EMPTY_ENV).minPatchCoverage).toBe(80);
    expect(parseGateArgs([...base, '--min-patch-coverage=72.5%'], EMPTY_ENV).minPatchCoverage).toBe(72.5);
    expect(parseGateArgs(base, EMPTY_ENV).minPatchCoverage).toBeUndefined();
    expect(() => parseGateArgs([...base, '--min-patch-coverage', '120'], EMPTY_ENV)).toThrow(/percentage/);
  });

  it('refuses to run without a dashboard URL', () => {
    expect(() => parseGateArgs(['--run-id', '1'], EMPTY_ENV)).toThrow(/No dashboard URL/);
  });

  it('refuses to run when no run can be resolved', () => {
    expect(() => parseGateArgs(['--server-url', 'https://x.example.com'], EMPTY_ENV)).toThrow(/No run to evaluate/);
  });

  it('ignores an output file that is missing, malformed or has no run id', () => {
    const cases = [
      path.join(tmpDir, 'absent.json'),
      writeOutputFile('{not json'),
      writeOutputFile({ runUrl: 'https://x/1' }),
      writeOutputFile({ runId: 0 }),
    ];
    for (const file of cases) {
      expect(() => parseGateArgs(['--server-url', 'https://x.example.com', '--from-file', file], EMPTY_ENV)).toThrow(
        /No run to evaluate/,
      );
    }
  });
});

/** Stub `fetch` with one canned response, restoring the original afterwards. */
function stubFetch(response: { ok: boolean; status?: number; json: () => unknown }) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: response.ok, status: response.status ?? 200, json: async () => response.json() } as Response;
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

function gateResult(passed: boolean) {
  return {
    passed,
    violations: passed ? [] : [{ rule: 'max-failed', message: '2 failing tests (limit 0)', actual: 2, limit: 0 }],
    facts: {
      runId: 7,
      runUrl: 'https://piwi.example.com/test-runs/7',
      projectName: 'checkout',
      status: passed ? 'passed' : 'failed',
      totalTests: 10,
      failedTests: passed ? 0 : 2,
      newRegressions: 0,
      newFlaky: 0,
      newClusters: 0,
      failingByTag: {},
      unmatchedTags: [],
      quarantinedFailures: 0,
      quarantinedTotal: 0,
    },
  };
}

const PASSING_ARGS = ['--server-url', 'https://piwi.example.com', '--run-id', '7', '--max-failed', '0'];

// The exit codes are the command's whole contract with CI, so each one is
// pinned rather than inferred.
describe('runGate against a responding dashboard', () => {
  it('exits 0 when the policy is satisfied', async () => {
    const stub = stubFetch({ ok: true, json: () => gateResult(true) });
    try {
      expect(await runGate(PASSING_ARGS, EMPTY_ENV)).toBe(0);
    } finally {
      stub.restore();
    }
  });

  it('exits 1 when the policy is violated', async () => {
    const stub = stubFetch({ ok: true, json: () => gateResult(false) });
    try {
      expect(await runGate(PASSING_ARGS, EMPTY_ENV)).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it('exits 3 when the run is an environment incident', async () => {
    const incident = {
      ...gateResult(false),
      passed: false,
      verdict: 'inconclusive',
      violations: [],
      facts: {
        ...gateResult(false).facts,
        incident: { rule: 'host-unreachable', reason: '9 of 10 tests failed', host: 'staging.example.test' },
      },
    };
    const stub = stubFetch({ ok: true, json: () => incident });
    try {
      expect(await runGate(PASSING_ARGS, EMPTY_ENV)).toBe(3);
      expect(await runGate([...PASSING_ARGS, '--json'], EMPTY_ENV)).toBe(3);
    } finally {
      stub.restore();
    }
  });

  it('posts the policy to the run being gated', async () => {
    const stub = stubFetch({ ok: true, json: () => gateResult(true) });
    try {
      await runGate([...PASSING_ARGS, '--require-tag', '@critical'], EMPTY_ENV);
      expect(stub.calls[0]?.url).toBe('https://piwi.example.com/api/test-runs/7/gate');
      expect(JSON.parse(String(stub.calls[0]?.init?.body))).toMatchObject({
        maxFailed: 0,
        requireTags: ['critical'],
      });
    } finally {
      stub.restore();
    }
  });

  it('sends the API key when one is configured', async () => {
    const stub = stubFetch({ ok: true, json: () => gateResult(true) });
    try {
      await runGate([...PASSING_ARGS, '--api-key', 'secret'], EMPTY_ENV);
      const headers = stub.calls[0]?.init?.headers as Record<string, string> | undefined;
      expect(headers?.['X-API-Key']).toBe('secret');
    } finally {
      stub.restore();
    }
  });

  it('names itself as the evaluation source', async () => {
    const stub = stubFetch({ ok: true, json: () => gateResult(true) });
    try {
      await runGate(PASSING_ARGS, EMPTY_ENV);
      const headers = stub.calls[0]?.init?.headers as Record<string, string> | undefined;
      expect(headers?.['X-Piwi-Client']).toBe('cli');
    } finally {
      stub.restore();
    }
  });

  it('still reports the verdict as an exit code in --json mode', async () => {
    const stub = stubFetch({ ok: true, json: () => gateResult(false) });
    try {
      expect(await runGate([...PASSING_ARGS, '--json'], EMPTY_ENV)).toBe(1);
    } finally {
      stub.restore();
    }
  });

  // A dashboard that rejects the request is "could not evaluate", never a pass.
  it('exits 2 when the dashboard returns an error', async () => {
    const stub = stubFetch({ ok: false, status: 409, json: () => ({ message: 'Run #7 has not finished yet' }) });
    try {
      expect(await runGate(PASSING_ARGS, EMPTY_ENV)).toBe(2);
    } finally {
      stub.restore();
    }
  });

  it('exits 2 when the error body is unreadable', async () => {
    const stub = stubFetch({
      ok: false,
      status: 500,
      json: () => {
        throw new Error('not json');
      },
    });
    try {
      expect(await runGate(PASSING_ARGS, EMPTY_ENV)).toBe(2);
    } finally {
      stub.restore();
    }
  });
});

describe('runGate exit codes', () => {
  // The contract CI depends on: a gate that cannot be evaluated must never
  // report success, or a misconfigured pipeline waves every merge through.
  it('exits 2 when the arguments are unusable', async () => {
    expect(await runGate(['--run-id', '1'], EMPTY_ENV)).toBe(2);
  });

  it('exits 2 when the dashboard cannot be reached', async () => {
    const code = await runGate(
      // Port 0 is never listening, so this fails without touching the network.
      ['--server-url', 'http://127.0.0.1:1', '--run-id', '1', '--max-failed', '0'],
      EMPTY_ENV,
    );
    expect(code).toBe(2);
  });

  it('exits 0 for --help', async () => {
    expect(await runGate(['--help'], EMPTY_ENV)).toBe(0);
  });
});
