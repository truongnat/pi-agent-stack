#!/usr/bin/env bash
# Shared by install.sh and release-native.sh: the release asset name for this machine.
# shellcheck disable=SC2034  # read by the scripts that source this file

native_version() {
	sed -n 's/^version = "\(.*\)"/\1/p' "$1/crates/pi-core-napi/Cargo.toml" | head -1
}

native_platform() {
	local os arch
	case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) os="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) arch="$(uname -m)" ;;
	esac
	echo "$os-$arch"
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

# Loads the addon with node, the way Pi does; fails if it cannot.
native_loads() {
	node -e "const m = { exports: {} }; process.dlopen(m, process.argv[1]); m.exports.version()" "$1" 2>/dev/null
}
