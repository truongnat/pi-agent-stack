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
	--exclude '__pycache__' \
	--exclude 'cache.json' \
	--exclude 'decisions.jsonl' \
	"$ROOT_DIR/" "$AGENT_DIR/pi-agent-stack/"

cd "$AGENT_DIR"
pi install npm:@davecodes/pi-dcp@0.2.0
node "$AGENT_DIR/pi-agent-stack/scripts/sync-settings.mjs"

cp "$AGENT_DIR/pi-agent-stack/config/jev-harness.json" "$AGENT_DIR/jev-harness.json"
cp "$AGENT_DIR/pi-agent-stack/config/subscription-providers.json" "$AGENT_DIR/subscription-providers.json"
mkdir -p "$HOME/.pi-dcp"
cp "$AGENT_DIR/pi-agent-stack/config/dcp.json" "$HOME/.pi-dcp/config.json"

# SoL-Pi (NVlabs) — clone if absent, then register user-wide
SOL_PI_DIR="$AGENT_DIR/git/github.com/NVlabs/SoL-Pi"
if [[ ! -d "$SOL_PI_DIR/.git" ]]; then
	echo "Cloning SoL-Pi..."
	mkdir -p "$(dirname "$SOL_PI_DIR")"
	git clone --filter=blob:none https://github.com/NVlabs/SoL-Pi "$SOL_PI_DIR"
else
	echo "SoL-Pi already cloned at $SOL_PI_DIR"
fi
(cd "$SOL_PI_DIR" && npm ci --ignore-scripts --no-audit --no-fund)
pi install "$SOL_PI_DIR" --approve

# Write user-wide sol-pi.json config (observationPack + actionFusion enabled)
cp "$AGENT_DIR/pi-agent-stack/config/sol-pi.json" "$AGENT_DIR/sol-pi.json"

# TypeSafe harness — sync to ~/.agents/typesafe-harness
TYPESAFE_DIR="${TYPESAFE_HARNESS_DIR:-$HOME/.agents/typesafe-harness}"
mkdir -p "$TYPESAFE_DIR"
rsync -a \
	--exclude '__pycache__' \
	--exclude 'cache.json' \
	--exclude 'decisions.jsonl' \
	"$ROOT_DIR/typesafe-harness/" "$TYPESAFE_DIR/"
chmod +x "$TYPESAFE_DIR"/*.sh "$TYPESAFE_DIR"/*.py 2>/dev/null || true

echo
echo "Pi agent stack installed."
echo "  settings: $AGENT_DIR/settings.json"
echo "  JEV config: $AGENT_DIR/jev-harness.json"
echo "  DCP config: $HOME/.pi-dcp/config.json"
echo "  SoL-Pi config: $AGENT_DIR/sol-pi.json"
echo "  TypeSafe harness: $TYPESAFE_DIR"
if [[ -f "$HOME/.keys/jev.env" ]]; then
	echo "  JEV key file: found at ~/.keys/jev.env"
else
	echo "  JEV key file: missing; copy config/jev.env.example to ~/.keys/jev.env"
fi
if [[ -f "$HOME/.keys/typesafe.env" ]]; then
	echo "  TypeSafe key file: found at ~/.keys/typesafe.env"
else
	echo "  TypeSafe key file: missing; add API_KEY to ~/.keys/typesafe.env"
fi

echo "Run: pi list"