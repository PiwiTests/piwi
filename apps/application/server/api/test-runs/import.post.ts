import { readFile } from 'node:fs/promises';
import { requireAuth } from '../../utils/auth';
import { streamMultipart } from '../../utils/multipart-stream';
import { sanitizeFilename } from '../../utils/sanitize-filename';
import { resolveMaxUploadBytes } from '../../utils/upload-limits';
import { importArchive } from '../../utils/import-archive';
import { formatBytes } from '#shared/utils/format-bytes';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Import a historical Playwright blob report or trace',
    description:
      'Import one archive as historical results. A blob report (blob-report/report-*.zip) becomes a complete run with its traces and attachments. A bare trace (trace.zip) becomes a single execution; pass the same importGroup with several traces to gather them into one run. Intended for backfilling runs recorded before Piwi was adopted: re-importing the same archive is a no-op, and imports deliberately do not trigger notifications, AI diagnosis or regression signals.',
    'x-required-permission': 'storage:manage',
    requestBody: {
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              projectName: { type: 'string' },
              archive: { type: 'string', format: 'binary', description: 'A blob report or trace .zip' },
              environment: { type: 'string' },
              label: { type: 'string' },
              importGroup: {
                type: 'string',
                description:
                  'Hex SHA-256 grouping key. Traces sharing one land in a single run; ignored for blob reports.',
              },
            },
            required: ['projectName', 'archive'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);

  const maxUploadBytes = resolveMaxUploadBytes();
  const contentLength = parseInt(getRequestHeader(event, 'content-length') ?? '0', 10);
  if (contentLength > maxUploadBytes) {
    throw apiError({ statusCode: 413, message: `Archive too large (max ${formatBytes(maxUploadBytes)})` });
  }

  // Stream the request to a temp file, within the cap counted on the bytes read
  // (a chunked body declares no length).
  const multipart = await streamMultipart(event, { maxTotalBytes: maxUploadBytes, maxFiles: 1 });
  try {
    const projectName = multipart.fields.get('projectName')?.trim();
    const environment = multipart.fields.get('environment')?.trim() || null;
    const label = multipart.fields.get('label')?.trim() || null;
    const group = multipart.fields.get('importGroup')?.trim().toLowerCase();
    const importGroup = group && /^[0-9a-f]{64}$/.test(group) ? group : null;
    const part = multipart.files.find((f) => f.field === 'archive');

    if (!projectName || !part) {
      throw apiError({ statusCode: 400, message: 'Missing required fields: projectName, archive' });
    }

    const archive = { filename: sanitizeFilename(part.filename), data: await readFile(part.path) };
    return await importArchive({ user, projectName, archive, environment, label, importGroup });
  } finally {
    await multipart.cleanup();
  }
});
