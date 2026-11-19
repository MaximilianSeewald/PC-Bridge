# Windows-Client für das eigenständig gehostete Relay

Windows benötigt Node.js 22 oder neuer und die Programme deiner lokalen
MCP-Server. Gib nur die Programme und Werkzeuge frei, die du aus dem Chat
benutzen möchtest.

1. Kopiere `pc-bridge.example.json` nach `pc-bridge.config.json`. Die
   Vorlage verwendet `https://relay.maximilian-seewald.de`. Trage für
   eine eigene Instanz unter `relay` deren HTTPS-Origin ein.
2. Trage unter `servers` deine lokalen `stdio`-MCP-Server ein. `command`
   und `args` entsprechen ihrer normalen MCP-Konfiguration. Unter `tools`
   stehen die exakten Tool-Namen, die dieser PC über das Relay freigibt.
   `cwd` wird relativ zur Konfigurationsdatei aufgelöst. Mit `env` kannst
   du Umgebungsvariablen des jeweiligen lokalen Servers setzen.
3. Starte `PC-Bridge-Portable.cmd` und gib den zu deinem OAuth-Konto
   eingerichteten Geräteschlüssel ein. Das Konsolenfenster meldet
   **Verbunden**, sobald das Relay deine Verbindung akzeptiert.
4. Rufe im verbundenen Plugin `list_local_mcp_tools` auf. Das Ergebnis
   zeigt die freigegebenen Tools mit ihren Argument-Schemata. Wähle eines
   davon für `call_local_mcp_tool`.

Das Beispiel verwendet den mitgelieferten MCP-Server mit zwei Tools für
Ping und lokalen Git-Status. Ändere den Git-Pfad auf deinen eigenen Checkout,
wenn du zuerst diese Beispielwerkzeuge testen möchtest.
