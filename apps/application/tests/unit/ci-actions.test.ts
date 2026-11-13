import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ciActionInputValues,
  ciActionSentNames,
  ciActionsFromLegacy,
  ciActionsProblem,
  ciServerTokenBinding,
  pickCiAction,
  reservedInputName,
  resolveCiActionsSettings,
  type CiAction,
  type CiActionsSettings,
} from '#shared/ci-actions';
import { resolveCiRerunSettings } from '#shared/ci-rerun';

const fileAt = vi.hoisted(() => ({ result: null as null | { content: string } | Error, asked: [] as string[][] }));
vi.mock('../../server/utils/scm/project-repository', () => ({
  readProjectRepositoryUrl: async () => 'https://github.com/acme/shop.git',
}));
vi.mock('../../server/utils/scm', () => ({
  createScmProvider: async () => ({
    provider: 'github',
    fetchFileAtRef: async (path: string, ref: string) => {
      fileAt.asked.push([path, ref]);
      if (fileAt.result instanceof Error) throw fileAt.result;
      return fileAt.result;
    },
  }),
}));

const { checkCiAction, workflowDispatchInputs } = await import('../../server/utils/ci-actions');
const { GitHubProvider } = await import('../../server/utils/scm/GitHubProvider');
const { GitLabProvider } = await import('../../server/utils/scm/GitLabProvider');
const { BitbucketProvider } = await import('../../server/utils/scm/BitbucketProvider');

const github = (over: Partial<CiAction> = {}): CiAction => ({
  id: 'smoke',
  name: 'Smoke',
  target: { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' },
  inputs: [],
  accepts: ['tests'],
  ...over,
});
const gitlab = (over: Partial<CiAction> = {}): CiAction => ({
  id: 'gl',
  name: 'GitLab',
  target: { type: 'gitlab', ref: 'main', argsVariable: 'PIWI_RERUN_ARGS' },
  inputs: [],
  accepts: ['tests'],
  ...over,
});
const jenkins = (over: Partial<CiAction> = {}): CiAction => ({
  id: 'jk',
  name: 'Jenkins',
  target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'e2e' } },
  inputs: [],
  accepts: ['tests'],
  ...over,
});
const settings = (actions: CiAction[], defaults: CiActionsSettings['defaults'] = {}): CiActionsSettings => ({
  enabled: true,
  actions,
  defaults,
});

