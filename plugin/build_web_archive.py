"""Build a portable PC-Bridge plugin ZIP for an independently hosted MCP relay."""

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def build_archive(origin, output, scope, mode, client_id):
    address = urlsplit(origin)
    if (
        address.scheme != "https" or not address.hostname or address.username or address.password
        or address.path not in ("", "/") or address.query or address.fragment
    ):
        raise ValueError("Use the public HTTPS origin of the relay.")
    if not re.fullmatch(r"[A-Za-z0-9_.:-]+", scope):
        raise ValueError("Invalid OAuth scope.")
    if (mode == "provided") != bool(client_id):
        raise ValueError("Supply --client-id with --client-mode provided.")
    client = {"mode": mode}
    if client_id:
        client.update({"clientId": client_id, "tokenEndpointAuthMethod": "none"})
    manifest = {
        "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        "name": "pc-bridge",
        "version": "0.3.0",
        "description": "Call permitted MCP tools running on a paired local PC.",
        "author": {"name": "PC-Bridge"},
        "repository": "https://github.com/MaximilianSeewald/PC-Bridge",
        "extensions": {
            "com.openai": {
                "interface": {
                    "displayName": "PC-Bridge",
                    "shortDescription": "Call permitted MCP tools on a paired local PC.",
                    "longDescription": "Connect to your PC-Bridge relay to use the MCP tools you enabled on your PC.",
                    "developerName": "PC-Bridge",
                    "category": "Productivity",
                }
            }
        },
    }
    mcp = {
        "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        "mcpServers": {
            "pc-bridge": {
                "type": "streamable-http",
                "url": origin.rstrip("/") + "/mcp",
                "extensions": {
                    "com.openai": {"auth": {"type": "oauth", "client": client, "baseScopes": [scope]}}
                },
            }
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w") as archive:
        for path, data in {"plugin.json": manifest, "mcp.json": mcp}.items():
            archive.writestr(ZipInfo(path), json.dumps(data, indent=2) + "\n", compress_type=ZIP_DEFLATED)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", help="Public HTTPS relay origin")
    parser.add_argument("--client-mode", choices=["provided", "dcr", "cimd"], default="provided")
    parser.add_argument("--client-id", help="Public OAuth client ID for authorisation code with PKCE")
    parser.add_argument("--scope", default="pcbridge:invoke")
    parser.add_argument("--output", type=Path, default=Path("PC-Bridge-Web.zip"))
    args = parser.parse_args()
    try:
        build_archive(args.origin, args.output, args.scope, args.client_mode, args.client_id)
    except ValueError as error:
        parser.error(str(error))
    print(args.output)
