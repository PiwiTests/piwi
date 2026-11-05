import { describe, expect, test } from 'vitest';
import { prepareCiServerRequest } from '../../server/utils/ci-server-dispatch';
import {
  ciServerFormState,
  ciServerPreviewCredential,
  ciServerRequestPreview,
  ciServerTargetFromForm,
  ciServerTokenState,
  customizeCiServerForm,
  type CiServerFormState,
} from '~/utils/ci-server-form';

const BASE = 'https://jenkins.example.com/';

function jenkinsForm(overrides: Partial<CiServerFormState> = {}): CiServerFormState {
  const state = ciServerFormState(null);
  return {
    ...state,
    baseUrl: BASE,
    user: 'piwi-bot',
    rerun: { ...state.rerun, job: 'polaris/e2e', ref: 'main' },
    ...overrides,
  };
}

describe('ciServerFormState', () => {
  test('a new form starts on Jenkins with every field empty', () => {
    expect(ciServerFormState(null)).toEqual({
      preset: 'jenkins',
      baseUrl: '',
      user: '',
      rerun: { job: '', ref: '', argsParameter: '', dispatchParameter: '' },
      flakeLab: { job: '', ref: '', argsParameter: '', dispatchParameter: '' },
      customRef: '',
      customJson: '',
    });
  });

  test('a saved Jenkins target opens with its fields', () => {
    const saved = ciServerTargetFromForm(
      jenkinsForm({ flakeLab: { job: 'polaris/flake-lab', ref: '', argsParameter: '', dispatchParameter: '' } }),
    );
    if (!saved.target) throw new Error(saved.error);
    const state = ciServerFormState(saved.target);
    expect(state.baseUrl).toBe(BASE);
    expect(state.user).toBe('piwi-bot');
    expect(state.rerun).toMatchObject({ job: 'polaris/e2e', ref: 'main' });
    expect(state.flakeLab.job).toBe('polaris/flake-lab');
  });
});

describe('ciServerTargetFromForm', () => {
  test('a Jenkins form saves the fields that are filled in', () => {
    const { target } = ciServerTargetFromForm(jenkinsForm());
    expect(target).toMatchObject({ preset: 'jenkins', baseUrl: BASE, user: 'piwi-bot' });
    expect(target?.rerun).toMatchObject({ job: 'polaris/e2e', ref: 'main' });
    expect(target?.flakeLab).toBeUndefined();
  });

  test('an empty base URL saves none, so the instance URL applies', () => {
    expect(ciServerTargetFromForm(jenkinsForm({ baseUrl: '' })).target?.baseUrl).toBeUndefined();
  });

  test('a base URL that is not http(s) is refused', () => {
    expect(ciServerTargetFromForm(jenkinsForm({ baseUrl: 'ftp://jenkins.example.com/' })).error).toMatch(/http\(s\)/);
    expect(ciServerTargetFromForm(jenkinsForm({ baseUrl: 'https://jenkins.example.com/?a=1' })).error).toMatch(
      /http\(s\)/,
    );
  });

  test('Jenkins without a job is refused', () => {
    const state = jenkinsForm();
    expect(ciServerTargetFromForm({ ...state, rerun: { ...state.rerun, job: '' } }).error).toBe(
      'Jenkins needs the job to re-run.',
    );
  });

  test('a Custom request needs valid JSON with a re-run request', () => {
    const custom = { ...jenkinsForm(), preset: 'custom' as const };
    expect(ciServerTargetFromForm({ ...custom, customJson: '{ nope' }).error).toBe(
      'The custom request is not valid JSON.',
    );
    expect(ciServerTargetFromForm({ ...custom, customJson: '{}' }).error).toMatch(/re-run request/);
  });
});

describe('ciServerTargetFromForm with the instance URL', () => {
  test('a form without a base URL needs the instance to set one', () => {
    const state = jenkinsForm({ baseUrl: '' });
    expect(ciServerTargetFromForm(state, { instanceUrl: null }).error).toBe(
      'Set a base URL: the instance has no CI server.',
    );
    expect(ciServerTargetFromForm(state, { instanceUrl: BASE }).target).not.toBeNull();
  });

  test('a Custom credential header the server cannot set is refused', () => {
    const custom = customizeCiServerForm(jenkinsForm());
    const json = JSON.parse(custom.customJson);
    for (const header of ['X Token', 'Host']) {
      const state = { ...custom, customJson: JSON.stringify({ ...json, auth: { header } }) };
      expect(ciServerTargetFromForm(state).error).toBe(`The credential header ${header} cannot be set.`);
    }
    const ok = { ...custom, customJson: JSON.stringify({ ...json, auth: { header: 'X-Token' } }) };
    expect(ciServerTargetFromForm(ok).target?.custom?.auth).toEqual({ header: 'X-Token' });
  });
});

