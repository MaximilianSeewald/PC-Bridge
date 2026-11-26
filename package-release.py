"""Build the Windows, Linux and ChatGPT Sites release archives."""

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
CLIENT_FILES = {
    f"client/{name}": name
    for name in (
        "README.md", "pc-bridge.mjs", "unity-mcp.mjs", "unity-tools.json",
        "project-git.mjs", "git-tools.json", "unity-image-import.mjs", "blender-mcp.mjs",
        "unity-asset-import.mjs", "blender-fbx-to-unity.mjs", "blender-files.mjs",
    )
}
PACKAGES = {
    "PC-Bridge-Sites-Relay.zip": {
        "README.md": "README.md",
        ".openai/hosting.json": ".openai/hosting.json",
        "build.mjs": "build.mjs",
        "package.json": "package.json",
        "worker/index.js": "worker/index.js",
        "client/unity-tools.json": "client/unity-tools.json",
        "client/git-tools.json": "client/git-tools.json",
        "drizzle/0000_bridge.sql": "drizzle/0000_bridge.sql",
        "drizzle/0001_unity_arguments.sql": "drizzle/0001_unity_arguments.sql",
        "drizzle/meta/_journal.json": "drizzle/meta/_journal.json",
    },
    "PC-Bridge-Windows-MCP.zip": {
        **CLIENT_FILES,
        "client/PC-Bridge.cmd": "PC-Bridge.cmd",
        "client/PC-Bridge-Testmodus.cmd": "PC-Bridge-Testmodus.cmd",
        "client/firewall-notifications.ps1": "firewall-notifications.ps1",
        "client/pc-bridge.config.example.json": "pc-bridge.config.example.json",
    },
    "PC-Bridge-Linux-MCP.zip": {
        **CLIENT_FILES,
        "client/pc-bridge.sh": "pc-bridge.sh",
        "client/pc-bridge.config.linux.example.json": "pc-bridge.config.example.json",
    },
}


def build_packages(output):
    output.mkdir(parents=True, exist_ok=True)
    for name, files in PACKAGES.items():
        archive_path = output / name
        with ZipFile(archive_path, "w") as archive:
            for source, target in sorted(files.items()):
                content = (ROOT / source).read_bytes()
                if source == ".openai/hosting.json":
                    manifest = json.loads(content)
                    manifest.pop("project_id", None)
                    content = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
                elif target.endswith(".cmd"):
                    content = content.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
                entry = ZipInfo(target)
                if target.endswith(".sh"):
                    entry.create_system = 3  # Unix
                    entry.external_attr = 0o100755 << 16
                archive.writestr(entry, content, compress_type=ZIP_DEFLATED)
        print(archive_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "packages")
    build_packages(parser.parse_args().output)
