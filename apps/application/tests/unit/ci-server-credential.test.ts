import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { resolveCiServerTarget, type CiServerTarget, type CiTemplateValues } from '#shared/ci-server';
import {
  ciServerAnswerError,
  instanceCiServer,
  openCiServerToken,
  prepareCiServerRequest,
  sealCiServerToken,
  sendCiServerRequest,
} from '../../server/utils/ci-server-dispatch';

const VALUES: CiTemplateValues = { args: '"a.spec.ts:1"', dispatchId: 'd1', ref: 'main', commit: '' };
const ENV = ['PIWI_CI_SERVER_URL', 'PIWI_CI_SERVER_USER', 'PIWI_CI_SERVER_TOKEN', 'PIWI_CI_SERVER_HOSTS'];

afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

function target(input: Record<string, unknown>): CiServerTarget {
  const resolved = resolveCiServerTarget(input);
  if (!resolved) throw new Error('target did not resolve');
  return resolved;
}

function useInstance(url: string) {
  process.env.PIWI_CI_SERVER_URL = url;
  process.env.PIWI_CI_SERVER_USER = 'piwi-bot';
  process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
}

function prepare(
  t: CiServerTarget,
  baseUrl: string,
  projectToken: { url: string; token: string } | null = null,
  values = VALUES,
) {
  return prepareCiServerRequest({
    target: t,
    kind: 'rerun',
    baseUrl,
    values,
    projectToken,
    instanceCredential: instanceCiServer().credential,
  });
}

