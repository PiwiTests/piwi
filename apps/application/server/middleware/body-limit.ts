// Refuses request bodies no route should buffer: see bodyLimitError.
import { bodyLimitError } from '../utils/body-limit';

export default eventHandler((event) => {
  const error = bodyLimitError({
    method: event.method,
    path: event.path,
    contentType: getRequestHeader(event, 'content-type'),
    contentLength: getRequestHeader(event, 'content-length'),
    transferEncoding: getRequestHeader(event, 'transfer-encoding'),
  });
  if (error) throw apiError(error);
});
