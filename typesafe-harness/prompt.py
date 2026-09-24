#!/usr/bin/env python3
"""UserPromptSubmit / PreInvocation: suggest at most one skill."""

import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gate import ROOT, call_jev, load_api_key, load_config, log, redact  # noqa: E402

SKILL_DIRS = [
    Path.home() / ".agents/skills",
    Path.home() / ".grok/skills",
    Path.home() / ".claude/skills",
    Path.home() / ".codex/skills",
]
ROSTER_PATH = ROOT / "roster.json"
ROSTER_TTL = 3600
DESC_LIMIT = 80


def parse_frontmatter(text):
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    data = {}
    key = None
    chunks = []
    for line in parts[1].splitlines():
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if match:
            if key:
                data[key] = " ".join(chunks).strip().strip('"')
            key = match.group(1)
            chunks = [match.group(2).lstrip("> ").strip()]
        elif key and line.strip():
            chunks.append(line.strip().lstrip("> "))
    if key:
        data[key] = " ".join(chunks).strip().strip('"')
    return data


def build_roster():
    if ROSTER_PATH.is_file() and time.time() - ROSTER_PATH.stat().st_mtime < ROSTER_TTL:
        try:
            return json.loads(ROSTER_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    roster = {}
    for folder in SKILL_DIRS:
        if not folder.is_dir():
            continue
        for skill in folder.glob("*/SKILL.md"):
            meta = parse_frontmatter(skill.read_text(encoding="utf-8", errors="replace")[:4000])
            if str(meta.get("disable-model-invocation", "")).lower() in ("true", "1", "yes"):
                continue
            name = meta.get("name") or skill.parent.name
            if name in roster:
                continue
            description = (meta.get("description") or "")[:DESC_LIMIT]
            roster[name] = description or name
            if len(roster) >= 200:
                break
    ROSTER_PATH.write_text(json.dumps(roster, ensure_ascii=False), encoding="utf-8")
    return roster


def extract_prompt(event):
    for key in ("prompt", "userPrompt", "user_prompt", "text", "message"):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def render(harness, hint):
    if not hint:
        return {}
    if harness == "antigravity":
        return {"injectSteps": [{"ephemeralMessage": hint}]}
    return {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": hint,
        }
    }


def emit(harness, payload):
    if payload in (None, {}):
        if harness != "codex":
            json.dump({}, sys.stdout)
        return
    json.dump(payload, sys.stdout)


def main():
    harness = os.environ.get("TYPESAFE_HARNESS", "unknown")
    raw = sys.stdin.read()
    try:
        event = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        event = {}
    invocation = event.get("invocationNum")
    if invocation not in (None, 0, 1):
        emit(harness, {})
        return
    prompt = extract_prompt(event if isinstance(event, dict) else {})
    if not prompt.strip():
        emit(harness, {})
        return
    config = load_config()
    roster = build_roster()
    api_key = "" if os.environ.get("TYPESAFE_SKIP_API") else load_api_key()
    if not api_key or not roster:
        emit(harness, {})
        return
    criteria = {"none": "No listed skill fits this request."}
    criteria.update({name: (desc or name) for name, desc in roster.items()})
    questions = {
        "needs_skill": {
            "type": "noul",
            "instructions": config["needs_skill_instructions"],
        },
        "skill": {
            "type": "choice",
            "instructions": config["skill_choice_instructions"],
            "criteria": criteria,
        },
    }
    try:
        result = call_jev(
            config,
            api_key,
            {"request": redact(prompt), "roster_size": len(roster)},
            questions,
            timeout=config.get("prompt_timeout_seconds", 8),
        )
        needs = float(result["answers"]["needs_skill"]["noul"])
        skill = result["answers"]["skill"]
        choice = skill["choice"]
        confidence = float(skill.get("confidence") or 0)
        usage = result.get("usage")
    except Exception as exc:
        log({"harness": harness, "event": "prompt", "source": "fallback", "error": type(exc).__name__})
        emit(harness, {})
        return
    hint = ""
    if (
        needs >= config.get("skill_noul_min", 0.35)
        and choice != "none"
        and confidence >= config.get("skill_confidence_min", 0.4)
        and choice in roster
    ):
        hint = (
            f"TypeSafe skill hint: `{choice}` — {roster[choice]}. "
            "Ignore this if it does not fit."
        )
    log({
        "harness": harness,
        "event": "prompt",
        "source": "jev",
        "decision": choice,
        "reason": hint or "no skill",
        "usage": usage,
        "excerpt": redact(prompt),
    })
    emit(harness, render(harness, hint))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit(os.environ.get("TYPESAFE_HARNESS", "unknown"), {})
