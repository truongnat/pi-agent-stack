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
check_file "$AGENT_DIR/settings.json"
check_file "$AGENT_DIR/jev-harness.json"
check_file "$AGENT_DIR/subscription-providers.json"
check_file "$HOME/.pi-dcp/config.json"

if [[ -f "$HOME/.keys/jev.env" ]]; then
	echo "OK   ~/.keys/jev.env"
else
	echo "WARN ~/.keys/jev.env not found; JEV will stay inactive"
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