# PC-Bridge unter Windows

Voraussetzung ist Node.js 22 oder neuer. Für Unity nutzt PC-Bridge
[MCP for Unity](https://coplaydev.github.io/unity-mcp/getting-started/install).

1. Öffne dein Unity-Projekt und installiere im **Unity Package Manager**
   über **+ → Add package from git URL** das Paket in der getesteten Version.

   ```text
   https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.0.0
   ```

2. Öffne **Window → MCP for Unity**. Folge bei Bedarf der Einrichtung
   für Python und `uv`. Starte den lokalen HTTP-Server am Standardport
   `8080` und öffne eine Szene. PC-Bridge verbindet sich mit
   `http://127.0.0.1:8080/mcp`.
3. Entpacke **PC-Bridge-Windows-MCP.zip** aus demselben Release wie
   deine Site. Klicke auf der privaten Site auf **Kopplungscode anzeigen**
   und füge den vollständigen Code nach dem Start von **PC-Bridge.cmd** ein.
   Ein neuer Code ersetzt die bisherige Kopplung.
4. Warte auf **Verbunden**. Wähle im Work-Chat das Plugin deiner Site.
   `pc_ping` prüft die Verbindung zum PC. `unity_active_scene` liest
   die aktive Unity-Szene.

Die Unity-Werkzeuge erscheinen unter ihren ursprünglichen MCP-Namen.
Der Client aktiviert die optionalen Gruppen zu Beginn einer lokalen
MCP-Sitzung. Unity-Pakete, externe Dienste und projektspezifische
Erweiterungen verwenden ihre eigenen Abhängigkeiten und Einstellungen.
`execute_custom_tool` erfordert die Unterstützung für projektbezogene
Werkzeuge im Unity-MCP-Server.

Strg+C beendet den Client. **Kopplung aufheben** widerruft den bisherigen
Gerätezugang. Behandle den Kopplungscode wie ein Passwort. Wenn ein
Schreibaufruf wegen eines Timeouts endet, prüfe den Zustand im Editor
vor einem erneuten Aufruf.

## Gemeinsamer Abnahmelauf

Öffne eine leere Unity-Testszene. Wähle das Site-Plugin in ChatGPT Work
und gib diesen Prompt ein.

> Lies die aktive Unity-Szene mit `unity_active_scene`. Erstelle darin
> mit `manage_gameobject` einen Würfel namens `PCBridge_Test`.
> Verschiebe ihn auf Position (2, 1, 0). Füge mit `manage_components`
> einen Rigidbody hinzu. Lies die Hierarchie mit `manage_scene` und
> überprüfe, ob das Objekt vorhanden ist. Gib an, welche Aufrufe
> erfolgreich waren. Lass die Szene ungespeichert.

Prüfe danach einmal im Editor, ob der Würfel in der Hierarchie steht
und der Inspector die neue Position und den Rigidbody zeigt.
