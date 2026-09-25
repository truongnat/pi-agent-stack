---
name: redmine
description: >-
  Query and update VietIS Redmine tickets (get issue, list issues, comment,
  log time) via the REST API, without needing browser login or the MCP
  server. Use when the user pastes a redmine.vietis.com.vn issue link/ID,
  says "check ticket", "xem ticket", "log time", or asks about a bug/task
  tracked in Redmine.
---

# redmine

Stdlib-only REST client at `redmine.py` in this skill's folder. No MCP server, no npx, no browser needed — works headless.

Auth key already lives at `~/.cursor/mcp-redmine/api-key` (chmod 600). Base URL defaults to `https://redmine.vietis.com.vn:93/redmine`.

## Get a ticket

```bash
python3 ~/.agents/skills/redmine/redmine.py get 239504 --notes
```

Prints the issue JSON (subject, status, description, custom fields, journals/comments if `--notes`). Summarize the relevant fields for the user — don't paste raw JSON unless asked.

## List tickets

```bash
python3 ~/.agents/skills/redmine/redmine.py list --project 466 --status open --limit 50
```

Default project is `466` (BSN.IPalet.Geni). `--status *` for all statuses.

## Comment on a ticket

```bash
python3 ~/.agents/skills/redmine/redmine.py comment 239504 "Fixed in commit abc123"
```

This writes to Redmine — confirm with the user before running it, same as any other shared-state action.

## Log time

```bash
python3 ~/.agents/skills/redmine/redmine.py log-time 239504 --date 2026-09-21 --hours 2 --comment "Investigate bug"
```

Default `activity_id` is 16 (Coding) — check the user's usual activity if unsure. Also writes shared state; confirm before running.

## If the key is missing or rejected

Tell the user to open Redmine → My account → API access key, and save it to `~/.cursor/mcp-redmine/api-key`. Don't try to guess or fetch it another way.
