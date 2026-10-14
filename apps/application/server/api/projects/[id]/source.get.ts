import { normalizeCoveragePath } from '@piwitests/core/coverage';
import { getDatabase } from '../../../database';
import { optionalIntQuery } from '../../../utils/query-params';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { isGitObjectId } from '../../../utils/scm/ScmProvider';
import { getSourceAtBlob } from '../../../utils/source-at-blob';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get a source file at a git blob',
    description:
      'The content of one repository file at the git `blob` a coverage names (the version its line numbers refer to), read through the project’s source control provider: by the blob’s id from a local clone (the desktop app), GitHub or GitLab, else as the file at the commit of `run` (or of the project’s newest run that records a repository), used only when its git blob id is `blob`. Returns `{ path, blob, content }`. A file is served whole, up to 200,000 characters, or not at all; 404 when the provider cannot serve it (no repository recorded, no provider for it, a larger file, or a blob it does not hold). Sources are kept an hour per blob, and a failed read two minutes.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'path',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Repository-relative path of the file.',
      },
      {
        name: 'blob',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Git blob id of the file version, 40 or 64 hex characters.',
      },
      {
        name: 'run',
        in: 'query',
        required: false,
        schema: { type: 'integer' },
        description:
          'A run of the project whose commit is read when the provider cannot read a blob by id, such as the run of the execution the coverage comes from.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const query = getQuery(event);
  const path = normalizeCoveragePath(typeof query.path === 'string' ? query.path.trim() : '');
  if (!path || path.split('/').includes('..')) {
    throw apiError({ statusCode: 400, message: 'path must be a repository-relative path (at most 500 characters)' });
  }
  const blob = typeof query.blob === 'string' ? query.blob.trim() : '';
  if (!isGitObjectId(blob)) throw apiError({ statusCode: 400, message: 'blob must be a git object id' });
  const runId = optionalIntQuery(event, 'run', { min: 1 }) ?? null;
  const source = await getSourceAtBlob(await getDatabase(), id, { path, blob, runId });
  if (!source) throw apiError({ statusCode: 404, message: 'Source not available' });
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600');
  return source;
});
