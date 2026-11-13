import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  ciServerCheckFinding,
  ciServerCheckPlans,
  jenkinsDeclaredParameters,
  resolveCiServerTarget,
  type CiServerCheckPlan,
  type CiServerTarget,
} from '#shared/ci-server';
import {
  checkCiServerTarget,
  instanceCiServer,
  prepareCiServerCheck,
  prepareCiServerRequest,
} from '../../server/utils/ci-server-dispatch';
import type { DbClient } from '../../server/database';

const ENV = [
  'PIWI_CI_SERVER_ALLOWED_INPUTS',
  'PIWI_CI_SERVER_URL',
  'PIWI_CI_SERVER_USER',
  'PIWI_CI_SERVER_TOKEN',
  'PIWI_CI_SERVER_HOSTS',
];
const TREE = 'tree=property%5BparameterDefinitions%5Bname%5D%5D';

afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

function target(input: Record<string, unknown>): CiServerTarget {
  const resolved = resolveCiServerTarget(input);
  if (!resolved) throw new Error('target did not resolve');
  return resolved;
}

function plans(t: CiServerTarget, baseUrl: string): CiServerCheckPlan[] {
  return ciServerCheckPlans(t, baseUrl).map((plan) => {
    if ('error' in plan) throw new Error(plan.error);
    return plan;
  });
}

const jobJson = (...names: string[]) => ({
  _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
  property: [
    { _class: 'jenkins.model.BuildDiscarderProperty' },
    { parameterDefinitions: names.map((name) => ({ name })) },
  ],
});

describe('a Jenkins job’s parameters', () => {
  test('are read from every property that defines some', () => {
    expect(jenkinsDeclaredParameters(jobJson('PIWI_RERUN_ARGS', 'PIWI_ORIGIN_REF'))).toEqual([
      'PIWI_RERUN_ARGS',
      'PIWI_ORIGIN_REF',
    ]);
  });

  test('are none for a job that takes no parameters', () => {
    expect(jenkinsDeclaredParameters({ _class: 'hudson.model.FreeStyleProject', property: [] })).toEqual([]);
  });

  test('are unknown when the answer is not a job', () => {
    expect(jenkinsDeclaredParameters({ message: 'login' })).toBeNull();
    expect(jenkinsDeclaredParameters('<html>')).toBeNull();
    expect(jenkinsDeclaredParameters(null)).toBeNull();
  });
});

describe('what Check reads', () => {
  test('is the job’s JSON under the base URL, for the re-run and for Flake Lab', () => {
    const t = target({
      preset: 'jenkins',
      rerun: { job: 'polaris/e2e' },
      flakeLab: { job: 'polaris/flake-lab', argsParameter: 'FLAKE_ARGS' },
    });
    const [rerun, flakeLab] = plans(t, 'https://jenkins.example.com/');
    expect(rerun!.url).toBe(`https://jenkins.example.com/job/polaris/job/e2e/api/json?${TREE}`);
    expect(rerun!.required).toEqual(['PIWI_RERUN_ARGS', 'PIWI_ORIGIN_REF']);
    expect(flakeLab!.url).toBe(`https://jenkins.example.com/job/polaris/job/flake-lab/api/json?${TREE}`);
    expect(flakeLab!.required).toEqual(['FLAKE_ARGS', 'PIWI_ORIGIN_REF']);
  });

  test('is only the re-run’s job when the target has no Flake Lab job', () => {
    expect(plans(target({ preset: 'jenkins', rerun: { job: 'e2e' } }), 'https://jenkins.example.com/')).toHaveLength(1);
  });

  test('is the default branch’s job of a multibranch pipeline, named as Jenkins names it', () => {
    const t = target({ preset: 'jenkins', rerun: { job: 'polaris/e2e/{branch}', ref: 'release/1.2' } });
    expect(plans(t, 'https://jenkins.example.com/')[0]!.url).toBe(
      `https://jenkins.example.com/job/polaris/job/e2e/job/release%252F1.2/api/json?${TREE}`,
    );
  });

  test('needs a default branch for a multibranch pipeline', () => {
    const t = target({ preset: 'jenkins', rerun: { job: 'polaris/e2e/{branch}' } });
    expect(ciServerCheckPlans(t, 'https://jenkins.example.com/')).toEqual([
      { kind: 'rerun', error: expect.stringContaining('Default branch') },
    ]);
  });

  test('is nothing for a Custom request, which names no job', () => {
    const t = target({ preset: 'custom', custom: { auth: 'none', rerun: { method: 'POST', path: 'build' } } });
    expect(ciServerCheckPlans(t, 'https://ci.example.com/')).toEqual([
      { kind: 'rerun', error: expect.stringContaining('cannot be checked') },
    ]);
  });
});

