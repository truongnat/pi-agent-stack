#!/usr/bin/env python3
"""Minimal Redmine REST client for VietIS (https://redmine.vietis.com.vn:93/redmine).

Auth: ~/.cursor/mcp-redmine/api-key (chmod 600), or $REDMINE_API_KEY.
No deps beyond stdlib.
"""
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

BASE_URL = os.environ.get("REDMINE_URL", "https://redmine.vietis.com.vn:93/redmine")
KEY_FILE = os.path.expanduser(os.environ.get("REDMINE_API_KEY_FILE", "~/.cursor/mcp-redmine/api-key"))

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE


def _api_key():
    if os.environ.get("REDMINE_API_KEY"):
        return os.environ["REDMINE_API_KEY"]
    with open(KEY_FILE) as f:
        return f.read().strip()


def _request(path, method="GET", data=None):
    url = f"{BASE_URL}{path}"
    headers = {"X-Redmine-API-Key": _api_key()}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, context=_ctx) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {method} {url}: {e.read().decode()}", file=sys.stderr)
        raise


def cmd_get(args):
    include = "journals" if args.notes else ""
    d = _request(f"/issues/{args.id}.json?include={include}")
    print(json.dumps(d["issue"], ensure_ascii=False, indent=2))


def cmd_list(args):
    q = f"?project_id={args.project}&status_id={args.status}&limit={args.limit}&sort=id:desc"
    d = _request(f"/issues.json{q}")
    for i in d["issues"]:
        print(f"#{i['id']}\t{i['status']['name']}\t{i['subject']}")


def cmd_comment(args):
    _request(f"/issues/{args.id}.json", method="PUT", data={"issue": {"notes": args.text}})
    print(f"Commented on #{args.id}")


def cmd_log_time(args):
    entry = {"issue_id": args.id, "spent_on": args.date, "hours": args.hours,
              "comments": args.comment, "activity_id": args.activity}
    d = _request("/time_entries.json", method="POST", data={"time_entry": entry})
    print(f"Logged {args.hours}h on {args.date} for #{args.id}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("get", help="fetch one issue as JSON")
    g.add_argument("id", type=int)
    g.add_argument("--notes", action="store_true", help="include journals/comments")
    g.set_defaults(func=cmd_get)

    l = sub.add_parser("list", help="list issues")
    l.add_argument("--project", default="466", help="project id (default 466 = BSN.IPalet.Geni)")
    l.add_argument("--status", default="*", help="status id or * for all (default *)")
    l.add_argument("--limit", type=int, default=100)
    l.set_defaults(func=cmd_list)

    c = sub.add_parser("comment", help="add a note to an issue")
    c.add_argument("id", type=int)
    c.add_argument("text")
    c.set_defaults(func=cmd_comment)

    t = sub.add_parser("log-time", help="log a time entry")
    t.add_argument("id", type=int)
    t.add_argument("--date", required=True, help="YYYY-MM-DD")
    t.add_argument("--hours", type=float, required=True)
    t.add_argument("--comment", default="")
    t.add_argument("--activity", type=int, default=16, help="activity_id (default 16 = Coding)")
    t.set_defaults(func=cmd_log_time)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
