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
5. Wähle im Work-Chat das Plugin deiner PC-Bridge-Site. Bitte um einen
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

## Unity anbinden

Verwende den Windows-Client und die Site aus demselben Release.

1. Öffne dein Projekt in Unity. Wähle im Unity Package Manager **+ →
   Add package from git URL** und installiere [MCP for Unity](https://coplaydev.github.io/unity-mcp/getting-started/install)
   mit dieser URL.

   ```text
   https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.0.0
   ```

2. Öffne **Window → MCP for Unity**. Folge bei Bedarf der Einrichtung
   für Python und `uv`. Starte den lokalen HTTP-Server am Standardport
   `8080` auf diesem PC und öffne eine Szene in Unity.
3. Starte PC-Bridge aus PowerShell im entpackten Windows-Ordner.

   ```powershell
   .\PC-Bridge.cmd --unity
   ```

   Füge den Kopplungscode deiner privaten Site ein. Das Feld für den
   EPOCH-Checkout kannst du für diesen Test leer lassen.
4. Wähle das Site-Plugin in ChatGPT Work im Browser und bitte es, mit
   `unity_active_scene` die aktuell offene Szene zu lesen. Füge danach
   in Unity ein Objekt auf oberster Ebene hinzu, ohne zu speichern.
   Eine erneute Abfrage zeigt den neuen Objektzähler und den
   ungespeicherten Zustand.

PC-Bridge verbindet sich mit `http://127.0.0.1:8080/mcp` und liest die
aktive Szene aus dem laufenden Editor. Starte für den Ersttest nur
den Unity-Editor, dessen Szene du prüfen möchtest.
Der Relay-Aufruf liefert Szenenname, projektbezogenen Pfad, die Anzahl
der Objekte auf oberster Ebene und den Speicherstatus.
