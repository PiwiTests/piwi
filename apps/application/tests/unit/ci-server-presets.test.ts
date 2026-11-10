import { describe, expect, test } from 'vitest';
import {
  CiTemplateError,
  ciServerRequestTemplate,
  ciServerTargetProblem,
  customizeCiServerTarget,
  jenkinsJobPath,
  isUnderBaseUrl,
  normalizeCiServerBaseUrl,
  readCiServerAnswer,
  renderCiRequest,
  resolveCiServerTarget,
  segmentClimbsWhenDecoded,
  type CiServerTarget,
  type CiTemplateValues,
} from '#shared/ci-server';

const BASE = 'https://jenkins.example.com/';
const VALUES: CiTemplateValues = {
  args: '"tests/login.spec.ts:10" --project="chromium"',
  dispatchId: '0123456789abcdef',
  ref: 'feature/x',
  commit: 'abc1234',
};

function jenkins(rerun: Record<string, string>, flakeLab?: Record<string, string>): CiServerTarget {
  const target = resolveCiServerTarget({ preset: 'jenkins', rerun, ...(flakeLab ? { flakeLab } : {}) });
  if (!target) throw new Error('target did not resolve');
  return target;
}

function render(target: CiServerTarget, kind: 'rerun' | 'flakeLab' = 'rerun', values = VALUES, base = BASE) {
  const spec = ciServerRequestTemplate(target, kind);
  if (!spec) throw new Error('no template');
  return renderCiRequest(base, spec.template, values);
}

describe('the Jenkins preset', () => {
  test('posts buildWithParameters on the folder path, with the two parameters as a form', () => {
    const request = render(jenkins({ job: 'polaris/e2e' }));
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://jenkins.example.com/job/polaris/job/e2e/buildWithParameters');
    expect(request.headers).toEqual([]);
    expect(request.body?.contentType).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(request.body!.text);
    expect([...form.keys()]).toEqual(['PIWI_RERUN_ARGS', 'PIWI_ORIGIN_REF']);
    expect(form.get('PIWI_RERUN_ARGS')).toBe(VALUES.args);
    expect(form.get('PIWI_ORIGIN_REF')).toBe(VALUES.dispatchId);
  });

  test('uses Basic authentication', () => {
    expect(ciServerRequestTemplate(jenkins({ job: 'e2e' }), 'rerun')?.auth).toBe('basic');
  });

  test('takes other parameter names', () => {
    const request = render(jenkins({ job: 'e2e', argsParameter: 'ARGS', dispatchParameter: 'DISPATCH' }));
    expect([...new URLSearchParams(request.body!.text).keys()]).toEqual(['ARGS', 'DISPATCH']);
  });

  test('names a multibranch branch job as Jenkins encodes it', () => {
    const request = render(jenkins({ job: 'polaris/e2e/{branch}' }));
    expect(request.url).toBe('https://jenkins.example.com/job/polaris/job/e2e/job/feature%252Fx/buildWithParameters');
  });

  test('falls back to the target ref for the branch job, and refuses an empty one', () => {
    const target = jenkins({ job: 'e2e/{branch}', ref: 'main' });
    expect(target.rerun.ref).toBe('main');
    expect(() => render(target, 'rerun', { ...VALUES, ref: '' })).toThrow(CiTemplateError);
  });

  test('encodes a folder name as one segment', () => {
    expect(jenkinsJobPath('QA team/e2e')).toBe('job/QA%20team/job/e2e');
    expect(jenkinsJobPath('a/../b')).toBeNull();
    expect(jenkinsJobPath(' / ')).toBeNull();
    const request = render(jenkins({ job: 'a?b/{{args}}' }));
    expect(request.url).toBe('https://jenkins.example.com/job/a%3Fb/job/%7B%7Bargs%7D%7D/buildWithParameters');
  });

  test('keeps the base URL path', () => {
    const request = render(jenkins({ job: 'e2e' }), 'rerun', VALUES, 'https://ci.example.com/jenkins');
    expect(request.url).toBe('https://ci.example.com/jenkins/job/e2e/buildWithParameters');
  });

  test('links to the job page', () => {
    const target = jenkins({ job: 'polaris/e2e' });
    const spec = ciServerRequestTemplate(target, 'rerun')!;
    const answer = readCiServerAnswer(BASE, spec.template, VALUES, { header: () => null, json: null });
    expect(answer).toEqual({ link: 'https://jenkins.example.com/job/polaris/job/e2e/', buildNumber: null });
  });

  test('a target without a job does not resolve, and a Flake Lab part without one is dropped', () => {
    expect(resolveCiServerTarget({ preset: 'jenkins', rerun: { job: ' ' } })).toBeNull();
    expect(resolveCiServerTarget({ preset: 'teamcity', rerun: { job: 'e2e' } })).toBeNull();
    const target = jenkins({ job: 'e2e' }, { job: '' });
    expect(target.flakeLab).toBeUndefined();
    expect(ciServerRequestTemplate(target, 'flakeLab')).toBeNull();
  });

  test('sends a Flake Lab dispatch to its own job', () => {
    const request = render(jenkins({ job: 'e2e' }, { job: 'flake-lab' }), 'flakeLab', { ...VALUES, args: 'flake 12' });
    expect(request.url).toBe('https://jenkins.example.com/job/flake-lab/buildWithParameters');
    expect(new URLSearchParams(request.body!.text).get('PIWI_RERUN_ARGS')).toBe('flake 12');
  });
});

