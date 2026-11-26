import type { Tracer } from '@opentelemetry/api';
import { isOtelTracingEnabled, startOtelTracing, stopOtelTracing } from '../utils/otel';

/** `response` with `name: value` added to its headers, copied when its headers cannot change. */
function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.append(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.append(name, value);
    return copy;
  }
}

/**
 * With OpenTelemetry tracing on (`server/utils/otel.ts`), every request runs
 * inside a span of its own, so the SQL statements it issues become that span's
 * children. A request the server makes to itself while rendering a page
 * (`useFetch` during SSR) runs inside an internal span under the page's, and a
 * top-level response names its trace in `Server-Timing: traceparent`, which
 * links a browser's page load (or the performance suite's request) to it.
 * Built assets, and the requests that arrive before the SDK has started, are
 * served without a span.
 */
export default defineNitroPlugin((nitroApp) => {
  if (!isOtelTracingEnabled()) return;

  let otel: { api: typeof import('@opentelemetry/api'); tracer: Tracer } | null = null;
  Promise.all([import('@opentelemetry/api'), startOtelTracing(String(useRuntimeConfig().public.appVersion ?? ''))])
    .then(([api, tracer]) => {
      otel = { api, tracer };
    })
    .catch((error) => {
      console.error('[OpenTelemetry] Tracing could not start:', error);
    });
  nitroApp.hooks.hook('close', () => stopOtelTracing());

  // Every request reaches the app through `fetch`, a page's own requests to the server included, so a span around it
  // covers the middleware, the route, the error handler and the status the response goes out with.
  const handle = nitroApp.fetch;

  nitroApp.fetch = (request) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!otel || path.includes('/_nuxt/')) return handle(request);
    const { context, propagation, SpanKind, SpanStatusCode, trace } = otel.api;

    const active = context.active();
    const nested = trace.getSpan(active) !== undefined;
    const parent = nested ? active : propagation.extract(active, Object.fromEntries(request.headers));
    const span = otel.tracer.startSpan(
      `${request.method} ${path}`,
      {
        kind: nested ? SpanKind.INTERNAL : SpanKind.SERVER,
        attributes: { 'http.request.method': request.method, 'url.path': path },
      },
      parent,
    );

    return context.with(trace.setSpan(parent, span), async () => {
      try {
        const response = await handle(request);
        span.setAttribute('http.response.status_code', response.status);
        if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        if (nested) return response;
        const { traceId, spanId, traceFlags } = span.spanContext();
        const flags = traceFlags.toString(16).padStart(2, '0');
        return withHeader(response, 'Server-Timing', `traceparent;desc="00-${traceId}-${spanId}-${flags}"`);
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  };
});
