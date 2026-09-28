#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export PI_CODING_AGENT_DIR="$AGENT_DIR"

# Published Pi CLI (earendil-works/pi). We install the npm package; we do not vendor the upstream tree.
PI_NPM_PKG="@earendil-works/pi-coding-agent@^0.87.1"

ensure_pi_cli() {
	if command -v pi >/dev/null 2>&1; then
		return 0
	fi
	echo "pi CLI not on PATH — installing ${PI_NPM_PKG} globally..."
	if command -v bun >/dev/null 2>&1; then
		bun add -g "$PI_NPM_PKG"
	elif command -v npm >/dev/null 2>&1; then
		npm install -g "$PI_NPM_PKG"
	else
		echo "need bun or npm to install ${PI_NPM_PKG}" >&2
		exit 1
	fi
	hash -r 2>/dev/null || true
	if ! command -v pi >/dev/null 2>&1; then
		echo "pi still not on PATH after install; add bun/npm global bin to PATH" >&2
		exit 1
	fi
}

if ! command -v bun >/dev/null 2>&1; then
	echo "bun is required: curl -fsSL https://bun.sh/install | bash" >&2
	exit 1
fi

ensure_pi_cli

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
	--exclude '/crates/target' \
	--exclude '/packages/pi-native-bridge/native' \
	"$ROOT_DIR/" "$AGENT_DIR/pi-agent-stack/"