describe('Customize', () => {
  test('produces a Custom target sending the same requests', () => {
    const preset = jenkins({ job: 'polaris/e2e/{branch}', ref: 'main' }, { job: 'flake-lab' });
    const custom = customizeCiServerTarget(preset);
    expect(custom.preset).toBe('custom');
    expect(custom.custom?.auth).toBe('basic');
    expect(render(custom)).toEqual(render(preset));
    expect(render(custom, 'flakeLab')).toEqual(render(preset, 'flakeLab'));
    expect(resolveCiServerTarget(JSON.parse(JSON.stringify(custom)))).toEqual(custom);
  });
});

describe('a Custom request', () => {
  function custom(rerun: Record<string, unknown>): CiServerTarget {
    const target = resolveCiServerTarget({ preset: 'custom', custom: { auth: 'bearer', rerun } });
    if (!target) throw new Error('target did not resolve');
    return target;
  }

  test('fills a JSON body as whole string values, the query and the headers', () => {
    const request = render(
      custom({
        method: 'PUT',
        path: '/api/{{ref}}/trigger',
        query: [['commit', '{{commit}}']],
        headers: [['X-Trigger', 'piwi {{dispatchId}}']],
        body: { type: 'json', template: '{"env":{"ARGS":"{{args}}","N":2},"list":["{{ref}}"]}' },
      }),
    );
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://jenkins.example.com/api/feature%2Fx/trigger?commit=abc1234');
    expect(request.headers).toEqual([['X-Trigger', 'piwi 0123456789abcdef']]);
    expect(JSON.parse(request.body!.text)).toEqual({ env: { ARGS: VALUES.args, N: 2 }, list: ['feature/x'] });
  });

  test('refuses a placeholder inside a JSON string, an unknown placeholder and a line break in a header', () => {
    expect(() =>
      render(custom({ method: 'POST', path: 'x', body: { type: 'json', template: '{"a":"x {{args}}"}' } })),
    ).toThrow('whole string value');
    expect(() => render(custom({ method: 'POST', path: '{{secret}}' }))).toThrow('Unknown placeholder');
    expect(() =>
      render(custom({ method: 'POST', path: 'x', headers: [['X-Ref', '{{ref}}']] }), 'rerun', {
        ...VALUES,
        ref: 'a\r\nInjected: 1',
      }),
    ).toThrow('line break');
  });

  test('refuses a header the transport or the credential owns', () => {
    for (const name of ['Host', 'content-length', 'Transfer-Encoding', 'Connection', 'Cookie', 'Authorization']) {
      expect(() => render(custom({ method: 'POST', path: 'x', headers: [[name, 'v']] }))).toThrow(CiTemplateError);
    }
    expect(() => render(custom({ method: 'POST', path: 'x', headers: [['Bad Name', 'v']] }))).toThrow(
      'Invalid header name',
    );
  });

  test('reads the link and the build number the answer names', () => {
    const target = custom({ method: 'POST', path: 'builds', link: { pointer: '/web_url' }, buildNumber: '/number' });
    const spec = ciServerRequestTemplate(target, 'rerun')!;
    const json = { web_url: 'https://ci.example.com/builds/42', number: 42 };
    expect(readCiServerAnswer(BASE, spec.template, VALUES, { header: () => null, json })).toEqual({
      link: 'https://ci.example.com/builds/42',
      buildNumber: '42',
    });
    const unsafe = { web_url: 'javascript:alert(1)', number: 42 };
    expect(readCiServerAnswer(BASE, spec.template, VALUES, { header: () => null, json: unsafe }).link).toBe(BASE);
  });

  test('keeps only a URL or a root path as the link, and only digits as the build number', () => {
    const target = custom({
      method: 'POST',
      path: 'tokens',
      link: { pointer: '/data/tokenValue' },
      buildNumber: '/data/tokenValue',
    });
    const spec = ciServerRequestTemplate(target, 'rerun')!;
    const json = { data: { tokenValue: '11a2b3c4d5e6f7' } };
    expect(readCiServerAnswer(BASE, spec.template, VALUES, { header: () => null, json })).toEqual({
      link: BASE,
      buildNumber: null,
    });
    const byHeader = custom({ method: 'POST', path: 'x', link: { header: 'Set-Cookie' } });
    const header = (name: string) => (name === 'Set-Cookie' ? 'JSESSIONID=secret' : null);
    expect(
      readCiServerAnswer(BASE, ciServerRequestTemplate(byHeader, 'rerun')!.template, VALUES, { header, json: null })
        .link,
    ).toBe(BASE);
    const location = custom({ method: 'POST', path: 'x', link: { header: 'Location' } });
    const queue = (name: string) => (name === 'Location' ? '/queue/item/5/' : null);
    expect(
      readCiServerAnswer(BASE, ciServerRequestTemplate(location, 'rerun')!.template, VALUES, {
        header: queue,
        json: null,
      }).link,
    ).toBe('https://jenkins.example.com/queue/item/5/');
  });

  test('refuses a path value whose slashes would climb once decoded', () => {
    const target = custom({ method: 'POST', path: 'job/{{ref}}/build' });
    expect(() => render(target, 'rerun', { ...VALUES, ref: '../../scriptText' })).toThrow('"." or ".." segment');
    expect(() => render(target, 'rerun', { ...VALUES, ref: 'a\\..\\b' })).toThrow('"." or ".." segment');
    expect(render(target, 'rerun', { ...VALUES, ref: 'release/1.2' }).url).toBe(
      'https://jenkins.example.com/job/release%2F1.2/build',
    );
  });

  test('a Custom target without a re-run request does not resolve', () => {
    expect(resolveCiServerTarget({ preset: 'custom', custom: { auth: 'none' } })).toBeNull();
    expect(resolveCiServerTarget({ preset: 'custom', custom: { rerun: { method: 'GET', path: 'x' } } })).toBeNull();
  });
});

