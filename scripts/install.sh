#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export PI_CODING_AGENT_DIR="$AGENT_DIR"

if ! command -v pi >/dev/null 2>&1; then
	echo "pi is not installed or is not on PATH" >&2
	exit 1
fi
if ! command -v node >/dev/null 2>&1; then
	echo "node is required (Node 22+)" >&2
	exit 1
fi

mkdir -p "$AGENT_DIR/pi-agent-stack"
rsync -a --delete \
	--exclude '.git' \
	--exclude 'node_modules' \
	--exclude '.pi' \
	"$ROOT_DIR/" "$AGENT_DIR/pi-agent-stack/"

cd "$AGENT_DIR"
pi install npm:@davecodes/pi-dcp@0.2.0
node "$AGENT_DIR/pi-agent-stack/scripts/sync-settings.mjs"

cp "$AGENT_DIR/pi-agent-stack/config/jev-harness.json" "$AGENT_DIR/jev-harness.json"
cp "$AGENT_DIR/pi-agent-stack/config/subscription-providers.json" "$AGENT_DIR/subscription-providers.json"
mkdir -p "$HOME/.pi-dcp"
cp "$AGENT_DIR/pi-agent-stack/config/dcp.json" "$HOME/.pi-dcp/config.json"

echo
echo "Pi agent stack installed."
echo "  settings: $AGENT_DIR/settings.json"
echo "  JEV config: $AGENT_DIR/jev-harness.json"
echo "  DCP config: $HOME/.pi-dcp/config.json"
if [[ -f "$HOME/.keys/jev.env" ]]; then
	echo "  JEV key file: found at ~/.keys/jev.env"
else
	echo "  JEV key file: missing; copy config/jev.env.example to ~/.keys/jev.env"
fi

echo "Run: pi list"