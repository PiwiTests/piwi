import { afterEach, describe, expect, test } from 'vitest';
import { credentialRefusal } from '#shared/credentials';
import {
  ciServerBaseUrl,
  prepareCiServerRequest,
  type CiServerCredential,
  type OutgoingCiRequest,
} from '../../server/utils/ci-server-dispatch';
import {
  ciServerFormState,
  ciServerPreviewCredential,
  ciServerRequestPreview,
  ciServerTargetFromForm,
  customizeCiServerForm,
  type CiServerFormCredential,
  type CiServerFormState,
  type CiServerPreviewCredential,
} from '~/utils/ci-server-form';

const BASE = 'https://jenkins.example.com/';

/** A credential an action names, as the form lists it. */
const TEAM: CiServerFormCredential = {
  id: 4,
  name: 'Team Jenkins',
  destination: BASE,
  customRequests: false,
  disabled: false,
};

afterEach(() => {
  delete process.env.PIWI_CI_SERVER_URL;
});

function jenkinsForm(overrides: Partial<CiServerFormState> = {}): CiServerFormState {
  const state = ciServerFormState(null);
  return {
    ...state,
    baseUrl: BASE,
    rerun: { ...state.rerun, job: 'polaris/e2e', ref: 'main' },
    ...overrides,
  };
}

describe('ciServerFormState', () => {
  test('a new form starts on Jenkins with every field empty', () => {
    expect(ciServerFormState(null)).toEqual({
      preset: 'jenkins',
      baseUrl: '',
      credentialId: null,
      rerun: { job: '', ref: '', argsParameter: '', dispatchParameter: '' },
      flakeLab: { job: '', ref: '', argsParameter: '', dispatchParameter: '' },
      customRef: '',
      customJson: '',
    });
  });

  test('a saved Jenkins target opens with its fields', () => {
    const saved = ciServerTargetFromForm(
      jenkinsForm({
        credentialId: 4,
        flakeLab: { job: 'polaris/flake-lab', ref: '', argsParameter: '', dispatchParameter: '' },
      }),
    );
    if (!saved.target) throw new Error(saved.error);
    const state = ciServerFormState(saved.target);
    expect(state.baseUrl).toBe(BASE);
    expect(state.credentialId).toBe(4);
    expect(state.rerun).toMatchObject({ job: 'polaris/e2e', ref: 'main' });
    expect(state.flakeLab.job).toBe('polaris/flake-lab');
  });
});