describe('a path segment that climbs once decoded', () => {
  test('is one whose decoded parts hold "." or "..", whatever the decoding passes or a ";" parameter', () => {
    for (const segment of [
      '..',
      '.',
      '%2e%2e',
      '%2E.',
      '..%2F..%2Fjob%2Fprod',
      '%252e%252e',
      '..%5Cx',
      '..;',
      '..;x=1',
      'a%2F..%2Fb',
    ]) {
      expect(segmentClimbsWhenDecoded(segment), segment).toBe(true);
    }
    for (const segment of ['job', 'feature%252Fx', 'feature%2Fx', '...', '..x', 'a;..', '%zz', 'a%2Fb']) {
      expect(segmentClimbsWhenDecoded(segment), segment).toBe(false);
    }
  });

  test('reads a decoded "?", "#" or NUL as the end of a part, and %uXXXX as a character', () => {
    for (const segment of ['..%3F', '..%23x', '..%00', '%u002e%u002e', '..%253Fx']) {
      expect(segmentClimbsWhenDecoded(segment), segment).toBe(true);
    }
    expect(segmentClimbsWhenDecoded('what%3F')).toBe(false);
  });

  test('counts a segment still encoded after three decoding passes as climbing, at once', () => {
    expect(segmentClimbsWhenDecoded(`%${'25'.repeat(2)}41`)).toBe(false);
    expect(segmentClimbsWhenDecoded(`%${'25'.repeat(3)}41`)).toBe(true);
    const started = performance.now();
    expect(segmentClimbsWhenDecoded(`%${'25'.repeat(200_000)}41`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('is refused in a base URL', () => {
    expect(normalizeCiServerBaseUrl('https://jenkins.example.com/job/qa/..%2F..%2Fjob%2Fprod/')).toBeNull();
    expect(normalizeCiServerBaseUrl('https://jenkins.example.com/job/qa/..;/..;/job/prod')).toBeNull();
    expect(normalizeCiServerBaseUrl('https://jenkins.example.com/job/feature%252Fx')).toBe(
      'https://jenkins.example.com/job/feature%252Fx/',
    );
  });

  test('is never under a base URL', () => {
    expect(isUnderBaseUrl(`${BASE}job/qa/`, `${BASE}job/qa/..%2F..%2Fjob%2Fprod/job/deploy/build`)).toBe(false);
    expect(isUnderBaseUrl(`${BASE}job/qa/`, `${BASE}job/qa/..;/x`)).toBe(false);
    expect(isUnderBaseUrl(`${BASE}job/qa/`, `${BASE}job/qa/job/e2e/build`)).toBe(true);
  });

  test('is refused in a Custom request path and a Jenkins job name', () => {
    for (const path of ['..%2F..%2FscriptText', 'job/..;/scriptText', '%252e%252e/x']) {
      const target = resolveCiServerTarget({ preset: 'custom', custom: { rerun: { method: 'POST', path } } })!;
      expect(() => render(target), path).toThrow(CiTemplateError);
    }
    expect(jenkinsJobPath('polaris/%2e%2e')).toBeNull();
    expect(jenkinsJobPath('..;')).toBeNull();
    expect(ciServerTargetProblem({ preset: 'jenkins', rerun: { job: '%2e%2e/prod' } })).toMatch(/cannot dispatch/);
  });

  test("keeps a Jenkins branch job's double encoding", () => {
    const { url } = render(jenkins({ job: 'polaris/e2e/{branch}' }));
    expect(url).toBe(`${BASE}job/polaris/job/e2e/job/feature%252Fx/buildWithParameters`);
  });
});

describe('a target sent to be saved', () => {
  test('is refused when its base URL is not an http(s) URL', () => {
    const rerun = { job: 'e2e' };
    for (const baseUrl of [
      'jenkins-team-b.corp',
      'https://me:pw@jenkins.example.com/',
      'https://jenkins.example.com/?a=1',
    ]) {
      expect(ciServerTargetProblem({ preset: 'jenkins', baseUrl, rerun })).toBe(
        'The CI server base URL must be an http(s) URL',
      );
    }
    expect(ciServerTargetProblem({ preset: 'jenkins', baseUrl: 'https://jenkins.example.com', rerun })).toBeNull();
    expect(ciServerTargetProblem({ preset: 'jenkins', baseUrl: '  ', rerun })).toBeNull();
    expect(ciServerTargetProblem({ preset: 'jenkins', baseUrl: 42, rerun })).toMatch(/http\(s\)/);
    expect(ciServerTargetProblem({ preset: 'jenkins', baseUrl: null, rerun })).toBeNull();
  });

  test('a stored target whose base URL cannot be used does not resolve, so it never falls back to the instance', () => {
    expect(
      resolveCiServerTarget({
        preset: 'jenkins',
        baseUrl: 'https://jenkins.example.com/job/a/..;/',
        rerun: { job: 'e2e' },
      }),
    ).toBeNull();
    expect(
      resolveCiServerTarget({ preset: 'jenkins', baseUrl: 'jenkins-team-b.corp', rerun: { job: 'e2e' } }),
    ).toBeNull();
    expect(resolveCiServerTarget({ preset: 'jenkins', baseUrl: '', rerun: { job: 'e2e' } })).toMatchObject({
      preset: 'jenkins',
    });
  });

  test('is refused when its base URL path climbs once decoded', () => {
    expect(
      ciServerTargetProblem({
        preset: 'jenkins',
        baseUrl: 'https://jenkins.example.com/job/qa/..%2Fprod/',
        rerun: { job: 'e2e' },
      }),
    ).toMatch(/climbs once decoded/);
  });

  test('is refused when the Flake Lab request it names cannot dispatch', () => {
    const rerun = { job: 'e2e' };
    expect(ciServerTargetProblem({ preset: 'jenkins', rerun, flakeLab: { argsParameter: 'X' } })).toMatch(/Flake Lab/);
    expect(ciServerTargetProblem({ preset: 'jenkins', rerun, flakeLab: { job: '..' } })).toMatch(/Flake Lab/);
    expect(ciServerTargetProblem({ preset: 'jenkins', rerun, flakeLab: { job: '', argsParameter: ' ' } })).toBeNull();
    expect(ciServerTargetProblem({ preset: 'jenkins', rerun, flakeLab: { job: 'flake' } })).toBeNull();
    const custom = { preset: 'custom', custom: { rerun: { method: 'POST', path: 'build' } } };
    expect(ciServerTargetProblem(custom)).toBeNull();
    expect(
      ciServerTargetProblem({ ...custom, custom: { ...custom.custom, flakeLab: { method: 'GET', path: 'flake' } } }),
    ).toMatch(/Flake Lab/);
  });

  test('is refused when its credential header cannot be set', () => {
    const custom = { preset: 'custom', custom: { auth: { header: 'Host' }, rerun: { method: 'POST', path: 'build' } } };
    expect(ciServerTargetProblem(custom)).toBe('The credential header Host cannot be set.');
  });

  test('is refused when it cannot dispatch', () => {
    const cannot = [
      { preset: 'jenkins', rerun: {} },
      { preset: 'gitea', rerun: { job: 'e2e' } },
      { preset: 'custom', custom: { rerun: { method: 'GET', path: 'build' } } },
      'jenkins',
    ];
    for (const target of cannot) expect(ciServerTargetProblem(target)).toMatch(/cannot dispatch/);
    expect(ciServerTargetProblem({ preset: 'jenkins', rerun: { job: 'e2e' } })).toBeNull();
  });
});
