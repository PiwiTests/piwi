import { describe, expect, test } from 'vitest';
import type { CiAction } from '#shared/ci-actions';
import { ciActionDraft, ciActionFromDraft, duplicateCiActionName, newInputDraft } from '~/utils/ci-action-form';

const opts = { otherNames: [] as string[], instanceUrl: null as string | null };

function githubDraft(over: Record<string, unknown> = {}) {
  const draft = ciActionDraft(null);
  draft.name = 'Smoke';
  draft.github.workflow = 'e2e.yml';
  return Object.assign(draft, over);
}

describe('ciActionDraft', () => {
  test('a new draft is a GitHub action that accepts re-runs', () => {
    const draft = ciActionDraft(null);
    expect(draft).toMatchObject({
      name: '',
      type: 'github',
      accepts: ['tests'],
      github: { ref: 'main', argsInput: 'args' },
      gitlab: { argsVariable: 'PIWI_RERUN_ARGS' },
    });
    expect(draft.id).toMatch(/^[0-9a-f]{8}$/);
  });

  test('opens an action as it is stored, and the kinds it is the default for', () => {
    const action: CiAction = {
      id: 'jk',
      name: 'Jenkins',
      target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'polaris/e2e' } },
      inputs: [
        { name: 'TARGET_ENV', kind: 'fixed', value: 'staging' },
        { name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'full' },
      ],
      accepts: ['tests', 'flakeLab'],
      environment: 'staging',
    };
    const draft = ciActionDraft(action, { enabled: true, actions: [action], defaults: { flakeLab: 'jk' } });
    expect(draft).toMatchObject({ id: 'jk', type: 'jenkins', environment: 'staging', defaultFor: ['flakeLab'] });
    expect(draft.inputs.map((i) => [i.name, i.kind, i.value, i.options, i.default])).toEqual([
      ['TARGET_ENV', 'fixed', 'staging', '', ''],
      ['SUITE', 'choice', '', 'smoke\nfull', 'full'],
    ]);
  });
});

