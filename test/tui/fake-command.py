#!/usr/bin/env python3
"""Fail-closed local replacements; never delegate to a real external command."""

import json
import os
from pathlib import Path
import re
import sys


def pr(repository, number, branch="feature/peek"):
    return {
        "number": number,
        "title": "Synthetic smoke fixture",
        "html_url": f"https://github.com/{repository}/pull/{number}",
        "state": "open",
        "draft": False,
        "merged_at": None,
        "updated_at": "2026-01-01T00:00:00Z",
        "head": {"ref": branch, "repo": {"full_name": repository}},
    }


def main():
    root = Path(os.environ["PR_PEEK_SMOKE_ROOT"])
    name, args = Path(sys.argv[0]).name, sys.argv[1:]
    with (root / "commands.jsonl").open("a") as log:
        log.write(json.dumps({"name": name, "args": args}) + "\n")
    if name in ("open", "xdg-open") and len(args) == 1:
        if args[0] in URLS:
            (root / "opened.txt").write_text(args[0])
            return
    elif name in ("pbcopy", "wl-copy", "xclip"):
        value = sys.stdin.read()
        if value in URLS and args in ([], ["-selection", "clipboard"]):
            (root / "copied.txt").write_text(value)
            return
    elif name == "gh":
        if (len(args) == 7 and args[:2] == ["pr", "view"] and args[3] == "--repo"
                and args[5:] == ["--json", "reviewDecision,reviewRequests"]):
            if any(args[2] == str(number) and args[4] == f"github.com/{repository}"
                   for repository, number in IDENTITIES):
                decision = {"101": "APPROVED", "32": "CHANGES_REQUESTED", "202": "REVIEW_REQUIRED"}[args[2]]
                print(json.dumps({"reviewDecision": decision,
                                  "reviewRequests": [{"login": "reviewer"}] if args[2] == "101" else []}))
                return
        if args == ["repo", "view", "github.com/smoke-fixture/widget", "--json",
                    "nameWithOwner,parent,defaultBranchRef"]:
            print(json.dumps({"nameWithOwner": "smoke-fixture/widget", "parent": None,
                              "defaultBranchRef": {"name": "main"}}))
            return
        if args[:3] == ["api", "--hostname", "github.com"]:
            endpoint = args[3] if len(args) > 3 else ""
            match = re.fullmatch(r"repos/(smoke-fixture/(?:widget|companion))/pulls/(\d+)", endpoint)
            if match and len(args) == 4:
                repository, number = match[1], int(match[2])
                if (repository, number) in IDENTITIES:
                    print(json.dumps(pr(repository, number)))
                    return
            prefix = "repos/smoke-fixture/widget/pulls?state=all&head=smoke-fixture%3A"
            suffix = "&per_page=100&sort=updated&direction=desc"
            if args[4:] == ["--paginate", "--slurp"]:
                if endpoint == prefix + "feature%2Fpeek" + suffix:
                    print(json.dumps([[pr("smoke-fixture/widget", 101)]]))
                    return
                if endpoint == prefix + "main" + suffix:
                    # Deliberately valid historical results: default branch must not query them.
                    print(json.dumps([[pr("smoke-fixture/widget", 999, "main")]]))
                    return
    message = f"Unexpected fake command: {name} {args!r}"
    with (root / "unexpected.txt").open("a") as log:
        log.write(message + "\n")
    sys.exit(message)


IDENTITIES = {("smoke-fixture/widget", 101), ("smoke-fixture/companion", 32),
              ("smoke-fixture/widget", 202)}
URLS = {f"https://github.com/{repo}/pull/{number}" for repo, number in IDENTITIES}

if __name__ == "__main__":
    main()
