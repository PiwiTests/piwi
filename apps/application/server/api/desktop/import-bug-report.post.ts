// Desktop-only: import a bug report saved by Piwi Picker (`.piwibug`) straight
// from a path on this machine — the backing for opening one with the app or
// dropping it on the window. Like `import-local`, the server reads the file from
// disk itself, and only the app's own window (token cookie) can call this.
import { stat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { BUG_REPORT_EXTENSION } from '@piwitests/core/bug-report';
import { requireAuth } from '../../utils/auth';
import { getDatabase } from '../../database';
import { getProjectScope } from '../../utils/project-access';
import { resolveIngestProject } from '../../utils/ingest-project';
import { readBugReportArchive, storeBugReport } from '../../utils/bug-report-store';
import { resolveMaxUploadBytes } from '../../utils/upload-limits';
import { refuseFilesAtQuota } from '../../utils/storage-quota';
import { formatBytes } from '#shared/utils/format-bytes';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Import a local bug report file (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Imports a bug report saved by Piwi Picker (a `.piwibug` file, or a `.zip` holding its `steps.json` and `evidence.json`) from an absolute path on the machine the app runs on, into the named project, as **Send to Piwi…** would. Answers `{ id, url }`. Once the stored bytes reach `PIWI_STORAGE_QUOTA_BYTES`, a report with screenshots answers 409 with `errorCode` `STORAGE_QUOTA_FILES_REFUSED`.',
    'x-required-permission': 'storage:manage',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute path to a .piwibug file' },
              projectName: { type: 'string' },
            },
            required: ['path', 'projectName'],
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
  const user = await requireAuth(event);

  const body = await readBody(event);
  const path = typeof body?.path === 'string' ? body.path : '';
  const projectName = typeof body?.projectName === 'string' ? body.projectName.trim() : '';
  if (!path || !projectName) {
    throw apiError({ statusCode: 400, message: 'Missing required fields: path, projectName' });
  }
  const lower = path.toLowerCase();
  if (!isAbsolute(path) || !(lower.endsWith(`.${BUG_REPORT_EXTENSION}`) || lower.endsWith('.zip'))) {
    throw apiError({ statusCode: 400, message: 'Expected an absolute path to a .piwibug file' });
  }

  let info;
  try {
    info = await stat(path);
  } catch {
    throw apiError({ statusCode: 404, message: 'File not found' });
  }
  if (!info.isFile()) {
    throw apiError({ statusCode: 400, message: 'Not a file' });
  }
  const maxUploadBytes = resolveMaxUploadBytes();
  if (info.size > maxUploadBytes) {
    throw apiError({ statusCode: 413, message: `File too large (max ${formatBytes(maxUploadBytes)})` });
  }

  const read = await readBugReportArchive(await readFile(path));
  if (!read) throw apiError({ statusCode: 400, message: 'Not a bug report saved by Piwi Picker' });

  const db = await getDatabase();
  const project = await resolveIngestProject(db, await getProjectScope(db, user), projectName);
  if (read.screenshots.size > 0 || read.stepShots.size > 0) await refuseFilesAtQuota(db);
  const { id } = await storeBugReport(db, {
    projectId: project.id,
    report: read.report,
    language: null,
    createdBy: user.id || null,
    screenshots: read.screenshots,
    stepShots: read.stepShots,
  });
  setResponseStatus(event, 201);
  return { id, url: `/bug-reports/${id}` };
});
