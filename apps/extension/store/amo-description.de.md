Diese deutsche Übersetzung ist ein Entwurf: Muttersprachler haben sie noch nicht geprüft. Wenn Ihnen ein Fehler oder eine holprige Formulierung auffällt, [schlagen Sie eine Korrektur vor](https://github.com/PiwiTests/platform/issues/new?template=translation.yml).

Piwi Picker gibt Ihnen den Playwright-Locator für jedes Element der Seite, die Sie gerade ansehen. Jeder Kandidat wird nach seiner Stabilität bewertet und dann auf der Seite, wie sie gerade ist, ausgeführt, sodass der oberste genau ein Element findet. Klicken Sie einen Ablauf durch, und die Erweiterung schreibt den Test; reproduzieren Sie einen Bug, und sie schreibt den fehlschlagenden Test und den Bericht.

**Aus dem Popup in der Symbolleiste, auf jeder Seite**

- **Element wählen**: die sortierten Locators eines Elements, erneut auf der Seite geprüft, kopiert als Locator, als Aktionszeile oder als Assertion. Teilen sich mehrere Elemente einen Namen, grenzen Sie den Locator auf ein stabiles Elternelement ein.
- **Aufzeichnen**: Klicks, Eingaben und Auswahlen auf den Seiten einer Website, umgewandelt in einen lauffähigen TypeScript-Test. Passwörter werden nie aufgezeichnet.
- **Bug melden**: Schritte aufzeichnen, markieren, was auf der Seite falsch ist, und einen fehlschlagenden Test, einen Markdown-Bericht und eine .piwibug-Datei mit den Konsolenfehlern und den fehlgeschlagenen Anfragen erhalten. **Bug-Report abspielen** spielt dessen Schritte in einem Tab erneut ab.
- **Prüfung**: die Elemente, die kein stabiler Locator allein findet, jeweils mit einer vorgeschlagenen data-testid.
- **Mehrfachauswahl**, **Assertions** und **KI-Kontext**: das gemeinsame Muster der Zeilen einer Liste, expect(...)-Zeilen für ein Element und ein Textblock über ein Element für einen KI-Coding-Agenten.

**In den DevTools des Browsers**

Die sortierten Locators des unter Elemente ausgewählten Elements, eine Locator-Konsole mit dem Ergebnis des Strict Mode, die Elemente, die Sie benennen, exportiert als Page Object, Netzwerk-Mocks, eine verlangsamte oder fehlgeschlagene Anfrage, der Viewport eines Playwright-Projekts und Anmeldung für Tests speichern.

**Standardmäßig privat**

Auswählen und Aufzeichnen nutzen nie das Netzwerk. Nichts wird gesammelt, nichts wird irgendwohin gesendet.

**Optional: Ihre eigene Piwi-Instanz verbinden**

Piwi ist ein selbst gehostetes Dashboard für Playwright-Ergebnisse. Mit Ihrer Instanz verbunden (ihre Adresse und ein API-Schlüssel, in den Einstellungen), hebt die Erweiterung außerdem die Elemente der Seite hervor, die Ihre Tests erreichen, zeigt, welche Ihrer Testfunktionen darauf funktionieren, und zeichnet Abläufe als Aufrufe dieser Funktionen auf. Sie liest Ihre Instanz und sendet ihr nur eines: einen Bug-Report, wenn Sie in der Vorschau, die genau zeigt, was gesendet wird, auf Senden klicken.

**Berechtigungen**

- Der Tab, den Sie gerade ansehen, nur wenn Sie auf den Button der Erweiterung klicken oder das Tastenkürzel drücken.
- Eine Website, erfragt, wenn Sie dort eine Aufzeichnung starten, damit der Recorder Ihnen von Seite zu Seite folgen kann. Bei der Installation wird nichts gewährt.
- Die Cookies dieser Website, erfragt nur, wenn Sie deren Anmeldung für Ihre Tests speichern: Sie landen in einer Datei auf Ihrem Rechner.
- Die Adresse Ihrer Piwi-Instanz, erfragt, wenn Sie eine Verbindung speichern.

Piwi Picker spricht Englisch, Französisch, Deutsch, Spanisch und brasilianisches Portugiesisch.

Dokumentation (auf Englisch): [piwitests.dev/features/extension](https://piwitests.dev/features/extension)

Piwi ist nicht mit der Microsoft Corporation verbunden und wird von ihr weder unterstützt noch gefördert. Playwright ist eine Marke der Microsoft Corporation.
