import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import {
  ciServerCheckFinding,
  ciServerCheckPlans,
  jenkinsDeclaredParameters,
  resolveCiServerTarget,
  type CiServerCheckPlan,
  type CiServerTarget,
} from '#shared/ci-server';
import { insertCredential } from '#shared/handlers/credentials';
import {
  checkCiServerTarget,
  listCiServerJobs,
  prepareCiServerCheck,
  readCiServerJobFields,
  prepareCiServerRequest,
  type CiServerCredential,
} from '../../server/utils/ci-server-dispatch';
import { sealCredentialSecret } from '../../server/utils/credentials';
import { checkCiAction } from '../../server/utils/ci-actions';
import { openTempDb, type TempDb } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const ENV = [
  'PIWI_CI_SERVER_ALLOWED_INPUTS',
  'PIWI_CI_SERVER_URL',
  'PIWI_CI_SERVER_USER',
  'PIWI_CI_SERVER_TOKEN',
  'PIWI_CI_SERVER_HOSTS',
];
const TREE = new URLSearchParams([
  ['tree', 'property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]'],
]).toString();

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
  const instance = (url: string): CiServerCredential => ({
    id: 1,
    name: 'CI server (environment)',
    url,
    user: 'piwi-bot',
    token: 'instance-secret',
    allowedInputs: [],
    source: 'instance',
  });

  function both(t: CiServerTarget, baseUrl: string, credential: CiServerCredential | null) {
    const [plan] = plans(t, baseUrl);
    const check = prepareCiServerCheck({ target: t, url: plan!.url, credential });
    const dispatch = prepareCiServerRequest({ target: t, kind: 'rerun', baseUrl, values, credential });
    return { check, dispatch };
  }

  test('is the instance credential a dispatch of a job in its folder carries', () => {
    const { check, dispatch } = both(
      target({ preset: 'jenkins', rerun: { job: 'qa/e2e' } }),
      'https://jenkins.example.com/',
      instance('https://jenkins.example.com/job/qa/'),
    );
    expect(check.credential?.source).toBe('instance');
    expect(check.credential).toBe(dispatch.credential);
    expect(check.headers.Authorization).toBe(dispatch.headers.Authorization);
  });

  test('is none outside the folder the instance credential is bound to', () => {
    const { check, dispatch } = both(
      target({ preset: 'jenkins', rerun: { job: 'other/e2e' } }),
      'https://jenkins.example.com/',
      instance('https://jenkins.example.com/job/qa/'),
    );
    expect(check.credential).toBeNull();
    expect(dispatch.credential).toBeNull();
    expect(check.headers.Authorization).toBeUndefined();
  });

  test('is none for a base URL on another host than the instance credential is bound to', () => {
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
        credential: instance('https://jenkins.example.com/'),
      });
      expect(check.credential).toBeNull();
      expect(check.headers.Authorization).toBeUndefined();
    }
  });

  test('is the credential the action names, as a dispatch carries it', () => {
    const credential: CiServerCredential = {
      id: 2,
      name: 'Team Jenkins',
      url: 'https://jenkins.example.com/job/team/',
      user: 'me',
      token: 'team-secret',
      allowedInputs: null,
      source: 'action',
    };
    const t = target({ preset: 'jenkins', credentialId: 2, rerun: { job: 'team/e2e' } });
    const { check, dispatch } = both(t, 'https://jenkins.example.com/', credential);
    expect(check.credential).toBe(credential);
    expect(check.headers.Authorization).toBe(`Basic ${Buffer.from('me:team-secret').toString('base64')}`);
    expect(check.headers.Authorization).toBe(dispatch.headers.Authorization);
    expect(check.method).toBe('GET');
    expect(check.body).toBeNull();
  });
});