describe('ciActionsFromLegacy', () => {
  test('a GitHub target becomes one re-run action that is the default', () => {
    const converted = ciActionsFromLegacy(
      resolveCiRerunSettings({
        enabled: true,
        github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args', dispatchIdInput: 'piwi_dispatch' },
      }),
    );
    expect(converted).toEqual({
      enabled: true,
      actions: [
        {
          id: 'rerun-github',
          name: 'Re-run failed tests',
          target: {
            type: 'github',
            workflow: 'e2e.yml',
            ref: 'main',
            argsInput: 'args',
            dispatchIdInput: 'piwi_dispatch',
          },
          inputs: [],
          accepts: ['tests'],
        },
      ],
      defaults: { rerun: 'rerun-github' },
    });
  });

  test('several providers get a name each, and the first is the default', () => {
    const converted = ciActionsFromLegacy(
      resolveCiRerunSettings({
        enabled: true,
        gitlab: { ref: 'main', variableName: 'PIWI_RERUN_ARGS' },
        bitbucket: { pipeline: 'rerun', variableName: 'PIWI_RERUN_ARGS' },
      }),
    );
    expect(converted.actions.map((a) => a.name)).toEqual([
      'Re-run failed tests · GitLab',
      'Re-run failed tests · Bitbucket',
    ]);
    expect(converted.defaults).toEqual({ rerun: 'rerun-gitlab' });
  });

  test('a Jenkins target keeps its Flake Lab job as a Flake Lab action', () => {
    const converted = ciActionsFromLegacy(
      resolveCiRerunSettings({
        enabled: true,
        via: 'ci-server',
        ciServer: { preset: 'jenkins', rerun: { job: 'polaris/e2e', ref: 'main' }, flakeLab: { job: 'flake-lab' } },
      } as never),
    );
    expect(converted.actions.map((a) => [a.id, a.accepts, a.target.type])).toEqual([
      ['rerun-ci-server', ['tests'], 'ci-server'],
      ['flakelab-ci-server', ['flakeLab'], 'ci-server'],
    ]);
    expect(converted.actions[1]!.target).toMatchObject({
      preset: 'jenkins',
      fields: { job: 'flake-lab', ref: 'main' },
    });
    expect(converted.defaults).toEqual({ rerun: 'rerun-ci-server', flakeLab: 'flakelab-ci-server' });
  });

  test('a custom request keeps its Flake Lab request', () => {
    const request = { method: 'POST', path: '/run', body: { args: '{{args}}' } };
    const converted = ciActionsFromLegacy(
      resolveCiRerunSettings({
        enabled: true,
        via: 'ci-server',
        ciServer: {
          preset: 'custom',
          baseUrl: 'https://ci.example.com',
          custom: { auth: { type: 'bearer' }, rerun: request, flakeLab: { ...request, path: '/flake' } },
        },
      } as never),
    );
    const flake = converted.actions.find((a) => a.accepts.includes('flakeLab'));
    expect(flake?.target).toMatchObject({
      type: 'ci-server',
      preset: 'custom',
      custom: { request: { path: '/flake' } },
    });
  });

  test('keeps the CI server side and the provider side, with the one `via` names as the default', () => {
    const raw = {
      enabled: true,
      ciServer: { preset: 'jenkins', rerun: { job: 'polaris/e2e', ref: 'main' } },
      github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' },
    };
    const ids = (c: CiActionsSettings) => c.actions.map((a) => a.id);
    const viaServer = ciActionsFromLegacy(resolveCiRerunSettings({ ...raw, via: 'ci-server' } as never));
    expect(ids(viaServer).sort()).toEqual(['rerun-ci-server', 'rerun-github']);
    expect(viaServer.defaults).toEqual({ rerun: 'rerun-ci-server' });
    const viaProvider = ciActionsFromLegacy(resolveCiRerunSettings({ ...raw, via: 'provider' } as never));
    expect(ids(viaProvider).sort()).toEqual(['rerun-ci-server', 'rerun-github']);
    expect(viaProvider.defaults).toEqual({ rerun: 'rerun-github' });
  });

  test('keeps the ids stable whichever side is the default', () => {
    const raw = {
      enabled: true,
      ciServer: { preset: 'jenkins', rerun: { job: 'e2e' }, flakeLab: { job: 'lab' } },
      gitlab: { ref: 'main', variableName: 'PIWI_RERUN_ARGS' },
      flakeLab: { gitlab: { variableName: 'PIWI_LAB' } },
    };
    const ids = (via: string) =>
      ciActionsFromLegacy(resolveCiRerunSettings({ ...raw, via } as never))
        .actions.map((a) => a.id)
        .sort();
    expect(ids('ci-server')).toEqual(ids('provider'));
    expect(ids('ci-server')).toEqual(['flakelab-ci-server', 'flakelab-gitlab', 'rerun-ci-server', 'rerun-gitlab']);
  });

  test('keeps a Flake Lab default on the side `via` names', () => {
    const converted = ciActionsFromLegacy(
      resolveCiRerunSettings({
        enabled: true,
        via: 'provider',
        ciServer: { preset: 'jenkins', rerun: { job: 'e2e' }, flakeLab: { job: 'lab' } },
        gitlab: { ref: 'main', variableName: 'PIWI_RERUN_ARGS' },
        flakeLab: { gitlab: { variableName: 'PIWI_LAB' } },
      } as never),
    );
    expect(converted.defaults).toEqual({ rerun: 'rerun-gitlab', flakeLab: 'flakelab-gitlab' });
  });

  test('keeps the switch, and an empty value has no actions', () => {
    expect(ciActionsFromLegacy(resolveCiRerunSettings({ enabled: false })).enabled).toBe(false);
    expect(ciActionsFromLegacy(resolveCiRerunSettings(null))).toEqual({ enabled: false, actions: [], defaults: {} });
  });
});

