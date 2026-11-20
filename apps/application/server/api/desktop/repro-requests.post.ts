// Desktop-only: Piwi Picker asks this app to run a bug report's steps with
// Playwright, or an editor asks it to reproduce or bisect a failure, or to run
// a flaky test's Flake Lab plan, from the instance it reads. The body is JSON
// (a web page cannot send one to another origin without a preflight this
// server never answers) and holds steps, or commits, test locations and lab
// conditions, never code or flags: the run is built here, and only after the
// developer confirms the request in the window. Responds 404 on the normal
// server build.
import { requireAuth } from '../../utils/auth';
import { apiError } from '../../utils/api-error';
import { createReproRequest, reproListenerCount } from '../../utils/desktop-repro';
import { parseReproRequest } from '#shared/desktop-repro';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Ask the desktop app to run a bug report or a failure with Playwright (desktop app)',
    description:
      "Desktop build only — 404 on the server build. Keeps a repro request for ten minutes and shows it in the app window, where the developer picks the linked project and starts or declines it. Piwi Picker's request is a steps document and the run options (headed, trace, Playwright project, repeat); its steps must pass `parseSteps`. An editor's job has `kind` `reproduce` (run the failing tests at `commit` in a throwaway worktree) or `bisect` (find the first bad commit between `good` and `commit`), the failing `tests`, the `browser`, and the `instanceUrl` and `clusterId` the failure came from; or `kind` `flake-lab` with the `plan` the instance's flake-plan endpoint recorded (a reproduce plan: its test, control and arms, every test path relative to the Playwright config and every condition one a plan file accepts), run with `piwi flake --plan <file> --json` at `commit` in a throwaway worktree. The body must be `application/json` (415 otherwise); 400 with the errors when it is invalid. Answers `{ id, status, expiresAt, windowOpen }`; poll `GET /api/desktop/repro-requests/:id` for the verdict.",
    'x-required-permission': 'signed-in',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['steps', 'reproduce', 'bisect', 'flake-lab'],
                description:
                  '`steps` (the default) runs a steps document; `reproduce`, `bisect` and `flake-lab` are an editor’s jobs.',
              },
              steps: { type: 'object', description: 'A steps document (`v: 1`), as Piwi Picker sends it.' },
              options: {
                type: 'object',
                properties: {
                  headed: { type: 'boolean' },
                  trace: { type: 'boolean' },
                  project: { type: 'string' },
                  repeatEach: { type: 'integer', minimum: 1, maximum: 20 },
                },
              },
              title: { type: 'string' },
              bugReportId: { type: 'integer', description: 'The report on the instance it came from.' },
              instanceUrl: { type: 'string' },
              commit: { type: 'string', description: 'A job’s failing commit (7 to 40 hex characters).' },
              good: { type: 'string', description: 'A bisect’s last green commit.' },
              tests: {
                type: 'array',
                description: 'A job’s failing tests, relative to the Playwright config (1 to 50).',
                items: {
                  type: 'object',
                  properties: {
                    filePath: { type: 'string' },
                    title: { type: 'string' },
                    line: { type: 'integer' },
                    projectName: { type: 'string' },
                  },
                  required: ['filePath'],
                },
              },
              browser: { type: 'string' },
              clusterId: { type: 'integer', description: 'A job’s failure cluster on the instance it came from.' },
              plan: {
                type: 'object',
                description:
                  'A `flake-lab` job’s reproduce plan, as `GET /api/test-cases/:id/flake-plan` returns it; the suspects’ text is not kept.',
              },
            },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) {
    throw apiError({ statusCode: 404, message: 'Desktop build only' });
  }
  await requireAuth(event);
  const contentType = getRequestHeader(event, 'content-type');
  // The type is checked before the body is read.
  const body = contentType?.toLowerCase().startsWith('application/json') ? await readBody(event) : null;
  const parsed = parseReproRequest(contentType, body);
  if (!parsed.ok) throw apiError({ statusCode: parsed.statusCode, message: parsed.message, data: parsed.errors });

  const request = createReproRequest(parsed.request);
  setResponseStatus(event, 201);
  return { id: request.id, status: request.status, expiresAt: request.expiresAt, windowOpen: reproListenerCount() > 0 };
});
