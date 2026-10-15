import { describe, expect, test } from 'vitest';
import { describePageLoadError } from '~/utils/page-error';

describe('describePageLoadError', () => {
  test('a missing entity is a 404 naming it', () => {
    expect(describePageLoadError(404, 'test run', 'Test run not found')).toEqual({
      statusCode: 404,
      title: 'Test run not found',
      description: 'This test run does not exist. It may have been deleted, or the link may be wrong.',
    });
  });

  test('a malformed id is a 404 too', () => {
    expect(describePageLoadError(400, 'project', 'Invalid project ID')).toMatchObject({
      statusCode: 404,
      title: 'Project not found',
    });
  });

  test('a refusal is a 403 saying who can grant a role', () => {
    const project = describePageLoadError(403, 'project', 'No access to this project');
    expect(project.statusCode).toBe(403);
    expect(project.title).toBe('No access to this project');
    expect(project.description).toContain('You have no role on this project.');

    const run = describePageLoadError(403, 'test run', 'No access to this project');
    expect(run.title).toBe('No access to this test run');
    expect(run.description).toContain('This test run belongs to a project you have no role on.');
  });

  test('an ended session is a 401 asking to sign in', () => {
    expect(describePageLoadError(401, 'execution')).toMatchObject({ statusCode: 401, title: 'Signed out' });
  });

  test('any other failure keeps its status and the API message', () => {
    expect(describePageLoadError(503, 'project', 'Database unavailable')).toEqual({
      statusCode: 503,
      title: 'Could not load this project',
      description: 'Database unavailable',
    });
  });

  test('a failure with no HTTP status is a 500', () => {
    const view = describePageLoadError(undefined, 'project');
    expect(view.statusCode).toBe(500);
    expect(view.description).toBe('The server did not answer. Try again in a moment.');
  });

  test('the title is printable ASCII, since it is the HTTP status text', () => {
    for (const status of [401, 403, 404, 500]) {
      expect(describePageLoadError(status, 'failure cluster').title).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
