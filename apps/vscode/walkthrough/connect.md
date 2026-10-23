## Connect to your Piwi instance

A workspace set up for the Piwi reporter needs nothing more: the extension reads `PIWI_DASHBOARD_URL`, `PIWI_API_KEY`
and `PIWI_PROJECT_NAME` from the environment or from the `.env` next to the Playwright config. With none of them, it
uses the Piwi desktop app while it runs.

Otherwise, **Piwi: Connect**:

1. lists the desktop app when it runs, or asks for the instance's address, such as `https://piwi.example.com`;
2. signs you in with the browser, which creates an API key for this editor, or takes a key you paste;
3. asks for the project.

The key is kept in VS Code's secret storage, for that instance only, never in a file. Until the connection works, the
status bar reads **Piwi: connect**.

[Editor connection](https://piwitests.dev/features/editor-connection) has the details.
