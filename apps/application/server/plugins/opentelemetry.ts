import type { Tracer } from '@opentelemetry/api';
import { appendResponseHeader } from 'h3';
import { isOtelTracingEnabled, startOtelTracing, stopOtelTracing } from '../utils/otel';

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

  const handle = nitroApp.h3App.handler;

  nitroApp.h3App.handler = (event) => {
    const path = event.path.split('?')[0] ?? event.path;
    if (!otel || path.includes('/_nuxt/')) return handle(event);
    const { context, propagation, SpanKind, SpanStatusCode, trace } = otel.api;

    const active = context.active();
    const nested = trace.getSpan(active) !== undefined;
    const parent = nested ? active : propagation.extract(active, event.node.req.headers);
    const span = otel.tracer.startSpan(
      `${event.method} ${path}`,
      {
        kind: nested ? SpanKind.INTERNAL : SpanKind.SERVER,
        attributes: { 'http.request.method': event.method, 'url.path': path },
      },
      parent,
    );
    if (!nested) {
      const { traceId, spanId, traceFlags } = span.spanContext();
      const flags = traceFlags.toString(16).padStart(2, '0');
      appendResponseHeader(event, 'Server-Timing', `traceparent;desc="00-${traceId}-${spanId}-${flags}"`);
    }

    return context.with(trace.setSpan(parent, span), async () => {
      try {
        return await handle(event);
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        const status = event.node.res.statusCode;
        span.setAttribute('http.response.status_code', status);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
    });
  };
});