describe('resolveCiActionsSettings', () => {
  test('reads a value in the original shape', () => {
    const resolved = resolveCiActionsSettings({
      enabled: true,
      github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' },
    });
    expect(resolved.actions).toHaveLength(1);
    expect(resolved.actions[0]!.target).toMatchObject({ type: 'github', argsInput: 'args' });
  });

  test('is off and empty for a value that is not an object', () => {
    for (const raw of [null, undefined, 'x', 3, []]) {
      expect(resolveCiActionsSettings(raw)).toEqual({ enabled: false, actions: [], defaults: {} });
    }
  });

  test('drops an action without a name or a complete target, and a repeated id or name', () => {
    const resolved = resolveCiActionsSettings({
      enabled: true,
      actions: [
        github(),
        { ...github({ id: 'other' }), name: 'smoke' },
        { ...github({ id: 'smoke' }), name: 'Again' },
        { ...github({ id: 'nameless' }), name: ' ' },
        { ...github({ id: 'half' }), name: 'Half', target: { type: 'github', workflow: 'e2e.yml', ref: '' } },
        gitlab(),
      ],
      defaults: {},
    });
    expect(resolved.actions.map((a) => a.id)).toEqual(['smoke', 'gl']);
  });

  test('keeps fixed and choice inputs, and drops an empty, repeated or built-in input name', () => {
    const resolved = resolveCiActionsSettings({
      enabled: true,
      actions: [
        github({
          inputs: [
            { name: 'TARGET_ENV', kind: 'fixed', value: ' staging ' },
            { name: 'target_env', kind: 'fixed', value: 'dup' },
            { name: 'args', kind: 'fixed', value: 'built in' },
            { name: 'SUITE', kind: 'choice', options: ['smoke', 'full', 'smoke', ''], default: 'nope' },
            { name: 'EMPTY', kind: 'choice', options: [], default: '' },
            { name: '1 bad', kind: 'fixed', value: 'x' },
          ],
        }),
      ],
    });
    expect(resolved.actions[0]!.inputs).toEqual([
      { name: 'TARGET_ENV', kind: 'fixed', value: 'staging' },
      { name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'smoke' },
    ]);
    expect(ciActionInputValues(resolved.actions[0]!)).toEqual({ TARGET_ENV: 'staging', SUITE: 'smoke' });
    expect(ciActionSentNames(resolved.actions[0]!)).toEqual(['args', 'TARGET_ENV', 'SUITE']);
  });

  test('keeps no inputs on a custom request', () => {
    const resolved = resolveCiActionsSettings({
      enabled: true,
      actions: [
        {
          id: 'c',
          name: 'Custom',
          target: {
            type: 'ci-server',
            preset: 'custom',
            baseUrl: 'https://ci.example.com',
            fields: {},
            custom: { auth: { type: 'bearer' }, request: { method: 'POST', path: '/run', body: { a: '{{args}}' } } },
          },
          inputs: [{ name: 'X', kind: 'fixed', value: '1' }],
          accepts: ['tests'],
        },
      ],
    });
    expect(resolved.actions[0]?.inputs).toEqual([]);
  });

  test('points a default that names no usable action at the first action that accepts the kind', () => {
    const resolved = resolveCiActionsSettings({
      enabled: true,
      actions: [github(), gitlab({ accepts: ['tests', 'suite'] })],
      defaults: { rerun: 'gone', suite: 'smoke', flakeLab: 'gl' },
    });
    expect(resolved.defaults).toEqual({ rerun: 'smoke', suite: 'gl' });
  });

  test('an action that accepts nothing accepts re-runs', () => {
    const resolved = resolveCiActionsSettings({ enabled: true, actions: [{ ...github(), accepts: [] }] });
    expect(resolved.actions[0]!.accepts).toEqual(['tests']);
  });
});

