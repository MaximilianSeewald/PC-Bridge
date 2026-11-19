# PC-Bridge Web-Relay

Das Relay läuft als Node-Prozess hinter einem HTTPS-Reverse-Proxy. Pro
OAuth-Konto ordnet die Konfiguration einen Geräteschlüssel zu. Der Windows-PC
holt seine Aufträge per HTTPS ab. Der Relay-Prozess hält noch offene Aufträge
im Arbeitsspeicher und führt die MCP-Tools nicht selbst aus.

## OAuth und Geräte konfigurieren

1. Richte bei einem OpenID-Connect-Anbieter eine API ein. Ihre Audience ist
   die Relay-Adresse inklusive `/mcp`, etwa
   `https://bridge.example.org/mcp`. Richte den Scope `pcbridge:invoke` ein.
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

   Trage in einer außerhalb des Repos liegenden JSON-Datei den
   OAuth-`sub` des Nutzers als Schlüssel und dessen Hash als Wert ein.
   Siehe `relay/devices.example.json`. Der PC bekommt
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

Der Reverse-Proxy benötigt eine gültige TLS-Konfiguration und ein Timeout
von mindestens 30 Sekunden für `POST /mcp`. Ein Status 200 auf
`GET /healthz` zeigt, dass der Prozess erreichbar ist. Das Relay publiziert
sein OAuth-Metadatendokument unter `/.well-known/oauth-protected-resource/mcp`.

Alternativ im Repository `docker build -f relay/Dockerfile -t pc-bridge-relay .`
ausführen. Im Container die Gerätezuordnung schreibgeschützt einbinden und
die Umgebungsvariablen setzen.
