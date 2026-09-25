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

(cd "$AGENT_DIR/pi-agent-stack" && npm install --no-audit --no-fund --ignore-scripts)

cd "$AGENT_DIR"
pi install npm:@davecodes/pi-dcp@0.2.0
node "$AGENT_DIR/pi-agent-stack/scripts/sync-settings.mjs"

# Register global extension bridges in ~/.pi/agent/extensions/ for 100% reliable command loading
mkdir -p "$AGENT_DIR/extensions"
echo "export { default } from '../pi-agent-stack/packages/pi-jev-harness/index.ts'" > "$AGENT_DIR/extensions/pi-jev-harness.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-subscription-providers/src/extension.ts'" > "$AGENT_DIR/extensions/pi-subscription-providers.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-rl-engine/index.ts'" > "$AGENT_DIR/extensions/pi-rl-engine.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-redmine/index.ts'" > "$AGENT_DIR/extensions/pi-redmine.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-xlsx2md/index.ts'" > "$AGENT_DIR/extensions/pi-xlsx2md.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-gdrive/index.ts'" > "$AGENT_DIR/extensions/pi-gdrive.ts"
echo "export { default } from '../pi-agent-stack/packages/pi-stitch/index.ts'" > "$AGENT_DIR/extensions/pi-stitch.ts"
cp "$AGENT_DIR/pi-agent-stack/config/typesafe-gate.ts" "$AGENT_DIR/extensions/typesafe-gate.ts"

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
		# </dev/null: npx must not read the remaining manifest lines from this loop's stdin.
		npx -y skills add "$repo" -s "${missing[@]}" "${flags[@]}" </dev/null >/dev/null ||
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
if command -v bsk >/dev/null 2>&1 && ! have_skill browser-skill; then
	bsk install-skill -H codex -y --quiet || echo "warning: browser-skill not installed" >&2
fi

npx -y skills update -g -y >/dev/null || echo "warning: skills update failed" >&2

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
	echo "  TypeSafe key file: missing; add API_KEY to ~/.keys/typesafe.env"
fi

echo "Run: pi list"