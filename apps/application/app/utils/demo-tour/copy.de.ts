import type { TourCopy } from './copy';

/**
 * The guided tour in German, with exactly the keys of the English (`copy.en.ts`).
 * A `**bold**` dashboard label stays in English, as the screen spells it. The
 * reader is „Sie“; quotes are „…“.
 */
export const DE_COPY = {
  ui: {
    launch: 'Geführte Tour',
    launchTitle: 'Wählen Sie Ihre Rolle und sehen Sie die Ansichten, die Sie am häufigsten nutzen würden',
    promptTitle: 'Möchten Sie eine geführte Tour machen?',
    promptBody:
      'Wählen Sie Ihre Rolle: Die Tour zeigt Ihnen die Ansichten, die Sie am häufigsten nutzen würden, mit den Beispieldaten dieser Demo.',
    roles: 'Ihre Rolle',
    stopCount: '{count} Stationen',
    later: 'Später',
    dismiss: 'Nicht mehr anzeigen',
    language: 'Sprache',
    next: 'Weiter',
    back: 'Zurück',
    done: 'Fertig',
    progress: '{{current}} von {{total}}',
    close: 'Tour beenden',
    docs: 'Dokumentation (auf Englisch)',
    finishedTitle: 'Ende der Tour',
    finishedBody: 'Die Touren der anderen Rollen finden Sie unter „Geführte Tour“ in der Leiste oben.',
  },
  profiles: {
    developer: {
      label: 'Entwicklung',
      hint: 'Fehler verstehen und beheben',
      stops: {
        failure: {
          title: 'Ein Fehlschlag, von oben nach unten gelesen',
          body: 'Jede fehlgeschlagene Ausführung beginnt mit diesem Block. Die Überschrift sagt, was fehlschlug, **Most likely** nennt die Ursache, auf die die Belege zeigen, und **Next** den einen nächsten Schritt: hier den Patch anwenden, den die KI-Diagnose des Fehlerclusters geschrieben hat.',
        },
        evidence: {
          title: 'Die Belege, über die CI hinaus aufbewahrt',
          body: 'Was der Lauf für diese Ausführung erfasst hat, ein Tab pro Ansicht: Schritte, Requests und Konsole auf einer Zeitleiste, die Seite im Moment des Fehlers, der Quelltext des Tests. Ein Punkt markiert jeden Tab, den **Most likely** zitiert.',
        },
        locator: {
          title: 'Der Locator, den Sie hätten verwenden sollen',
          body: "Bricht ein Locator, wie hier getByRole('button') mit drei gefundenen Buttons, ordnet Piwi Ersatz-Locators aus dem letzten Lauf, in dem der Test bestand. Kopieren Sie den empfohlenen oder klicken Sie das Element mit **Pick from snapshot** auf der fehlgeschlagenen Seite an.",
        },
        diagnosis: {
          title: 'Eine KI-Diagnose, an Ihrem Code geprüft',
          body: 'Mit einem konfigurierten KI-Anbieter diagnostiziert Piwi einen Fehlercluster aus seinen Belegen und den Commits seit dem letzten Erfolg. Diese Diagnose führt die 51 Zeilen der Benutzertabelle auf die Standard-Seitengröße der API zurück und schlägt diesen Patch vor, am Code geprüft: **Applies cleanly**. Inzwischen ist ein Fix gelandet und hält.',
        },
        coverage: {
          title: 'Die Serverzeilen, die dieser Test ausführte',
          body: 'Wenn ein Projekt Coverage aufzeichnet, listet der Tab **Source** den Code, den ein Test ausgeführt hat. Dieser fehlgeschlagene Test lief durch fünf Dateien der ASP.NET-Core-API, zuerst die Users-Endpoints mit den verdächtigen Zeilen; öffnen Sie eine für ihre ausgeführten Zeilen. Der Link **tests** einer Datei öffnet alle Tests, die sie ausführen, Zeile für Zeile.',
        },
        mcp: {
          title: 'Fragen Sie aus Ihrem Editor',
          body: 'Piwi ist auch ein MCP-Server: Claude Code, Cursor oder Copilot in VS Code können Fehlercluster, ihre Belege und Fix-Pläne lesen und sie triagieren, ohne den Editor zu verlassen. **Client setup** enthält die Konfiguration jedes Clients; der Endpunkt dieser Demo ist nicht aktiv.',
        },
        simulate: {
          title: 'Einen Lauf ankommen sehen',
          body: '**Simulate a test run** streamt einen neuen Lauf in die Demo, wie es der Reporter aus der CI tut. Bei **Run with failures** landen zwei Timeouts im Cluster des ersten Fehlschlags, den Sie gesehen haben, und ein neuer Fehler eröffnet einen eigenen.',
        },
      },
    },
    qa: {
      label: 'QA / Testing',
      hint: 'Instabile, langsame, fehlende Tests',
      stops: {
        inbox: {
          title: 'Fehlschläge, nach Ursache gruppiert',
          body: 'Die **Failure inbox** listet alle offenen Fehlercluster der Projekte: eine Zeile pro Grundursache, egal wie viele Tests sie betrifft. Lösen Sie eine Zeile per Tastatur, weisen Sie sie zu, stellen Sie sie zurück oder setzen Sie sie in Quarantäne: Die Entscheidung gilt für alle ihre Tests.',
        },
        flaky: {
          title: 'Instabile Tests, nach Kosten sortiert',
          body: 'Tests, die fehlschlagen und dann bestehen, sortiert nach der CI-Zeit, die ihre Wiederholungen kosten, jeder mit einem Score von 0 bis 100 aus Wiederholungen und Statuswechseln und mit seinem Hauptverdacht. **Quarantine** lässt einen Test weiterlaufen und berichten, aber das CI-Gate ignoriert ihn.',
        },
        suspects: {
          title: 'Was ihn instabil macht',
          body: 'Piwi vergleicht die fehlgeschlagenen und erfolgreichen Ausführungen dieses Tests über 30 Tage und ordnet, was die Fehlschläge unterscheidet. Eine langsame Warenkorb-API steht vorn, und sie im Flake Lab zu verzögern, reproduzierte den Fehler in 3 von 4 Läufen.',
        },
        slow: {
          title: 'Welche Tests die Suite bremsen',
          body: '**Slowest tests** sortiert die Tests des Projekts nach durchschnittlicher Dauer in den letzten Läufen, mit ihrer schlechtesten und letzten Zeit. Die Checkout-Tests mit Kreditkarte und PayPal sind als langsamer markiert: Ihre letzten Läufe erreichen das Timeout von 30 s.',
        },
        lab: {
          title: 'Einen Fix belegen, bevor die Quarantäne endet',
          body: 'Das Flake Lab führt einen instabilen Test unter jeder verdächtigen Bedingung neben einer Kontrolle erneut aus, und nach dem Fix noch einmal. „Table pagination works correctly“ ist **Verified fixed**: Unter der Verzögerung, die ihn reproduzierte, hielt der Fix in 5 von 5 Läufen, also wird seine Freigabe aus der Quarantäne vorgeschlagen.',
        },
        gaps: {
          title: 'Was Ihre Tests nicht abdecken',
          body: 'Die Test Map zeichnet die Funktionen der App aus dem, was die Tests erreichen, und listet die Tests auf, die es noch nicht gibt, sortiert nach Risikoexposition. Einer davon hier: Die Tests bestehen weiter, wenn POST /api/orders ausfällt.',
        },
      },
    },
    product: {
      label: 'Product Owner',
      hint: 'Qualität im Zeitverlauf und Berichte',
      stops: {
        health: {
          title: 'Alle Projekte auf einen Blick',
          body: '**Project health** zeigt für jedes Projekt die letzten 20 Läufe, seine Tendenz und die Erfolgsquote seines letzten Laufs, fehlschlagende Projekte zuerst. Öffnen Sie eines, um zu sehen, was fehlschlug.',
        },
        analytics: {
          title: 'Qualität im Zeitverlauf',
          body: 'Die **Headline numbers** aller Projekte über die letzten 30 Tage, verglichen mit den 30 Tagen davor: Erfolgsquoten, instabile Tests, verschwendete CI-Minuten, offene Fehlerursachen, Zeit bis zum Fix. Setzt ein Projekt einen Zielwert, zeigt die Kachel, wie viele Projekte ihn erreichen.',
        },
        dashboards: {
          title: 'Ein Dashboard pro Team',
          body: 'Neben den eingebauten Dashboards pflegt ein Team eigene Widgets und Filter: **Checkout team** verfolgt die Checkout-Smoke-Tests Sprint für Sprint. Jedes Dashboard kann im TV-Modus auf einem Wandbildschirm laufen oder als geplanter Bericht verschickt werden.',
        },
        reports: {
          title: 'Berichte, die sich selbst verschicken',
          body: 'Ein Zeitplan schickt einen Qualitätsbericht täglich, wöchentlich oder monatlich an seine Kanäle, auf Englisch oder Französisch, und bewahrt jeden hier als Snapshot auf. **Weekly engineering report** ist einer davon; in dieser Demo wird nichts verschickt.',
        },
        issue: {
          title: 'Aus Fehlschlägen werden Tickets',
          body: 'Dieser Login-Fehler wird in DEMO-42 verfolgt, aus Piwi angelegt mit dem Fix-Plan des Fehlerclusters als Beschreibung und inzwischen „In Progress“. Schlüssel und Status begleiten den Fehler: auf dieser Seite, bei seinen Ausführungen und in der Inbox. Ein Cluster ohne Ticket bietet **Create issue** und **Link an issue**.',
        },
        personas: {
          title: 'So, wie Ihr Team es sieht',
          body: '**Acting as** lädt die Demo als eine von sieben Beispielpersonen neu, von der Administration bis zu jemandem, der E2E Checkout nur lesen darf. Jede sieht, was ihre Rolle erlaubt.',
        },
      },
    },
    platform: {
      label: 'DevOps / Plattform',
      hint: 'CI-Tempo und Zustand der Maschinen',
      stops: {
        timeline: {
          title: 'Wohin die Zeit des Laufs ging',
          body: 'Die Tests jedes Workers auf einer Zeitleiste, mit CPU, Speicher und offenen Seiten der Maschine, die sie ausgeführt hat. Dieser Lauf war auf zwei CI-Shards verteilt: Die Maschine jedes Shards hat eigene Spuren über ihren zwei Workern.',
        },
        leaks: {
          title: 'Lecks zwischen Tests',
          body: '**Findings** listet, was die Tests über ihren Gültigkeitsbereich hinaus offen ließen, mit der Zeile, die es öffnete. Hier lässt die Fixture loggedInContext in allen 10 Tests einen Browser-Kontext offen, bis der Worker endet.',
        },
        incident: {
          title: 'Wenn Staging ausfällt und nicht die Tests',
          body: 'Zehn von elf Tests scheiterten an der Verbindung zu Staging, also hat Piwi den Lauf als Umgebungsvorfall markiert. Instabilitäts-Scores, Baselines, Fix-Verifizierung und CI-Gate lassen ihn außen vor, und die Trenddiagramme erhalten eine einzige Markierung.',
        },
        alerts: {
          title: 'Benachrichtigungen dort, wo Sie arbeiten',
          body: 'Ein Kanal ist das Ziel von Benachrichtigungen: eine E-Mail, ein Slack- oder Microsoft-Teams-Webhook oder ein eigener Webhook. Ein Abonnement wählt dann Projekte und Ereignisse, etwa einen fehlgeschlagenen Lauf, einen neuen Fehlercluster oder einen Umgebungsvorfall.',
        },
        setup: {
          title: 'Was eingeschaltet ist',
          body: "**What's switched on** liest die Daten dieser Instanz, nicht ihre Konfiguration, um zu zeigen, welche Funktionen genutzt werden und was jede andere braucht, etwa ein Repository-Token oder einen KI-Anbieter. Die Schritte darüber verbinden eine Suite.",
        },
        simulate: {
          title: 'Einen Lauf live verfolgen',
          body: '**Simulate a test run** streamt einen neuen Lauf in die Demo, wie es der Reporter aus der CI tut. **Leaky run** spielt das Leck nach, das Sie eben gesehen haben: Eine Login-Fixture lässt in jedem Test einen Browser-Kontext offen.',
        },
      },
    },
  },
} satisfies TourCopy;
