#!/usr/bin/env python3
"""PreToolUse gate. Code handles obvious calls. Jev judges the rest.

Stdout is one JSON object for the harness. The log never includes the API key.
"""

import hashlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "questions.json"
LOG_PATH = ROOT / "decisions.jsonl"
CACHE_PATH = ROOT / "cache.json"
KEY_PATH = Path.home() / ".keys" / "typesafe.env"
EXCERPT_LIMIT = 1500
CACHE_TTL_SECONDS = 3
LOG_LIMIT_BYTES = 1_000_000
socket.setdefaulttimeout(2.0)


def load_config():
    with CONFIG_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_api_key():
    if os.environ.get("API_KEY"):
        return os.environ["API_KEY"]
    if not KEY_PATH.is_file():
        return ""
    for line in KEY_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.removeprefix("export ").strip()
        if name == "API_KEY":
            return value.strip().strip('"').strip("'")
    return ""


def redact(text):
    text = re.sub(
        r"(?i)(api[_-]?key|token|secret|bearer|authorization)\s*[=:]\s*\S+",
        r"\1=<redacted>",
        text,
    )
    return text[:EXCERPT_LIMIT]


def extract(event):
    tool = event.get("toolName") or event.get("tool_name") or ""
    payload = event.get("toolInput") or event.get("tool_input") or {}
    call = event.get("toolCall")
    if isinstance(call, dict):
        tool = call.get("name") or tool
        payload = call.get("args") or payload
    if not isinstance(payload, dict):
        payload = {"value": str(payload)}
    command = str(
        payload.get("command")
        or payload.get("CommandLine")
        or payload.get("cmd")
        or ""
    )
    path = str(
        payload.get("file_path")
        or payload.get("path")
        or payload.get("target_file")
        or payload.get("filePath")
        or ""
    )
    return str(tool or "unknown"), command, path


def matches(patterns, text):
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def classify_without_model(config, tool, command):
    name = tool.lower()
    if name in {item.lower() for item in config["read_only_tools"]}:
        return "read"
    if name in {item.lower() for item in config["shell_tools"]}:
        if matches(config.get("deny_shell", []), command):
            return "forbid"
        if matches(config["destructive_shell"], command):
            return "destructive"
        if re.search(r"[|><;&`$]", command):
            return "shell"
        if matches(config["read_only_shell"], command.strip()):
            return "read"
        return "shell"
    if name in {item.lower() for item in config["write_tools"]}:
        return "write"
    return "other"


def fallback(harness, kind):
    """Basic-safe permissions used when JEV is unreachable.

    Keeps the agent unblocked for normal coding work while still
    escalating destructive commands for manual review.

    Kinds:
      read        -> always allow (no model needed)
      write       -> allow (routine file edits; reversible)
      shell       -> allow (non-destructive shell work)
      other       -> allow (unknown tool; fail-open)
      destructive -> ask  (hard to undo; keep human in loop)
    """
    if harness == "antigravity":
        if kind in {"read", "write", "shell", "other"}:
            return "allow", f"jev unavailable, basic allow ({kind})"
        if kind == "destructive":
            return "ask", "destructive call: jev unavailable, manual review"
        return "allow", f"jev unavailable, basic allow ({kind})"
    return "none", "typesafe gate left this call to the harness"


def decide_from_answers(config, harness, answers):
    disposition = answers["disposition"]
    hard = float(answers["hard_to_undo"]["noul"])
    choice = disposition["choice"]
    confidence = float(disposition.get("confidence") or 0)
    if choice == "deny" and confidence >= config.get("deny_confidence", 0.75):
        return "deny", f"jev deny confidence {confidence:.2f} hard-to-undo {hard:.2f}"
    # Pi: Jev is the decision. Never escalate to the human.
    if harness == "pi":
        return "none", f"jev {choice} confidence {confidence:.2f}; harness proceeds"
    if hard >= config["hard_to_undo_ask"] or choice in {"ask", "deny"} or confidence < config["allow_confidence"]:
        return "ask", f"jev {choice} confidence {confidence:.2f} hard-to-undo {hard:.2f}"
    if harness == "antigravity":
        return "allow", f"jev allow confidence {confidence:.2f}"
    return "none", f"jev allow confidence {confidence:.2f}; harness permission stands"


