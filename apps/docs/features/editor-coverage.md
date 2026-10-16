---
title: Coverage in the editor
description: "The lines your tests ran, marked in VS Code and the JetBrains IDEs, Rider included: the lines run and not run, the tests behind each function and line, and the lines changed since the coverage run."
lang: en-US
---

# Coverage in the editor

<Needs reporter fixtures backend />

With [coverage](/guide/concepts#coverage) recorded, the [editor extensions](./editors) mark the lines of an
application file your tests ran, the executable lines no test runs, and the lines you changed since, in VS Code and in
the JetBrains IDEs, Rider included. A lens above each function names the tests that ran it and runs them; the hover on
a line lists them.

## Turn it on

The marks show what the reporter records, per test:

- **Server code**: an ASP.NET Core backend built for coverage, with the reporter's `coverage.server` set to `lines`, or
  `PIWI_COVERAGE_SERVER=lines`: [Server coverage](./server-coverage) has the steps. With `functions`,
  every line of a function that ran is marked run, and no line is marked as not run.
- **Browser code**: recorded per file ([code reach](./code-reach#turn-it-on)), so such a file lists its tests in its
  top lens, with no line marks; with `coverage.browser: 'functions'`, every line of a function that ran is marked run,
  with its lens above it. No line of a browser file is marked as not run.

Nothing else is needed in the editor. A test file, a file no recorded coverage names lines of, and a project without
coverage show nothing of it: no mark, no lens line, no command, no hover text.

The editor asks the instance for a file's coverage when you open it, and, when the project's code reach can tell, only
for a file it says coverage recorded. It asks again on a refresh and when a run ends, naming the answer it holds, which
the instance confirms unchanged without sending it again. Typing asks nothing: the marks are placed on your edits
locally.

## The marks

| Mark | Meaning |
|---|---|
| Solid, teal | A test ran the line. The hover names the tests. |
| Solid, slate | The line is executable and no test runs it. Shown when the run recorded the file's executable lines, which `lines` does. |
| Dashed, amber | The line changed since the coverage run: what runs it is not known until a run records it again. |

Teal and slate are the colors the dashboard marks a file's source in. The hover on a marked line ends by saying what
the marks mean.

In VS Code the marks are a bar at the left edge of each line, in `piwi.coverageRunBorder`, `piwi.coverageNotRunBorder`
and `piwi.coverageChangedBorder`, which a theme or `workbench.colorCustomizations` can restyle; the lines no test runs
and the changed lines also show in the overview ruler. In a JetBrains IDE they are at the left of the gutter and in the
scroll bar, and hovering either shows what the lines are and what the marks mean. Restyle them under **Settings →
Editor → Color Scheme → Piwi → Coverage**, where the error stripe color is the mark's, and a background, none by
default, tints the lines too.

## Changed since the coverage run

Coverage names the lines of one version of a file, by its git blob id, the id `git hash-object` gives the file as the
test ran it. Your file may be another version: edited since, or the coverage may come from a CI run on an older commit.
The marks come from, in order:

1. **The version that is your file as it stands**, saved or not, whatever its line endings and byte order mark: its
   marks are exact.
2. **The version your file was saved as**, when you edited it since.
3. **The version the most tests recorded that your repository holds** (`git cat-file`).

From the second and the third, the lines are placed on your file through the diff between the two, as
[failures follow your edits](./editor-runs#failures-follow-your-edits): a line moved by the edits above it keeps its
mark on its new line; a line the diff adds or rewrites is marked changed since the coverage run, not guessed; a line it
removes loses its mark. Blank lines are never marked changed.

When your repository holds none of the versions, such as a commit you have not fetched, no line is marked and the
file's lens says `coverage recorded on another version`. Fetching it brings the marks back on the next refresh.

## Lenses and hover

- **Top of the file**: `Reached by 6 tests · 1 failing · 41 of 63 lines run · 3 lines changed since the coverage run`.
  The tests are those code reach and the coverage name; the line counts show when the run recorded the executable
  lines. A click runs those tests.
- **Above each function a test ran**: `Reached by 2 tests · 1 failing`, the tests that ran it. A click runs them,
  as [Runs from the editor](./editor-runs#run-tests) describes.
- **Hover**: on a line tests ran, each test with its latest result and a link to its page in the dashboard; on a line
  no test runs, `no test runs this line`; on a changed line, that it changed since the coverage run.

## Refresh the marks with a local run

A run started from a lens of a server file records the backend's coverage by line: the editor adds
`PIWI_COVERAGE_SERVER=lines` to the run's environment, which the reporter reads when your Playwright config leaves
`coverage.server` unset. The backend the run calls must be the coverage build, as for any run that records server
coverage. From a browser file's lens, the run records the browser's coverage by function instead
(`PIWI_COVERAGE_BROWSER=functions`). When the run ends, the editor reads the file's coverage again, and the marks show what your run recorded:
exactly, as long as the file is as you saved it for the run, since the reporter takes blob ids from the files on disk.

A run started anywhere else (a test's lens, the failures view, a selection) changes nothing of your config's coverage
options.

## Show or hide the marks

| Editor | Command |
|---|---|
| VS Code | **Piwi: Toggle the coverage marks** |
| JetBrains IDE | **Tools → Piwi → Show Coverage Marks** |

The command shows up once a file showed marks. The marks are shown by default; the choice is kept for the workspace in
VS Code and in `.idea/workspace.xml` in a JetBrains IDE, on your machine only. The lenses and the hover stay.

## C# and Razor files

Both extensions read `.cs`, `.cshtml` and `.razor` files, so an ASP.NET Core project's services, controllers and views
show their marks and lenses as any application file does. The JetBrains plugin is checked on Rider; it starts once it
finds a Playwright config in the solution's folder or its Git repository.

## Limits

- **Lines for server code only.** Browser code is recorded per file or per function; recorded per function, a function
  that ran marks all its lines run, the branches it skipped included.
- **The latest coverage of each test**: on your branch where its tests ran with coverage, else on the default branch.
- **API calls** through Playwright's `request` fixture keep their last response's server coverage only
  ([Server coverage](./server-coverage#limits)).
- An instance without coverage shows nothing, and is asked again only on a refresh.

## Related

- [Code reach](./code-reach): turning coverage on, and what it records
- [Editor extensions](./editors): what else the editors show
- [Runs from the editor](./editor-runs): running the tests a lens names
- [Uncovered changes](./uncovered-changes): the changed files no test reaches, on a pull request