describe('ciServerTargetFromForm', () => {
  test('a Jenkins form saves the fields that are filled in', () => {
    const { target } = ciServerTargetFromForm(jenkinsForm());
    expect(target).toMatchObject({ preset: 'jenkins', baseUrl: BASE });
    expect(target?.rerun).toMatchObject({ job: 'polaris/e2e', ref: 'main' });
    expect(target?.credentialId).toBeUndefined();
    expect(target?.flakeLab).toBeUndefined();
  });

  test('saves the credential the action names', () => {
    expect(ciServerTargetFromForm(jenkinsForm({ credentialId: 4 })).target?.credentialId).toBe(4);
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

  test('a base URL whose path climbs once decoded is refused', () => {
    for (const baseUrl of [
      'https://jenkins.example.com/job/qa/..%2Fprod/',
      'https://jenkins.example.com/job/qa/..;/',
    ]) {
      expect(ciServerTargetFromForm(jenkinsForm({ baseUrl })).error).toMatch(/climbs once decoded/);
    }
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
  test('a form without a base URL needs a credential or the instance to set one', () => {
    const state = jenkinsForm({ baseUrl: '' });
    expect(ciServerTargetFromForm(state, { instanceUrl: null }).error).toBe(
      'Set a base URL or pick a credential: the instance has no CI server.',
    );
    expect(ciServerTargetFromForm(state, { instanceUrl: BASE }).target).not.toBeNull();
    expect(ciServerTargetFromForm({ ...state, credentialId: 4 }, { instanceUrl: null }).target).toMatchObject({
      credentialId: 4,
    });
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
      { instanceUrl: null, branch: 'feature/x', credential: TEAM },
    );
    const lines = preview.text?.split('\n') ?? [];
    expect(lines[0]).toBe('POST https://jenkins.example.com/job/polaris/job/e2e/job/feature%252Fx/buildWithParameters');
    expect(lines).toContain('Authorization: •••••••• (Team Jenkins)');
    expect(preview.credential).toBe('credential');
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

  test('uses the destination of the credential the action names when the form names no base URL', () => {
    const credential = { ...TEAM, destination: 'https://ci.team.example/' };
    const preview = ciServerRequestPreview(jenkinsForm({ baseUrl: '', credentialId: 4 }), 'rerun', {
      instanceUrl: 'https://ci.internal.example/',
      credential,
    });
    expect(preview.text?.split('\n')[0]).toBe('POST https://ci.team.example/job/polaris/job/e2e/buildWithParameters');
    expect(preview.credential).toBe('credential');
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
    ).toEqual({
      text: null,
      url: null,
      credential: null,
      carriesAuth: null,
      droppedInputs: null,
      error: 'Jenkins needs the job to re-run.',
    });
  });
});

describe('the preview headers', () => {
  test('are set as the server sets them, a template header replacing the body type', () => {
    const custom = customizeCiServerForm(jenkinsForm());
    const json = JSON.parse(custom.customJson);
    json.rerun.headers = [['content-type', 'application/x-www-form-urlencoded; charset=utf-8']];
    const lines = ciServerRequestPreview({ ...custom, customJson: JSON.stringify(json) }, 'rerun', {
      instanceUrl: null,
      credential: { ...TEAM, customRequests: true },
    }).text?.split('\n');
    expect(lines?.slice(1, 4)).toEqual([
      'Accept: application/json',
      'content-type: application/x-www-form-urlencoded; charset=utf-8',
      'Authorization: •••••••• (Team Jenkins)',
    ]);
  });

  test('carry no credential when none applies, and say when the instance credential would', () => {
    const none = ciServerRequestPreview(jenkinsForm(), 'rerun', { instanceUrl: null }).text ?? '';
    expect(none).not.toContain('Authorization');
    const state = jenkinsForm({ baseUrl: '' });
    const instance = ciServerRequestPreview(state, 'rerun', { instanceUrl: BASE }).text ?? '';
    expect(instance).toContain('Authorization: •••••••• (the instance credential)');
  });

  test('carry no credential its rules refuse, and say so', () => {
    const preview = ciServerRequestPreview(jenkinsForm({ baseUrl: 'https://other.example.com/' }), 'rerun', {
      instanceUrl: null,
      credential: TEAM,
    });
    expect(preview.credential).toBe('refused');
    expect(preview.text).not.toContain('Authorization');
  });
});

describe('ciServerPreviewCredential', () => {
  const URL = `${BASE}job/polaris/job/e2e/buildWithParameters`;

  test('is the credential the action names for a request under its destination', () => {
    expect(ciServerPreviewCredential('jenkins', URL, { instanceUrl: BASE, credential: TEAM })).toBe('credential');
    const folder = { ...TEAM, destination: `${BASE}job/polaris/` };
    expect(ciServerPreviewCredential('jenkins', URL, { instanceUrl: null, credential: folder })).toBe('credential');
  });

  test('is refused outside its destination, when it is disabled, and for a Custom request it does not allow', () => {
    const opts = { instanceUrl: BASE };
    const elsewhere = { ...TEAM, destination: 'https://other.example.com/' };
    expect(ciServerPreviewCredential('jenkins', URL, { ...opts, credential: elsewhere })).toBe('refused');
    const sibling = { ...TEAM, destination: `${BASE}job/polaris-other/` };
    expect(ciServerPreviewCredential('jenkins', URL, { ...opts, credential: sibling })).toBe('refused');
    expect(ciServerPreviewCredential('jenkins', URL, { ...opts, credential: { ...TEAM, disabled: true } })).toBe(
      'refused',
    );
    expect(ciServerPreviewCredential('custom', URL, { ...opts, credential: TEAM })).toBe('refused');
    expect(ciServerPreviewCredential('custom', URL, { ...opts, credential: { ...TEAM, customRequests: true } })).toBe(
      'credential',
    );
  });

  test('a preset under the instance URL falls back on the instance credential, a Custom request never does', () => {
    expect(ciServerPreviewCredential('jenkins', URL, { instanceUrl: BASE })).toBe('instance');
    expect(ciServerPreviewCredential('custom', URL, { instanceUrl: BASE })).toBe('none');
  });

  test('is none without a credential, or under another instance URL', () => {
    expect(ciServerPreviewCredential('jenkins', URL, { instanceUrl: null })).toBe('none');
    expect(ciServerPreviewCredential('jenkins', URL, { instanceUrl: 'https://other.example.com/' })).toBe('none');
    expect(ciServerPreviewCredential('jenkins', URL, { instanceUrl: `${BASE}job/qa/`, credential: null })).toBe('none');
  });
});

describe('the preview and the server send the same credential', () => {
  /**
   * What the server sends with a request: none, the instance credential, or
   * the action's, which `withCredential` refuses as its rules say.
   */
  function serverSends(
    request: OutgoingCiRequest,
    credential: CiServerFormCredential | null,
  ): CiServerPreviewCredential {
    if (!request.credential) return 'none';
    if (request.credential.source === 'instance') return 'instance';
    const rules = { ...credential!, allProjects: true, projectIds: [] };
    return credentialRefusal(rules, { projectId: 1, url: request.url, custom: request.custom })
      ? 'refused'
      : 'credential';
  }

  function both(
    state: CiServerFormState,
    opts: { instanceUrl: string | null; credential?: CiServerFormCredential },
    kind: 'rerun' | 'flakeLab' = 'rerun',
  ) {
    const credential = opts.credential ?? null;
    const form = { ...state, credentialId: credential?.id ?? null };
    const preview = ciServerRequestPreview(form, kind, { ...opts, branch: 'main' });
    const target = ciServerTargetFromForm(form, { instanceUrl: credential?.destination ?? opts.instanceUrl }).target;
    if (!target || !preview.url) throw new Error('the form did not resolve');
    if (opts.instanceUrl) process.env.PIWI_CI_SERVER_URL = opts.instanceUrl;
    else delete process.env.PIWI_CI_SERVER_URL;
    // The credential `ciServerCredential` reads: the action's when it names one, else the instance's.
    const carried: CiServerCredential | null = credential
      ? {
          id: credential.id,
          name: credential.name,
          url: credential.destination,
          user: null,
          allowedInputs: null,
          source: 'action',
        }
      : opts.instanceUrl
        ? {
            id: 99,
            name: 'CI server (environment)',
            url: opts.instanceUrl,
            user: 'piwi-bot',
            allowedInputs: [],
            source: 'instance',
          }
        : null;
    const baseUrl = ciServerBaseUrl(target, carried);
    if (!baseUrl) throw new Error('no base URL');
    const request = prepareCiServerRequest({
      target,
      kind,
      baseUrl,
      values: { args: kind === 'flakeLab' ? 'flake 12' : 'a', dispatchId: 'd', ref: 'main', commit: '' },
      credential: carried,
    });
    expect(request.url).toBe(preview.url);
    return { preview: preview.credential, server: serverSends(request, credential) };
  }

  test('with the credential the action names, under its destination', () => {
    expect(both(jenkinsForm(), { instanceUrl: null, credential: TEAM })).toEqual({
      preview: 'credential',
      server: 'credential',
    });
    expect(both(jenkinsForm({ baseUrl: '' }), { instanceUrl: null, credential: TEAM })).toEqual({
      preview: 'credential',
      server: 'credential',
    });
  });

  test('with the credential the action names, after the base URL moved off its destination', () => {
    const moved = jenkinsForm({ baseUrl: 'https://ci.moved.example/' });
    expect(both(moved, { instanceUrl: BASE, credential: TEAM })).toEqual({ preview: 'refused', server: 'refused' });
  });

  test('with a disabled credential', () => {
    expect(both(jenkinsForm(), { instanceUrl: null, credential: { ...TEAM, disabled: true } })).toEqual({
      preview: 'refused',
      server: 'refused',
    });
  });

  test('with a Custom request whose auth is none, or a header, and a credential that allows one or not', () => {
    const custom = customizeCiServerForm(jenkinsForm());
    const json = JSON.parse(custom.customJson);
    const none = { ...custom, customJson: JSON.stringify({ ...json, auth: 'none' }) };
    expect(both(none, { instanceUrl: BASE, credential: TEAM })).toEqual({ preview: 'none', server: 'none' });
    expect(ciServerRequestPreview(none, 'rerun', { instanceUrl: BASE, credential: TEAM }).carriesAuth).toBe(false);
    const header = { ...custom, customJson: JSON.stringify({ ...json, auth: { header: 'X-Token' } }) };
    expect(both(header, { instanceUrl: BASE, credential: { ...TEAM, customRequests: true } })).toEqual({
      preview: 'credential',
      server: 'credential',
    });
    expect(both(header, { instanceUrl: BASE, credential: TEAM })).toEqual({ preview: 'refused', server: 'refused' });
    expect(both(header, { instanceUrl: BASE })).toEqual({ preview: 'none', server: 'none' });
  });

  test('for a Flake Lab job outside the folder a credential is bound to', () => {
    const state = jenkinsForm({
      rerun: { job: 'qa/e2e', ref: 'main', argsParameter: '', dispatchParameter: '' },
      flakeLab: { job: 'lab/flake', ref: '', argsParameter: '', dispatchParameter: '' },
    });
    const opts = { instanceUrl: null, credential: { ...TEAM, destination: `${BASE}job/qa/` } };
    expect(both(state, opts)).toEqual({ preview: 'credential', server: 'credential' });
    expect(both(state, opts, 'flakeLab')).toEqual({ preview: 'refused', server: 'refused' });
  });

  test('with an instance credential bound to a folder, for a job inside it under a root base URL', () => {
    const state = jenkinsForm({ rerun: { job: 'qa/e2e', ref: 'main', argsParameter: '', dispatchParameter: '' } });
    expect(both(state, { instanceUrl: `${BASE}job/qa/` })).toEqual({ preview: 'instance', server: 'instance' });
    expect(both(jenkinsForm(), { instanceUrl: `${BASE}job/qa/` })).toEqual({ preview: 'none', server: 'none' });
  });

  test('with no base URL in the form, under the instance URL', () => {
    expect(both(jenkinsForm({ baseUrl: '' }), { instanceUrl: BASE })).toEqual({
      preview: 'instance',
      server: 'instance',
    });
  });
});

describe('the preview of a request whose credential allows some inputs only', () => {
  test('leaves out the inputs the credential does not allow, as a dispatch does, and names them', () => {
    const state = ciServerFormState(null);
    state.baseUrl = 'https://jenkins.example.com/';
    state.credentialId = 3;
    state.rerun.job = 'qa/e2e';
    const credential = {
      id: 3,
      name: 'QA bot',
      destination: 'https://jenkins.example.com/',
      customRequests: false,
      disabled: false,
      allowedInputs: ['SUITE'],
    };
    const preview = ciServerRequestPreview(state, 'rerun', {
      instanceUrl: null,
      credential,
      inputs: [
        ['SUITE', 'smoke'],
        ['TARGET_ENV', 'staging'],
      ],
    });
    expect(preview.droppedInputs).toEqual(['TARGET_ENV']);
    expect(preview.text).toContain('SUITE=smoke');
    expect(preview.text).not.toContain('TARGET_ENV');
    const everyInput = ciServerRequestPreview(state, 'rerun', {
      instanceUrl: null,
      credential: { ...credential, allowedInputs: null },
      inputs: [['TARGET_ENV', 'staging']],
    });
    expect(everyInput.droppedInputs).toEqual([]);
    expect(everyInput.text).toContain('TARGET_ENV=staging');
  });
});

describe('the preview of a request carrying the instance credential', () => {
  test('leaves out the inputs PIWI_CI_SERVER_ALLOWED_INPUTS does not list, as a dispatch does', () => {
    const state = ciServerFormState(null);
    state.rerun.job = 'qa/e2e';
    const opts = {
      instanceUrl: 'https://jenkins.example.com/',
      inputs: [['SUITE', 'smoke']] as [string, string][],
    };
    const none = ciServerRequestPreview(state, 'rerun', { ...opts, instanceAllowedInputs: [] });
    expect(none.credential).toBe('instance');
    expect(none.droppedInputs).toEqual(['SUITE']);
    expect(none.text).not.toContain('SUITE');
    const listed = ciServerRequestPreview(state, 'rerun', { ...opts, instanceAllowedInputs: ['SUITE'] });
    expect(listed.droppedInputs).toEqual([]);
    expect(listed.text).toContain('SUITE=smoke');
  });
});
