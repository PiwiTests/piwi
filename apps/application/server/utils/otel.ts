/**
 * OpenTelemetry tracing. Off unless an OTLP endpoint is configured through the
 * standard `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 * variable, and `OTEL_SDK_DISABLED` is not `true`. When on, every request gets a
 * span (`server/plugins/opentelemetry.ts`) and every SQL statement a child span
 * of the request it ran for (`@kubiks/otel-drizzle`), sent over OTLP/HTTP to
 * that endpoint only. The exporter, the batch processor and the sampler read the
 * other standard `OTEL_*` variables themselves.
 */
import type { Tracer } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/** The longest statement text a query span carries; Drizzle's widest selects run past the library's 1000. */
const MAX_STATEMENT_LENGTH = 8000;

/** Whether tracing is configured for this process. */
export function isOtelTracingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return false;
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim());
}

let provider: NodeTracerProvider | null = null;

/**
 * Register the global tracer provider: spans are batched and exported over
 * OTLP/HTTP, and the active span follows the async context of each request.
 * The SDK loads only here, so an instance that does not trace never imports it.
 * Resolves to the tracer requests are traced with — taken from the provider
 * itself, since the server bundle holds its own copy of `@opentelemetry/api`
 * beside the one the SDK registers with.
 */
export async function startOtelTracing(serviceVersion: string): Promise<Tracer> {
  if (provider) return provider.getTracer('piwi');
  const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, resources] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
  ]);
  const resource = resources
    .defaultResource()
    .merge(resources.resourceFromAttributes({ 'service.name': 'piwi', 'service.version': serviceVersion }))
    .merge(resources.detectResources({ detectors: [resources.envDetector] }));
  provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  return provider.getTracer('piwi');
}

/** Export the spans still queued and stop tracing. */
export async function stopOtelTracing(): Promise<void> {
  const current = provider;
  provider = null;
  await current?.shutdown();
}

/**
 * Give every SQL statement a span. PostgreSQL is traced at Drizzle's session,
 * transactions included; SQLite at the libSQL client's `execute`, which every
 * statement outside a transaction goes through.
 */
export async function traceSqlStatements(dialect: 'sqlite' | 'postgres', db: object, client: object): Promise<void> {
  const { instrumentDrizzle, instrumentDrizzleClient } = await import('@kubiks/otel-drizzle');
  if (dialect === 'postgres') {
    instrumentDrizzleClient(db as Parameters<typeof instrumentDrizzleClient>[0], {
      dbSystem: 'postgresql',
      maxQueryTextLength: MAX_STATEMENT_LENGTH,
    });
  } else {
    instrumentDrizzle(client as Parameters<typeof instrumentDrizzle>[0], {
      dbSystem: 'sqlite',
      maxQueryTextLength: MAX_STATEMENT_LENGTH,
    });
  }
}
