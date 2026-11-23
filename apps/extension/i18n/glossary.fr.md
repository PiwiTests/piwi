# French glossary

The words the French catalog uses for the terms that come back everywhere. They follow the dashboard's French
(`apps/application/shared/reports/sentences.fr.ts`), so a French team reads the same word in both. The tone is the
one of `store/amo-description.fr.md`: plain sentences, `vous`, no anglicism where a French word is as clear.

| English                             | French                       | Notes                                                                    |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| locator                             | locator (masculin)           | `un locator`, `des locators`; never _sélecteur_, which is a CSS selector |
| locator index                       | index de locators            |                                                                          |
| selector (CSS)                      | sélecteur                    | only for CSS or XPath selectors                                          |
| test id                             | test id                      | code, kept as it is                                                      |
| run                                 | exécution                    |                                                                          |
| flaky                               | instable                     |                                                                          |
| passed / failed                     | réussi / en échec            | `un test en échec`                                                       |
| step                                | étape                        |                                                                          |
| assertion                           | assertion                    |                                                                          |
| page object                         | page object                  | as French developers say it                                              |
| helper function                     | fonction d’aide              |                                                                          |
| test function                       | fonction de test             |                                                                          |
| recording / to record               | enregistrement / enregistrer |                                                                          |
| bug report                          | rapport de bug               |                                                                          |
| to replay                           | rejouer                      |                                                                          |
| screenshot                          | capture d’écran              |                                                                          |
| tested elements                     | éléments testés              | the tool's name, capitalized as a title: _Éléments testés_               |
| URL pattern                         | motif d’adresse              | the settings section's name, in the plural: _Motifs d’adresse_           |
| watch (a locator's stability level) | à surveiller                 | the level between stable and brittle, _Watch_ in the dashboard           |
| branch                              | branche                      |                                                                          |
| instance (Piwi)                     | instance                     | `votre instance Piwi`                                                    |
| API key                             | clé d’API                    |                                                                          |
| settings                            | réglages                     | the gear button and the settings page                                    |
| dashboard                           | tableau de bord              |                                                                          |
| popup                               | ce menu                      | when a text must name it; mostly avoided                                 |
| background worker                   | processus d’arrière-plan     |                                                                          |
| to pick (an element)                | choisir                      |                                                                          |
| to hover                            | survoler                     |                                                                          |
| badge                               | badge                        |                                                                          |
| team instance                       | instance d’équipe            | the instance whose pages send Piwi Runner its run requests               |
| run request                         | demande d’exécution          |                                                                          |
| linked folder                       | dossier lié                  | to link, to unlink: _lier_, _dissocier_                                  |
| to pair / paired                    | associer / associé           | to unpair is _dissocier_; the pairing is _l’association_                 |
| worker (Playwright)                 | worker (masculin)            | `un worker`, `des workers`                                               |
| stop, breakpoint                    | arrêt, point d’arrêt         | a test stopped at a line: _cet arrêt_                                    |
| Hold failures                       | Retenir les échecs           | the switch, in Piwi Picker and Piwi Runner                               |
| live (Share live, live view)        | en direct                    | _Partager en direct_, _vue en direct_, _Arrêter le partage_              |
| tray (system)                       | zone de notification         | the icon and its menu; the menu bar on macOS                             |
| local host                          | serveur local                | Piwi Runner's own Node server, on the start screen                       |
| uncommitted changes                 | modifications non commitées  | `commit` stays, as developers say it                                     |

## Typography

- `’` for the apostrophe, `« »` around a quoted text with a narrow no-break space inside.
- A no-break space (U+00A0) before `:`, a narrow no-break space (U+202F) before `;`, `!` and `?`. The catalog check
  rejects an ordinary space there.
- `…` rather than three dots.
