#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(+process.versions.node.split(".")[0] < 22 ? 1 : 0)'; then
    printf '%s\n' 'Bitte installiere Node.js 22 oder neuer und starte PC-Bridge erneut.' >&2
    exit 1
fi

exec node "$(dirname -- "$0")/pc-bridge.mjs"