describe('customizeCiServerForm', () => {
  test('turns Jenkins into a Custom request that sends the same request', () => {
    const jenkins = jenkinsForm();
    const custom = customizeCiServerForm(jenkins);
    expect(custom.preset).toBe('custom');
    expect(custom.customRef).toBe('main');
    expect(JSON.parse(custom.customJson)).toMatchObject({ auth: 'basic', rerun: { method: 'POST' } });
    const opts = { instanceUrl: null, branch: 'feature/x' };
    expect(ciServerRequestPreview(custom, 'rerun', opts).text).toBe(
      ciServerRequestPreview(jenkins, 'rerun', opts).text,
    );
  });

  test('leaves a form that cannot be saved as it is', () => {
    const state = jenkinsForm();
    const broken = { ...state, rerun: { ...state.rerun, job: '' } };
    expect(customizeCiServerForm(broken)).toBe(broken);
  });
});

describe('ciServerRequestPreview', () => {
  test('shows the Jenkins request with the credential masked', () => {
    const preview = ciServerRequestPreview(
      jenkinsForm({ rerun: { job: 'polaris/e2e/{branch}', ref: '', argsParameter: '', dispatchParameter: '' } }),
      'rerun',
      { instanceUrl: null, branch: 'feature/x', typedToken: true },
    );
    const lines = preview.text?.split('\n') ?? [];
    expect(lines[0]).toBe('POST https://jenkins.example.com/job/polaris/job/e2e/job/feature%252Fx/buildWithParameters');
    expect(lines).toContain('Authorization: ••••••••');
    expect(lines).toContain('Content-Type: application/x-www-form-urlencoded');
    expect(lines.at(-1)).toContain('PIWI_RERUN_ARGS=');
    expect(lines.at(-1)).toContain('PIWI_ORIGIN_REF=0f3a9c2e7b5d4e1a');
  });

  test('falls back to the default branch, then to main', () => {
    expect(ciServerRequestPreview(jenkinsForm(), 'rerun', { instanceUrl: null }).text).toBeTruthy();
    const state = jenkinsForm({ rerun: { job: 'e2e/{branch}', ref: '', argsParameter: '', dispatchParameter: '' } });
    expect(ciServerRequestPreview(state, 'rerun', { instanceUrl: null }).text?.split('\n')[0]).toBe(
      'POST https://jenkins.example.com/job/e2e/job/main/buildWithParameters',
    );
  });

  test('uses the instance URL when the form names none', () => {
    const preview = ciServerRequestPreview(jenkinsForm({ baseUrl: '' }), 'rerun', {
      instanceUrl: 'https://ci.internal.example/',
    });
    expect(preview.text?.split('\n')[0]).toBe(
      'POST https://ci.internal.example/job/polaris/job/e2e/buildWithParameters',
    );
    expect(ciServerRequestPreview(jenkinsForm({ baseUrl: '' }), 'rerun', { instanceUrl: null }).error).toMatch(
      /base URL/,
    );
  });

  test('a Flake Lab preview passes the flake command', () => {
    const state = jenkinsForm({
      flakeLab: { job: 'polaris/flake-lab', ref: '', argsParameter: '', dispatchParameter: '' },
    });
    const text = ciServerRequestPreview(state, 'flakeLab', { instanceUrl: null }).text ?? '';
    expect(text.split('\n')[0]).toBe('POST https://jenkins.example.com/job/polaris/job/flake-lab/buildWithParameters');
    expect(text).toContain('PIWI_RERUN_ARGS=flake+12');
    expect(ciServerRequestPreview(jenkinsForm(), 'flakeLab', { instanceUrl: null }).error).toMatch(/Flake Lab/);
  });

  test('says why a form cannot be previewed', () => {
    const state = jenkinsForm();
    expect(
      ciServerRequestPreview({ ...state, rerun: { ...state.rerun, job: '' } }, 'rerun', { instanceUrl: null }),
    ).toEqual({ text: null, url: null, credential: null, error: 'Jenkins needs the job to re-run.' });
  });
});