# Native Rust core (pi-core Node-API addon). Downloads the prebuilt release asset for this
# platform (checked against its .sha256 and loaded with node before use). Without one, or with
# PI_NATIVE_FROM_SOURCE=1, it is built: the Rust toolchain is installed when missing and
# --target-dir overrides any global CARGO_TARGET_DIR. PI_SKIP_NATIVE=1 keeps the TS fallbacks.
# shellcheck source=scripts/native-platform.sh
source "$ROOT_DIR/scripts/native-platform.sh"
ensure_cargo() {
	if command -v cargo >/dev/null 2>&1; then
		return 0
	fi
	if [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
		echo "Rust toolchain not found; installing rustup (minimal profile)..."
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
	fi
	export PATH="$HOME/.cargo/bin:$PATH"
}
CRATES_DIR="$AGENT_DIR/pi-agent-stack/crates"
ADDON_DIR="$AGENT_DIR/pi-agent-stack/packages/pi-native-bridge/native"
NATIVE_TAG="native-v$(native_version "$ROOT_DIR")"
NATIVE_ASSET="pi_core-$(native_platform).node"
NATIVE_URL="${PI_NATIVE_BASE_URL:-https://github.com/${PI_NATIVE_REPO:-truongnat/pi-agent-stack}/releases/download/$NATIVE_TAG}"

download_addon() {
	local tmp expected
	tmp="$(mktemp -d)"
	curl -fsSL "$NATIVE_URL/$NATIVE_ASSET.sha256" -o "$tmp/sha" || return 1
	expected="$(tr -d '[:space:]' <"$tmp/sha")"
	if [[ -f "$ADDON_DIR/pi_core.node" && "$(sha256_of "$ADDON_DIR/pi_core.node")" == "$expected" ]]; then
		echo "pi-core addon $NATIVE_TAG ($NATIVE_ASSET) already installed"
		return 0
	fi
	echo "Downloading pi-core addon $NATIVE_TAG ($NATIVE_ASSET)..."
	curl -fsSL "$NATIVE_URL/$NATIVE_ASSET" -o "$tmp/addon" || return 1
	if [[ "$(sha256_of "$tmp/addon")" != "$expected" ]]; then
		echo "warning: $NATIVE_ASSET checksum mismatch; building from source instead" >&2
		return 1
	fi
	native_loads "$tmp/addon" || return 1
	mkdir -p "$ADDON_DIR"
	mv "$tmp/addon" "$ADDON_DIR/pi_core.node"
}

build_addon() {
	ensure_cargo
	echo "Building native Rust core engine (pi-core Node-API addon)..."
	cargo build --release -p pi-core-napi --manifest-path "$CRATES_DIR/Cargo.toml" --target-dir "$CRATES_DIR/target"
	local addon=""
	for name in libpi_core_napi.so libpi_core_napi.dylib pi_core_napi.dll; do
		[[ -f "$CRATES_DIR/target/release/$name" ]] && addon="$CRATES_DIR/target/release/$name"
	done
	if [[ -z "$addon" ]]; then
		echo "pi-core addon build produced no library" >&2
		exit 1
	fi
	mkdir -p "$ADDON_DIR"
	cp "$addon" "$ADDON_DIR/pi_core.node"
}

if [[ "${PI_SKIP_NATIVE:-0}" != 1 ]]; then
	if [[ "${PI_NATIVE_FROM_SOURCE:-0}" == 1 ]] || ! download_addon; then
		[[ "${PI_NATIVE_FROM_SOURCE:-0}" == 1 ]] || echo "No prebuilt $NATIVE_ASSET for $NATIVE_TAG; building from source"
		build_addon
	fi
fi

# Link workspaces and dependencies
(cd "$AGENT_DIR/pi-agent-stack" && bun install)

cd "$AGENT_DIR"
node "$AGENT_DIR/pi-agent-stack/scripts/sync-settings.mjs"

# Register global extension bridges in ~/.pi/agent/extensions/ for 100% reliable command loading
mkdir -p "$AGENT_DIR/extensions"
echo "export { default } from '../pi-agent-stack/packages/pi-jev-harness/index.ts'" > "$AGENT_DIR/extensions/pi-jev-harness.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-subscription-providers/src/extension.ts'" > "$AGENT_DIR/extensions/pi-subscription-providers.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-rl-engine/index.ts'" > "$AGENT_DIR/extensions/pi-rl-engine.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-xlsx2md/index.ts'" > "$AGENT_DIR/extensions/pi-xlsx2md.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-gdrive/index.ts'" > "$AGENT_DIR/extensions/pi-gdrive.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-stitch/index.ts'" > "$AGENT_DIR/extensions/pi-stitch.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-goal/index.ts'" > "$AGENT_DIR/extensions/pi-goal.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-orchestrator/index.ts'" > "$AGENT_DIR/extensions/pi-orchestrator.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-persona/index.ts'" > "$AGENT_DIR/extensions/pi-persona.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-dcp/index.ts'" > "$AGENT_DIR/extensions/pi-dcp.ts"
cp "$AGENT_DIR/pi-agent-stack/config/typesafe-gate.ts" "$AGENT_DIR/extensions/typesafe-gate.ts"
# Ember chrome: model rail above the editor (repaints on every model change), spinner, title.
cp "$AGENT_DIR/pi-agent-stack/extensions/ember-ui.ts" "$AGENT_DIR/extensions/ember-ui.ts"

# Themes (ember, ember-light)
mkdir -p "$AGENT_DIR/themes"
cp "$AGENT_DIR/pi-agent-stack/themes/"*.json "$AGENT_DIR/themes/"

# Bridges left behind by removed packages would fail to import at startup. Only bridges into
# pi-agent-stack/packages are touched; other extensions in the directory are not ours.
for bridge in "$AGENT_DIR/extensions/"*.ts; do
	target="$(sed -n "s#^export { default } from '\.\./\(pi-agent-stack/packages/[^']*\)'.*#\1#p" "$bridge")"
	if [[ -n "$target" && ! -f "$AGENT_DIR/$target" ]]; then
		echo "Removing stale bridge $bridge (target $target is gone)"
		rm -f "$bridge"
	fi
done

# Config files belong to the user once installed (the extensions also save to some of them):
# copy only when missing, and say when the repo's version differs instead of overwriting it.
install_config() {
	local src="$AGENT_DIR/pi-agent-stack/$1" dst="$2"
	mkdir -p "$(dirname "$dst")"
	if [[ ! -f "$dst" ]]; then
		cp "$src" "$dst"
	elif ! cmp -s "$src" "$dst"; then
		echo "Kept your $dst; the repo version differs (diff '$src' '$dst')"
	fi
}
install_config config/jev-harness.json "$AGENT_DIR/jev-harness.json"
install_config config/subscription-providers.json "$AGENT_DIR/subscription-providers.json"
install_config config/orchestrator.json "$AGENT_DIR/orchestrator.json"
install_config config/persona.json "$AGENT_DIR/persona-config.json"
install_config config/AGENTS.md "$AGENT_DIR/AGENTS.md"
install_config config/dcp.json "$HOME/.pi-dcp/config.json"



# SoL-Pi (NVlabs) — clone if absent, then register user-wide
SOL_PI_DIR="$AGENT_DIR/git/github.com/NVlabs/SoL-Pi"
if [[ ! -d "$SOL_PI_DIR/.git" ]]; then
	echo "Cloning SoL-Pi..."
	mkdir -p "$(dirname "$SOL_PI_DIR")"
	git clone --filter=blob:none https://github.com/NVlabs/SoL-Pi "$SOL_PI_DIR"
else
	echo "SoL-Pi already cloned at $SOL_PI_DIR"
fi
(cd "$SOL_PI_DIR" && bun install --ignore-scripts)
pi install "$SOL_PI_DIR" --approve

# Write user-wide sol-pi.json config (observationPack + actionFusion enabled)
install_config config/sol-pi.json "$AGENT_DIR/sol-pi.json"

# TypeSafe harness — sync to ~/.agents/typesafe-harness
TYPESAFE_DIR="${TYPESAFE_HARNESS_DIR:-$HOME/.agents/typesafe-harness}"
mkdir -p "$TYPESAFE_DIR"
rsync -a \
	--exclude '__pycache__' \
	--exclude 'cache.json' \
	--exclude 'decisions.jsonl' \
	"$ROOT_DIR/typesafe-harness/" "$TYPESAFE_DIR/"
chmod +x "$TYPESAFE_DIR"/*.sh "$TYPESAFE_DIR"/*.py 2>/dev/null || true

# Antigravity (agy) reads hooks from ~/.gemini/config/hooks.json. Add the TypeSafe gate block
# only when missing; the file also holds other tools' hooks (ai-memory), which stay as they are.
if command -v agy >/dev/null 2>&1; then
	AGY_HOOKS="$HOME/.gemini/config/hooks.json"
	mkdir -p "$(dirname "$AGY_HOOKS")"
	node -e '
		const fs = require("fs")
		const [file, repoFile] = process.argv.slice(1)
		let hooks = {}
		try { hooks = JSON.parse(fs.readFileSync(file, "utf8")) } catch (e) {
			if (fs.existsSync(file)) { console.error(`warning: ${file} is not valid JSON; agy hooks not added`); process.exit(0) }
		}
		if (hooks["typesafe-gate"]) process.exit(0)
		const home = require("os").homedir()
		const block = JSON.parse(fs.readFileSync(repoFile, "utf8").replaceAll("~/", home + "/"))
		fs.writeFileSync(file, JSON.stringify({ ...hooks, ...block }, null, 2) + "\n")
		console.log(`Added the TypeSafe gate to ${file}`)
	' "$AGY_HOOKS" "$ROOT_DIR/config/agy-hooks.json"
fi

# xlsx2md CLI for pi-xlsx2md, vendored in tools/xlsx2md. Installed into an isolated tool env
# (uv, then pipx, then pip --user) only when no `xlsx2md` is on PATH.
if ! command -v xlsx2md >/dev/null 2>&1; then
	XLSX2MD_SRC="$AGENT_DIR/pi-agent-stack/tools/xlsx2md"
	if command -v uv >/dev/null 2>&1; then
		uv tool install --quiet "$XLSX2MD_SRC"
	elif command -v pipx >/dev/null 2>&1; then
		pipx install --quiet "$XLSX2MD_SRC"
	else
		python3 -m pip install --user --quiet "$XLSX2MD_SRC"
	fi || echo "warning: xlsx2md CLI not installed; pi-xlsx2md tools will fail" >&2
fi

# Global agent skills (config/skills.json) in the shared ~/.agents/skills, which Pi, Codex,
# Cursor, and agy all read. Skills load on demand, so they cost no tokens until used; pi-stitch
# refers to the design skills before sending prompts to Stitch. A skill already present under
# the same SKILL.md `name:` is kept (manual copies are not duplicated); the rest are installed
# per repo in one call, then everything tracked in ~/.agents/.skill-lock.json is updated.
SKILLS_DIR="$HOME/.agents/skills"
SKILLS_JSON="$ROOT_DIR/config/skills.json"
have_skill() { grep -qsx "name: $1" "$SKILLS_DIR"/*/SKILL.md; }
manifest() { node -e "$1" "$SKILLS_JSON"; }

