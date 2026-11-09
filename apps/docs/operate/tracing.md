---
title: Tracing with OpenTelemetry
description: "Send a trace of every request Piwi serves, with each SQL statement it ran, to an OpenTelemetry collector you run."
lang: en-US
---

# Tracing with OpenTelemetry

Piwi can send a trace of each request it serves to an OpenTelemetry collector: one span per request, one per request
the server makes to itself while it renders a page, and one per SQL statement, with its text. When a page is slow, the
trace names the statements that made it slow and the data call that ran them.

Tracing is **off by default**. It starts when you name a collector, and traces go to that endpoint only, so it does
not change the "zero telemetry" promise.

## Turning it on

Point the standard OTLP variable at your collector's OTLP/HTTP endpoint, in the environment of the Piwi container or
your `.env` file:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

Piwi exports OTLP over HTTP, as JSON. The other standard variables apply as the OpenTelemetry SDK defines them:

| Variable                                                    | Use                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                        | The traces endpoint alone, in place of `OTEL_EXPORTER_OTLP_ENDPOINT`    |
| `OTEL_EXPORTER_OTLP_HEADERS`                                | Headers for the collector, such as an API key (`x-api-key=…`)           |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`             | How the traces are labeled; the service is `piwi` by default            |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`            | Keep a share of the traces: `parentbased_traceidratio` and `0.1` keep 10 % |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_QUEUE_SIZE`        | How spans are batched before they are sent                              |
| `OTEL_SDK_DISABLED`                                         | `true` turns tracing off again                                          |

## What a trace holds

- **A span per request**, named after its method and path (`GET /projects/12`), with its status code. A request that
  arrives with a `traceparent` header continues that trace.
- **An internal span per request the server makes to itself** while rendering a page, one per data call, under the
  page's span, so a slow page shows which of its data calls is slow.
- **A span per SQL statement**, with the statement as Drizzle sent it (`db.statement`, parameters as placeholders,
  never their values). PostgreSQL traces every statement, transactions included; SQLite every statement outside a
  transaction.

Each page response names its trace in a `Server-Timing: traceparent` header, which the browser's developer tools show
beside the request.

## Looking at traces on your machine

Jaeger accepts OTLP and shows traces in the browser:

```bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

Start Piwi with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and open `http://localhost:16686`.

## Related

- [Metrics and rollup export](./metrics): the numbers Piwi serves to Prometheus
- [Deployment](./deployment): where the variables are set
- [Configuration reference](/reference/configuration): every variable Piwi reads
