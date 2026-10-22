## See the failures of the latest CI run

The **Failures** view, in the Piwi panel, lists the failures of the latest CI run on your branch, else on the default
branch. Your local runs since are laid over them: a test you fixed is checked, one your run broke joins the list.

- Click a failure to open the line it failed at. Its buttons run the test, open the trace and open it in the dashboard.
- **Group the failures by…** groups them by file, cluster, owner, or not at all.
- **Compare with…** reads them against another branch, a run by its id, or your local runs only.

Each failure is also in the Problems panel at that line, with the heal as a quick fix when Piwi has one. The status bar
counts the tests still failing.
