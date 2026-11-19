## Pair Piwi Picker

[Piwi Picker](https://piwitests.dev/features/extension), the browser extension, works with this editor once paired:

- **Send to editor**: a locator you pick on any page lands at the cursor, or replaces the locator on the line a run
  stopped at.
- **The Runs window** follows the test runs this window starts, and stops and steps them from the browser.

To pair:

1. In Piwi Picker's settings, under **Editor**, click **Pair**. It finds the editors open on this computer.
2. Here, **Allow** the request once it shows the code Piwi Picker shows.

The **Piwi Picker** view of the Piwi panel shows the pairing, when Piwi Picker was last heard from, and **Unpair**. In
a remote window, or when Piwi Picker does not find this editor, run **Piwi: Copy the pairing address for Piwi Picker**
and paste the address in Piwi Picker's settings, under **Pair with an address**.

Every test run Piwi starts gets the pairing too, so a locator picked at one of its stops goes to its line.
[Editor pairing](https://piwitests.dev/features/editor-pairing) has the details.
