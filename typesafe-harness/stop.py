#!/usr/bin/env python3
"""Stop gate. Block a completion claim that the turn's evidence does not support."""

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gate import call_jev, load_api_key, load_config, log, redact  # noqa: E402

CLAIM_WINDOW = 2500


def extract_message(event):
    for key in ("lastAssistantMessage", "last_assistant_message", "assistantMessage"):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, dict):
            text = value.get("text") or value.get("content")
            if isinstance(text, str) and text.strip():
                return text
    path = event.get("transcriptPath") or event.get("transcript_path")
    if path and Path(path).is_file():
        try:
            lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            lines = []
        for line in reversed(lines[-80:]):
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            role = str(row.get("role") or row.get("type") or "")
            if "assistant" in role or role in {"model", "ai"}:
                text = row.get("text") or row.get("content") or row.get("message")
                if isinstance(text, list):
                    text = " ".join(
                        part.get("text", "") if isinstance(part, dict) else str(part)
                        for part in text
                    )
                if isinstance(text, str) and text.strip():
                    return text
    return ""


def has_claim(config, text):
    return bool(re.search(config["claim_pattern"], text, re.IGNORECASE))


def render(harness, block, reason):
    if not block:
        return {}
    if harness == "antigravity":
        return {"decision": "continue", "reason": reason}
    return {"decision": "block", "reason": reason}


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
    reason_field = str(event.get("reason") or event.get("terminationReason") or "end_turn")
    if reason_field not in {"end_turn", "model_stop", ""}:
        emit(harness, {})
        return
    config = load_config()
    message = extract_message(event if isinstance(event, dict) else {})
    tail = message[-CLAIM_WINDOW:]
    if not has_claim(config, tail):
        log({"harness": harness, "event": "stop", "source": "code", "decision": "allow", "reason": "no completion claim"})
        emit(harness, {})
        return
    api_key = "" if os.environ.get("TYPESAFE_SKIP_API") else load_api_key()
    if not api_key:
        log({"harness": harness, "event": "stop", "source": "fallback", "decision": "allow", "reason": "no api key"})
        emit(harness, {})
        return
    questions = {
        "relation": {
            "type": "choice",
            "instructions": config["claim_instructions"],
            "criteria": config["claim_criteria"],
        }
    }
    try:
        result = call_jev(
            config,
            api_key,
            {"claim": redact(tail), "note": "Judge only what this message itself shows as evidence."},
            questions,
        )
        answer = result["answers"]["relation"]
        choice = answer["choice"]
        confidence = float(answer.get("confidence") or 0)
        usage = result.get("usage")
        source = "jev"
        error = ""
    except Exception as exc:
        log({"harness": harness, "event": "stop", "source": "fallback", "decision": "allow", "error": type(exc).__name__})
        emit(harness, {})
        return
    min_conf = float(config.get("claim_confidence", 0.7))
    # Only block when the message evidence is against the claim.
    # `says_nothing` fires on ordinary wrap-ups that do not paste logs;
    # blocking those loops Codex Stop on every finished turn.
    if choice == "contradicts" and confidence >= min(0.6, min_conf):
        block = True
    else:
        block = False
    reason = (
        f"Completion claim is {choice} (confidence {confidence:.2f}). "
        "Show the command and its output before finishing."
    )
    log({
        "harness": harness,
        "event": "stop",
        "source": source,
        "decision": "block" if block else "allow",
        "reason": reason,
        "usage": usage,
        "error": error,
        "excerpt": redact(tail),
    })
    emit(harness, render(harness, block, reason))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit(os.environ.get("TYPESAFE_HARNESS", "unknown"), {})
