#!/usr/bin/env python3
"""Print the TypeSafe API key to stdout. Used by Pi !command auth. Never logs."""
from pathlib import Path
import os
import sys

KEY_PATH = Path.home() / ".keys" / "typesafe.env"


def load_api_key():
    if os.environ.get("API_KEY"):
        return os.environ["API_KEY"].strip().strip('"').strip("'")
    if os.environ.get("TYPESAFE_API_KEY"):
        return os.environ["TYPESAFE_API_KEY"].strip().strip('"').strip("'")
    if not KEY_PATH.is_file():
        return ""
    for line in KEY_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.removeprefix("export ").strip()
        if name in {"API_KEY", "TYPESAFE_API_KEY"}:
            return value.strip().strip('"').strip("'")
    return ""


def main():
    key = load_api_key()
    if not key:
        sys.stderr.write("no TypeSafe API key in ~/.keys/typesafe.env\n")
        sys.exit(1)
    sys.stdout.write(key)


if __name__ == "__main__":
    main()