describe('ciActionsProblem', () => {
  test('names two actions with the same name, ignoring case', () => {
    expect(ciActionsProblem({ actions: [github(), { ...github({ id: 'b' }), name: 'SMOKE' }] })).toContain(
      'names must be unique',
    );
  });

  test('names an action that has no name or target, and accepts a value in the original shape', () => {
    expect(ciActionsProblem({ actions: [{ id: 'x', name: 'Lone', target: { type: 'gitlab' } }] })).toBe(
      '"Lone" needs a name and a complete target.',
    );
    expect(ciActionsProblem({ enabled: true, github: {} })).toBeNull();
    expect(ciActionsProblem({ actions: [github(), gitlab()] })).toBeNull();
  });

  test('refuses a fixed value or an option over 500 characters', () => {
    const long = 'x'.repeat(501);
    const withInput = (input: Record<string, unknown>) =>
      ciActionsProblem({ actions: [github({ inputs: [input as never] })] });
    expect(withInput({ name: 'A', kind: 'fixed', value: long })).toContain('500');
    expect(withInput({ name: 'A', kind: 'fixed', value: 'x'.repeat(500) })).toBeNull();
    expect(withInput({ name: 'A', kind: 'choice', options: ['a', long] })).toContain('500');
    expect(withInput({ name: 'A', kind: 'choice', options: ['a', 'x'.repeat(500)] })).toBeNull();
  });

  test('refuses more than 50 options in a choice', () => {
    const options = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    const withOptions = (n: number) =>
      ciActionsProblem({
        actions: [github({ inputs: [{ name: 'A', kind: 'choice', options: options(n) } as never] })],
      });
    expect(withOptions(51)).toContain('50');
    expect(withOptions(50)).toBeNull();
  });

  test('refuses a repeated action id', () => {
    expect(ciActionsProblem({ actions: [github(), github({ name: 'Other' })] })).toContain('"smoke"');
    expect(ciActionsProblem({ actions: [github(), github({ id: 'other', name: 'Other' })] })).toBeNull();
  });

  test('refuses a name over 80 characters, and an environment over 80', () => {
    expect(ciActionsProblem({ actions: [github({ name: 'n'.repeat(81) })] })).toContain('80');
    expect(ciActionsProblem({ actions: [github({ name: 'n'.repeat(80) })] })).toBeNull();
    expect(ciActionsProblem({ actions: [github({ environment: 'e'.repeat(81) })] })).toContain('80');
  });

  test('refuses an input name the CI cannot take', () => {
    const named = (name: string) =>
      ciActionsProblem({ actions: [github({ inputs: [{ name, kind: 'fixed', value: 'x' }] })] });
    expect(named('9LIVES')).toContain('not a valid input name');
    expect(named('has space')).toContain('not a valid input name');
    expect(named('a-b')).toContain('not a valid input name');
    expect(named('_ok_1')).toBeNull();
  });

  test('refuses the variables GitLab and Bitbucket reserve, whatever their case', () => {
    const on = (action: CiAction, name: string) =>
      ciActionsProblem({ actions: [{ ...action, inputs: [{ name, kind: 'fixed', value: 'x' }] }] });
    expect(on(gitlab(), 'CI_JOB_TOKEN')).toContain('reserves');
    expect(on(gitlab(), 'gitlab_user_login')).toContain('reserves');
    expect(
      on(
        { ...gitlab(), target: { type: 'bitbucket', pipeline: 'rerun', argsVariable: 'PIWI_RERUN_ARGS' } },
        'Bitbucket_Branch',
      ),
    ).toContain('reserves');
    expect(on(gitlab(), 'MY_CI_NAME')).toBeNull();
    expect(on(github(), 'CI_ENV')).toBeNull();
  });

  test('caps the number of actions', () => {
    const many = Array.from({ length: 21 }, (_, i) => github({ id: `a${i}`, name: `Action ${i}` }));
    expect(ciActionsProblem({ actions: many })).toBe('A project can have at most 20 CI actions.');
  });
});

