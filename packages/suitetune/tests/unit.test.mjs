import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withOptimizations } from '../src/config.mjs';
import { checkVersion, TESTED_VERSIONS, validIntervals } from '../src/hooks.mjs';

test('leaves a config alone without options', () => {
  const config = { use: { trace: 'on' }, projects: [{ name: 'chromium' }] };
  const result = withOptimizations(config);
  assert.deepEqual(result, config);
  assert.notEqual(result, config);
});

test('sets the trace mode, reduced motion and blocked requests', () => {
  const result = withOptimizations(
    { use: { trace: 'on', contextOptions: { locale: 'fr-FR' } } },
    { trace: 'retain-on-failure', reducedMotion: true, blockRequests: ['**/analytics.js'] },
  );
  assert.equal(result.use.trace, 'retain-on-failure');
  assert.deepEqual(result.use.contextOptions, { locale: 'fr-FR', reducedMotion: 'reduce' });
  assert.deepEqual(result.use.blockRequests, ['**/analytics.js']);
});

test('adds a setup project every project depends on', () => {
  const result = withOptimizations(
    { projects: [{ name: 'chromium', use: { viewport: { width: 800, height: 600 } } }, { name: 'firefox', dependencies: ['db'] }] },
    { signIn: { storageState: '.auth/user.json' } },
  );
  assert.deepEqual(result.projects.map((project) => project.name), ['setup', 'chromium', 'firefox']);
  assert.match('auth.setup.ts', result.projects[0].testMatch);
  assert.deepEqual(result.projects[1].dependencies, ['setup']);
  assert.deepEqual(result.projects[2].dependencies, ['db', 'setup']);
  assert.equal(result.projects[1].use.storageState, '.auth/user.json');
  assert.deepEqual(result.projects[1].use.viewport, { width: 800, height: 600 });
});

test("keeps a project's own storageState", () => {
  const result = withOptimizations(
    { projects: [{ name: 'signed-out', use: { storageState: { cookies: [], origins: [] } } }] },
    { signIn: { storageState: '.auth/user.json' } },
  );
  assert.deepEqual(result.projects[1].use.storageState, { cookies: [], origins: [] });
});

test('gives a config without projects one project behind the setup', () => {
  const result = withOptimizations({}, { signIn: { storageState: 'state.json', project: 'login' } });
  assert.deepEqual(result.projects.map((project) => project.name), ['login', 'tests']);
  assert.deepEqual(result.projects[1].dependencies, ['login']);
});

test('refuses a sign-in without a storage path, or with a taken project name', () => {
  assert.throws(() => withOptimizations({}, { signIn: {} }), /storageState/);
  assert.throws(() => withOptimizations({ projects: [{ name: 'setup' }] }, { signIn: { storageState: 'x.json' } }), /already named "setup"/);
});

test('does not mutate the input projects', () => {
  const projects = [{ name: 'chromium' }];
  withOptimizations({ projects }, { signIn: { storageState: 'state.json' } });
  assert.deepEqual(projects, [{ name: 'chromium' }]);
});

test('passes the experimental options to the fixtures', () => {
  const result = withOptimizations({}, { experimental: { fastScreenshots: true, retryIntervals: [10, 20] } });
  assert.equal(result.use.fastScreenshots, true);
  assert.deepEqual(result.use.retryIntervals, [10, 20]);
});

test('accepts only tested Playwright versions, unless told otherwise', () => {
  assert.doesNotThrow(() => checkVersion(TESTED_VERSIONS[0]));
  assert.throws(() => checkVersion('1.0.0'), /tested with playwright-core .* and 1\.0\.0 is installed/);
  assert.doesNotThrow(() => checkVersion('1.0.0', true));
});

test('accepts retry intervals only as a non-empty list of milliseconds', () => {
  assert.deepEqual(validIntervals([10, 20]), [10, 20]);
  assert.equal(validIntervals(undefined), undefined);
  for (const bad of [[], [-1], ['10'], 50, [Number.NaN]]) assert.throws(() => validIntervals(bad), /retryIntervals/);
});
