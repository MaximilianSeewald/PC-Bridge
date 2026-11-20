# PC-Bridge unter Windows und Linux

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
3. Entpacke das Client-ZIP für dein Betriebssystem aus demselben Release
   wie deine Site. Starte unter Windows **PC-Bridge.cmd**. Unter Linux
   startest du **./pc-bridge.sh** im Terminal. Klicke auf der privaten
   Site auf **Kopplungscode anzeigen** und füge den vollständigen Code
   in den Client ein.
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

## Start unter Linux

Entpacke `PC-Bridge-Linux-MCP.zip` und starte im entpackten Ordner
`./pc-bridge.sh`. Falls dein Entpacker die Ausführungsrechte entfernt,
kannst du `sh ./pc-bridge.sh` verwenden. Unity Editor und Unity MCP
laufen auf demselben Rechner wie der Client. Für Git-Funktionen verwende
einen absoluten Linux-Pfad in `pc-bridge.config.json` und richte lokal
den GitHub-Zugriff ein. Eine Kopplung mit einem neuen Code ersetzt die
bisherige Gerätekopplung derselben privaten Site.

## Bild aus dem laufenden Unity-Spiel

Starte den Play Mode und rufe `unity_game_view` im Chat auf. Der
Client fordert über `manage_camera` ein PNG der Game View an und sendet
es direkt im Tool-Ergebnis. Die komponierte Game View kann auch HUD und
Unity-UI zeigen. Wenn Unity den Bildpuffer nicht lesen kann, verwendet
MCP for Unity gegebenenfalls die Kameraansicht. Für Bewegungen lassen sich
mehrere Bilder zu unterschiedlichen Zeitpunkten abrufen.

Das Werkzeug erfasst den Unity-Editor, der mit dem lokalen MCP-Server
verbunden ist. Ein separat gestarteter Standalone-Player oder dessen
Fenster erfordert eine eigene Capture-Anbindung. Unity speichert die
lokalen Kopien unter `Temp/PC-Bridge-Captures`.

## Chatbilder als Sprite importieren

1. Öffne das Zielprojekt im lokalen Unity-Editor und beende den Play Mode.
   Wenn ein Projektpfad in `pc-bridge.config.json` gesetzt ist, muss er
   zum geöffneten Projekt passen.
2. Wähle im Work-Chat das PC-Bridge-Plugin und gib an, welches Bild du
   importieren willst. Verwende ein im Chat ausgewähltes Bild als Datei.
   Beispielprompt:

   > Importiere das angehängte Bild mit `unity_import_chat_image` als
   > `Pumpenraum_Schott` in mein geöffnetes Unity-Projekt.

3. Das Tool legt das Bild unter `Assets/Art/ChatImports/` ab und importiert
   es als einzelnes Sprite. Es meldet den Pfad und die Unity-GUID.
   Für einen abweichenden Maßstab gib `pixelsPerUnit` an. Standard sind 100.

Der Import akzeptiert PNG und JPEG bis 12 MiB, 8192 Pixel je Seite und
32 Megapixel. Ein bereits belegter Dateiname bleibt erhalten. Wenn der
Import nach dem Schreiben scheitert, meldet das Tool den vorhandenen
Pfad, damit du den Unity-Import prüfen kannst. Für Chatbilder, die deine
Chat-Ansicht nicht direkt als Datei an ein Tool übergibt, hänge das Bild
als PNG- oder JPEG-Datei an.

## Testmodus für Unity-Multiplayer unter Windows

Starte `PC-Bridge-Testmodus.cmd` per Doppelklick, wenn Windows bei
automatisch erzeugten Unity-Testprogrammen wiederholt nach Netzwerkzugriff
fragt. Bestätige einmal die Windows-Adminabfrage für den Firewall-Helfer.
PC-Bridge nutzt danach denselben Kopplungsablauf wie mit `PC-Bridge.cmd`.

Der Helfer setzt `NotifyOnListen` für das private Profil während dieser
Sitzung auf `False`. Das betrifft die Benachrichtigungen für alle
Programme im privaten Profil. Die Firewall prüft die Verbindungen nach
ihren vorhandenen Regeln. Unity, MCP und der Windows-Client laufen mit
den normalen Benutzerrechten. `PC-Bridge.cmd` ist der reguläre Start
ohne Änderung der Windows-Einstellung.

Beim Beenden über Strg+C oder Schließen des Client-Fensters stellt der
separate Helfer die Einstellung wieder her. Waren die Benachrichtigungen
schon ausgeschaltet, bleiben sie ausgeschaltet. Endet der Helfer selbst
abrupt, etwa bei einem Stromausfall, holt der nächste Start im Testmodus
die ausstehende Wiederherstellung nach. Bei Bedarf kannst du sie sofort
in einer PowerShell als Administrator einschalten:

```powershell
Set-NetFirewallProfile -Profile Private -NotifyOnListen True
```

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

1. Installiere Git und klone das GitHub-Repository des Spiels.
   Öffne in Unity diesen Checkout. `Assets/`, `Packages/` und
   `ProjectSettings/` liegen direkt an der Git-Wurzel. Versioniere
   Unity-`.meta`-Dateien und ignoriere die generierten Ordner wie
   `Library/`, `Temp/` und `Logs/`.
2. Kopiere `pc-bridge.config.example.json` als `pc-bridge.config.json`
   neben dein Startskript. Setze `projectPath` auf den absoluten Pfad
   dieses Checkouts, `repository` auf `GitHubName/MeinSpiel` und
   `baseBranch` auf den Basisbranch. Die Fetch- und Push-URL von
   `origin` müssen auf dieses Repository zeigen. GitHub-Zugriff über
   HTTPS und Git Credential Manager oder über SSH einmal lokal einrichten.
   Setze auch Git `user.name` und `user.email` im Checkout.
3. Starte den aktualisierten Client. Öffne den ContinueWork-Chat
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
