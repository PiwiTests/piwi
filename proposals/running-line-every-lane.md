# The running line of every lane of the developer's own run

**Status.** Proposed 2026-11-15. S1 built: the `positions` feature and the `position` message in
`@piwitests/core/run-channel`, and the reporter sending them from `watchCalls`, paced; nothing asks for them yet. S2
to S4 remain. The maintainer chose a proposal before building the rest of LR9 of
[editor-ux-coherence.md](editor-ux-coherence.md): the line of the call each running test of the developer's own run is
at, marked in the editor whether or not someone watches its lane.

**Summary.** Today the editors mark the running line of one lane: the one the editor watches. The call that line comes
from rides on the lane view's call log, which a worker sends only while its lane is watched, and both the service and
the JetBrains plugin keep a single line. A CI run's positions are marked for every lane. This proposes a small
`position` message on the run channel, sent by each worker as each call of its test starts, which the editor service
turns into one running line per lane, and the clients changes that drawing every lane needs. It works where the
capture fixtures run, as the call log does.

## 1. What exists

- **The run channel** (`packages/core/src/run-channel.ts`, MIT, bundled into the reporter and the editor service): a
  worker says `test-begin` (`testId`) and `test-end`, its stops (`stopped`, with a `Place`: `file`, `line`, optional
  `column`), and, while its lane is watched (`view-lane` on, `layers` asking `calls`), its call log as `lane-layer`
  (`LiveCallLog`).
- **The reporter** already hears each call as it begins (`watchCalls`, `packages/reporter/src/internal/capture/run-events.ts`,
  through Playwright's `_instrumentation`), titles it with its credentials and typed text hidden (`callTitle`), and
  finds its place in the user's code (`callPlace`: the first frame under `cwd`, never `node_modules`). Today it tells a
  call only as it ends, as a run event an agent asks for (`events`).
- **The editor service** (`ClientLaneView`, `packages/editor/src/client-page-view.ts`) keeps one running line, the
  watched lane's, from its call log, and clears it before telling another lane's; `RunningLine` and
  `InitializationOptions.runningLine` (`packages/editor/src/protocol.ts`) say "the lane the editor watches".
- **The clients**: VS Code keeps a line per lane it hears (`RunningLines`, `apps/vscode/src/run-control.ts`) and redraws
  the visible editors on each change; the JetBrains plugin draws only the watched lane's (`PiwiRunControl.kt`
  `runningLine`, cleared by `stopLaneView`, and `Glue.runningLinesShown`).

## 2. The message

A worker whose `run-attach` lists `positions` in `features`, once the service asks for them (`{ type: 'positions', on:
true }`), sends one message as each call of its running test begins, from the listener `watchCalls` already adds:

```ts
{
  type: "position";
  testId: string;
  title: string;
  place: Place;
}
```

- **`testId`** is Playwright's id of the test, as `test-begin` names it; `title` is `callTitle`'s, its credentials and
  typed text hidden as every call's; `place` is `callPlace`'s, as a stop's. A call with no place in the user's code
  sends nothing, and the line stays where the test's last placed call was until the test ends or stops.
- **Paced**: at most `POSITIONS_PER_SECOND` (4) per worker, the latest call begun in each quarter second sent at its
  end (a trailing send), a call already ended included: it is where the test last was.
- **Only to the editor**: positions go to the service on the run channel, never into the run events an agent reads or
  the instance's live stream.
- **The source of truth for a watched lane** stays its call log, which says more; the service takes a lane's position
  only while its call log is off.

An older reporter lists no `positions` and sends none: its lanes keep today's behavior. An older service never asks.

## 3. The service

- One running line per lane of a run the editor follows (`RunSessions`: a run it started, one of a terminal that
  connects, one of the editor's test runner), a checkout's or an unattended run's left out.
- A lane's line goes as its test ends, stops (the stop has its own mark), or its worker leaves; a retry's first call
  sets it again.
- `ClientLaneView`'s single line becomes a tracker per lane (`RunningLines` in the service), and the protocol's
  `RunningLine` and `InitializationOptions.runningLine` say "each lane" where they say "the lane the editor watches".
- **Pace to the client**: the lines of every lane are sent together at most every 250 ms, so 16 workers make four
  notifications a second, not 64.
- **A switch**: `piwi.runningLines` (`all`, `watched`, `off`), registered in the settings registry, as
  `piwi.ciPositions` is for CI runs; `watched` keeps today's behavior.

## 4. The clients

- **VS Code** draws every lane's line already; the change is the setting, and one redraw for a burst of lines rather
  than one per line.
- **The JetBrains plugin** keeps a line per lane rather than the watched lane's alone (`runningLine`, `stopLaneView`,
  `Glue.runningLinesShown`), each named after its worker as today.
- **Two lanes on one line** show once, naming both workers (`Worker 2, Worker 4`), in both editors.

## 5. Stages

| Stage | Builds                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1    | `position` and `positions` in `@piwitests/core/run-channel`, with their parser and tests; the reporter sends them from `watchCalls`, paced                         |
| S2    | The editor service: a running line per lane, paced to the client, the setting, the protocol's words; `tests/run-lanes.test.ts` covers an unwatched lane and a stop |
| S3    | The JetBrains plugin's line per lane and two lanes on one line; VS Code's single redraw per burst                                                                  |
| S4    | The docs: the run control page says every running test marks its line, and the setting                                                                             |

S1 and S2 can ship together: core is bundled into both, and S2 keeps today's behavior for a reporter without the
feature. S3 follows S2, since a client that draws every lane is useless before the service sends them.

## 6. Open questions

- Whether a run with many workers (16 and more) marks every lane, or only the lanes of the files open.
- Whether a `test.step` with a location moves the line, as an API call does.
- Whether `all` or `watched` is the default.
