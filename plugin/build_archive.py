"""Build a ChatGPT archive for an existing, registered PC-Bridge Site app."""

import argparse
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

VERSION = "0.2.0"


def build_archive(app_id, output):
    app_id = app_id.removeprefix("plugin_")
    if not re.fullmatch(r"asdk_app_[A-Za-z0-9][A-Za-z0-9_-]{0,127}", app_id):
        raise ValueError("Bitte die App-ID deiner veröffentlichten Site angeben.")
    description = "Verbindungstest und lokaler Git-Status über deinen gekoppelten Windows-PC."
    manifest = {
        "name": "pc-bridge-mcp",
        "version": VERSION,
        "description": description,
        "author": {"name": "PC-Bridge"},
        "apps": "./.app.json",
        "interface": {
            "displayName": "PC-Bridge MCP",
            "shortDescription": "Verbindungstest und lesender Git-Status.",
            "longDescription": description,
            "developerName": "PC-Bridge",
            "category": "Productivity",
            "capabilities": ["Read"],
        },
    }
    app = {"apps": {"pc-bridge": {"id": app_id, "required": True}}}
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w") as archive:
        for path, data in {".codex-plugin/plugin.json": manifest, ".app.json": app}.items():
            archive.writestr(
                ZipInfo(path), json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                compress_type=ZIP_DEFLATED,
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app_id", help="asdk_app_… oder plugin_asdk_app_… deiner Site")
    parser.add_argument("--output", type=Path, default=Path("PC-Bridge-Plugin.zip"))
    args = parser.parse_args()
    try:
        build_archive(args.app_id, args.output)
    except ValueError as error:
        parser.error(str(error))
    print(args.output)