describe('what Check finds', () => {
  const [plan] = plans(
    target({ preset: 'jenkins', rerun: { job: 'e2e', dispatchParameter: 'DISPATCH' } }),
    'https://jenkins.example.com/',
  );

  test('passes a job that declares every parameter a dispatch sends', () => {
    expect(ciServerCheckFinding(plan!, jobJson('DISPATCH', 'PIWI_RERUN_ARGS', 'OTHER'))).toMatchObject({
      ok: true,
      missing: [],
    });
  });

  test('names the parameters a job does not declare', () => {
    const finding = ciServerCheckFinding(plan!, jobJson('PIWI_RERUN_ARGS', 'PIWI_ORIGIN_REF'));
    expect(finding).toMatchObject({ ok: false, missing: ['DISPATCH'] });
    expect(finding.message).toContain('DISPATCH');
    expect(finding.message).toContain('first build');
  });

  test('says so when the answer is not a job', () => {
    expect(ciServerCheckFinding(plan!, { nope: true })).toMatchObject({ ok: false, missing: [] });
  });
});

describe('the credential Check carries', () => {
  const values = { args: '', dispatchId: 'd1', ref: 'main', commit: '' };

  function both(t: CiServerTarget, baseUrl: string, projectToken: { url: string; token: string } | null) {
    const instanceCredential = instanceCiServer().credential;
    const [plan] = plans(t, baseUrl);
    const check = prepareCiServerCheck({ target: t, url: plan!.url, projectToken, instanceCredential });
    const dispatch = prepareCiServerRequest({
      target: t,
      kind: 'rerun',
      baseUrl,
      values,
      projectToken,
      instanceCredential,
    });
    return { check, dispatch };
  }

  test('is the instance token a dispatch of a job in its folder carries', () => {
    process.env.PIWI_CI_SERVER_URL = 'https://jenkins.example.com/job/qa/';
    process.env.PIWI_CI_SERVER_USER = 'piwi-bot';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
    const { check, dispatch } = both(
      target({ preset: 'jenkins', rerun: { job: 'qa/e2e' } }),
      'https://jenkins.example.com/',
      null,
    );
    expect(check.credential).toBe('instance');
    expect(check.credential).toBe(dispatch.credential);
    expect(check.headers.Authorization).toBe(dispatch.headers.Authorization);
  });

  test('is none outside the folder the instance token is bound to', () => {
    process.env.PIWI_CI_SERVER_URL = 'https://jenkins.example.com/job/qa/';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
    const { check, dispatch } = both(
      target({ preset: 'jenkins', rerun: { job: 'other/e2e' } }),
      'https://jenkins.example.com/',
      null,
    );
    expect(check.credential).toBeNull();
    expect(dispatch.credential).toBeNull();
    expect(check.headers.Authorization).toBeUndefined();
  });

  test('is none for a base URL on another host than any token is bound to', () => {
    process.env.PIWI_CI_SERVER_URL = 'https://jenkins.example.com/';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
    const projectToken = { url: 'https://jenkins.example.com/job/team/', token: 'project-secret' };
    for (const baseUrl of [
      'https://attacker.example/',
      'http://jenkins.example.com/',
      'https://jenkins.example.com:8443/',
    ]) {
      const t = target({ preset: 'jenkins', baseUrl, rerun: { job: 'team/e2e' } });
      const [plan] = plans(t, baseUrl);
      const check = prepareCiServerCheck({
        target: t,
        url: plan!.url,
        projectToken,
        instanceCredential: instanceCiServer().credential,
      });
      expect(check.credential).toBeNull();
      expect(check.headers.Authorization).toBeUndefined();
    }
  });

  test('is the project token where it is bound, before the instance one', () => {
    process.env.PIWI_CI_SERVER_URL = 'https://jenkins.example.com/';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
    const projectToken = { url: 'https://jenkins.example.com/job/team/', token: 'project-secret' };
    const t = target({ preset: 'jenkins', user: 'me', rerun: { job: 'team/e2e' } });
    const { check, dispatch } = both(t, 'https://jenkins.example.com/', projectToken);
    expect(check.credential).toBe('project');
    expect(check.headers.Authorization).toBe(dispatch.headers.Authorization);
    expect(check.method).toBe('GET');
    expect(check.body).toBeNull();
  });
});

