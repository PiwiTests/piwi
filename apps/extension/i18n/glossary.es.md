# Spanish glossary

The words the Spanish catalog uses for the terms that come back everywhere. One Spanish serves Spain and Latin America
(the `es` catalog also answers browsers set to `es_419`), so it avoids words that belong to one region: *hacer clic*,
*archivo*, *pantalla*, *pestaña*, and no *ordenador* or *computadora*. The reader is addressed with `tú`, as Google's and
Mozilla's Spanish do; the tone is the one of `store/amo-description.es.md`: plain sentences, no anglicism where a
Spanish word is as clear. This catalog is a draft until a native reader reviews it.

| English | Spanish | Notes |
| --- | --- | --- |
| locator | locator (masculino) | `el locator`, `los locators`; never *selector*, which is a CSS selector |
| locator index | índice de locators | |
| selector (CSS) | selector | only for CSS or XPath selectors |
| test id | test id | code, kept as it is |
| test | prueba | `una prueba de Playwright`, `la prueba que falla` |
| run | ejecución | |
| flaky | inestable | |
| passed / failed | superada / fallida | about a test (`prueba`, feminine); `una prueba que falla` for a failing test |
| step | paso | |
| assertion | aserción | |
| page object | page object | as Spanish-speaking developers say it |
| helper function | función auxiliar | |
| test function | función de prueba | feminine: `lista para usar`, `encontrada en parte` |
| recording / to record | grabación / grabar | |
| bug | bug (masculino) | `el bug`, `los bugs`; not *error*, which the report uses for console errors |
| bug report | informe de bug | |
| to report (a bug) | notificar | |
| to replay | reproducir | `Reproducido` / `No reproducido` for the verdict |
| screenshot | captura de pantalla | `hacer una captura de pantalla` |
| tested elements | elementos probados | the tool's name, capitalized as a title: *Elementos probados* |
| URL pattern | patrón de dirección | the settings section's name, in the plural: *Patrones de dirección* |
| branch | rama | `rama predeterminada` |
| instance (Piwi) | instancia | `tu instancia de Piwi` |
| API key | clave de API | |
| settings | configuración | the gear button and the settings page, as Chrome's Spanish says |
| dashboard | panel de control | |
| panel (of a tool) | panel | |
| popup | este menú | when a text must name it; mostly avoided |
| background worker | proceso en segundo plano | |
| to pick (an element) | elegir | |
| to hover | pasar el puntero | |
| to click | hacer clic (en) | |
| to type, to fill | escribir | |
| badge (on a box) | insignia | the toolbar badge's texts are `REC`, `BUG`, `REPR` |
| hidden / visible | oculto / visible | states agree with the noun: `oculto`, `oculta` |
| enabled / disabled | habilitado / deshabilitado | in the report's own words, `disponible` / `atenuado` |
| brittle | frágil | a brittle locator `puede fallar` |
| watch (a locator's stability level) | a vigilar | the level between stable and brittle, *Watch* in the dashboard |

## The tools' names

The popup, the panels, the store description and the phrasebook use these names.

| Key | English | Spanish |
| --- | --- | --- |
| `popup_pick` | Pick an element | Elegir un elemento |
| `popup_hoverInspect` | Hover-inspect | Inspeccionar |
| `popup_locatorConsole` | Locator console | Consola |
| `popup_multiPick` | Multi-pick | Multiselección |
| `popup_lint` | Lint overlay | Revisión |
| `popup_assertions` | Assertions | Aserciones |
| `popup_session` | Session | Sesión |
| `popup_agentContext` | Agent context | Contexto para IA |
| `popup_testFunctions` | Test functions | Funciones de prueba |
| `popup_record` | Record actions | Grabar acciones |
| `popup_reportBug` | Report a bug | Notificar un bug |
| `popup_replayBug` | Replay a bug report | Reproducir un informe de bug |
| `popup_testedElements` | Tested elements | Elementos probados |

## Typography

- `«…»` around a quoted page text, with no space inside: `el botón «Apply coupon»`.
- No space before `:`, `;`, `!` or `?`; a question or an exclamation also opens with `¿` or `¡`.
- A no-break space (U+00A0) between a number and its unit or `%`: `hace 3 min`, `40 %`, as the RAE writes them.
- `…` rather than three dots.
- Buttons and titles take a capital only on their first word: *Copiar el informe*, *Paso siguiente*.
- Steps of a bug report start with an infinitive, the article agreeing with the noun: *Hacer clic en el botón
  «Apply coupon»*, *Escribir «SPRING10» en el campo de texto «Coupon»*, *Marcar la casilla «I agree»*.
