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
| D1  | **Evidence of a backend instrumentation is a stored request carrying its logs or its spans** (`server_logs IS NOT NULL OR server_traces IS NOT NULL`, `shared/handlers/setup-status.ts`). The partial index `idx_nr_instrumented` repeats the condition and replaces `idx_nr_server_traces`. A project's probe starts from its runs and looks each one up in the index, so a project without evidence never reads the other projects' requests, which on an ASP.NET Core or Nitro instance nearly all match. |
| D2  | **Missing evidence never makes a capability not applicable.** Without evidence, `backend-logs` reads `undecided`, and so does `server-probes` until a project turns the level on (`available`). Their sections, the Setup guide and the assistant's nudge stay. `not-applicable` is kept for a setup Piwi knows cannot use the capability, such as a known stack with no backend package; no detection sets it. |
| D3  | **Server faults are planned only once a backend instrumentation answered a request of the project** (`backend-logs` active), whatever the `server-probes` state: elsewhere none can apply, and each would take half of the probe budget to record as inconclusive. |
| D4  | **A server probe is evidence only once the backend applied it** (`probes.applied`). One it did not apply records as inconclusive and leaves `server-probes` to its decision, so a decline holds. |
| D5  | **The Setup ladder says why an installed package sends nothing**: capture is on only in the environments the package is active in, and the reporter reads its headers through the capture fixtures. |
| D6  | **The model's data coverage map reads an execution's own requests**: with one carrying a backend header and no logs, the backend answered and logged nothing; with none, the execution needs a backend integration, whatever the project's other executions show. |

## Consequences

- A project with no backend keeps the backend logs and server probes surfaces, with their *Not set up* copy, until it
  declines them (*Not for this project*). Declining backend logs does not decline server probes: each is decided on
  its own.
- A project that turns server probes on before any backend evidence gets the client plan only, until a run records a
  request the instrumentation answered.
- On an instance whose backend is ASP.NET Core, the index holds every instrumented request, as it already did for
  Nitro, whose spans come on every response. The migration builds it at startup, over the whole table.
