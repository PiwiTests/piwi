# The running line of every lane of the developer's own run

**Status.** Proposed 2026-11-15, nothing built. The maintainer chose a proposal before building the rest of LR9 of
[editor-ux-coherence.md](editor-ux-coherence.md): the line of the call each running test of the developer's own run is
at, marked in the editor whether or not someone watches its lane.

**Summary.** The editors mark the line a running test is at only for the lane the editor watches
(`piwi/runningLine`), because the call that line comes from rides on the lane view's call log, which a worker sends only
while its lane is watched. A CI run's positions are marked for every lane. This proposes a small `position` message on
the run channel, sent by each worker as each call of its test starts, which the editor service turns into the running
lines it already sends, for every lane, and which the clients already draw.

## 1. What exists

- **The run channel** (`packages/core/src/run-channel.ts`, MIT, read by the reporter and the editor service): a worker
  says `test-begin` and `test-end`, its stops (`stopped`), and, while its lane is watched (`view-lane` on, and
  `layers` asking `calls`), its call log as `lane-layer` (`LiveCallLog`: the call, its status, its last log lines, its
  point).
- **The editor service** (`ClientLaneView`, `packages/editor/src/client-page-view.ts`) reads the call log of the
  watched lane and sends `piwi/runningLine` (`RunningLine`: run, lane, worker, and the call's test, title and place),
  only when it changes, and null once the test ends or stops, the watch ends or the run does.
- **The clients** draw it: VS Code's running-line decoration (`runControl.runningLines`), JetBrains' inlay
  (`Glue.runningLinesShown`), each mapped through the edits since the run started, one line per lane.

What is missing is the call's place for a lane nobody watches.

## 2. The message

A worker whose `run-attach` lists `positions` in `features`, once the service asks for them (`{ type: 'positions', on:
true }`), sends one message as each call of its running test starts:

```ts
{
  type: "position";
  test: string;
  title: string;
  file: string;
  line: number;
  column: number | null;
}
```

- **`test`** is Playwright's id of the test, as `test-begin` names it; `title` the call's, as the call log titles it;
  `file`, `line` and `column` its place in the user's code, relative to the run's `cwd`, as a stop's `place` is (the
  first frame of the call's stack in a file of the workspace, never `node_modules`).
- **Paced.** At most `POSITIONS_PER_SECOND` (4) per worker; a call that starts and ends between two sends is never told,
  the latest one is. A call with no place in the user's code sends nothing.
- **Cheap.** About 150 bytes, on the local socket the run channel already holds; no frame, no log line, no page text.
- **Off by default on the worker**: the service asks for positions only when a client marks running lines
  (`InitializationOptions.runningLine`), and turns them off when none does.

An older reporter lists no `positions` and sends none: its lanes keep today's behavior, the watched lane alone marked.

## 3. The service and the clients

- The service keeps each worker's latest position while its test runs, and sends `piwi/runningLine` for each lane of a
  run of its own, watched or not, from the call log where a lane is watched (it says more) and from `position` otherwise.
  The rules of `RunningLine` hold: one per lane, null as the test ends or stops, sent only when it changes.
- The clients need nothing new: both already draw one running line per lane, named after its worker.
- A CI run's positions keep their own path (`piwi/ciSessionChanged`).

## 4. Stages

| Stage | Builds                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| S1    | `position` and `positions` in `@piwitests/core/run-channel`, with their parser; the reporter sends them, paced, behind the feature |
| S2    | The editor service asks for positions and sends a running line per lane; `tests/run-lanes.test.ts` covers an unwatched lane        |
| S3    | The docs: the run control page says every running test marks its line; the reporter's changelog names the new message              |

Each stage is a pull request of its own; S1 ships in a reporter release before S2 relies on it, and S2 keeps today's
behavior for a reporter without the feature.

## 5. Open questions

- Whether a run with many workers (16 and more) marks every lane in the editor, or only the lanes of the files open.
- Whether the editors show a running line in a file nobody has open, as a count in the status item.
- Whether `POSITIONS_PER_SECOND` is a fixed rate or follows the editor's frame rate setting.
