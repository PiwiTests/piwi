import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

test.describe.serial('API Server Tests', () => {
  test('should submit test results via JSON API', async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.TEST_API,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 120000,
        totalTests: 10,
        passedTests: 9,
        failedTests: 1,
        skippedTests: 0,
        playwrightVersion: '1.51.0',
        reporterVersion: '0.5.0',
        testCases: [
          {
            title: 'should login successfully',
            status: 'passed',
            duration: 1500,
            location: 'tests/login.spec.ts:10:5',
            retries: 0,
          },
          {
            title: 'should handle errors',
            status: 'failed',
            duration: 2300,
            location: 'tests/errors.spec.ts:5:5',
            error: 'Expected true but got false',
            retries: 1,
          },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBeDefined();
    expect(data.projectId).toBeDefined();
  });

  test('should get list of projects', async ({ request }) => {
    const response = await request.get('/api/projects');

    expect(response.ok()).toBeTruthy();
    const { items: projects } = await response.json();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThan(0);

    const project = projects.find((p: { name: string; totalRuns?: number }) => p.name === PROJECT.TEST_API);
    expect(project).toBeDefined();
    expect(project.totalRuns).toBeGreaterThan(0);
  });

  test('should get project details', async ({ request }) => {
    // First, get the project list to find our project
    const projectsResponse = await request.get('/api/projects');
    const { items: projects } = await projectsResponse.json();
    const project = projects.find((p: { name: string; id: number }) => p.name === PROJECT.TEST_API);

    expect(project).toBeDefined();

    // Now get project details
    const response = await request.get(`/api/projects/${project.id}`);
    expect(response.ok()).toBeTruthy();

    const projectDetails = await response.json();
    expect(projectDetails.name).toBe(PROJECT.TEST_API);
    expect(projectDetails.testRuns).toBeDefined();
    expect(Array.isArray(projectDetails.testRuns)).toBe(true);
  });

  test('should get test run details', async ({ request }) => {
    // First, get the project list to find our test run
    const projectsResponse = await request.get('/api/projects');
    const { items: projects } = await projectsResponse.json();
    const project = projects.find((p: { name: string; id: number }) => p.name === PROJECT.TEST_API);

    const projectDetailsResponse = await request.get(`/api/projects/${project.id}`);
    const projectDetails = await projectDetailsResponse.json();
    const testRun = projectDetails.testRuns[0];

    expect(testRun).toBeDefined();

    // Now get test run details
    const response = await request.get(`/api/test-runs/${testRun.id}`);
    expect(response.ok()).toBeTruthy();

    const testRunDetails = await response.json();
    expect(testRunDetails.id).toBe(testRun.id);
    expect(testRunDetails.status).toBeDefined();
    expect(testRunDetails.testCases).toBeDefined();
    expect(Array.isArray(testRunDetails.testCases)).toBe(true);
    expect(testRunDetails.testCases.length).toBe(2);
    expect(testRunDetails.playwrightVersion).toBe('1.51.0');
    expect(testRunDetails.reporterVersion).toBe('0.5.0');
  });

  test('should get test case details (stable identity)', async ({ request }) => {
    // Get test run to find test cases
    const projectsResponse = await request.get('/api/projects');
    const { items: projects } = await projectsResponse.json();
    const project = projects.find((p: { name: string; id: number }) => p.name === PROJECT.TEST_API);

    const projectDetailsResponse = await request.get(`/api/projects/${project.id}`);
    const projectDetails = await projectDetailsResponse.json();
    const testRun = projectDetails.testRuns[0];

    const testRunDetailsResponse = await request.get(`/api/test-runs/${testRun.id}`);
    const testRunDetails = await testRunDetailsResponse.json();
    const testCase = testRunDetails.testCases[0];

    expect(testCase).toBeDefined();

    // Get the test-run-case execution detail
    const execResponse = await request.get(`/api/test-run-cases/${testCase.executionId}`);
    expect(execResponse.ok()).toBeTruthy();

    const execDetails = await execResponse.json();
    expect(execDetails.id).toBe(testCase.executionId);
    expect(execDetails.title).toBeDefined();
    expect(execDetails.status).toBeDefined();

    // Then get the stable test case using testCaseId
    expect(execDetails.testCaseId).toBeDefined();
    const stableResponse = await request.get(`/api/test-cases/${execDetails.testCaseId}`);
    expect(stableResponse.ok()).toBeTruthy();
    const stableDetails = await stableResponse.json();
    expect(stableDetails.id).toBe(execDetails.testCaseId);
    expect(stableDetails.title).toBeDefined();
    expect(stableDetails.totalRuns).toBeDefined();
  });

  test('should handle invalid project ID gracefully', async ({ request }) => {
    const response = await request.get('/api/projects/99999');
    expect(response.status()).toBe(404);
  });

  test('should handle invalid test run ID gracefully', async ({ request }) => {
    const response = await request.get('/api/test-runs/99999');
    expect(response.status()).toBe(404);
  });

  test('should handle invalid test case ID gracefully', async ({ request }) => {
    const response = await request.get('/api/test-cases/99999');
    expect(response.status()).toBe(404);
  });

  test('should reject malformed JSON in submit endpoint', async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.TEST_PROJECT,
        // Missing required fields
      },
    });

    expect(response.ok()).toBeFalsy();
  });

  test('should calculate and store flaky tests correctly', async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.TEST_FLAKY,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 150000,
        totalTests: 5,
        passedTests: 5,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'stable test',
            status: 'passed',
            duration: 1000,
            location: 'tests/stable.spec.ts:5:5',
            retries: 0,
          },
          {
            title: 'flaky test 1',
            status: 'passed',
            duration: 2000,
            location: 'tests/flaky1.spec.ts:10:5',
            retries: 1,
          },
          {
            title: 'flaky test 2',
            status: 'passed',
            duration: 1500,
            location: 'tests/flaky2.spec.ts:15:5',
            retries: 2,
          },
          {
            title: 'another stable test',
            status: 'passed',
            duration: 1200,
            location: 'tests/stable2.spec.ts:20:5',
            retries: 0,
          },
          {
            title: 'failed test with retries',
            status: 'failed',
            duration: 3000,
            location: 'tests/failed.spec.ts:25:5',
            error: 'Test failed even after retries',
            retries: 3,
          },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBeDefined();

    // Verify the test run has the correct flaky test count
    const testRunResponse = await request.get(`/api/test-runs/${data.runId}`);
    expect(testRunResponse.ok()).toBeTruthy();
    const testRunDetails = await testRunResponse.json();

    // Should count only tests that passed after retries (2 tests)
    expect(testRunDetails.flakyTests).toBe(2);
  });

  test('should include flaky tests in project statistics', async ({ request }) => {
    const projectsResponse = await request.get('/api/projects');
    expect(projectsResponse.ok()).toBeTruthy();

    const { items: projects } = await projectsResponse.json();
    const flakyProject = projects.find((p: { name: string }) => p.name === PROJECT.TEST_FLAKY);

    expect(flakyProject).toBeDefined();
    expect(flakyProject.latestRun).toBeDefined();
    expect(flakyProject.latestRun.flakyTests).toBe(2);
  });
});