describe('checking a job on a CI server', () => {
  let server: Server;
  let base: string;
  const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
  const answers: Record<string, (res: import('node:http').ServerResponse) => void> = {
    '/job/good/api/json': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jobJson('PIWI_RERUN_ARGS', 'PIWI_ORIGIN_REF')));
    },
    '/job/bare/api/json': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ property: [] }));
    },
    '/job/locked/api/json': (res) => {
      res.writeHead(401);
      res.end();
    },
    '/job/sso/api/json': (res) => {
      res.writeHead(302, { Location: '/login' });
      res.end();
    },
  };
  /** No stored project token: the check reads only the instance's. */
  const db = { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as DbClient;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const path = (req.url ?? '').split('?')[0]!;
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      const answer = answers[path];
      if (answer) return answer(res);
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function useInstance() {
    process.env.PIWI_CI_SERVER_URL = base;
    process.env.PIWI_CI_SERVER_USER = 'piwi-bot';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
  }

  test('passes a job that declares the parameters, with a GET and the instance token', async () => {
    useInstance();
    seen.length = 0;
    const results = await checkCiServerTarget(db, 1, target({ preset: 'jenkins', rerun: { job: 'good' } }));
    expect(results).toEqual([expect.objectContaining({ kind: 'rerun', ok: true })]);
    expect(seen).toEqual([
      { method: 'GET', url: `/job/good/api/json?${TREE}`, auth: expect.stringMatching(/^Basic /) },
    ]);
  });

  test('says which inputs the instance credential does not send, and does not ask the job to declare them', async () => {
    useInstance();
    const job = target({ preset: 'jenkins', rerun: { job: 'good' } });
    const [result] = await checkCiServerTarget(db, 1, job, ['TARGET_ENV']);
    expect(result).toMatchObject({ kind: 'rerun', ok: false, missing: [] });
    expect(result!.message).toContain('Not sent: TARGET_ENV');
    expect(result!.message).toContain('PIWI_CI_SERVER_ALLOWED_INPUTS');
  });

  test('asks the job to declare an input the operator lets the instance credential send', async () => {
    useInstance();
    process.env.PIWI_CI_SERVER_ALLOWED_INPUTS = 'TARGET_ENV';
    const job = target({ preset: 'jenkins', rerun: { job: 'good' } });
    const [result] = await checkCiServerTarget(db, 1, job, ['TARGET_ENV']);
    expect(result).toMatchObject({ kind: 'rerun', ok: false, missing: ['TARGET_ENV'] });
    expect(result!.message).not.toContain('Not sent');
  });

  test('names both parameters for a job that takes none, and checks the Flake Lab job too', async () => {
    useInstance();
    const results = await checkCiServerTarget(
      db,
      1,
      target({ preset: 'jenkins', rerun: { job: 'bare' }, flakeLab: { job: 'good' } }),
    );
    expect(results).toEqual([
      expect.objectContaining({ kind: 'rerun', ok: false, missing: ['PIWI_RERUN_ARGS', 'PIWI_ORIGIN_REF'] }),
      expect.objectContaining({ kind: 'flakeLab', ok: true }),
    ]);
  });

  test('explains a refused credential, a missing job and a redirect, without following it', async () => {
    useInstance();
    seen.length = 0;
    const check = async (job: string) =>
      (await checkCiServerTarget(db, 1, target({ preset: 'jenkins', rerun: { job } })))[0]!;
    expect((await check('locked')).message).toContain('refused the credential (401)');
    expect((await check('missing')).message).toContain('No job at this path');
    expect((await check('sso')).message).toContain('302');
    expect(seen.map((hit) => hit.url.split('?')[0])).toEqual([
      '/job/locked/api/json',
      '/job/missing/api/json',
      '/job/sso/api/json',
    ]);
  });

  test('reaches no private address the operator did not list', async () => {
    seen.length = 0;
    const privateBase = base.replace('http:', 'https:');
    const results = await checkCiServerTarget(
      db,
      1,
      target({ preset: 'jenkins', baseUrl: privateBase, rerun: { job: 'good' } }),
    );
    expect(results).toEqual([
      expect.objectContaining({ ok: false, message: expect.stringContaining('URL host is not allowed') }),
    ]);
    expect(seen).toEqual([]);
  });
});
