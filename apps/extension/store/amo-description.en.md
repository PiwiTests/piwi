Piwi Picker gives you the Playwright locator to use for any element of the page you are on. Every candidate is scored for stability, then run against the live page, so the one at the top finds exactly one element. Click through a flow and it writes the test; reproduce a bug and it writes the failing test and the report.

**From the toolbar popup, on any page**

- **Pick an element**: the ranked locators of one element, re-checked against the page, copied as a locator, an action line or an assertion. When several elements share a name, scope the locator to a stable parent.
- **Record actions**: clicks, fills and choices across a site's pages, turned into a runnable TypeScript spec. Passwords are never captured.
- **Report a bug**: record the steps, mark what is wrong on the page, and get a failing test, a Markdown report and a .piwibug file with the console errors and the failed requests. **Replay a bug report** plays its steps again in a tab.
- **Lint overlay**: the elements no stable locator finds alone, each with a suggested data-testid.
- **Multi-pick**, **Assertions** and **Agent context**: the pattern shared by a list's rows, expect(...) lines for an element, and one block about an element for a coding agent.

**In the browser's DevTools**

The ranked locators of the element selected in Elements, a locator console with a strict-mode verdict, the elements you name exported as a page object, network mocks, a request slowed down or failed, a Playwright project's viewport, and Save login for tests.

**Private by default**

Picking and recording never use the network. Nothing is collected, nothing is sent anywhere.

**Optional: connect your own Piwi instance**

Piwi is a self-hosted dashboard for Playwright results. Connected to your instance (its address and an API key, in the settings), the add-on also outlines the elements of the page your tests reach, says which of your test functions work on it, and records flows as calls to those functions. It reads from your instance and sends it one thing: a bug report, when you click Send in the preview that shows exactly what goes.

**Permissions**

- The tab you are looking at, only when you click the toolbar button or press the shortcut.
- One site, asked for when you start recording on it, so the recorder can follow you across its pages. Nothing is granted at install.
- That site's cookies, asked for only when you save its login for your tests: they go into a file on your machine.
- Your Piwi instance's address, asked for when you save a connection.

Piwi Picker speaks English, French, German, Spanish and Brazilian Portuguese.

Documentation: [piwitests.dev/features/extension](https://piwitests.dev/features/extension)

Piwi is not affiliated with, endorsed by, or connected to Microsoft Corporation. Playwright is a trademark of Microsoft Corporation.
