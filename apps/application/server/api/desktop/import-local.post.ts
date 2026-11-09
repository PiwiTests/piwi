// Desktop-only: import an archive straight from a path on this machine — the
// backing for drag & drop and "Open with Piwi". The shell hands the dashboard a
// file path (Tauri drag-drop events carry paths, not bytes), and the server
// reads it from disk itself: server and file live on the same machine, so the
// bytes never have to squeeze through the IPC bridge or a multipart upload.
//
// Responds 404 on the normal server build (no PIWI_DESKTOP_TOKEN). Under the
// desktop guard only the app's own window (token cookie) can call this; that
// caller already owns the machine, so reading a user-chosen local file adds no
// reach it does not have.
import { stat, readFile } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import { requireAuth } from '../../utils/auth';
import { sanitizeFilename } from '../../utils/sanitize-filename';
import { resolveMaxImportBytes } from '../../utils/upload-limits';
import { importArchive } from '../../utils/import-archive';
import { formatBytes } from '#shared/utils/format-bytes';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Import a local archive file (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Imports a Playwright blob report or trace .zip directly from an absolute path on the machine the app runs on. Same semantics as POST /api/test-runs/import: idempotent by content hash, no notifications or regression signals.',
    'x-required-permission': 'storage:manage',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute path to a blob report or trace .zip' },
              projectName: { type: 'string' },
              environment: { type: 'string' },
              label: { type: 'string' },
              importGroup: { type: 'string', description: 'Hex SHA-256 grouping key for multi-trace imports.' },
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
  const environment = typeof body?.environment === 'string' && body.environment.trim() ? body.environment.trim() : null;
  const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : null;
  const rawGroup = typeof body?.importGroup === 'string' ? body.importGroup.trim().toLowerCase() : '';
  const importGroup = /^[0-9a-f]{64}$/.test(rawGroup) ? rawGroup : null;

  if (!path || !projectName) {
    throw apiError({ statusCode: 400, message: 'Missing required fields: path, projectName' });
  }
  if (!isAbsolute(path) || !path.toLowerCase().endsWith('.zip')) {
    throw apiError({ statusCode: 400, message: 'Expected an absolute path to a .zip archive' });
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
  const maxUploadBytes = resolveMaxImportBytes();
  if (info.size > maxUploadBytes) {
    throw apiError({ statusCode: 413, message: `Archive too large (max ${formatBytes(maxUploadBytes)})` });
  }

  const data = await readFile(path);
  return importArchive({
    user,
    projectName,
    archive: { filename: sanitizeFilename(basename(path)), data },
    environment,
    label,
    importGroup,
  });
});
