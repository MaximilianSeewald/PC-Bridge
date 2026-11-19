# PC-Bridge ChatGPT-Plugin

Der Baukasten erzeugt das installierbare ZIP für eine bereits veröffentlichte
PC-Bridge-Site. Jede Site erhält ihre eigene App-ID. Sie steht im technischen
Link des von Sites erstellten Plugins, beispielsweise
`plugin_asdk_app_sites_…`. Alternativ lass dir in ChatGPT Work die ID des
bereitgestellten Site-Plugins anzeigen.

Mit Python 3.9 oder neuer:

```powershell
python build_archive.py "<App-ID deiner Site>"
```

Importiere anschließend **PC-Bridge-Plugin.zip** über **Plugins → Hinzufügen →
Archiv hochladen**, wenn der Upload für dein Konto verfügbar ist. Wähle danach
**PC-Bridge MCP** in einem neuen Work-Chat. Die Site und deren Berechtigungen
gelten für dieses Archiv weiter.

Site-Eigentümer können das instanzgebundene ZIP optional über die Startseite
bereitstellen. Setze nach der Erzeugung des ZIP die Sites-Laufzeitvariable
`BRIDGE_PLUGIN_ARCHIVE` auf den Base64-Inhalt der ZIP-Datei und veröffentliche
eine neue Version. Die Site prüft beim Download das Eigentümerkonto.

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path .\PC-Bridge-Plugin.zip)))
```