describe('checking a job on a CI server', () => {
  let server: Server;
  let base: string;
  let db: TempDb;
  let close: () => Promise<void>;
  const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
  const answers: Record<string, (res: import('node:http').ServerResponse) => void> = {
    '/job/good/api/json': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jobJson('PIWI_RERUN_ARGS', 'PIWI_ORIGIN_REF', 'SUITE')));
    },
    '/api/json': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jobs: [
            { _class: 'hudson.model.FreeStyleProject', name: 'good', buildable: true },
            { _class: 'hudson.model.FreeStyleProject', name: 'retired', buildable: false },
            {
              _class: 'com.cloudbees.hudson.plugins.folder.Folder',
              name: 'polaris',
              jobs: [{ _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject', name: 'e2e' }],
            },
          ],
        }),
      );
    },
    '/job/large/api/json': (res) => {
      // A choice of 1,500 spec paths: past the 64 KB a dispatch's answer is read to.
      const choices = Array.from({ length: 1500 }, (_, i) => `tests/area-${i}/checkout-flow-${i}.spec.ts`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          property: [
            {
              parameterDefinitions: [
                { name: 'PIWI_RERUN_ARGS', type: 'StringParameterDefinition' },
                { name: 'PIWI_ORIGIN_REF', type: 'StringParameterDefinition' },
                { name: 'SPEC', type: 'ChoiceParameterDefinition', choices },
              ],
            },
          ],
        }),
      );
    },
    '/job/huge/api/json': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ property: [{ parameterDefinitions: [{ name: 'x'.repeat(3 * 1024 * 1024) }] }] }));
    },
    '/job/rich/api/json': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          property: [
            {
              parameterDefinitions: [
                { name: 'PIWI_RERUN_ARGS', type: 'StringParameterDefinition', defaultParameterValue: { value: '' } },
                {
                  name: 'TARGET_ENV',
                  type: 'ChoiceParameterDefinition',
                  description: 'Where the suite runs',
                  choices: ['staging', 'production'],
                  defaultParameterValue: { value: 'staging' },
                },
                {
                  name: 'DEPLOY_TOKEN',
                  type: 'PasswordParameterDefinition',
                  defaultParameterValue: { value: 'hunter2' },
                },
              ],
            },
          ],
        }),
      );
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
  /** A Check a person starts from the project's settings. */
  const USE = { actor: { userId: null, apiKeyId: null } };

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const path = (req.url ?? '').split('?')[0]!;
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      if (path === '/job/echo/api/json') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `Refused ${req.headers.authorization}` }));
        return;
      }
      const answer = answers[path];
      if (answer) return answer(res);
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    ({ db, close } = await openTempDb());
    await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  });

  afterAll(async () => {
    await close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    seen.length = 0;
    await db.delete(schema.credentialUses);
  });

  function useInstance() {
    process.env.PIWI_CI_SERVER_URL = base;
    process.env.PIWI_CI_SERVER_USER = 'piwi-bot';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
  }

  const check = (t: CiServerTarget, inputNames: string[] = []) =>
    checkCiServerTarget(db as never, 1, t, inputNames, USE);
  const uses = () => db.select().from(schema.credentialUses);

  /** A credential shared with every project, its secret sealed for its destination. */
  async function credential(over: { destination?: string; allowedInputs?: string[] | null } = {}) {
    process.env.PIWI_SECRET_KEY = 'a'.repeat(64);
    try {
      const destination = over.destination ?? base;
      return await insertCredential(
        db as never,
        {
          name: `Team Jenkins ${Math.random().toString(36).slice(2, 8)}`,
          description: null,
          service: 'ci-server',
          user: 'team-bot',
          destination,
          scope: { allProjects: true },
          allowedInputs: over.allowedInputs ?? null,
          customRequests: false,
          disabled: false,
        },
        sealCredentialSecret(destination, 'team-secret'),
        null,
      );
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
  }

  test('passes a job that declares the parameters, with a GET and the instance credential, counted in one log row', async () => {
    useInstance();
    const job = target({ preset: 'jenkins', rerun: { job: 'good' } });
    expect(await check(job)).toEqual([expect.objectContaining({ kind: 'rerun', ok: true })]);
    await check(job);
    expect(seen).toEqual([
      {
        method: 'GET',
        url: `/job/good/api/json?${TREE}`,
        auth: `Basic ${Buffer.from('piwi-bot:instance-secret').toString('base64')}`,
      },
      { method: 'GET', url: `/job/good/api/json?${TREE}`, auth: expect.stringMatching(/^Basic /) },
    ]);
    expect(await uses()).toEqual([
      expect.objectContaining({
        credentialName: 'CI server (environment)',
        feature: 'ci-check',
        projectId: 1,
        result: 'ok',
        count: 2,
        destination: `${base}job/good/api/json`,
      }),
    ]);
  });

  test('says which inputs the instance credential does not send, and does not ask the job to declare them', async () => {
    useInstance();
    const job = target({ preset: 'jenkins', rerun: { job: 'good' } });
    const [result] = await check(job, ['TARGET_ENV']);
    expect(result).toMatchObject({ kind: 'rerun', ok: false, missing: [] });
    expect(result!.message).toContain('Not sent: TARGET_ENV');
    expect(result!.message).toContain('the credential "CI server (environment)" does not allow');
  });

  test('asks the job to declare an input the operator lets the instance credential send', async () => {
    useInstance();
    process.env.PIWI_CI_SERVER_ALLOWED_INPUTS = 'TARGET_ENV';
    const job = target({ preset: 'jenkins', rerun: { job: 'good' } });
    const [result] = await check(job, ['TARGET_ENV']);
    expect(result).toMatchObject({ kind: 'rerun', ok: false, missing: ['TARGET_ENV'] });
    expect(result!.message).not.toContain('Not sent');
  });

  test('names both parameters for a job that takes none, and checks the Flake Lab job too', async () => {
    useInstance();
    const results = await check(target({ preset: 'jenkins', rerun: { job: 'bare' }, flakeLab: { job: 'good' } }));
    expect(results).toEqual([
      expect.objectContaining({ kind: 'rerun', ok: false, missing: ['PIWI_RERUN_ARGS', 'PIWI_ORIGIN_REF'] }),
      expect.objectContaining({ kind: 'flakeLab', ok: true }),
    ]);
  });

  test('explains a refused credential, a missing job and a redirect, without following it', async () => {
    useInstance();
    const first = async (job: string) => (await check(target({ preset: 'jenkins', rerun: { job } })))[0]!;
    expect((await first('locked')).message).toContain('refused the credential (401)');
    expect((await first('missing')).message).toContain('No job at this path');
    expect((await first('sso')).message).toContain('302');
    expect(seen.map((hit) => hit.url.split('?')[0])).toEqual([
      '/job/locked/api/json',
      '/job/missing/api/json',
      '/job/sso/api/json',
    ]);
    expect((await uses()).map((row) => [row.result, row.count])).toEqual([['failed', 3]]);
  });

  test('sends the credential the action names, with its user, and only the inputs it allows', async () => {
    const id = await credential({ allowedInputs: ['SUITE'] });
    process.env.PIWI_SECRET_KEY = 'a'.repeat(64);
    process.env.PIWI_CI_SERVER_HOSTS = '127.0.0.1';
    try {
      const job = target({ preset: 'jenkins', credentialId: id, rerun: { job: 'good' } });
      const [result] = await check(job, ['SUITE', 'TARGET_ENV']);
      expect(seen[0]!.url.startsWith('/job/good/api/json')).toBe(true);
      expect(seen[0]!.auth).toBe(`Basic ${Buffer.from('team-bot:team-secret').toString('base64')}`);
      expect(result).toMatchObject({ kind: 'rerun', ok: false, missing: [] });
      expect(result!.message).toContain('Not sent: TARGET_ENV');
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
    expect(await uses()).toEqual([expect.objectContaining({ credentialId: id, feature: 'ci-check', result: 'ok' })]);
  });

  test('refuses a credential outside its destination, sends nothing and logs the refusal', async () => {
    const id = await credential({ destination: 'https://ci.other.example/' });
    process.env.PIWI_CI_SERVER_HOSTS = '127.0.0.1';
    const [result] = await check(
      target({ preset: 'jenkins', baseUrl: base, credentialId: id, rerun: { job: 'good' } }),
    );
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('is sent only under https://ci.other.example/'),
    });
    expect(result!.message).not.toContain('could not be reached');
    expect(seen).toEqual([]);
    expect(await uses()).toEqual([expect.objectContaining({ credentialId: id, result: 'refused', count: 1 })]);
  });

  test('says so when the credential the action names does not exist', async () => {
    const results = await check(
      target({ preset: 'jenkins', baseUrl: base, credentialId: 9999, rerun: { job: 'good' } }),
    );
    expect(results).toEqual([
      expect.objectContaining({ ok: false, message: expect.stringContaining('does not exist') }),
    ]);
    expect(seen).toEqual([]);
  });

  test('answers without the secret when the server’s message repeats it', async () => {
    useInstance();
    const [result] = await check(target({ preset: 'jenkins', rerun: { job: 'echo' } }));
    expect(result).toMatchObject({ ok: false });
    expect(result!.message).toContain('The CI server answered 500');
    expect(result!.message).not.toContain(Buffer.from('piwi-bot:instance-secret').toString('base64'));
  });

  test('logs the Check of a CI action under that action', async () => {
    useInstance();
    const action = {
      id: 'nightly',
      name: 'Nightly',
      target: { type: 'ci-server' as const, preset: 'jenkins' as const, fields: { job: 'good' } },
      inputs: [],
      accepts: ['tests' as const],
    };
    expect(await checkCiAction(db as never, 1, action, USE)).toMatchObject({ ok: true });
    expect(await uses()).toEqual([
      expect.objectContaining({ feature: 'ci-check', subjectType: 'ci-action', subjectId: 'nightly', result: 'ok' }),
    ]);
  });

  test('lists the jobs under the base URL for the editor, logged as a listing', async () => {
    useInstance();
    const listing = await listCiServerJobs(db as never, 1, target({ preset: 'jenkins', rerun: { job: 'x' } }), USE);
    expect(listing).toEqual({
      jobs: [
        { id: 'good', label: 'good' },
        { id: 'polaris/e2e/{branch}', label: 'polaris/e2e/{branch}' },
      ],
      truncated: false,
      message: null,
    });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: `/api/json?${new URLSearchParams([
        ['tree', 'jobs[name,_class,buildable,jobs[name,_class,buildable,jobs[name,_class,buildable]]]'],
      ])}`,
    });
    expect(await uses()).toEqual([expect.objectContaining({ feature: 'ci-list', result: 'ok' })]);
  });

  test('reads the parameters of a job with the credential the action names, never a password’s default', async () => {
    const id = await credential();
    process.env.PIWI_SECRET_KEY = 'a'.repeat(64);
    process.env.PIWI_CI_SERVER_HOSTS = '127.0.0.1';
    try {
      const fields = await readCiServerJobFields(
        db as never,
        1,
        target({ preset: 'jenkins', credentialId: id, rerun: { job: 'rich' } }),
        USE,
      );
      expect(fields).toEqual({
        fields: [
          { name: 'PIWI_RERUN_ARGS', type: 'string', required: false, default: '' },
          {
            name: 'TARGET_ENV',
            type: 'choice',
            required: false,
            default: 'staging',
            description: 'Where the suite runs',
            options: ['staging', 'production'],
          },
          { name: 'DEPLOY_TOKEN', type: 'secret', required: false },
        ],
        message: null,
      });
      expect(JSON.stringify(fields)).not.toContain('hunter2');
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
  });

  test('leaves out free-text defaults and descriptions read with the instance’s credential, which every project shares', async () => {
    useInstance();
    const fields = await readCiServerJobFields(
      db as never,
      1,
      target({ preset: 'jenkins', rerun: { job: 'rich' } }),
      USE,
    );
    expect(fields).toEqual({
      fields: [
        { name: 'PIWI_RERUN_ARGS', type: 'string', required: false },
        { name: 'TARGET_ENV', type: 'choice', required: false, default: 'staging', options: ['staging', 'production'] },
        { name: 'DEPLOY_TOKEN', type: 'secret', required: false },
      ],
      message: expect.stringContaining('instance’s CI server credential'),
    });
  });

  test('checks and reads a job whose parameters answer more than a dispatch reads, and says when one answers too much', async () => {
    useInstance();
    const large = target({ preset: 'jenkins', rerun: { job: 'large' } });
    expect(await check(large)).toEqual([expect.objectContaining({ ok: true })]);
    const fields = await readCiServerJobFields(db as never, 1, large, USE);
    expect(fields.fields?.find((f) => f.name === 'SPEC')?.options).toHaveLength(50);
    const huge = target({ preset: 'jenkins', rerun: { job: 'huge' } });
    expect(await check(huge)).toEqual([
      expect.objectContaining({ ok: false, message: expect.stringContaining('2 MB') }),
    ]);
    expect(await readCiServerJobFields(db as never, 1, huge, USE)).toEqual({
      fields: null,
      message: expect.stringContaining('2 MB'),
    });
  });

  test('says why a job or a listing cannot be read', async () => {
    useInstance();
    const locked = await readCiServerJobFields(
      db as never,
      1,
      target({ preset: 'jenkins', rerun: { job: 'locked' } }),
      USE,
    );
    expect(locked).toEqual({ fields: null, message: expect.stringContaining('(401)') });
    const missing = await readCiServerJobFields(
      db as never,
      1,
      target({ preset: 'jenkins', rerun: { job: 'gone' } }),
      USE,
    );
    expect(missing).toEqual({ fields: null, message: expect.stringContaining('No job at this path') });
    const elsewhere = target({ preset: 'jenkins', baseUrl: `${base}job/good/`, rerun: { job: 'x' } });
    expect(await listCiServerJobs(db as never, 1, elsewhere, USE)).toMatchObject({ jobs: null });
  });

  test('reaches no private address the operator did not list', async () => {
    const privateBase = base.replace('http:', 'https:');
    const results = await check(target({ preset: 'jenkins', baseUrl: privateBase, rerun: { job: 'good' } }));
    expect(results).toEqual([
      expect.objectContaining({ ok: false, message: expect.stringContaining('URL host is not allowed') }),
    ]);
    expect(seen).toEqual([]);
  });
});
