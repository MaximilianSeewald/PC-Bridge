# PC-Bridge-Web-Plugin bauen

Baue das Plugin-ZIP mit der produktiven HTTPS-Origin deiner Relay-Instanz
und der öffentlichen Client-ID für OAuth Authorization Code mit PKCE.

```sh
python3 build_web_archive.py https://bridge.example.org --client-id CLIENT_ID
```

Falls dein Anbieter DCR oder CIMD unterstützt, verwende stattdessen
`--client-mode dcr` oder `--client-mode cimd`. Nutzt dein Relay einen
anderen OAuth-Scope, gib ihn mit `--scope` an.

Das erzeugte `PC-Bridge-Web.zip` enthält `plugin.json` und eine
`mcp.json`. Die MCP-Konfiguration verweist auf den Relay-Endpunkt
`/mcp` und enthält die OAuth-Einstellungen. Geräteschlüssel und andere
Zugangsdaten bleiben in der Laufzeitkonfiguration.

## In ChatGPT Web bereitstellen

Für eine veröffentlichte Version lade das ZIP im OpenAI-Entwicklerportal
über **With MCP** hoch. Verwende den tatsächlich erreichbaren Relay,
verbinde OAuth, verifiziere die Domain und reiche das Plugin zur Prüfung
ein. Nach der Freigabe können Nutzer das Plugin in ChatGPT installieren,
ihr OAuth-Konto verbinden und ihren PC am Relay anmelden.

Ein verwalteter Workspace kann das Archiv mit der entsprechenden
Custom-MCP-Berechtigung für Teamtests importieren. Ob ein Import auf
der jeweiligen ChatGPT-Oberfläche läuft, richtet sich nach den verfügbaren
Workspace- und Kontofunktionen. Für Plus ist die öffentliche Freigabe
der dokumentierte Weg zur Nutzung durch andere Web-Nutzer.

- [OpenAI Plugin-Einreichung](https://developers.openai.com/plugins/deploy/submission)
- [Custom-MCP-Zugriff in ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
