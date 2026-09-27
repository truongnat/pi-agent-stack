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
check_file "$AGENT_DIR/orchestrator.json"
check_file "$AGENT_DIR/persona-config.json"
check_file "$AGENT_DIR/themes/ember.json"
check_file "$AGENT_DIR/themes/ember-light.json"
check_file "$HOME/.pi-dcp/config.json"

check_file "$AGENT_DIR/sol-pi.json"
check_file "$HOME/.agents/typesafe-harness/gate.py"
check_file "$HOME/.agents/typesafe-harness/pre-tool.sh"
check_file "$AGENT_DIR/pi-agent-stack/packages/pi-rl-engine/package.json"
check_file "$AGENT_DIR/pi-agent-stack/packages/pi-goal/package.json"
check_file "$AGENT_DIR/pi-agent-stack/packages/pi-orchestrator/package.json"
check_file "$AGENT_DIR/pi-agent-stack/packages/pi-persona/package.json"


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

if [[ -f "$HOME/.keys/stitch.env" || -f "$HOME/.keys/stitch.key" || -f "$HOME/.keys/stitch-api-key" ]]; then
	echo "OK   ~/.keys/stitch.env"
else
	echo "INFO ~/.keys/stitch.env not found; Google Stitch tools will stay inactive (or run /stitch key)"
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

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
native_lib=""
for cand in \
	"$AGENT_DIR/pi-agent-stack/crates/pi-core/target/release/libpi_core.dylib" \
	"$AGENT_DIR/pi-agent-stack/crates/pi-core/target/release/libpi_core.so" \
	"$AGENT_DIR/pi-agent-stack/crates/pi-core/target/release/pi_core.dll" \
	"$ROOT_DIR/crates/pi-core/target/release/libpi_core.dylib" \
	"$ROOT_DIR/crates/pi-core/target/release/libpi_core.so" \
	"$ROOT_DIR/crates/pi-core/target/release/pi_core.dll"
do
	if [[ -f "$cand" ]]; then
		native_lib="$cand"
		break
	fi
done

if [[ -n "$native_lib" ]]; then
	echo "OK   native pi-core at $native_lib"
	if command -v bun >/dev/null 2>&1; then
		if bun -e "
			import { isNativeAvailable, getNativeVersion } from '${ROOT_DIR}/packages/pi-native-bridge/src/index.ts'
			if (!isNativeAvailable()) {
				console.error('FFI load failed; version=' + getNativeVersion())
				process.exit(1)
			}
			console.log('OK   pi-core FFI ' + getNativeVersion())
		"; then
			:
		else
			echo "MISS pi-core FFI failed to load"
			fail=1
		fi
	else
		echo "WARN bun not on PATH; skipped FFI probe"
	fi
elif command -v cargo >/dev/null 2>&1; then
	echo "MISS native pi-core dylib (cargo is installed; run bun run setup or cargo build --release -p pi-core)"
	fail=1
else
	echo "WARN native pi-core not built (no cargo); TypeScript fallbacks are in use"
fi

echo
pi list

exit "$fail"