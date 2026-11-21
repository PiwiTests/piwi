import * as http from 'node:http';

/**
 * A worker's stream to the run's live view on `baseUrl`, held as a test worker holds it (worker 0 unless `id` names
 * another, and its lane, and what it can do, `features`), whether it is still open, the headers it was answered with,
 * and what the instance said on it.
 */
export function holdWorkerStream(
  baseUrl: string,
  runId: number,
  key: string,
  id: { worker: number; slot?: number; features?: string } = { worker: 0 },
): {
  open: () => boolean;
  close: () => void;
  headers: () => http.IncomingHttpHeaders | null;
  heard: () => Array<Record<string, unknown>>;
} {
  let open = true;
  let headers: http.IncomingHttpHeaders | null = null;
  const heard: Array<Record<string, unknown>> = [];
  const lane = id.slot === undefined ? '' : `&slot=${id.slot}`;
  const can = id.features === undefined ? '' : `&features=${id.features}`;
  const request = http.request(`${baseUrl}/api/test-runs/${runId}/live-view?worker=${id.worker}${lane}${can}`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${key}` },
  });
  request.on('response', (response) => {
    headers = response.headers;
    response.setEncoding('utf8');
    let text = '';
    response.on('data', (chunk: string) => {
      text += chunk;
      let end: number;
      while ((end = text.indexOf('\n\n')) >= 0) {
        const data = text
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        text = text.slice(end + 2);
        if (data) heard.push(JSON.parse(data) as Record<string, unknown>);
      }
    });
    response.on('close', () => (open = false));
  });
  request.on('error', () => (open = false));
  request.end();
  return { open: () => open, close: () => request.destroy(), headers: () => headers, heard: () => heard };
}
