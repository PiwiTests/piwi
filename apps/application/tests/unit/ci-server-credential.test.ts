import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { resolveCiServerTarget, type CiServerTarget, type CiTemplateValues } from '#shared/ci-server';
import { credentialRefusal } from '#shared/credentials';
import { insertCredential, loadCredentialRecord } from '#shared/handlers/credentials';
import {
  ciServerAnswerError,
  ciServerBaseUrl,
  ciServerCredential,
  prepareCiServerRequest,
  sendCiServerRequest,
  type CiServerCredential,
} from '../../server/utils/ci-server-dispatch';
import { openTempDb, type TempDb } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const VALUES: CiTemplateValues = { args: '"a.spec.ts:1"', dispatchId: 'd1', ref: 'main', commit: '' };
const ENV = [
  'PIWI_CI_SERVER_URL',
  'PIWI_CI_SERVER_USER',
  'PIWI_CI_SERVER_TOKEN',
  'PIWI_CI_SERVER_HOSTS',
  'PIWI_CI_SERVER_ALLOWED_INPUTS',
];

afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

function target(input: Record<string, unknown>): CiServerTarget {
  const resolved = resolveCiServerTarget(input);
  if (!resolved) throw new Error('target did not resolve');
  return resolved;
}

/** The credential the environment sets, its secret opened. */
const instance = (url: string, over: Partial<CiServerCredential> = {}): CiServerCredential => ({
  id: 1,
  name: 'CI server (environment)',
  url,
  user: 'piwi-bot',
  token: 'instance-secret',
  allowedInputs: [],
  source: 'instance',
  ...over,
});

/** A credential an action names, its secret opened. */
const named = (url: string, over: Partial<CiServerCredential> = {}): CiServerCredential => ({
  id: 2,
  name: 'Team Jenkins',
  url,
  user: 'team-bot',
  token: 'team-secret',
  allowedInputs: null,
  source: 'action',
  ...over,
});

function prepare(
  t: CiServerTarget,
  baseUrl: string,
  credential: CiServerCredential | null,
  values = VALUES,
  inputs?: Record<string, string>,
) {
  return prepareCiServerRequest({ target: t, kind: 'rerun', baseUrl, values, inputs, credential });
}

