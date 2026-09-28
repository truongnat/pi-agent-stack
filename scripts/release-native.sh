#!/usr/bin/env bash
# Builds the pi-core Node-API addon on this machine and uploads it to the GitHub release
# native-v<version> (crates/pi-core-napi/Cargo.toml), which install.sh downloads from.
# Run it once per platform and version; bump the crate version when crates/ changes.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/native-platform.sh
source "$ROOT_DIR/scripts/native-platform.sh"

VERSION="$(native_version "$ROOT_DIR")"
TAG="native-v$VERSION"
PLATFORM="$(native_platform)"
ASSET="pi_core-$PLATFORM.node"
REPO="${PI_NATIVE_REPO:-truongnat/pi-agent-stack}"
DIST="$ROOT_DIR/crates/target/dist"

cargo build --release -p pi-core-napi --manifest-path "$ROOT_DIR/crates/Cargo.toml" --target-dir "$ROOT_DIR/crates/target"
lib=""
for name in libpi_core_napi.so libpi_core_napi.dylib pi_core_napi.dll; do
	[[ -f "$ROOT_DIR/crates/target/release/$name" ]] && lib="$ROOT_DIR/crates/target/release/$name"
done
[[ -n "$lib" ]] || { echo "build produced no addon" >&2; exit 1; }

mkdir -p "$DIST"
cp "$lib" "$DIST/$ASSET"
strip -x "$DIST/$ASSET" 2>/dev/null || true
native_loads "$DIST/$ASSET" || { echo "built addon does not load in node" >&2; exit 1; }
sha256_of "$DIST/$ASSET" >"$DIST/$ASSET.sha256"

if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
	gh release create "$TAG" -R "$REPO" --title "pi-core native $VERSION" \
		--notes "Prebuilt pi-core Node-API addon. scripts/install.sh downloads the asset for its platform and checks the .sha256."
fi
gh release upload "$TAG" -R "$REPO" --clobber "$DIST/$ASSET" "$DIST/$ASSET.sha256"
echo "Uploaded $ASSET to $REPO release $TAG"
