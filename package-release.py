"""Build the three distributable PC-Bridge packages from the repository."""

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
PACKAGES = {
    "PC-Bridge-ChatGPT-Plugin-Baukasten.zip": {
        "plugin/README.md": "README.md",
        "plugin/build_archive.py": "build_archive.py",
    },
    "PC-Bridge-Sites-Relay.zip": {
        "README.md": "README.md",
        ".openai/hosting.json": ".openai/hosting.json",
        "build.mjs": "build.mjs",
        "package.json": "package.json",
        "worker/index.js": "worker/index.js",
        "drizzle/0000_bridge.sql": "drizzle/0000_bridge.sql",
        "drizzle/meta/_journal.json": "drizzle/meta/_journal.json",
    },
    "PC-Bridge-Windows-MCP.zip": {
        f"client/{name}": name
        for name in ("PC-Bridge.cmd", "README.md", "pc-bridge.mjs", "mcp-client.mjs", "mcp-server.mjs")
    },
}


WEB_PACKAGES = {
    "PC-Bridge-Web-Plugin-Builder.zip": {
        "plugin/build_web_archive.py": "build_web_archive.py",
        "plugin/README-web.md": "README.md",
    },
    "PC-Bridge-Web-Relay.zip": {
        **{f"relay/{name}": f"relay/{name}" for name in (
            "server.mjs", "oauth.mjs", "Dockerfile", "devices.example.json"
        )},
        "relay/README.md": "README.md",
    },
    "PC-Bridge-Web-Windows.zip": {
        **{f"client/{name}": name for name in (
            "PC-Bridge-Portable.cmd", "portable-device.mjs", "mcp-client.mjs",
            "mcp-server.mjs", "pc-bridge.example.json"
        )},
        "client/README-portable.md": "README.md",
    },
}


def build_packages(output, packages=PACKAGES):
    output.mkdir(parents=True, exist_ok=True)
    for name, files in packages.items():
        archive_path = output / name
        with ZipFile(archive_path, "w") as archive:
            for source, target in sorted(files.items()):
                content = (ROOT / source).read_bytes()
                if target.endswith(".cmd"):
                    content = content.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
                archive.writestr(ZipInfo(target), content, compress_type=ZIP_DEFLATED)
        print(archive_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "packages")
    parser.add_argument("--web", action="store_true", help="Build the independently hosted Web packages.")
    args = parser.parse_args()
    build_packages(args.output, WEB_PACKAGES if args.web else PACKAGES)
