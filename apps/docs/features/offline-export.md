---
title: Offline export
description: "Export a failing execution or a whole failure cluster as HTML, ZIP, PDF, Markdown or JSON that opens with no network and no Piwi server, plus a Perfetto trace of a run."
lang: en-US
---

# Offline export

<Needs reporter />

An investigation is only useful while someone can open it. Piwi can write a failing execution or a
whole failure cluster to a file that opens with **no network and no Piwi server** — for a ticket
attachment, a mail to someone without an account, or an archive that outlives your retention window.

The **Export** button sits on a test-case execution (`/test-run-cases/:id`) and on a failure cluster
(`/failure-clusters/:id`). A run (`/test-runs/:id`) and an execution also offer a **Perfetto trace**
(see [below](#perfetto-trace)).

## Formats

| Format | What you get |
|--------|--------------|
| **HTML** | One file. Screenshots and video are embedded as `data:` URIs; error, steps, console, network, ARIA snapshot, test source and the AI diagnosis are all inline. Double-click it. |
| **ZIP** | `report.html` plus the raw artifacts on disk — full-size video, reconstructed `trace.zip` archives, console and network logs — and `data.json` with everything the report shows, machine-readable. |
| **PDF** | A formatted document generated directly — no browser print dialog, so it is identical on the web app, the desktop app and the demo. Screenshots embed; video and trace archives can't live in a PDF, so they're listed as omitted (use ZIP to keep them). |
| **Markdown / JSON** | Text only, for pasting into an issue or feeding an agent. |

A cluster export carries the most recent failing execution of each affected test.

## Replay the failure in a browser

A failed execution's **Export** also offers **Bug report (.piwibug)**: the failure as the
[bug report file](/reference/bug-report-file) Piwi Picker writes, to play in your own browser with
[Replay](./replay-a-bug-report#a-report-made-from-a-test-run). It holds the test's steps up to the failure, the failing
assertion with its expected and received values, the failed requests, the console's errors and the failure
screenshot. The line under it counts the steps, those done by hand and the calls of the test the steps leave out; the
button's tooltip names those calls. **Steps (steps.json)**, under **Copy to clipboard**, copies the steps alone, to
paste into Replay.

## What an export leaves out, and why it tells you

Exports are bounded so one download cannot exhaust the server:

| Variable | Default | Bounds |
|---|---|---|
| `PIWI_EXPORT_MAX_INLINE_BYTES` | 8 MB | What a single HTML file will embed as a `data:` URI. Larger files stay out of the one-file HTML; the ZIP still carries them at full size. |
| `PIWI_EXPORT_MAX_BYTES` | 500 MB | The whole export. Evidence is added in order — each execution's attachments, then its trace archives — and a file that would pass the budget is left out. The archive is built in memory, so this also bounds what one export costs the server. |
| `PIWI_EXPORT_MAX_CASES` | 25 | Member executions carrying full evidence in a cluster export. Remaining affected tests are listed by name. |

Anything left out is listed in an **Omitted from this export** table in the report and in the ZIP's
`README.txt` — an export never drops evidence silently. Defaults and tuning:
[Configuration](/reference/configuration#offline-export).

## Opening a hostile report safely

The exported HTML carries a restrictive `Content-Security-Policy` and escapes every value that came
from a test run, so a report is safe to open even when the failure it describes involved hostile page
content.

## Reading an exported trace

The ZIP carries reconstructed `trace.zip` archives, but reading one still needs a Playwright trace
viewer — `npx playwright show-trace trace.zip`, or the [bundled viewer](./evidence#trace-viewer) on any
Piwi instance. Bundling the viewer's assets into the export itself is on the
[roadmap](https://github.com/PiwiTests/platform/blob/main/ROADMAP.md).

## Perfetto trace

A run and an execution also export as a **Perfetto trace** — a [Trace Event Format](https://perfetto.dev/docs/getting-started/other-formats) JSON file that opens the run on a timeline in
[ui.perfetto.dev](https://ui.perfetto.dev) or Chrome's `chrome://tracing`, with no Piwi server needed.

The file lays the run out the way it ran: **one process per shard, one thread per worker**. Each
execution is a slice on its worker's thread, with its hooks, fixtures and steps nested underneath by
start time, and a slice colored by outcome (green passed, red failed). A failing execution adds an
instant marker at the moment it failed. Every slice carries its details in the event arguments —
source location, step params, tags, locks, annotations, status, error message, and links back to the
execution and its attachments on the dashboard. Suite-level `beforeAll`/`afterAll` setup steps appear
on their worker's thread too.

Open it by dragging the downloaded `.json` onto [ui.perfetto.dev](https://ui.perfetto.dev), or use
**Open trace file** there. Timestamps are relative to the first event, so a run always starts at zero.

The trace **does not embed the attachments themselves** — screenshots, video and trace archives are
referenced by their dashboard URL, so following those links needs the Piwi instance the run came from.
For a self-contained snapshot of one failure, use the HTML or ZIP export above.

## Related
- [Share links](./share-links) — the live counterpart: a revocable read-only URL instead of a file
- [Failure evidence](./evidence) — what the export is a snapshot of
- [AI diagnosis](./ai-diagnosis): cluster exports carry the diagnosis too
- [Storage & retention](/operate/storage#data-retention): retention, and why an export outlives it