# 1. Public repos, one `skills add` per repo for whatever is missing.
while IFS=$'\t' read -r repo depth names; do
	missing=()
	for name in $names; do have_skill "$name" || missing+=("$name"); done
	if ((${#missing[@]})); then
		echo "skills from $repo: installing ${missing[*]}"
		flags=(-g -y -a codex)
		[[ "$depth" == 1 ]] && flags+=(--full-depth)
		# </dev/null: bunx must not read the remaining manifest lines from this loop's stdin.
		bunx skills add "$repo" -s "${missing[@]}" "${flags[@]}" </dev/null >/dev/null ||
			echo "warning: could not install skills from $repo" >&2
	fi
done < <(manifest 'for (const s of require(process.argv[1]).sources)
	console.log([s.repo, s.fullDepth ? 1 : 0, s.skills.join(" ")].join("\t"))')

# 2. Personal skills without a public source, vendored in ./skills (never overwrite local edits).
for name in $(manifest 'console.log(require(process.argv[1]).vendored.join(" "))'); do
	have_skill "$name" || { mkdir -p "$SKILLS_DIR" && cp -R "$ROOT_DIR/skills/$name" "$SKILLS_DIR/$name"; }
done

# 3. Skills shipped by their own CLI, installed only when that CLI is present.
if command -v ai-memory >/dev/null 2>&1 && ! have_skill ai-memory-retrieval; then
	# --target: the instruction snippet goes to a scratch file, only the skills are kept.
	ai-memory install-instructions --target "$(mktemp)" --skills-scope global --skills-agent agents \
		>/dev/null || echo "warning: ai-memory skills not installed" >&2
fi

# Updating touches every global skill the user has, not only this stack's: opt in.
if [[ "${PI_UPDATE_SKILLS:-0}" == 1 ]]; then
	bunx skills update -g -y >/dev/null || echo "warning: skills update failed" >&2
fi

echo
echo "Pi agent stack installed."
echo "  settings: $AGENT_DIR/settings.json"
echo "  JEV config: $AGENT_DIR/jev-harness.json"
echo "  DCP config: $HOME/.pi-dcp/config.json"
echo "  SoL-Pi config: $AGENT_DIR/sol-pi.json"
echo "  TypeSafe harness: $TYPESAFE_DIR"
echo "  Harness RL Engine: $AGENT_DIR/extensions/pi-rl-engine.ts"
if [[ -f "$HOME/.keys/jev.env" ]]; then
	echo "  JEV key file: found at ~/.keys/jev.env"
else
	echo "  JEV key file: missing; copy config/jev.env.example to ~/.keys/jev.env"
fi
if [[ -f "$HOME/.keys/typesafe.env" ]]; then
	echo "  TypeSafe key file: found at ~/.keys/typesafe.env"
else
	echo "  TypeSafe key file: missing; copy config/typesafe.env.example to ~/.keys/typesafe.env"
fi
if [[ -f "$HOME/.keys/stitch.env" || -f "$HOME/.keys/stitch.key" || -f "$HOME/.keys/stitch-api-key" ]]; then
	echo "  Stitch key file: found at ~/.keys/stitch.env"
else
	echo "  Stitch key file: missing; copy config/stitch.env.example to ~/.keys/stitch.env or run /stitch key"
fi

echo "Run: pi list"