def call_jev(config, key, state, questions=None, timeout=None):
    body = {
        "model": config["model"],
        "state": state,
        "questions": questions or {
            "disposition": {
                "type": "choice",
                "instructions": config["disposition_instructions"],
                "criteria": config["disposition_criteria"],
            },
            "hard_to_undo": {
                "type": "noul",
                "instructions": config["hard_to_undo_instructions"],
            },
        },
    }
    request = urllib.request.Request(
        config["endpoint"],
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout or config["timeout_seconds"]) as response:
        return json.loads(response.read().decode("utf-8"))


def cache_key(harness, policy, tool, excerpt):
    digest = hashlib.sha256(f"{harness}\n{policy}\n{tool}\n{excerpt}".encode("utf-8")).hexdigest()
    slot = int(time.time() // CACHE_TTL_SECONDS)
    return f"{digest}:{slot}"


def cache_get(key):
    if not CACHE_PATH.is_file():
        return None
    try:
        cached = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    item = cached.get(key)
    if not item:
        return None
    if time.time() - item.get("at", 0) > CACHE_TTL_SECONDS:
        return None
    return item.get("decision")


def cache_put(key, decision):
    cached = {}
    if CACHE_PATH.is_file():
        try:
            cached = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached = {}
    now = time.time()
    cached = {
        name: item
        for name, item in cached.items()
        if now - item.get("at", 0) <= CACHE_TTL_SECONDS
    }
    cached[key] = {"at": now, "decision": decision}
    CACHE_PATH.write_text(json.dumps(cached), encoding="utf-8")


def log(record):
    try:
        if LOG_PATH.is_file() and LOG_PATH.stat().st_size > LOG_LIMIT_BYTES:
            lines = LOG_PATH.read_text(encoding="utf-8").splitlines()[-200:]
            LOG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        return


def render(harness, decision, reason):
    if harness == "codex":
        # Codex PreToolUse: empty stdout = allow. Schema rejects `{}`,
        # top-level `decision`, and permissionDecision values other than allow|deny.
        # `ask` is unsupported; leave the call to Codex's own approval policy.
        if decision == "deny":
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        return None
    if decision == "none":
        return {}
    if harness == "antigravity":
        return {"decision": decision, "reason": reason}
    return {
        "decision": decision,
        "reason": reason,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        },
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
    config = load_config()
    tool, command, path = extract(event if isinstance(event, dict) else {})
    kind = classify_without_model(config, tool, command)
    excerpt = redact(f"tool={tool}\ncommand={command}\npath={path}")
    policy = "antigravity" if harness == "antigravity" else "strict"
    key = cache_key(harness, policy, tool, excerpt)
    cached = cache_get(key)
    if cached is not None:
        log({"harness": harness, "tool": tool, "kind": kind, "source": "cache", "decision": cached})
        emit(harness, cached)
        return

    source = "code"
    usage = None
    error = ""
    if kind == "read":
        decision, reason = ("allow", "read-only call") if harness == "antigravity" else ("none", "read-only call")
    elif kind == "write":
        # Edit/write is the agent's job. Skip Jev so the loop stays fast.
        decision, reason = ("allow", "routine write") if harness == "antigravity" else ("none", "write, harness proceeds")
    elif kind == "forbid":
        decision, reason = "deny", "code: destructive call blocked"
    else:
        api_key = "" if os.environ.get("TYPESAFE_SKIP_API") else load_api_key()
        if not api_key:
            decision, reason = fallback(harness, kind)
            source = "fallback"
            error = "no api key" if not os.environ.get("TYPESAFE_SKIP_API") else "skipped"
        else:
            try:
                result = call_jev(config, api_key, {"tool_call": excerpt, "harness": harness})
                decision, reason = decide_from_answers(config, harness, result["answers"])
                usage = result.get("usage")
                source = "jev"
            except Exception as exc:
                decision, reason = fallback(harness, kind)
                source = "fallback"
                error = type(exc).__name__

    rendered = render(harness, decision, reason)
    cache_put(key, rendered)
    log({
        "harness": harness,
        "tool": tool,
        "kind": kind,
        "source": source,
        "decision": decision,
        "reason": reason,
        "usage": usage,
        "error": error,
        "excerpt": excerpt,
    })
    emit(harness, rendered)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        harness = os.environ.get("TYPESAFE_HARNESS", "unknown")
        if harness == "antigravity":
            json.dump({"decision": "ask", "reason": "typesafe gate failed"}, sys.stdout)
        else:
            emit(harness, {})
