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

## Git für ContinueWork einrichten

1. Installiere Git für Windows und klone das GitHub-Repository des Spiels.
   Öffne in Unity diesen Checkout. `Assets/`, `Packages/` und
   `ProjectSettings/` liegen direkt an der Git-Wurzel. Versioniere
   Unity-`.meta`-Dateien und ignoriere die generierten Ordner wie
   `Library/`, `Temp/` und `Logs/`.
2. Kopiere `pc-bridge.config.example.json` als `pc-bridge.config.json`
   neben `PC-Bridge.cmd`. Setze `projectPath` auf den absoluten Pfad
   dieses Checkouts, `repository` auf `GitHubName/MeinSpiel` und
   `baseBranch` auf den Basisbranch. Die Fetch- und Push-URL von
   `origin` müssen auf dieses Repository zeigen. GitHub-Zugriff über
   HTTPS und Git Credential Manager oder über SSH einmal lokal einrichten.
   Setze auch Git `user.name` und `user.email` im Checkout.
3. Starte den aktualisierten Windows-Client. Öffne den ContinueWork-Chat
   mit dem aktualisierten PC-Bridge-Plugin.

| Werkzeug | Aufgabe |
| --- | --- |
| `project_git_status` | Lokalen Branch, HEAD und Dateistatus abfragen |
| `project_git_diff` | Änderungen an versionierten Dateien gegen HEAD lesen |
| `project_git_prepare` | Feature-Branch vom aktuellen GitHub-Basisbranch erstellen oder vorhandene Historie per Fast-Forward fortsetzen |
| `project_git_commit` | Explizit ausgewählte Dateien auf dem erwarteten Branch und HEAD committen |
| `project_git_push` | Den exakten getesteten SHA auf denselben Feature-Branch pushen |

Ein Durchlauf beginnt mit `project_git_status` und `project_git_prepare`.
Danach Unity mit `refresh_unity` aktualisieren, die Änderungen im Editor
speichern, kompilieren und testen. C# lässt sich mit `create_script`,
`script_apply_edits` und `manage_script` bearbeiten. Nach der Prüfung
Dateiliste und HEAD erneut lesen, nötige `.meta`-Dateien einbeziehen
und committen. Den SHA des Commits an `project_git_push` geben und für
den GitHub Pull Request oder die Übergabe im ContinueWork-Issue verwenden.

Schreibaktionen prüfen den in Unity MCP ausgewählten Checkout, den
Editor-Modus und ungespeicherte Szenen oder Prefabs. Branchwechsel und
Push setzen einen sauberen Checkout voraus. Der Basisbranch wird über
den Pull Request aktualisiert. PC, Unity, Unity MCP und PC-Bridge
müssen während des Durchlaufs erreichbar bleiben.
