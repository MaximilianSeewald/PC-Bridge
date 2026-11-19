# PC-Bridge

PC-Bridge verbindet einen ChatGPT-Work-Chat im Browser mit einem lokalen
Windows-PC. Der Prototyp bietet zwei lesende MCP-Werkzeuge.

- `pc_ping` sendet einen frischen Prüfwert an den Windows-Client und meldet dessen Antwort.
- `epoch_git_status` zeigt den Branch und die Änderungszahlen eines lokal ausgewählten
  Git-Checkouts, beispielsweise von EPOCH.

Die private ChatGPT Site hostet den Web-MCP-Endpunkt und die Auftragswarteschlange
in D1. Der Windows-Client holt Aufträge per HTTPS ab und ruft einen zweiten,
lokalen MCP-Server über Standard-Ein- und Ausgabe auf. Der lokale Server führt
die Werkzeuge aus.

## Pakete

Die drei Archive stehen unter [GitHub Releases](https://github.com/MaximilianSeewald/PC-Bridge/releases).

| Paket | Verwendung |
| --- | --- |
| `PC-Bridge-ChatGPT-Plugin-Baukasten.zip` | Erstellt das installierbare ZIP für die App-ID deiner eigenen Site. [Anleitung](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/plugin). |
| `PC-Bridge-Sites-Relay.zip` | Enthält den Worker, den Build und die D1-Migration für eine eigene private Site. |
| `PC-Bridge-Windows-MCP.zip` | Enthält das Startskript, den Windows-Client und den lokalen MCP-Server. [Anleitung](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/client). |

## Eigene private Site einrichten

Du brauchst Zugang zu ChatGPT Sites und zur Erstellung eines privaten Site-Plugins.
Auf Windows brauchst du Node.js 22 oder neuer. Git wird für die Statusabfrage benötigt.

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
   [Anleitung für den Windows-Client](https://github.com/MaximilianSeewald/PC-Bridge/tree/main/client).
   Für den Import per ZIP verwende den Plugin-Baukasten mit der App-ID
   dieses Site-Plugins.

Der Kopplungscode enthält die Adresse der Site und die Zugangsdaten für
den PC. Kopiere ihn direkt von deiner privaten Site in den Client. Über
**Kopplung aufheben** trennst du den bisherigen Client. Der Client
überträgt den Prüfwert oder Branch und Änderungszahlen. Git-Dateinamen,
Dateiinhalte und der Pfad zum Checkout bleiben lokal.

## Lokal testen

Im Hauptordner unter Node.js 22 oder neuer und mit Git:

```sh
npm test
npm run build
```

Die Tests verwenden SQLite im Arbeitsspeicher und einen temporären
Git-Checkout. Die Live-Kopplung mit dem eigenen ChatGPT-Konto und
Windows-PC prüfst du mit den Schritten im Client-Handbuch.

Die drei Release-Archive lassen sich mit `python3 package-release.py` erstellen.