describe('the preview headers', () => {
  test('are set as the server sets them, a template header replacing the body type', () => {
    const custom = customizeCiServerForm(jenkinsForm());
    const json = JSON.parse(custom.customJson);
    json.rerun.headers = [['content-type', 'application/x-www-form-urlencoded; charset=utf-8']];
    const lines = ciServerRequestPreview({ ...custom, customJson: JSON.stringify(json) }, 'rerun', {
      instanceUrl: null,
      typedToken: true,
    }).text?.split('\n');
    expect(lines?.slice(1, 4)).toEqual([
      'Accept: application/json',
      'content-type: application/x-www-form-urlencoded; charset=utf-8',
      'Authorization: ••••••••',
    ]);
  });

  test('carry no credential when none applies, and say when the instance token would', () => {
    const none = ciServerRequestPreview(jenkinsForm(), 'rerun', { instanceUrl: null }).text ?? '';
    expect(none).not.toContain('Authorization');
    const state = jenkinsForm({ baseUrl: '' });
    const instance = ciServerRequestPreview(state, 'rerun', { instanceUrl: BASE }).text ?? '';
    expect(instance).toContain('Authorization: •••••••• (the instance token, when it sets one)');
  });
});

describe('ciServerPreviewCredential', () => {
  const URL = `${BASE}job/polaris/job/e2e/buildWithParameters`;
  const opts = { instanceUrl: null, typedToken: false, tokenUrl: null };

  test('a typed token, or one stored for a URL the request lies under, is the project credential', () => {
    expect(ciServerPreviewCredential('jenkins', URL, BASE, { ...opts, typedToken: true })).toBe('project');
    expect(ciServerPreviewCredential('jenkins', URL, BASE, { ...opts, tokenUrl: BASE })).toBe('project');
  });

  test('a preset under the instance URL falls back on the instance token, a Custom request never does', () => {
    expect(ciServerPreviewCredential('jenkins', URL, BASE, { ...opts, instanceUrl: BASE })).toBe('instance');
    expect(ciServerPreviewCredential('custom', URL, BASE, { ...opts, instanceUrl: BASE })).toBe('none');
  });

  test('a token stored for another URL is not sent', () => {
    expect(ciServerPreviewCredential('jenkins', URL, BASE, { ...opts, tokenUrl: 'https://other.example.com/' })).toBe(
      'none',
    );
  });
});

describe('the preview and the server send the same credential', () => {
  const credentials = {
    instance: { url: `${BASE}job/qa/`, user: 'piwi-bot', token: 'instance-secret' },
  };

  function both(state: CiServerFormState, opts: { instanceUrl: string | null; tokenUrl: string | null }) {
    const preview = ciServerRequestPreview(state, 'rerun', { ...opts, branch: 'main' });
    const target = ciServerTargetFromForm(state, { instanceUrl: opts.instanceUrl }).target;
    if (!target || !preview.url) throw new Error('the form did not resolve');
    const server = prepareCiServerRequest({
      target,
      kind: 'rerun',
      baseUrl: target.baseUrl ?? opts.instanceUrl!,
      values: { args: 'a', dispatchId: 'd', ref: 'main', commit: '' },
      projectToken: opts.tokenUrl ? { url: opts.tokenUrl, token: 'project-secret' } : null,
      instanceCredential: opts.instanceUrl ? { ...credentials.instance, url: opts.instanceUrl } : null,
    });
    return { preview: preview.credential, server: server.credential ?? 'none' };
  }

  test('with an instance token bound to a folder, for a job inside it under a root base URL', () => {
    const state = jenkinsForm({ rerun: { job: 'qa/e2e', ref: 'main', argsParameter: '', dispatchParameter: '' } });
    const sent = both(state, { instanceUrl: `${BASE}job/qa/`, tokenUrl: null });
    expect(sent).toEqual({ preview: 'instance', server: 'instance' });
    const outside = both(jenkinsForm(), { instanceUrl: `${BASE}job/qa/`, tokenUrl: null });
    expect(outside).toEqual({ preview: 'none', server: 'none' });
  });

  test('with a project token bound to a folder, after the base URL moved to the root', () => {
    const state = jenkinsForm({ rerun: { job: 'qa/e2e', ref: 'main', argsParameter: '', dispatchParameter: '' } });
    expect(both(state, { instanceUrl: null, tokenUrl: `${BASE}job/qa/` })).toEqual({
      preview: 'project',
      server: 'project',
    });
    expect(both(jenkinsForm(), { instanceUrl: null, tokenUrl: `${BASE}job/qa/` })).toEqual({
      preview: 'none',
      server: 'none',
    });
  });
});

describe('ciServerTokenState', () => {
  test('none without a stored token', () => {
    expect(ciServerTokenState(BASE, null)).toBe('none');
  });

  test('bound when the request URL lies under the URL the token was saved with', () => {
    expect(ciServerTokenState(BASE, BASE)).toBe('bound');
    expect(ciServerTokenState('https://jenkins.example.com/job/qa/', BASE)).toBe('bound');
  });

  test('elsewhere when the request URL is off it', () => {
    expect(ciServerTokenState('https://other.example.com/', BASE)).toBe('elsewhere');
    expect(ciServerTokenState(null, BASE)).toBe('elsewhere');
  });
});
