# PC-Bridge unter Windows

Voraussetzungen sind Node.js 22 oder neuer sowie Git für die Statusabfrage.
Der Verbindungstest funktioniert auch ohne Git.

1. Entpacke **PC-Bridge-Windows-MCP.zip** und öffne deine private
   PC-Bridge-Site. Die Einrichtung steht in der
   [Projekt-README](https://github.com/MaximilianSeewald/PC-Bridge#eigene-private-site-einrichten).
2. Wähle **Kopplungscode anzeigen** und kopiere den vollständigen Code.
   Ein neuer Code ersetzt die bisherige Kopplung.
3. Starte **PC-Bridge.cmd** und füge den Code ein. Die Konsole zeigt den Code
   beim Einfügen nicht an. Gib den vollständigen Pfad zum Git-Checkout ein,
   beispielsweise deiner EPOCH-Kopie. Für einen reinen Verbindungstest lässt
   du den Pfad leer.
4. Warte auf **Lokaler MCP-Server gestartet** und **Verbunden**.
   Das Konsolenfenster hält beide Prozesse offen.
5. Wähle im Work-Chat **PC-Bridge MCP** für das importierte Plugin-ZIP
   oder **PC-Bridge** für das Plugin deiner Site. Bitte um einen
   Verbindungstest und dann um den lokalen EPOCH-Git-Status.

Strg+C beendet den Client. Nach rund zwölf Sekunden ohne Lebenszeichen
meldet die Site den PC als offline. **Kopplung aufheben** widerruft den
bisherigen Gerätezugang. Behandle den Kopplungscode wie ein Passwort.

## Lokaler MCP-Endpunkt

Der Client startet `mcp-server.mjs` als separaten Node-Prozess und ruft die
Werkzeuge über MCP und Standard-Ein- und Ausgabe auf. Der Server kann auch
von einem lokalen MCP-Client per `stdio` gestartet werden. Trage dort
`node` als Kommando und den absoluten Pfad zu `mcp-server.mjs` als Argument
ein. Der optionale zweite Parameter ist der absolute Pfad zum Git-Checkout.

`pc_ping` bestätigt einen Prüfwert aus 16 Kleinbuchstaben a–f oder Ziffern.
`epoch_git_status` liefert Branch und Änderungszahlen. Git-Dateinamen,
Dateiinhalte und der lokale Checkout-Pfad bleiben auf dem PC.
