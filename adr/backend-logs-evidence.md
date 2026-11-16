# Backend logs without evidence

- Status: accepted
- Date: 2026-11-16

## Context

[capabilities-opt-out.md](capabilities-opt-out.md) made `backend-logs` applicable only once a server trace had
arrived (§4), so it was hidden everywhere but the Setup ladder until then (D4) and never nudged (D7); `server-probes`
read the same evidence. [PiwiTests/piwi#1482](https://github.com/PiwiTests/piwi/issues/1482) reports an ASP.NET Core
application, instrumented, whose instance read both as *not applicable*. Two facts break the rule:

- **The evidence missed the ASP.NET Core package.** It was a stored request with server spans (`server_traces`, read
  from `X-Piwi-Trace`). The ASP.NET Core package sends that header only on a probe request; its logs come in
  `X-Piwi-Logs`, on every response, an empty list when nothing was logged. Its projects read *not applicable* while
  their logs showed on the execution page, and their server probes could never start: the setting needed a trace that
  only a probe produces.
- **Missing evidence is not a setup without a backend.** An instrumented application sends nothing while its capture is
  off in the environment the suite runs against, after retention removed the requests that carried it, or before a new
  project's first run.

This record supersedes the `backend-logs` paragraph of §4, its example in D4 and the last sentence of D7 of
[capabilities-opt-out.md](capabilities-opt-out.md). Its other decisions stand.

## Decision

| #   | Decision |
| --- | -------- |
| D1  | **Evidence of a backend instrumentation is a stored request carrying its logs or its spans** (`server_logs IS NOT NULL OR server_traces IS NOT NULL`, `shared/handlers/setup-status.ts`). The partial index `idx_nr_instrumented` repeats the condition and replaces `idx_nr_server_traces`, so the probe stays an index read on an instance with no instrumented backend. |
| D2  | **Missing evidence never makes a capability not applicable.** Without evidence, `backend-logs` reads `undecided`, and so does `server-probes` until a project turns the level on (`available`). Their sections, the Setup guide and the assistant's nudge stay. `not-applicable` is kept for a setup Piwi knows cannot use the capability, such as a known stack with no backend package; no detection sets it. |
| D3  | **The Setup ladder says why an installed package sends nothing**: capture is on only in the environments the package is active in, and the reporter reads its headers through the capture fixtures. |
| D4  | **An execution without backend logs, in a project that has them, is "nothing happened"** in the model's data coverage map, not "needs a backend integration". |

## Consequences

- A project with no backend keeps the backend logs and server probes surfaces, with their *Not set up* copy, until it
  declines them (*Not for this project*).
- A project that turns server probes on before any backend evidence gets server items in its probe plan. Without an
  instrumented backend, each records as inconclusive, never as a pass.
- On an instance whose backend is ASP.NET Core, the index holds every instrumented request, as it already did for
  Nitro, whose spans come on every response.
