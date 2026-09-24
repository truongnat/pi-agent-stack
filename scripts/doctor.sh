#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export PI_CODING_AGENT_DIR="$AGENT_DIR"

fail=0
check_file() {
	if [[ -f "$1" ]]; then
		echo "OK   $1"
	else
		echo "MISS $1"
		fail=1
	fi
}

command -v pi >/dev/null 2>&1 && echo "OK   pi" || { echo "MISS pi"; fail=1; }
command -v node >/dev/null 2>&1 && echo "OK   node $(node --version)" || { echo "MISS node"; fail=1; }
command -v python3 >/dev/null 2>&1 && echo "OK   python3 $(python3 --version | cut -d' ' -f2)" || { echo "MISS python3"; fail=1; }
check_file "$AGENT_DIR/settings.json"
check_file "$AGENT_DIR/jev-harness.json"
check_file "$AGENT_DIR/subscription-providers.json"
check_file "$HOME/.pi-dcp/config.json"
check_file "$AGENT_DIR/sol-pi.json"
check_file "$HOME/.agents/typesafe-harness/gate.py"
check_file "$HOME/.agents/typesafe-harness/pre-tool.sh"
check_file "$AGENT_DIR/pi-agent-stack/packages/pi-rl-engine/package.json"

SOL_PI_DIR="$AGENT_DIR/git/github.com/NVlabs/SoL-Pi"
if [[ -d "$SOL_PI_DIR/.git" ]]; then
	echo "OK   SoL-Pi checkout at $SOL_PI_DIR"
else
	echo "MISS SoL-Pi checkout not found; run scripts/install.sh"
	fail=1
fi

if [[ -f "$HOME/.keys/jev.env" ]]; then
	echo "OK   ~/.keys/jev.env"
else
	echo "WARN ~/.keys/jev.env not found; JEV will stay inactive"
fi

if [[ -f "$HOME/.keys/typesafe.env" ]]; then
	echo "OK   ~/.keys/typesafe.env"
else
	echo "WARN ~/.keys/typesafe.env not found; TypeSafe harness will run in offline/fallback mode"
fi

if [[ -f "$HOME/.claude/.credentials.json" ]]; then
	echo "OK   Claude OAuth credentials found (~/.claude/.credentials.json)"
else
	echo "INFO Claude credentials not found; use /login anthropic if needed"
fi

for cli in cursor-agent agy; do
	if command -v "$cli" >/dev/null 2>&1; then
		echo "OK   $cli"
	else
		echo "WARN $cli not found; that subscription route will be unavailable"
	fi
done

echo
pi list

exit "$fail"