const basic = (user: string, token: string) => `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

describe('the instance token', () => {
  test('goes with a request under PIWI_CI_SERVER_URL', () => {
    useInstance('https://jenkins.example.com');
    const request = prepare(target({ preset: 'jenkins', rerun: { job: 'e2e' } }), 'https://jenkins.example.com/');
    expect(request.credential).toBe('instance');
    expect(request.headers.Authorization).toBe(basic('piwi-bot', 'instance-secret'));
  });

  test('never goes to a base URL a project points elsewhere', () => {
    useInstance('https://jenkins.example.com/');
    const jenkins = target({ preset: 'jenkins', rerun: { job: 'e2e' } });
    for (const base of [
      'https://attacker.example/',
      'https://jenkins.example.com.attacker.example/',
      'http://jenkins.example.com/',
      'https://jenkins.example.com:8443/',
    ]) {
      const request = prepare(jenkins, base);
      expect(request.credential).toBeNull();
      expect(request.headers.Authorization).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain('instance-secret');
    }
  });

  test('stays inside the folder its URL names', () => {
    useInstance('https://jenkins.example.com/job/qa/');
    const jenkins = target({ preset: 'jenkins', rerun: { job: 'e2e' } });
    expect(prepare(jenkins, 'https://jenkins.example.com/job/qa/').credential).toBe('instance');
    expect(prepare(jenkins, 'https://jenkins.example.com/job/qa-other/').credential).toBeNull();
    expect(prepare(jenkins, 'https://jenkins.example.com/').credential).toBeNull();
  });
});

describe('a Custom request', () => {
  test('never carries the instance token, only the project token', () => {
    useInstance('https://jenkins.example.com/');
    const custom = target({
      preset: 'custom',
      custom: { auth: 'basic', rerun: { method: 'POST', path: 'scriptText', body: { type: 'form', fields: [] } } },
    });
    const request = prepare(custom, 'https://jenkins.example.com/');
    expect(request.credential).toBeNull();
    expect(JSON.stringify(request)).not.toContain(Buffer.from('piwi-bot:instance-secret').toString('base64'));
    const projectToken = { url: 'https://jenkins.example.com/', token: 'project-secret' };
    expect(prepare(custom, 'https://jenkins.example.com/', projectToken).credential).toBe('project');
  });
});

describe('a project token', () => {
  test('goes only under the base URL it was saved with, before the instance token', () => {
    useInstance('https://jenkins.example.com/');
    const jenkins = target({ preset: 'jenkins', user: 'team-bot', rerun: { job: 'e2e' } });
    const projectToken = { url: 'https://ci.team.example/', token: 'project-secret' };

    const own = prepare(jenkins, 'https://ci.team.example/', projectToken);
    expect(own.credential).toBe('project');
    expect(own.headers.Authorization).toBe(basic('team-bot', 'project-secret'));

    const moved = prepare(jenkins, 'https://ci.moved.example/', projectToken);
    expect(moved.credential).toBeNull();
    expect(JSON.stringify(moved)).not.toContain('project-secret');

    const instance = prepare(jenkins, 'https://jenkins.example.com/', projectToken);
    expect(instance.credential).toBe('instance');
  });

  test('is sealed with its base URL and read back', () => {
    process.env.PIWI_SECRET_KEY = 'a-test-key-for-the-ci-server-token';
    try {
      const sealed = sealCiServerToken('https://ci.team.example/', 'project-secret');
      expect(sealed).not.toContain('project-secret');
      expect(openCiServerToken(sealed)).toEqual({ url: 'https://ci.team.example/', token: 'project-secret' });
      expect(openCiServerToken('v1:garbage')).toBeNull();
      expect(openCiServerToken(null)).toBeNull();
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
  });
});

describe('a placeholder value stays inside the base URL', () => {
  const custom = target({
    preset: 'custom',
    custom: { auth: 'bearer', rerun: { method: 'POST', path: 'job/{{ref}}/build' } },
  });

  test('a slash stays inside one segment', () => {
    const projectToken = { url: 'https://jenkins.example.com/job/qa/', token: 'project-secret' };
    for (const ref of ['a/b', 'feature/x/y']) {
      const request = prepare(custom, 'https://jenkins.example.com/job/qa/', projectToken, { ...VALUES, ref });
      const url = new URL(request.url);
      expect(url.pathname.startsWith('/job/qa/job/')).toBe(true);
      expect(url.pathname.split('/')).toHaveLength(6);
      expect(request.credential).toBe('project');
    }
  });

  test('a dot segment is refused', () => {
    for (const ref of ['..', '.', '../../admin', 'a/../b', '%2e%2e', '%2E%2E/x', '..;x']) {
      expect(() => prepare(custom, 'https://jenkins.example.com/job/qa/', null, { ...VALUES, ref })).toThrow(
        '"." or ".."',
      );
    }
    const literal = target({ preset: 'custom', custom: { auth: 'none', rerun: { method: 'POST', path: '%2e%2e/x' } } });
    expect(() => prepare(literal, 'https://jenkins.example.com/job/qa/')).toThrow('"." or ".."');
  });
});

describe('a path that climbs once decoded', () => {
  test('never carries a credential out of the folder it is bound to', () => {
    useInstance('https://jenkins.example.com/job/qa/');
    const jenkins = target({ preset: 'jenkins', rerun: { job: 'deploy' } });
    for (const baseUrl of [
      'https://jenkins.example.com/job/qa/..%2F..%2Fjob%2Fprod/',
      'https://jenkins.example.com/job/qa/..;/..;/job/prod/',
    ]) {
      expect(() => prepare(jenkins, baseUrl), baseUrl).toThrow(/base URL/);
    }
    const projectToken = { url: 'https://jenkins.example.com/job/qa/', token: 'project-secret' };
    const custom = target({
      preset: 'custom',
      custom: { auth: 'bearer', rerun: { method: 'POST', path: '..%2F..%2FscriptText' } },
    });
    expect(() => prepare(custom, 'https://jenkins.example.com/job/qa/', projectToken)).toThrow('"." or ".."');
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
      headers: { Authorization: 'Bearer project-secret' },
      body: null,
      credential: 'project',
    });
    expect(answer.status).toBe(302);
    expect(hits).toEqual(['/build']);
    expect(ciServerAnswerError(answer).message).toContain('302');
  });
});