describe('reservedInputName', () => {
  test('names the first reserved input of a GitLab or Bitbucket action, and none on GitHub', () => {
    const inputs = [
      { name: 'OK', kind: 'fixed', value: 'x' },
      { name: 'ci_x', kind: 'fixed', value: 'x' },
    ] as CiAction['inputs'];
    expect(reservedInputName(gitlab({ inputs }))).toBe('ci_x');
    expect(reservedInputName(github({ inputs }))).toBeNull();
  });
});

describe('ciServerTokenBinding', () => {
  const server = (name: string, baseUrl?: string): CiAction =>
    jenkins({
      id: name,
      name,
      target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'e2e' }, ...(baseUrl ? { baseUrl } : {}) },
    });

  test('answers an error when two actions use different base URLs', () => {
    const binding = ciServerTokenBinding(
      settings([server('A', 'https://a.example.com'), server('B', 'https://b.example.com')]),
      null,
    );
    expect(binding.url).toBeNull();
    expect(binding.error).toContain('2 different base URLs');
  });

  test('binds to the one URL every action shares, however it is written', () => {
    expect(
      ciServerTokenBinding(
        settings([server('A', 'https://a.example.com'), server('B', 'https://a.example.com/')]),
        null,
      ),
    ).toEqual({ url: 'https://a.example.com/', error: null });
  });

  test('counts the instance URL as its own value beside an action URL', () => {
    const binding = ciServerTokenBinding(
      settings([server('A', 'https://a.example.com'), server('B')]),
      'https://instance.example.com',
    );
    expect(binding.url).toBeNull();
    expect(binding.error).toContain('2 different base URLs');
  });

  test('binds to the instance URL when no action has its own, and asks for a URL when there is none', () => {
    expect(ciServerTokenBinding(settings([server('A')]), 'https://instance.example.com')).toEqual({
      url: 'https://instance.example.com',
      error: null,
    });
    expect(ciServerTokenBinding(settings([server('A')]), null).error).toContain('base URL');
  });

  test('ignores actions that are not CI server actions', () => {
    expect(
      ciServerTokenBinding(settings([github(), server('A', 'https://a.example.com')]), 'https://instance.example.com'),
    ).toEqual({
      url: 'https://a.example.com/',
      error: null,
    });
  });
});

