#!/bin/sh
# Shared PreToolUse adapter. Loads the key without printing it.
set -u
export TYPESAFE_HARNESS="${TYPESAFE_HARNESS:-unknown}"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$DIR/gate.py"
