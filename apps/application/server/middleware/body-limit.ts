// Refuses request bodies no route should buffer: see bodyLimitError. The operator's limits it reads are held fresh
// first.
import { bodyLimitError } from '../utils/body-limit';
import { loadOperatorLimits } from '../utils/operator-limits';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default defineEventHandler(async (event) => {
  if (BODY_METHODS.has(event.method.toUpperCase())) await loadOperatorLimits();
  const error = bodyLimitError({
    method: event.method,
    path: event.path,
    contentType: getRequestHeader(event, 'content-type'),
    contentLength: getRequestHeader(event, 'content-length'),
    transferEncoding: getRequestHeader(event, 'transfer-encoding'),
  });
  if (error) throw apiError(error);
});
