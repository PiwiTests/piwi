import * as http from 'node:http';

/** A worker's stream to the run's live view on `baseUrl`, held as a test worker holds it, and whether it is still open. */
export function holdWorkerStream(
  baseUrl: string,
  runId: number,
  key: string,
): { open: () => boolean; close: () => void } {
  let open = true;
  const request = http.request(`${baseUrl}/api/test-runs/${runId}/live-view?worker=0`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${key}` },
  });
  request.on('response', (response) => {
    response.resume();
    response.on('close', () => (open = false));
  });
  request.on('error', () => (open = false));
  request.end();
  return { open: () => open, close: () => request.destroy() };
}
