## Pair Piwi Picker

[Piwi Picker](https://piwitests.dev/features/extension), the browser extension, works with this editor once paired:

- **Send to editor**: a locator you pick on any page lands at the cursor, or replaces the locator on the line a run
  stopped at.
- **The Runs window** follows the test runs this window starts, and stops and steps them from the browser.

To pair:

1. **Piwi: Pair with Piwi Picker** copies a pairing address, `http://127.0.0.1:<port>/…#<token>`.
2. In Piwi Picker's settings, paste it under **Editor** and click **Pair**.

Every test run Piwi starts gets the pairing too, so a locator picked at one of its stops goes to its line.
[Editor pairing](https://piwitests.dev/features/editor-pairing) has the details.
