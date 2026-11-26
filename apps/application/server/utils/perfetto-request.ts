import type { H3Event } from 'nitro/h3';
import { buildPerfettoTrace } from '#shared/perfetto/build';
import type { PerfettoRunInput } from '#shared/perfetto/types';
import { sanitizeFilename } from './sanitize-filename';
import { publicBaseUrl } from './public-base-url';

/** The dashboard origin recorded in the trace's execution and attachment URLs. */
export function perfettoBaseUrl(event: H3Event): string {
  return publicBaseUrl(event);
}

function perfettoPiwiVersion(): string | null {
  return ((useRuntimeConfig().public as { appVersion?: string })?.appVersion as string) || null;
}

/** Build the Trace Event Format document and stream it as a `.json` download. */
export function sendPerfetto(
  event: H3Event,
  input: PerfettoRunInput,
  scope: 'run' | 'execution',
  fileName: string,
): Buffer {
  const trace = buildPerfettoTrace(input, {
    scope,
    baseUrl: perfettoBaseUrl(event),
    piwiVersion: perfettoPiwiVersion(),
  });
  const bytes = Buffer.from(JSON.stringify(trace), 'utf-8');

  setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8');
  setResponseHeader(event, 'Content-Length', String(bytes.length));
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${sanitizeFilename(fileName)}"`);
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return bytes;
}