describe('pickCiAction', () => {
  const staging = github({ id: 'staging', name: 'Staging', environment: 'staging' });
  const prod = github({ id: 'prod', name: 'Prod', environment: 'production' });
  const plain = github({ id: 'plain', name: 'Plain' });
  const all = settings([plain, staging, prod], { rerun: 'prod' });

  test('prefers the action of the run’s environment, then the default, then the first', () => {
    expect(pickCiAction(all, 'tests', { provider: 'github', environment: 'staging' }).action?.id).toBe('staging');
    expect(pickCiAction(all, 'tests', { provider: 'github', environment: 'qa' }).action?.id).toBe('prod');
    expect(pickCiAction(all, 'tests', { provider: 'github' }).action?.id).toBe('prod');
    expect(pickCiAction(settings([plain, staging]), 'tests', { provider: 'github' }).action?.id).toBe('plain');
  });

  test('serves a run only through an action of its provider, or a CI server', () => {
    const mixed = settings([github(), gitlab(), jenkins()], { rerun: 'smoke' });
    expect(pickCiAction(mixed, 'tests', { provider: 'gitlab' }).action?.id).toBe('gl');
    expect(pickCiAction(mixed, 'tests', { provider: 'bitbucket' }).action?.id).toBe('jk');
    expect(pickCiAction(mixed, 'tests', { provider: null }).action?.id).toBe('jk');
    expect(pickCiAction(settings([github()]), 'tests', { provider: 'gitlab' }).reason).toBe(
      'No CI action re-runs tests for a GitLab repository.',
    );
    expect(pickCiAction(settings([github()]), 'tests', { provider: null }).reason).toBe(
      'Its run has no supported repository to dispatch to.',
    );
  });

  test('uses only actions that accept the kind', () => {
    const flake = github({ id: 'flake', name: 'Flake', accepts: ['flakeLab'] });
    expect(pickCiAction(settings([plain, flake]), 'flakeLab', { provider: 'github' }).action?.id).toBe('flake');
    expect(pickCiAction(settings([plain]), 'flakeLab', { provider: 'github' }).reason).toBe(
      'No CI action runs Flake Lab for this project.',
    );
  });

  test('an id or an exact name picks one action, which must accept the kind and serve the run', () => {
    expect(pickCiAction(all, 'tests', { provider: 'github', actionId: 'staging' }).action?.id).toBe('staging');
    expect(pickCiAction(all, 'tests', { provider: 'github', actionId: 'Prod' }).action?.id).toBe('prod');
    expect(pickCiAction(all, 'tests', { provider: 'github', actionId: 'nope' }).reason).toBe(
      'This project has no CI action "nope".',
    );
    expect(pickCiAction(all, 'flakeLab', { provider: 'github', actionId: 'staging' }).reason).toContain(
      'does not accept Flake Lab',
    );
    expect(pickCiAction(all, 'tests', { provider: 'gitlab', actionId: 'staging' }).reason).toContain(
      'does not serve this run',
    );
  });

  test('picks nothing from a project with no actions', () => {
    expect(pickCiAction(settings([]), 'tests', { provider: 'github' }).action).toBeNull();
  });
});

describe('a dispatch sends the inputs beside the arguments', () => {
  const calls: Array<{ url: string; body: any }> = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ id: 9, build_number: 4 }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const ARGS = '"tests/a.spec.ts:3" --project="chromium"';

  test('GitHub puts them in the workflow inputs, with the arguments under their own name', async () => {
    const target = github().target;
    await new GitHubProvider('acme/shop', 'tok').dispatchRerun(target, ARGS, {
      ref: 'main',
      inputs: { TARGET_ENV: 'staging' },
    });
    expect(calls[0]!.body).toEqual({ ref: 'main', inputs: { TARGET_ENV: 'staging', args: ARGS } });
  });

  test('GitHub never lets an input replace the arguments', async () => {
    await new GitHubProvider('acme/shop', 'tok').dispatchRerun(github().target, ARGS, {
      ref: 'main',
      inputs: { args: 'x' },
    });
    expect(calls[0]!.body.inputs.args).toBe(ARGS);
  });

  test('GitLab sends them as pipeline variables', async () => {
    await new GitLabProvider('gitlab.com', 'acme/shop', 'tok').dispatchRerun(gitlab().target, ARGS, {
      ref: 'main',
      inputs: { TARGET_ENV: 'staging' },
    });
    expect(calls[0]!.body.variables).toEqual([
      { key: 'TARGET_ENV', value: 'staging' },
      { key: 'PIWI_RERUN_ARGS', value: ARGS },
    ]);
  });

  test('Bitbucket sends them as pipeline variables', async () => {
    await new BitbucketProvider('acme', 'shop', 'tok').dispatchRerun(
      { type: 'bitbucket', pipeline: 'rerun', argsVariable: 'PIWI_RERUN_ARGS' },
      ARGS,
      { ref: 'main', inputs: { TARGET_ENV: 'staging' } },
    );
    expect(calls[0]!.body.variables).toEqual([
      { key: 'TARGET_ENV', value: 'staging' },
      { key: 'PIWI_RERUN_ARGS', value: ARGS },
    ]);
  });
});