describe('ciActionFromDraft', () => {
  test('builds the action a save sends, trimming what was typed', () => {
    const draft = githubDraft({ name: '  Smoke · staging ', environment: ' staging ' });
    draft.github.workflow = ' e2e.yml ';
    draft.inputs.push({ ...newInputDraft(), name: ' TARGET_ENV ', value: ' staging ' });
    const result = ciActionFromDraft(draft, opts);
    expect(result.error).toBeNull();
    expect(result.action).toEqual({
      id: draft.id,
      name: 'Smoke · staging',
      target: { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' },
      inputs: [{ name: 'TARGET_ENV', kind: 'fixed', value: 'staging' }],
      accepts: ['tests'],
      environment: 'staging',
    });
  });

  test('needs a name that no other action has, ignoring case', () => {
    expect(ciActionFromDraft(githubDraft({ name: ' ' }), opts).error).toBe('Give the action a name.');
    expect(ciActionFromDraft(githubDraft({ name: 'SMOKE' }), { ...opts, otherNames: ['smoke'] }).error).toContain(
      'names must be unique',
    );
  });

  test('needs a complete target', () => {
    const draft = githubDraft();
    draft.github.workflow = '';
    expect(ciActionFromDraft(draft, opts).error).toBe('GitHub needs the workflow file to dispatch.');
    const gitlab = githubDraft({ type: 'gitlab' });
    gitlab.gitlab.argsVariable = '';
    expect(ciActionFromDraft(gitlab, opts).error).toContain('GitLab needs');
    const bitbucket = githubDraft({ type: 'bitbucket' });
    expect(ciActionFromDraft(bitbucket, opts).error).toContain('Bitbucket needs');
  });

  test('refuses an input with an invalid or repeated name, or one the target already sends', () => {
    const named = (name: string) => {
      const draft = githubDraft();
      draft.inputs.push({ ...newInputDraft(), name, value: 'x' });
      return draft;
    };
    expect(ciActionFromDraft(named('1 bad'), opts).error).toContain('is not a valid input name');
    expect(ciActionFromDraft(named('ARGS'), opts).error).toContain('already sent by this action');
    const twice = named('ENV');
    twice.inputs.push({ ...newInputDraft(), name: 'env', value: 'y' });
    expect(ciActionFromDraft(twice, opts).error).toContain('already sent by this action');
  });

  test('takes only letters, digits and "_" in an input name', () => {
    const named = (name: string) => {
      const draft = githubDraft();
      draft.inputs.push({ ...newInputDraft(), name, value: 'x' });
      return ciActionFromDraft(draft, opts);
    };
    for (const bad of ['a-b', 'a.b', 'a b', '9a']) expect(named(bad).error).toContain('is not a valid input name');
    expect(named('_a1').action?.inputs).toEqual([{ name: '_a1', kind: 'fixed', value: 'x' }]);
  });

  test('refuses a name, an environment, a fixed value or an option over its limit, and too many options', () => {
    expect(ciActionFromDraft(githubDraft({ name: 'n'.repeat(81) }), opts).error).toContain('at most 80');
    expect(ciActionFromDraft(githubDraft({ environment: 'e'.repeat(81) }), opts).error).toContain('at most 80');
    const fixed = githubDraft();
    fixed.inputs.push({ ...newInputDraft(), name: 'A', value: 'x'.repeat(501) });
    expect(ciActionFromDraft(fixed, opts).error).toContain('at most 500');
    const long = githubDraft();
    long.inputs.push({ ...newInputDraft(), name: 'A', kind: 'choice', options: `a\n${'x'.repeat(501)}` });
    expect(ciActionFromDraft(long, opts).error).toContain('at most 500');
    const many = githubDraft();
    const options = Array.from({ length: 51 }, (_, i) => `v${i}`);
    many.inputs.push({ ...newInputDraft(), name: 'A', kind: 'choice', options: options.join('\n') });
    expect(ciActionFromDraft(many, opts).error).toContain('at most 50 options');
    many.inputs[0]!.options = options.slice(0, 50).join('\n');
    expect(ciActionFromDraft(many, opts).error).toBeNull();
  });

  test('refuses the variables GitLab and Bitbucket reserve', () => {
    const gitlab = githubDraft({ type: 'gitlab' });
    gitlab.gitlab.argsVariable = 'PIWI_RERUN_ARGS';
    gitlab.inputs.push({ ...newInputDraft(), name: 'ci_job_token', value: 'x' });
    expect(ciActionFromDraft(gitlab, opts).error).toContain('reserves');
    gitlab.inputs[0]!.name = 'MY_CI_NAME';
    expect(ciActionFromDraft(gitlab, opts).error).toBeNull();
    const github = githubDraft();
    github.inputs.push({ ...newInputDraft(), name: 'CI_ENV', value: 'x' });
    expect(ciActionFromDraft(github, opts).error).toBeNull();
  });

  test('a choice needs options, and its default is one of them', () => {
    const draft = githubDraft();
    draft.inputs.push({ ...newInputDraft(), name: 'SUITE', kind: 'choice', options: ' ', default: '' });
    expect(ciActionFromDraft(draft, opts).error).toBe('The choice "SUITE" needs at least one option.');
    draft.inputs[0]!.options = 'smoke\nfull\nsmoke';
    draft.inputs[0]!.default = 'other';
    expect(ciActionFromDraft(draft, opts).action?.inputs).toEqual([
      { name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'smoke' },
    ]);
  });

  test('skips an empty input row, and needs at least one accepted kind', () => {
    const draft = githubDraft();
    draft.inputs.push(newInputDraft());
    expect(ciActionFromDraft(draft, opts).action?.inputs).toEqual([]);
    draft.accepts = [];
    expect(ciActionFromDraft(draft, opts).error).toBe('Choose what the action accepts.');
  });

  test('keeps the accepted kinds in their listed order', () => {
    const draft = githubDraft({ accepts: ['flakeLab', 'tests'] });
    expect(ciActionFromDraft(draft, opts).action?.accepts).toEqual(['tests', 'flakeLab']);
  });
});

describe('duplicateCiActionName', () => {
  test('adds "(copy)", then numbers the copy when that name is taken, ignoring case', () => {
    expect(duplicateCiActionName('Smoke', ['Smoke'])).toBe('Smoke (copy)');
    expect(duplicateCiActionName('Smoke', ['Smoke', 'SMOKE (copy)'])).toBe('Smoke (copy 2)');
  });

  test('stays within 80 characters by shortening the name', () => {
    const name = 'n'.repeat(80);
    const copy = duplicateCiActionName(name, [name]);
    expect(copy).toHaveLength(80);
    expect(copy.endsWith(' (copy)')).toBe(true);
    expect(duplicateCiActionName(name, [name, copy])).toHaveLength(80);
  });
});
