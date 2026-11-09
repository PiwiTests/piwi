import { test, expect } from './fixtures';
import { waitForHydration } from './utils';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT } from '#shared/test-project-names';

test.describe('Environment API Tests', () => {
  const envValues = ['production', 'staging', 'development', 'integration'];

  test('should accept test run with environment via JSON submission', async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.ENV_API,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        environment: 'production',
        testCases: [
          { title: 'env test 1', status: 'passed', duration: 500, location: 't.spec.ts:1:1' },
          { title: 'env test 2', status: 'passed', duration: 300, location: 't.spec.ts:2:1' },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBeDefined();
  });

  test('should retrieve environment from test run details', async ({ request }) => {
    const submitResponse = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.ENV_RETRIEVAL,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 3000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        environment: 'staging',
        testCases: [{ title: 'retrieve env', status: 'passed', duration: 400, location: 'r.spec.ts:1:1' }],
      },
    });

    const submitData = await submitResponse.json();

    const getResponse = await request.get(`/api/test-runs/${submitData.runId}`);
    expect(getResponse.ok()).toBeTruthy();

    const testRun = await getResponse.json();
    expect(testRun.environment).toBe('staging');
  });

  test('should allow multiple environments on the same project', async ({ request }) => {
    const projectName = PROJECT.ENV_MULTI;
    const runIds: number[] = [];

    for (const env of envValues) {
      const res = await request.post('/api/test-runs/submit', {
        data: {
          projectName,
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 1000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
          environment: env,
          testCases: [{ title: `env ${env}`, status: 'passed', duration: 200, location: 'm.spec.ts:1:1' }],
        },
      });
      expect(res.ok()).toBeTruthy();
      runIds.push((await res.json()).runId);
    }

    // Verify each run retains its environment
    for (let i = 0; i < runIds.length; i++) {
      const res = await request.get(`/api/test-runs/${runIds[i]}`);
      const run = await res.json();
      expect(run.environment).toBe(envValues[i]);
    }

    // Verify project detail includes all environments
    const projectRes = await request.get('/api/projects');
    const { items: projects } = await projectRes.json();
    const project = projects.find((p: { name: string }) => p.name === projectName);
    expect(project).toBeDefined();

    const projectDetailRes = await request.get(`/api/projects/${project.id}`);
    const projectDetail = await projectDetailRes.json();

    const envs = new Set(projectDetail.testRuns.map((r: { environment?: string }) => r.environment));
    for (const env of envValues) {
      expect(envs.has(env)).toBe(true);
    }
  });

  test('should set environment to null when not provided', async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.ENV_NULL,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'no env', status: 'passed', duration: 100, location: 'n.spec.ts:1:1' }],
      },
    });

    const data = await response.json();

    const getResponse = await request.get(`/api/test-runs/${data.runId}`);
    const testRun = await getResponse.json();
    expect(testRun.environment).toBeNull();
  });

  test('should handle empty string environment as null', async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.ENV_EMPTY,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        environment: '',
        testCases: [{ title: 'empty env', status: 'passed', duration: 100, location: 'e.spec.ts:1:1' }],
      },
    });

    const data = await response.json();

    const getResponse = await request.get(`/api/test-runs/${data.runId}`);
    const testRun = await getResponse.json();
    expect(testRun.environment).toBeNull();
  });

  test('should include environment in project latestRun', async ({ request }) => {
    const submitRes = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.ENV_LATEST_RUN,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 2000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        environment: 'integration',
        testCases: [{ title: 'latest run env', status: 'passed', duration: 300, location: 'l.spec.ts:1:1' }],
      },
    });
    expect(submitRes.ok()).toBeTruthy();

    const projectsRes = await request.get('/api/projects');
    const { items: projects } = await projectsRes.json();
    const project = projects.find((p: { name: string }) => p.name === PROJECT.ENV_LATEST_RUN);
    expect(project).toBeDefined();
    expect(project.latestRun).toBeDefined();
    expect(project.latestRun.environment).toBe('integration');
  });

  test('should accept environment via upload endpoint', async ({ request }) => {
    const response = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.ENV_UPLOAD,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 60000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
          environment: 'production',
        }),
        testCases: JSON.stringify([{ title: 'upload env', status: 'passed', duration: 500 }]),
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.runId).toBeDefined();

    const getResponse = await request.get(`/api/test-runs/${data.runId}`);
    const testRun = await getResponse.json();
    expect(testRun.environment).toBe('production');
  });

  test('should accept environment via streaming start endpoint', async ({ request }) => {
    const response = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.ENV_STREAM_START,
        startTime: new Date().toISOString(),
        environment: 'development',
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.runId).toBeDefined();

    const getResponse = await request.get(`/api/test-runs/${data.runId}`);
    const testRun = await getResponse.json();
    expect(testRun.environment).toBe('development');
  });

  test('should accept environment via setup endpoint', async ({ request }) => {
    const response = await request.post('/api/test-runs/setup', {
      data: {
        projectName: PROJECT.ENV_SETUP,
        startTime: new Date().toISOString(),
        environment: 'staging',
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.runId).toBeDefined();

    const getResponse = await request.get(`/api/test-runs/${data.runId}`);
    const testRun = await getResponse.json();
    expect(testRun.environment).toBe('staging');
  });

  test('reporter options.d.ts should include environment option', async () => {
    // The reporter bundles its dist/ via tsup: only the published entry
    // (dist/index.d.ts) is a stable public-contract path — internal per-file
    // dts output (e.g. dist/public/options.d.ts) is not guaranteed to exist.
    const typeDefsPath = join(process.cwd(), '..', '..', 'packages', 'reporter', 'dist', 'index.d.ts');
    const typeDefs = readFileSync(typeDefsPath, 'utf-8');

    expect(typeDefs).toContain('environment');
    // Verify it's defined on PiwiDashboardOptions
    expect(typeDefs).toContain('PiwiDashboardOptions');
  });
});

