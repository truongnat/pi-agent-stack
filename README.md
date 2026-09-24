# Pi Agent Stack

Portable local setup for Pi with JEV as the routing/harness layer, subscription-aware Cursor/Antigravity routing, and DCP token/context pruning.

This repository contains the custom code and reproducible configuration from the tuned setup. It does not contain API keys, Pi auth, session history, readiness cache, `node_modules`, or personal absolute paths.

## What is included

- `packages/pi-jev-harness`: JEV harness with route/prefetch/trim/loop/guard, model/thinking policy, subscription-aware routing, and the DCP `compress` tool protected from accidental hiding.
- `packages/pi-subscription-providers`: Pi compatibility providers for `cursor-agent` and `agy` stream-json, with readiness caching and redacted status metadata.
- `NVlabs/SoL-Pi` (cloned from GitHub by `scripts/install.sh`): Observation Pack, Action Fusion, Evidence-Preserving Reducer, and Online Context Compact — context-cost optimizers that run as Pi extensions. Config template is in `config/sol-pi.json`.
- `@davecodes/pi-dcp@0.2.0`: pinned third-party DCP package, installed from npm. Its active config is versioned in `config/dcp.json`; source and license are mirrored under `vendor/pi-dcp` for audit/reference.
- `config/`: portable Pi, JEV, provider, DCP, and environment templates.
- `scripts/install.sh`: stages this repo into `~/.pi/agent/pi-agent-stack`, merges Pi settings, installs DCP, and writes runtime configs.
- `scripts/doctor.sh`: checks the install and available subscription CLIs.

## Install on another Mac

Requirements: Pi, Node 22+, and optionally `cursor-agent` / `agy` for subscription routes.

```bash
git clone <this-repository-url>
cd pi-agent-stack
bash scripts/install.sh
```

The installer preserves unrelated Pi packages/settings, removes the old JEV git checkout and duplicate custom package entries, and installs these defaults:

```text
provider: openai-codex
model:    gpt-5.6-luna
thinking: high
```

JEV is active only when `JEV_API_KEY` is available. Keep the key outside the repo:

```bash
mkdir -p ~/.keys
cp config/jev.env.example ~/.keys/jev.env
# edit ~/.keys/jev.env, then source it from your shell startup or before Pi
source ~/.keys/jev.env
```

Then verify:

```bash
bash scripts/doctor.sh
pi list
pi -p 'Reply with exactly pong.'
```

## Routing and cost policy

JEV decides the model and thinking level from the task. It prefers the cheapest sufficient route and only switches automatically when confidence and savings gates pass. Cursor/Antigravity are compatibility-only answer routes because their stream output is not Pi's native tool-call wire. Explore/change/run/unclear turns are forced back to a native API model, preferring `openai-codex/gpt-5.6-luna`.

DCP handles context cost locally: deduplicates repeated tool results, purges stale error inputs, and exposes `/dcp context`, `/dcp stats`, and the `compress` tool. DCP never mutates the on-disk Pi transcript.

## Useful commands

```text
/jev-harness          # current counters and savings
/jev-harness on       # enable the harness
/jev-harness off      # disable the harness
/subscription-providers refresh
/dcp context
/dcp stats
```

The JEV log is local at `~/.jev-harness/log.jsonl`. The subscription status cache is local at `~/.pi/agent/subscription-providers-status.json` and is intentionally not committed.

## Development

```bash
cd packages/pi-jev-harness && npm ci && npm run check && npm test
cd ../pi-subscription-providers && npm ci && npm run check
```


The vendored DCP source is third-party code under its original AGPL-3.0-or-later license. This stack uses the npm package rather than treating that code as our own.