describe('workflowDispatchInputs', () => {
  test('reads the inputs of a workflow_dispatch map', () => {
    expect(
      workflowDispatchInputs(
        'on:\n  workflow_dispatch:\n    inputs:\n      args:\n        type: string\n      env: {}\n',
      ),
    ).toEqual(['args', 'env']);
  });

  test('accepts the event as a name or a list, with no inputs', () => {
    expect(workflowDispatchInputs('on: workflow_dispatch\n')).toEqual([]);
    expect(workflowDispatchInputs('on: [push, workflow_dispatch]\n')).toEqual([]);
    expect(workflowDispatchInputs('on:\n  workflow_dispatch:\n')).toEqual([]);
  });

  test('is null for a workflow that cannot be dispatched', () => {
    expect(workflowDispatchInputs('on: push\n')).toBeNull();
    expect(workflowDispatchInputs('on: [push]\n')).toBeNull();
    expect(workflowDispatchInputs('on:\n  push:\n')).toBeNull();
    expect(workflowDispatchInputs('name: x\n')).toBeNull();
  });
});

describe('Check on a GitHub action', () => {
  const db = {} as never;
  const WORKFLOW = 'on:\n  workflow_dispatch:\n    inputs:\n      args: {}\n      TARGET_ENV: {}\n';
  beforeEach(() => {
    fileAt.asked.length = 0;
    fileAt.result = { content: WORKFLOW };
  });

  test('passes when the workflow declares every name a dispatch sends, read at the action’s ref', async () => {
    const action = github({ inputs: [{ name: 'TARGET_ENV', kind: 'fixed', value: 'staging' }] });
    expect(await checkCiAction(db, 1, action)).toMatchObject({ ok: true, missing: [] });
    expect(fileAt.asked).toEqual([['.github/workflows/e2e.yml', 'main']]);
  });

  test('names what the workflow does not declare', async () => {
    const action = github({
      inputs: [
        { name: 'TARGET_ENV', kind: 'fixed', value: 'staging' },
        { name: 'SUITE', kind: 'fixed', value: 'smoke' },
      ],
    });
    const result = await checkCiAction(db, 1, action);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['SUITE']);
    expect(result.message).toContain('does not declare SUITE');
  });

  test('fails a workflow with no workflow_dispatch trigger', async () => {
    fileAt.result = { content: 'on: push\n' };
    expect(await checkCiAction(db, 1, github())).toMatchObject({ ok: false, missing: [] });
  });

  test('cannot say when the file is unreadable, missing, invalid or named by its id', async () => {
    fileAt.result = new Error('rate limited');
    expect((await checkCiAction(db, 1, github())).message).toContain('rate limited');
    fileAt.result = null;
    expect(await checkCiAction(db, 1, github())).toMatchObject({ ok: null });
    fileAt.result = { content: 'on: [unclosed' };
    expect((await checkCiAction(db, 1, github())).message).toContain('not valid YAML');
    const byId = github({ target: { type: 'github', workflow: '1234', ref: 'main', argsInput: 'args' } });
    expect((await checkCiAction(db, 1, byId)).message).toContain('numeric id');
  });

  test('says what cannot be checked on GitLab and Bitbucket', async () => {
    expect((await checkCiAction(db, 1, gitlab())).message).toContain("GitLab pipelines can't be checked");
    const bitbucket: CiAction = {
      ...gitlab(),
      target: { type: 'bitbucket', pipeline: 'rerun', argsVariable: 'PIWI_RERUN_ARGS' },
    };
    expect(await checkCiAction(db, 1, bitbucket)).toMatchObject({ ok: null, missing: [] });
  });
});