test.describe('Environment UI Tests', () => {
  // fullyParallel can schedule these tests across multiple workers; beforeAll
  // is scoped per-worker, so without serial mode two workers could each submit
  // the seed runs, doubling the shared data these tests assert against.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    // Create runs with different environments
    for (const env of ['production', 'staging', 'development']) {
      await request.post('/api/test-runs/submit', {
        data: {
          projectName: PROJECT.ENV_UI,
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 3000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
          environment: env,
          testCases: [{ title: `env ${env} test`, status: 'passed', duration: 200, location: 'env-ui.spec.ts:1:1' }],
        },
      });
    }
  });

  test('should display environment badge on test run detail page', async ({ page, request }) => {
    const projectsRes = await request.get('/api/projects');
    const { items: projects } = await projectsRes.json();
    const project = projects.find((p: { name: string }) => p.name === PROJECT.ENV_UI);
    expect(project).toBeDefined();

    const projectDetailRes = await request.get(`/api/projects/${project.id}`);
    const projectDetail = await projectDetailRes.json();
    const firstRun = projectDetail.testRuns[0];
    expect(firstRun.environment).toBeDefined();

    await page.goto(`/test-runs/${firstRun.id}`);
    await page.waitForURL(/\/test-runs\/\d+/);
    await expect(page.locator('span.rounded-full').filter({ hasText: firstRun.environment })).toBeVisible();
  });

  test('should show environment filter on project detail page', async ({ page, request }) => {
    const projectsRes = await request.get('/api/projects');
    const { items: projects } = await projectsRes.json();
    const project = projects.find((p: { name: string }) => p.name === PROJECT.ENV_UI);
    expect(project).toBeDefined();

    await page.goto(`/projects/${project.id}`);
    await page.waitForURL(/\/projects\/\d+/);
    await waitForHydration(page);

    // The environment select in the Filters block offers every environment.
    // Exact: the block's folded summary line also names "All environments".
    await page.getByText('All environments', { exact: true }).click();
    await expect(page.getByRole('option', { name: 'production' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'staging' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'development' })).toBeVisible();
  });

  test('should filter test runs by environment', async ({ page, request }) => {
    const projectsRes = await request.get('/api/projects');
    const { items: projects } = await projectsRes.json();
    const project = projects.find((p: { name: string }) => p.name === PROJECT.ENV_UI);
    expect(project).toBeDefined();

    await page.goto(`/projects/${project.id}`);
    await page.waitForURL(/\/projects\/\d+/);
    await waitForHydration(page);

    // Pick production in the Filters block's environment select.
    await page.getByText('All environments', { exact: true }).click();
    await page.getByRole('option', { name: 'production' }).click();
    await page.keyboard.press('Escape');

    // An active filter reveals the Reset control.
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();
  });
});
