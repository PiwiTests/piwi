# German glossary

The words the German catalog uses for the terms that come back everywhere. This catalog is a draft: a native reader
has not reviewed it yet. The tone is the one of `store/amo-description.de.md`: plain sentences, `Sie`, and the
English words German developers use every day (Locator, Test-ID, Page Object, Branch, Screenshot) where a German
word would be less clear. German is the longest of the languages: of two equally clear wordings, take the shorter,
above all on popup tiles, buttons and badges.

| English | German | Notes |
| --- | --- | --- |
| locator | Locator (maskulin) | `der Locator`, `die Locators`; never *Selektor*, which is a CSS selector |
| locator index | Locator-Index | |
| selector (CSS) | Selektor | only for CSS or XPath selectors: `CSS-Selektor` |
| test id | Test-ID (feminin) | `die Test-ID`; the value itself is code, kept as it is |
| run | Lauf | `im letzten Lauf` |
| flaky | instabil | |
| passed / failed | bestanden / fehlgeschlagen | `ein fehlschlagender Test`, `schlägt fehl` |
| step | Schritt | |
| assertion | Assertion (feminin) | `die Assertion`, `die Assertions` |
| page object | Page Object (neutrum) | as German developers say it |
| helper function | Hilfsfunktion | |
| test function | Testfunktion | |
| recording / to record | Aufzeichnung / aufzeichnen | the recorder is *der Recorder* |
| bug report | Bug-Report | *der Bericht* when the sentence already says which one |
| to report a bug | einen Bug melden | |
| to replay | abspielen | `einen Bug-Report abspielen`, `erneut abspielen` |
| screenshot | Screenshot (maskulin) | |
| tested elements | getestete Elemente | the tool's name, capitalized as a title: *Getestete Elemente* |
| URL pattern | Adressmuster | the settings section's name, in the plural: *Adressmuster* |
| branch | Branch (maskulin) | `der Branch`, `die Branches` |
| instance (Piwi) | Instanz | `Ihre Piwi-Instanz` |
| API key | API-Schlüssel | |
| settings | Einstellungen | the gear button and the settings page |
| dashboard | Dashboard | `das Piwi-Dashboard` |
| popup | dieses Menü | when a text must name it; mostly avoided |
| background worker | Hintergrundprozess | |
| tab (browser) | Tab (maskulin) | `der Tab`, `in diesem Tab` |
| site / web page | Website / Webseite | the whole site / one page of it |
| to pick (an element) | wählen, auswählen | |
| to hover | mit der Maus zeigen | the tool says *unter der Maus* |
| strict mode | Strict Mode | Playwright's term, kept |
| brittle | fragil | `ein fragiler Locator` |
| watch (a locator's stability level) | zu beobachten | the level between stable and brittle, *Watch* in the dashboard |
| to act on (an element) | bedienen | `von Tests bedient`, for click, fill and the other actions |
| to check (an assertion) | prüfen | `nur geprüft`; *aktivieren* is for a checkbox |
| enabled / disabled (state) | nutzbar / ausgegraut | as the bug panel says it; *aktivieren* / *deaktivieren* check and uncheck a checkbox |
| hidden | ausgeblendet | |
| badge | Badge | |
| evidence (bug report) | Belege | |
| page outline | Seitenstruktur | |
| team instance | Team-Instanz (feminin) | `Ihre Team-Instanz`, the Piwi instance a team shares |
| run request | Laufanfrage | a team instance asking to run tests on this machine; *die Anfrage* once the sentence says which one |
| to run (tests) | ausführen | the Run button is *Ausführen*; the run itself is *Lauf* |
| linked folder | verknüpfter Ordner | `der verknüpfte Ordner`; to link is *verknüpfen*, to unlink *Verknüpfung lösen* |
| this machine | dieser Rechner | `auf diesem Rechner`; *Computer* where the English says computer |
| tray (system tray) | Infobereich | `im Infobereich`, for the macOS menu bar too |
| local host (Runner's server) | lokaler Server | `der lokale Server`; never *Host* |
| stop (a test at a breakpoint) | Halt (maskulin) | `an diesem Halt`; a stopped test is *angehalten*; *stoppen* only ends a whole run |
| breakpoint | Haltepunkt | |
| worker (Playwright) | Worker (maskulin) | `der Worker`, `die Worker` |
| live view / to share live | Live-Ansicht / live teilen | the button that ends it is *Teilen beenden* |
| update (of an app) | Update / aktualisieren | `Nach Updates suchen…`, `Aktualisieren Sie sie` |

## Tool names

As the popup shows them; the panels, the store description and the phrasebook use the same names.

| English | German |
| --- | --- |
| Pick an element | Element wählen |
| Hover-inspect | Untersuchen |
| Locator console | Konsole |
| Multi-pick | Mehrfachauswahl |
| Lint overlay | Prüfung |
| Assertions | Assertions |
| Session | Session |
| Agent context | KI-Kontext |
| Test functions | Testfunktionen |
| Record | Aufzeichnen |
| Replay | Abspielen |
| Check an element | Element prüfen |
| Tested elements | Getestete Elemente |

## Typography

- `„…“` around a quoted text (low-9 opening mark, left double quotation mark closing), with no space inside.
- No space before `:`, `;`, `!` or `?`. After a colon, a full sentence starts with a capital letter (`… nicht
  erreichen: Prüfen Sie die Adresse`); a fragment does not.
- A no-break space (U+00A0) between a number and `%`: `42 %`.
- Numbers use `.` for thousands and `,` for decimals (`1.234`); the code formats them.
- `…` rather than three dots; `z. B.` with a space.
- Nouns are capitalized, compounds are written as one word or with a hyphen (`Locator-Index`, `API-Schlüssel`,
  `Piwi-Instanz`), never as two separate words.