const basic = (user: string, token: string) => `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

/** The rules `withCredential` reads, for a credential shared with every project. */
const rulesOf = (credential: CiServerCredential, over: { customRequests?: boolean; disabled?: boolean } = {}) => ({
  name: credential.name,
  destination: credential.url,
  allProjects: true,
  projectIds: [],
  customRequests: over.customRequests ?? false,
  disabled: over.disabled ?? false,
});

describe('the instance credential', () => {
  test('goes with a preset’s request under its URL', () => {
    const request = prepare(
      target({ preset: 'jenkins', rerun: { job: 'e2e' } }),
      'https://jenkins.example.com/',
      instance('https://jenkins.example.com/'),
    );
    expect(request.credential?.source).toBe('instance');
    expect(request.headers.Authorization).toBe(basic('piwi-bot', 'instance-secret'));
  });

  test('never goes to a base URL a project points elsewhere', () => {
    const jenkins = target({ preset: 'jenkins', rerun: { job: 'e2e' } });
    for (const base of [
      'https://attacker.example/',
      'https://jenkins.example.com.attacker.example/',
      'http://jenkins.example.com/',
      'https://jenkins.example.com:8443/',
    ]) {
      const request = prepare(jenkins, base, instance('https://jenkins.example.com/'));
      expect(request.credential).toBeNull();
      expect(request.headers.Authorization).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain('instance-secret');
    }
  });

  test('stays inside the folder its URL names', () => {
    const jenkins = target({ preset: 'jenkins', rerun: { job: 'e2e' } });
    const credential = instance('https://jenkins.example.com/job/qa/');
    expect(prepare(jenkins, 'https://jenkins.example.com/job/qa/', credential).credential).toBe(credential);
    expect(prepare(jenkins, 'https://jenkins.example.com/job/qa-other/', credential).credential).toBeNull();
    expect(prepare(jenkins, 'https://jenkins.example.com/', credential).credential).toBeNull();
  });

  test('sends only the inputs it allows', () => {
    const jenkins = target({ preset: 'jenkins', rerun: { job: 'e2e' } });
    const inputs = { TARGET_ENV: 'staging', SUITE: 'full' };
    const none = prepare(
      jenkins,
      'https://jenkins.example.com/',
      instance('https://jenkins.example.com/'),
      VALUES,
      inputs,
    );
    expect(none.droppedInputs).toEqual(['TARGET_ENV', 'SUITE']);
    expect(none.body).not.toContain('TARGET_ENV');
    const listed = prepare(
      jenkins,
      'https://jenkins.example.com/',
      instance('https://jenkins.example.com/', { allowedInputs: ['TARGET_ENV'] }),
      VALUES,
      inputs,
    );
    expect(listed.droppedInputs).toEqual(['SUITE']);
    const form = new URLSearchParams(listed.body ?? '');
    expect(form.get('TARGET_ENV')).toBe('staging');
    expect(form.has('SUITE')).toBe(false);
  });

  test('drops no input from a request that carries no credential', () => {
    const jenkins = target({ preset: 'jenkins', rerun: { job: 'e2e' } });
    const request = prepare(jenkins, 'https://other.example.com/', instance('https://jenkins.example.com/'), VALUES, {
      TARGET_ENV: 'staging',
    });
    expect(request.credential).toBeNull();
    expect(request.droppedInputs).toEqual([]);
    expect(new URLSearchParams(request.body ?? '').get('TARGET_ENV')).toBe('staging');
  });
});

describe('a Custom request', () => {
  const custom = target({
    preset: 'custom',
    custom: { auth: 'basic', rerun: { method: 'POST', path: 'scriptText', body: { type: 'form', fields: [] } } },
  });

  test('never carries the instance credential', () => {
    const request = prepare(custom, 'https://jenkins.example.com/', instance('https://jenkins.example.com/'));
    expect(request.credential).toBeNull();
    expect(request.custom).toBe(true);
    expect(JSON.stringify(request)).not.toContain(Buffer.from('piwi-bot:instance-secret').toString('base64'));
  });

  test('names the action’s credential, which goes only when it allows a Custom request', () => {
    const credential = named('https://jenkins.example.com/');
    const request = prepare(custom, 'https://jenkins.example.com/', credential);
    expect(request.credential).toBe(credential);
    expect(request.custom).toBe(true);
    const use = { projectId: 1, url: request.url, custom: request.custom };
    expect(credentialRefusal(rulesOf(credential), use)).toContain('does not go with a Custom request');
    expect(credentialRefusal(rulesOf(credential, { customRequests: true }), use)).toBeNull();
  });

  test('whose auth is none carries no credential', () => {
    const none = target({ preset: 'custom', custom: { auth: 'none', rerun: { method: 'POST', path: 'build' } } });
    const request = prepare(none, 'https://jenkins.example.com/', named('https://jenkins.example.com/'));
    expect(request.credential).toBeNull();
    expect(request.headers.Authorization).toBeUndefined();
  });
});

describe('the credential an action names', () => {
  const jenkins = target({ preset: 'jenkins', rerun: { job: 'e2e' } });

  test('adds its header only once its secret is opened', () => {
    const { token: _token, ...planned } = named('https://jenkins.example.com/');
    const request = prepare(jenkins, 'https://jenkins.example.com/', planned);
    expect(request.credential).toBe(planned);
    expect(request.headers.Authorization).toBeUndefined();
    const opened = prepare(jenkins, 'https://jenkins.example.com/', named('https://jenkins.example.com/'));
    expect(opened.headers.Authorization).toBe(basic('team-bot', 'team-secret'));
    expect(opened.url).toBe(request.url);
  });

  test('is named on a request outside its destination, which its rules refuse', () => {
    const credential = named('https://jenkins.example.com/job/qa/');
    const { token: _token, ...planned } = credential;
    const request = prepare(jenkins, 'https://jenkins.example.com/', planned);
    expect(request.credential?.source).toBe('action');
    expect(credentialRefusal(rulesOf(credential), { projectId: 1, url: request.url, custom: false })).toContain(
      'is sent only under https://jenkins.example.com/job/qa/',
    );
  });

  test('sends every input when it allows all, and only the ones it lists otherwise', () => {
    const inputs = { TARGET_ENV: 'staging', SUITE: 'full' };
    const all = prepare(jenkins, 'https://jenkins.example.com/', named('https://jenkins.example.com/'), VALUES, inputs);
    expect(all.droppedInputs).toEqual([]);
    expect(new URLSearchParams(all.body ?? '').get('SUITE')).toBe('full');
    const listed = prepare(
      jenkins,
      'https://jenkins.example.com/',
      named('https://jenkins.example.com/', { allowedInputs: ['SUITE'] }),
      VALUES,
      inputs,
    );
    expect(listed.droppedInputs).toEqual(['TARGET_ENV']);
    expect(new URLSearchParams(listed.body ?? '').has('TARGET_ENV')).toBe(false);
  });
});

describe('the base URL a target dispatches under', () => {
  test('is its own, else its credential’s destination, else the instance’s URL', () => {
    process.env.PIWI_CI_SERVER_URL = 'https://instance.example.com';
    const own = target({ preset: 'jenkins', baseUrl: 'https://own.example.com/', rerun: { job: 'e2e' } });
    const bare = target({ preset: 'jenkins', rerun: { job: 'e2e' } });
    expect(ciServerBaseUrl(own, named('https://team.example.com/'))).toBe('https://own.example.com/');
    expect(ciServerBaseUrl(bare, named('https://team.example.com/'))).toBe('https://team.example.com/');
    expect(ciServerBaseUrl(bare, instance('https://elsewhere.example.com/'))).toBe('https://instance.example.com/');
    expect(ciServerBaseUrl(bare, null)).toBe('https://instance.example.com/');
    delete process.env.PIWI_CI_SERVER_URL;
    expect(ciServerBaseUrl(bare, null)).toBeNull();
  });
});

describe('the credential a target’s requests carry', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await openTempDb());
  });

  afterAll(() => close());

  test('is the one its action names, without its secret', async () => {
    const id = await insertCredential(
      db as never,
      {
        name: 'Team Jenkins',
        description: null,
        service: 'ci-server',
        user: 'team-bot',
        destination: 'https://team.example.com/',
        scope: { allProjects: true },
        allowedInputs: ['SUITE'],
        customRequests: false,
        disabled: false,
      },
      null,
      null,
    );
    process.env.PIWI_CI_SERVER_URL = 'https://instance.example.com/';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
    const credential = await ciServerCredential(
      db as never,
      target({ preset: 'jenkins', credentialId: id, rerun: { job: 'e2e' } }),
    );
    expect(credential).toEqual({
      id,
      name: 'Team Jenkins',
      url: 'https://team.example.com/',
      user: 'team-bot',
      allowedInputs: ['SUITE'],
      source: 'action',
    });
  });

  test('cannot be one that no longer exists', async () => {
    await expect(
      ciServerCredential(db as never, target({ preset: 'jenkins', credentialId: 9999, rerun: { job: 'e2e' } })),
    ).rejects.toThrow('no longer exists');
  });

  test('is the instance’s when the action names none and the environment sets one, else none', async () => {
    const bare = target({ preset: 'jenkins', rerun: { job: 'e2e' } });
    expect(await ciServerCredential(db as never, bare)).toBeNull();
    process.env.PIWI_CI_SERVER_URL = 'https://instance.example.com';
    process.env.PIWI_CI_SERVER_USER = 'piwi-bot';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
    process.env.PIWI_CI_SERVER_ALLOWED_INPUTS = 'TARGET_ENV';
    const credential = await ciServerCredential(db as never, bare);
    expect(credential).toMatchObject({
      name: 'CI server (environment)',
      url: 'https://instance.example.com/',
      user: 'piwi-bot',
      allowedInputs: ['TARGET_ENV'],
      source: 'instance',
    });
    expect(credential).not.toHaveProperty('token');
    const record = await loadCredentialRecord(db as never, credential!.id);
    expect(record).toMatchObject({ managedBy: 'env', allProjects: true, customRequests: false });
    const [row] = await db
      .select({ secret: schema.credentials.secret })
      .from(schema.credentials)
      .where(eq(schema.credentials.id, credential!.id));
    expect(row!.secret).toBeNull();
  });
});

describe('a placeholder value stays inside the base URL', () => {
  const custom = target({
    preset: 'custom',
    custom: { auth: 'bearer', rerun: { method: 'POST', path: 'job/{{ref}}/build' } },
  });

  test('a slash stays inside one segment', () => {
    const credential = named('https://jenkins.example.com/job/qa/');
    for (const ref of ['a/b', 'feature/x/y']) {
      const request = prepare(custom, 'https://jenkins.example.com/job/qa/', credential, { ...VALUES, ref });
      const url = new URL(request.url);
      expect(url.pathname.startsWith('/job/qa/job/')).toBe(true);
      expect(url.pathname.split('/')).toHaveLength(6);
      const use = { projectId: 1, url: request.url, custom: request.custom };
      expect(credentialRefusal(rulesOf(credential, { customRequests: true }), use)).toBeNull();
    }
  });

  test('a dot segment is refused', () => {
    for (const ref of ['..', '.', '../../admin', 'a/../b', '%2e%2e', '%2E%2E/x', '..;x']) {
      expect(() => prepare(custom, 'https://jenkins.example.com/job/qa/', null, { ...VALUES, ref })).toThrow(
        '"." or ".."',
      );
    }
    const literal = target({ preset: 'custom', custom: { auth: 'none', rerun: { method: 'POST', path: '%2e%2e/x' } } });
    expect(() => prepare(literal, 'https://jenkins.example.com/job/qa/', null)).toThrow('"." or ".."');
  });
});

describe('a path that climbs once decoded', () => {
  test('never carries a credential out of the folder it is bound to', () => {
    const jenkins = target({ preset: 'jenkins', rerun: { job: 'deploy' } });
    for (const baseUrl of [
      'https://jenkins.example.com/job/qa/..%2F..%2Fjob%2Fprod/',
      'https://jenkins.example.com/job/qa/..;/..;/job/prod/',
    ]) {
      expect(() => prepare(jenkins, baseUrl, instance('https://jenkins.example.com/job/qa/')), baseUrl).toThrow(
        /base URL/,
      );
    }
    const custom = target({
      preset: 'custom',
      custom: { auth: 'bearer', rerun: { method: 'POST', path: '..%2F..%2FscriptText' } },
    });
    expect(() =>
      prepare(custom, 'https://jenkins.example.com/job/qa/', named('https://jenkins.example.com/job/qa/')),
    ).toThrow('"." or ".."');
  });
});

describe('a redirect', () => {
  let server: Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/build') {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('login page');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('is not followed, and fails naming its status', async () => {
    process.env.PIWI_CI_SERVER_HOSTS = '127.0.0.1';
    const answer = await sendCiServerRequest({
      method: 'POST',
      url: `${base}build`,
      headers: { Authorization: 'Bearer team-secret' },
      body: null,
      credential: named(base),
      custom: false,
      droppedInputs: [],
    });
    expect(answer.status).toBe(302);
    expect(hits).toEqual(['/build']);
    expect(ciServerAnswerError(answer).message).toContain('302');
  });
});
