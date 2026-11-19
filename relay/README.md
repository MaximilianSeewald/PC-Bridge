# PC-Bridge Web-Relay

Das Relay läuft als Node-Prozess hinter einem HTTPS-Reverse-Proxy. Pro
OAuth-Konto ordnet die Konfiguration einen Geräteschlüssel zu. Der Windows-PC
holt seine Aufträge per HTTPS ab. Der Relay-Prozess hält noch offene Aufträge
im Arbeitsspeicher und führt die MCP-Tools nicht selbst aus.

## OAuth und Geräte konfigurieren

1. Richte bei einem OpenID-Connect-Anbieter eine API ein. Ihre Audience ist
   die Relay-Adresse inklusive `/mcp`. Für die Projektinstanz lautet sie
   `https://relay.maximilian-seewald.de/mcp`. Richte den Scope `pcbridge:invoke` ein.
   Das Relay akzeptiert RS256-signierte JWT-Access-Tokens mit dieser Audience,
   diesem Scope und dem verifizierten `sub` des Nutzers.
2. Registriere für den Plugin-Import bzw. die Einreichung einen öffentlichen
   OAuth-Client mit Authorization Code und PKCE oder konfiguriere DCR/CIMD,
   falls dein Anbieter das unterstützt. Der OAuth-Anbieter muss die im
   OpenAI-Verbindungsdialog angezeigte Callback-Adresse erlauben.
3. Erzeuge pro PC einen Geräteschlüssel und den Hash dafür:

   ```sh
   node -e 'const c=require("node:crypto"), k=c.randomBytes(32).toString("hex"); console.log("PC-Schluessel:", k, "\nSHA-256:", c.createHash("sha256").update(k).digest("hex"))'
   ```

   Trage in einer privaten JSON-Datei den
   OAuth-`sub` des Nutzers als Schlüssel und dessen Hash als Wert ein.
   Kopiere dazu `relay/devices.example.json` nach `relay/devices.json`
   oder konfiguriere einen eigenen Pfad. Der PC bekommt
   den Geräteschlüssel, das Relay speichert nur den Hash.

## Relay ausführen

Mit Node.js 22 oder neuer im entpackten Relay-Archiv oder im Repo:

| Variable | Wert |
| --- | --- |
| `PC_BRIDGE_ORIGIN` | Öffentliche HTTPS-Origin des Reverse-Proxys |
| `PC_BRIDGE_ISSUER` | Exakter Issuer des OpenID-Connect-Anbieters |
| `PC_BRIDGE_DEVICES_FILE` | Pfad zur privaten JSON-Zuordnung von Nutzer und Geräteschlüssel-Hash |
| `PC_BRIDGE_SCOPE` | Optional. Standard `pcbridge:invoke` |
| `PC_BRIDGE_LISTEN`, `PC_BRIDGE_PORT` | Optional. Standard `127.0.0.1:8787` |

```sh
node relay/server.mjs
```

### Docker Compose

Kopiere `relay/.env.example` nach `relay/.env` und trage den exakten
OAuth-Issuer ein. Die Vorlage setzt die Projekt-Domain. Passe
`PC_BRIDGE_ORIGIN` für eine eigene Instanz an. Die Geräte-Datei muss
für den Benutzer `node` im Container lesbar sein. Starte den Dienst
aus dem Hauptordner des Repos oder des entpackten Relay-Archivs.

```sh
docker compose --env-file relay/.env -f relay/compose.yaml up -d --build
```

### Öffentliches HTTPS einrichten

Leite die Relay-Subdomain per DNS auf den Server mit deinem HTTPS-Reverse-Proxy.
Ein Proxy auf demselben Host leitet den gesamten Hostnamen an
`http://127.0.0.1:8787` weiter. Er benötigt ein gültiges TLS-Zertifikat
und ein Antwort-Timeout von mindestens 30 Sekunden für `POST /mcp`.

Prüfe für die Projektinstanz die beiden öffentlichen Endpunkte.

```sh
curl -fsS https://relay.maximilian-seewald.de/healthz
curl -fsS https://relay.maximilian-seewald.de/.well-known/oauth-protected-resource/mcp
```

Das OAuth-Metadatendokument muss als `resource` die öffentliche MCP-URL
und unter `authorization_servers` deinen OAuth-Issuer ausgeben.
