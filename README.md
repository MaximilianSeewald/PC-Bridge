# PC-Bridge

PC-Bridge verbindet einen ChatGPT-Work-Chat im Browser mit einem lokalen
Windows- oder Linux-PC und übergibt Unity-Aufrufe an den lokalen MCP-Server.

- `pc_ping` sendet einen frischen Prüfwert an den Windows-Client und meldet dessen Antwort.
- `unity_active_scene` liest die aktuell im lokalen Unity-Editor geöffnete
  Szene und zeigt ihren Speicherstatus. [Unity einrichten](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/client#pc-bridge-unter-windows-und-linux)
- `unity_game_view` liefert ein aktuelles PNG der Game View im Play Mode.
- Der Katalog spiegelt die integrierten Werkzeuge von MCP for Unity
  v10.0.0 mitsamt ihren Parameterschemas. Der Client startet
  die Unity-Anbindung automatisch beim ersten Unity-Aufruf.

Die private ChatGPT Site hostet den Web-MCP-Endpunkt und die Auftragswarteschlange
in D1. Der Client holt Aufträge per HTTPS ab und übergibt sie
an den lokalen Unity-MCP-Server. So laufen auch Änderungen im lokalen
Editor. Die private Site und die Gerätekopplung regeln den Zugriff.
Die `project_git_*`-Werkzeuge verwenden Git direkt im konfigurierten
Unity-Checkout. [Git für ContinueWork einrichten](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/client#git-für-continuework-einrichten)

## Unity-Projektdaten

Das Unity-Projekt liegt einmal lokal auf dem gekoppelten PC. Für Live-Abfragen
arbeitet ChatGPT über PC-Bridge mit dem laufenden Editor und erhält die
Antwort des jeweiligen Unity-MCP-Tools. So lassen sich auch ungespeicherte
Änderungen erkennen. GitHub kann parallel den gespeicherten Stand
versionieren, einschließlich `Assets/` mit `.meta`-Dateien, `Packages/`
und `ProjectSettings/`. Unity erzeugt lokale Arbeitsordner wie `Library/`.

## Pakete

Jeder Push auf `main` startet Tests und baut drei ZIP-Dateien. Sind die
Prüfungen erfolgreich, veröffentlicht der Workflow alle drei zusammen als
[GitHub Release](https://github.com/MaximilianSeewald/PC-Bridge/releases).
Der Tag `main-<Laufnummer>-<Commit>` zeigt, aus welchem Stand die Pakete
gebaut wurden. Die Veröffentlichung einer Site erfolgt in ChatGPT Sites.

| Paket | Verwendung |
| --- | --- |
| `PC-Bridge-Sites-Relay.zip` | Site-Projekt mit Worker, Hosting-Konfiguration und D1-Migration für die Einrichtung oder Aktualisierung einer privaten Site. |
| `PC-Bridge-Windows-MCP.zip` | Startprogramme und Windows-Client. Entpacken und `PC-Bridge.cmd` starten. [Anleitung](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/client). |
| `PC-Bridge-Linux-MCP.zip` | Linux-Client. Entpacken und `./pc-bridge.sh` starten. [Anleitung](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/client#start-unter-linux). |

## Eigene private Site einrichten

Du brauchst Zugang zu ChatGPT Sites und zur Erstellung eines privaten Site-Plugins.
Für den Client brauchst du Node.js 22 oder neuer.

1. Klone das Repository oder entpacke das Relay-ZIP. Öffne den Ordner in der ChatGPT-Desktop-App als
   lokales Projekt. Prüfe den Build im Hauptordner mit `npm run build`.
2. Erstelle aus dem lokalen Projekt eine neue, nur für dich zugängliche
   ChatGPT Site. Der Build-Befehl ist `npm run build`. Der Worker liegt danach
   unter `dist/server/index.js`. Die Hosting-Konfiguration in
   `.openai/hosting.json` deklariert die MCP-Fähigkeit und die D1-Bindung
   `DB`. Die SQL-Migration liegt in `drizzle/`. ChatGPT Sites vergibt eine
   eigene Projekt-ID.
3. Lass in Sites für diese Instanz ein Service-Token für zugelassene
   HTTPS-Aufrufe ohne Browsersitzung generieren. Setze diese
   Produktionsvariablen in Sites und veröffentliche die Site anschließend
   mit derselben privaten Zugriffsregel.

   | Variable | Wert |
   | --- | --- |
   | `BRIDGE_ORIGIN` | Die HTTPS-Adresse deiner Site ohne abschließenden Schrägstrich, z. B. `https://meine-pc-bridge.chatgpt.site`. |
   | `BRIDGE_OWNER_EMAIL` | Die E-Mail des ChatGPT-Kontos, dem die Site gehört. Als Secret speichern. |
   | `BRIDGE_SITES_TOKEN` | Das Site-spezifische Service-Token. Als Secret speichern. |

   Wenn du die Einrichtung an ChatGPT Work in der Desktop-App übergibst, kannst
   du diesen Auftrag verwenden:

   > Veröffentliche dieses lokale PC-Bridge-Projekt als neue ChatGPT Site,
   > die nur mir gehört und nur für mich zugänglich ist. Verwende
   > `npm run build`, die mitgelieferte MCP-Konfiguration und die D1-Migration
   > aus `drizzle/`. Stelle die drei Laufzeitvariablen aus der README in
   > Sites ein. Verwende für den Gerätezugriff ein Service-Token dieser Site
   > und halte es aus Quellcode und Chat-Ausgabe heraus. Prüfe nach der
   > Veröffentlichung, ob das private MCP-Plugin vorhanden ist.

   [Kompatible Projekte in ChatGPT Sites](https://learn.chatgpt.com/docs/sites/creating-a-site) ·
   [Servicezugriff auf private Sites](https://learn.chatgpt.com/docs/sites/data-and-connections#call-a-private-site-with-a-siwc-bypass-token)
4. Installiere und verbinde das erzeugte Plugin bei Bedarf unter **Plugins →
   Persönlich → Von dir erstellt**. Folge dann der
   [Anleitung für den Client](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/client).

Der Kopplungscode enthält die Adresse der Site und die Zugangsdaten für
den PC. Kopiere ihn direkt von deiner privaten Site in den Client. Über
**Kopplung aufheben** trennst du den bisherigen Client. Der Client
überträgt den Prüfwert oder die Ausgabe des angeforderten Unity-Werkzeugs.

## Bestehende private Site aktualisieren

1. Lade `PC-Bridge-Sites-Relay.zip` aus dem gewünschten GitHub Release
   herunter und entpacke es separat. Öffne das Quellprojekt deiner bestehenden
   Site in ChatGPT Work oder Codex.
2. Übernimm `worker/`, `drizzle/`, `client/unity-tools.json`,
   `client/git-tools.json`, `build.mjs` und `package.json` aus
   dem Release in das bestehende Quellprojekt. Verwende die vorhandene
   `.openai/hosting.json` als Grundlage. Ihre `project_id` und die
   D1-Bindung identifizieren die Site und ihre Datenbank. Die Vorlage im ZIP
   enthält die benötigten Hosting-Einstellungen für eine neue Site.
3. Bitte ChatGPT Work oder Codex, die bestehende Site mit `npm run build`
   zu bauen und als neue private Version zu veröffentlichen. Verwende
   dabei die vorhandenen Site-Secrets und wende bei Bedarf die mitgelieferten
   Datenbankmigrationen an.
4. Starte den Client aus demselben Release und prüfe im bestehenden
   `@PC-Bridge`-Plugin mit `pc_ping`, ob der gekoppelte PC antwortet.

## Lokal testen

Im Hauptordner unter Node.js 22 oder neuer:

```sh
npm test
npm run build
```

Die Tests verwenden SQLite im Arbeitsspeicher und einen simulierten
Unity-MCP-Endpunkt. Der gemeinsame Abnahmelauf im
[Client-Handbuch](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/client#gemeinsamer-abnahmelauf)
prüft die Strecke bis zum echten Unity-Editor.

Die drei Release-Archive lassen sich im Repository mit
`python3 package-release.py` unter `dist/packages/` erstellen.
