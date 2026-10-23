#!/usr/bin/env python3
"""Opt-in OpenCode 2.1.4 PTY integration test, using only Python's stdlib.

All child processes have a private HOME/XDG/database and a network sandbox.
No prompts are submitted: completed assistant/tool messages are imported data.
"""

import argparse
import codecs
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata
import uuid
import zlib

if os.name != "posix":
    sys.exit("test:tui requires macOS or Linux (Python PTY support).")

import fcntl
import pty
import termios

PROJECT = Path(__file__).resolve().parents[2]
WIDTH, HEIGHT, SIDEBAR = 160, 45, 118
CSI = re.compile(r"\x1b\[([0-?]*)([ -/]*)([@-~])")
OSC = re.compile(r"\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[P_][\s\S]*?\x1b\\)")


def run(command, cwd, env):
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True,
                            text=True, timeout=45)
    if result.returncode:
        raise RuntimeError(f"Command failed: {command[:6]!r}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def network_sandbox(root):
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        profile = root / "network.sb"
        # Standalone API uses an ephemeral loopback HTTP server, not the shared service.
        profile.write_text('(version 1) (allow default) (deny network*)\n'
                           '(allow network-inbound (local ip "localhost:*"))\n'
                           '(allow network-outbound (remote ip "localhost:*"))\n')
        command = [shutil.which("sandbox-exec"), "-f", str(profile)]
    elif sys.platform.startswith("linux") and shutil.which("unshare"):
        # A fresh network namespace has no external interfaces; bring up only loopback.
        setup = ("import fcntl,os,socket,struct,sys; "
                 "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); "
                 "fcntl.ioctl(s,0x8914,struct.pack('16sH14x',b'lo',0x49)); "
                 "s.close(); os.execvp(sys.argv[1],sys.argv[1:])")
        command = [shutil.which("unshare"), "--user", "--map-root-user", "--net", "--",
                   sys.executable, "-c", setup]
    else:
        raise RuntimeError("Network isolation requires sandbox-exec (macOS) or unshare (Linux).")
    # Fail rather than silently running without network isolation.
    run(command + ["/usr/bin/true"], root, os.environ.copy())
    return command


def checkout(root):
    """Build a tiny valid local Git fixture without git init/commit or user identity."""
    directory = root / "checkout"
    git = directory / ".git"
    (git / "objects").mkdir(parents=True)
    (git / "refs/heads/feature").mkdir(parents=True)

    def obj(kind, content):
        raw = f"{kind} {len(content)}\0".encode() + content
        digest = hashlib.sha1(raw).hexdigest()
        target = git / "objects" / digest[:2] / digest[2:]
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(zlib.compress(raw))
        return digest

    tree = obj("tree", b"")
    commit = obj("commit", (f"tree {tree}\nauthor Smoke <smoke@example.invalid> 1 +0000\n"
                            "committer Smoke <smoke@example.invalid> 1 +0000\n\nFixture\n").encode())
    (git / "refs/heads/main").write_text(commit + "\n")
    (git / "refs/heads/feature/peek").write_text(commit + "\n")
    (git / "HEAD").write_text("ref: refs/heads/feature/peek\n")
    (git / "config").write_text(
        '[core]\nrepositoryformatversion = 0\nbare = false\n'
        '[remote "origin"]\nurl = https://github.com/smoke-fixture/widget.git\n'
        'fetch = +refs/heads/*:refs/remotes/origin/*\n')
    return directory


class Harness:
    def __init__(self, root, binary):
        self.root = root
        self.directory = checkout(root)
        self.launch = network_sandbox(root) + [binary]
        for name in ("home", "config/opencode", "data", "state", "cache", "tmp", "bin"):
            (root / name).mkdir(parents=True, exist_ok=True)
        # Allowlist, rather than inheriting provider credentials, Git config or server addresses.
        self.env = {"PATH": str(root / "bin") + os.pathsep + os.environ.get("PATH", os.defpath),
                    "HOME": str(root / "home"), "XDG_CONFIG_HOME": str(root / "config"),
                    "XDG_DATA_HOME": str(root / "data"), "XDG_STATE_HOME": str(root / "state"),
                    "XDG_CACHE_HOME": str(root / "cache"), "TMPDIR": str(root / "tmp"),
                    "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_US.UTF-8",
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                    "PR_PEEK_SMOKE_ROOT": str(root), "OPENCODE_DB": str(root / "smoke.db"),
                    "OPENCODE_DISABLE_AUTOUPDATE": "true", "OPENCODE_DISABLE_MODELS_FETCH": "true",
                    "OPENCODE_DISABLE_FREE_MODELS": "true", "OPENCODE_DISABLE_CLAUDE_CODE": "true",
                    "OPENCODE_DISABLE_PROJECT_CONFIG": "true", "OPENCODE_LOG_LEVEL": "DEBUG"}
        # Use the current interpreter, even if python3 is not on a child process's PATH.
        fake = root / "fake-command.py"
        fake.write_text(f"#!{sys.executable}\n" +
                        (Path(__file__).with_name("fake-command.py").read_text().split("\n", 1)[1]))
        fake.chmod(0o700)
        for name in ("gh", "open", "xdg-open", "pbcopy", "wl-copy", "xclip"):
            (root / "bin" / name).symlink_to(fake)
        self.write_json(root / "config/opencode/opencode.json", {
            "$schema": "https://opencode.ai/config.json", "update": "disable",
            "snapshots": False, "policies": [
                {"action": "provider.use", "resource": "*", "effect": "deny"},
                {"action": "tool.use", "resource": "*", "effect": "deny"}],
        })
        self.write_json(root / "config/opencode/cli.json", {
            "$schema": "https://opencode.ai/v2/cli.json", "animations": False,
            "highlights": False, "mouse": True, "session": {"sidebar": "auto"},
            "attention": {"notifications": False, "sound": False},
            "plugins": [{"package": str(PROJECT), "options": {
                "compact": True, "showBranch": True, "maxVisiblePRs": 3,
                "localRefreshMs": 1000, "remoteRefreshMs": 60000}}],
        })

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value, indent=2) + "\n")

    def api(self, method, path, data=None):
        command = self.launch + ["api", method, path, "--standalone"]
        if data is not None:
            command += ["--data", json.dumps(data)]
        return json.loads(run(command, self.directory, self.env))

    def session(self, title):
        location = {"directory": str(self.directory)}
        info = self.api("post", "/api/session", {"title": title, "location": location})["data"]
        # Import is create-only. Reuse the host-generated project/location metadata, not its ID.
        info["id"] = "ses_" + uuid.uuid4().hex
        now = int(time.time() * 1000)
        tools = []
        for index, (repository, number) in enumerate((("widget", 101), ("companion", 32))):
            tools.append({"type": "tool", "id": f"call_{info['id']}_{index}", "name": "shell",
                          "time": {"created": now, "completed": now + 1}, "state": {
                              "status": "completed", "input": {"command":
                                  f"gh pr create --repo smoke-fixture/{repository} --title Smoke"},
                              "metadata": {"exit": 0}, "content": [{"type": "text", "text":
                                  f"https://github.com/smoke-fixture/{repository}/pull/{number}\n"}]}})
        messages = [
            {"id": "msg_user_" + info["id"], "type": "user", "time": {"created": now},
             "text": "Dependency: https://github.com/smoke-fixture/widget/pull/202",
             "files": [], "agents": []},
            # Import silently drops unfinished assistant messages; these fields are essential.
            {"id": "msg_assistant_" + info["id"], "type": "assistant", "agent": "build",
             "model": {"providerID": "smoke", "id": "never-called"},
             "time": {"created": now + 1, "completed": now + 2}, "finish": "tool-calls",
             "content": tools},
        ]
        self.api("post", "/api/experimental/session/import",
                 {"info": info, "messages": messages, "location": location})
        persisted = self.api("get", f"/api/session/{info['id']}/message")["data"]
        assistants = [m for m in persisted if m["type"] == "assistant"]
        assert len(assistants) == 1 and len(assistants[0]["content"]) == 2, "Import lost tool fixtures"
        return info["id"]


class App:
    def __init__(self, harness, session, label):
        self.harness, self.label = harness, label
        self.raw = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", HEIGHT, WIDTH, 0, 0))
        try:
            self.process = subprocess.Popen(harness.launch + ["--standalone", "--session", session],
                                            cwd=harness.directory, env=harness.env,
                                            stdin=slave, stdout=slave, stderr=slave)
        finally:
            os.close(slave)

    def __enter__(self):
        return self

    def read(self):
        if select.select([self.master], [], [], 0.1)[0]:
            try:
                self.raw += self.decoder.decode(os.read(self.master, 65536))
            except OSError:
                pass  # PTY returns EIO once the child exits on Linux.

    def screen(self):
        # Minimal ANSI renderer for OpenTUI's fixed-size absolute-position frames.
        grid = [[" "] * WIDTH for _ in range(HEIGHT)]
        row = col = i = 0
        while i < len(self.raw):
            if self.raw.startswith("\x1b[?1049l", i):
                break
            if self.raw[i] == "\x1b":
                match = CSI.match(self.raw, i)
                if match:
                    args, _, code = match.groups()
                    nums = ([int(v) if v else 0 for v in args.split(";")]
                            if not args.startswith(("?", ">", "<")) else [])
                    if code in ("H", "f"):
                        row = (nums[0] or 1) - 1 if nums else 0
                        col = ((nums[1] if len(nums) > 1 else 1) or 1) - 1
                    elif code == "J" and nums and nums[0] in (2, 3):
                        grid = [[" "] * WIDTH for _ in range(HEIGHT)]
                    elif code == "K" and 0 <= row < HEIGHT:
                        start, end = ((0, WIDTH) if nums and nums[0] == 2 else
                                      (0, col + 1) if nums and nums[0] == 1 else (col, WIDTH))
                        grid[row][start:end] = [" "] * (end - start)
                    i = match.end()
                    continue
                match = OSC.match(self.raw, i)
                if match:
                    i = match.end()
                    continue
                if i + 1 >= len(self.raw):
                    break
                i += 2
                continue
            char = self.raw[i]
            i += 1
            if char == "\r":
                col = 0
            elif char == "\n":
                row += 1
            elif ord(char) >= 32:
                if 0 <= row < HEIGHT and 0 <= col < WIDTH:
                    grid[row][col] = char
                col += (0 if unicodedata.combining(char) else
                        2 if unicodedata.east_asian_width(char) in ("W", "F") else 1)
        # Never match the imported transcript: assertions only inspect the actual sidebar.
        return "\n".join("".join(line)[SIDEBAR:] for line in grid)

    def wait(self, predicate, description):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and self.process.poll() is None:
            self.read()
            screen = self.screen()
            if predicate(screen):
                return screen
        raise AssertionError(f"{self.label}: {description}\n{self.screen()}")

    def click(self, label, after=None):
        lines = self.screen().splitlines()
        start = next(i + 1 for i, line in enumerate(lines) if after in line) if after else 0
        y = next(i for i in range(start, len(lines)) if label in lines[i])
        x = SIDEBAR + lines[y].index(label) + 1
        os.write(self.master, f"\x1b[<0;{x};{y + 1}M\x1b[<0;{x};{y + 1}m".encode())

    def __exit__(self, kind, value, traceback):
        if self.process.poll() is None:
            os.write(self.master, b"\x03")
        deadline = time.monotonic() + 8
        while self.process.poll() is None and time.monotonic() < deadline:
            self.read()  # Drain output while exiting; otherwise a full PTY can deadlock shutdown.
        forced = self.process.poll() is None
        if forced:
            self.process.kill()
        self.process.wait()
        os.close(self.master)
        (self.harness.root / f"{self.label}.ansi").write_text(self.raw)
        (self.harness.root / f"{self.label}.screen.txt").write_text(self.screen())
        if kind is None:
            assert not forced and self.process.returncode == 0, "TUI did not exit cleanly"


def initial(app):
    screen = app.wait(lambda s: "widget#101" in s and "companion#32" in s and
                      "Related PRs (1)" in s, "branch + created PRs, related collapsed")
    assert "widget#202" not in screen and "widget#32" not in screen
    assert screen.index("companion#32") < screen.index("Related PRs")
    assert screen.index("widget#101") < screen.index("Related PRs")
    app.wait(lambda s: "Approved · 1 requested" in s and "Changes requested" in s,
             "GitHub approval, outstanding requests, and changes-requested status")
    return screen


def exercise(harness):
    branch_only = harness.api("post", "/api/session", {
        "title": "Branch only", "location": {"directory": str(harness.directory)},
    })["data"]["id"]
    with App(harness, branch_only, "00-branch-only") as app:
        screen = app.wait(lambda s: "widget#101" in s, "branch PR without history")
        assert "companion#32" not in screen and "Related PRs" not in screen
    first, second = harness.session("Smoke one"), harness.session("Smoke two")
    with App(harness, first, "01-choices") as app:
        initial(app)
        for label, repository, number in (("widget#101", "widget", 101),
                                           ("companion#32", "companion", 32)):
            url = f"https://github.com/smoke-fixture/{repository}/pull/{number}"
            app.click(label)
            app.wait(lambda s: (harness.root / "opened.txt").exists() and
                     (harness.root / "opened.txt").read_text() == url, f"open {label}")
            app.click("Copy link", after=label)
            app.wait(lambda s: (harness.root / "copied.txt").exists() and
                     (harness.root / "copied.txt").read_text() == url, f"copy {label}")
        app.click("Related PRs")
        app.wait(lambda s: "widget#202" in s, "expand related")
        app.wait(lambda s: "Review required" in s, "related PR requires review")
        app.click("Pin", after="widget#202")
        app.wait(lambda s: "widget#202" in s and "Related PRs" not in s and "Unpin" in s, "pin")
        app.click("Hide", after="widget#202")
        app.wait(lambda s: "Restore hidden PRs (1)" in s and "widget#202" not in s, "hide")
    with App(harness, second, "02-isolation") as app:
        assert "Restore hidden" not in initial(app), "Choices leaked to another session"
    with App(harness, first, "03-restore") as app:
        app.wait(lambda s: "Restore hidden PRs (1)" in s and "companion#32" in s and
                 "widget#202" not in s, "hidden choice survives reopen")
        app.click("Restore hidden PRs")
        app.wait(lambda s: "widget#202" in s and "Unpin" in s and
                 "Restore hidden" not in s and "Related PRs" not in s, "restore retains pin")
    with App(harness, first, "04-unpin") as app:
        app.wait(lambda s: "widget#202" in s and "Unpin" in s, "pin survives reopen")
        app.click("Unpin", after="widget#202")
        app.wait(lambda s: "Related PRs (1)" in s and "widget#202" not in s, "unpin to related")
    # Switch only the generated checkout. Creation evidence remains primary on main.
    (harness.directory / ".git/HEAD").write_text("ref: refs/heads/main\n")
    with App(harness, first, "05-default-branch") as app:
        screen = initial(app)
        assert "main" in screen and "widget#999" not in screen
    with App(harness, branch_only, "06-default-no-history") as app:
        screen = app.wait(lambda s: "main" in s and "No working PRs" in s,
                          "default branch without creation evidence has no working PRs")
        assert not re.search(r"(?:widget|companion)#\d+", screen)
    calls = [json.loads(line) for line in (harness.root / "commands.jsonl").read_text().splitlines()]
    assert not any("smoke-fixture%3Amain" in arg for call in calls for arg in call["args"]), \
        "Default branch queried historical PRs"
    assert not (harness.root / "unexpected.txt").exists(), "Unexpected command; inspect unexpected.txt"
    print("PASS: real sidebar classification, repository labels, open/copy URLs, pin/hide/restore/unpin,")
    print("      review decisions, durable reopen, session isolation, and default-branch history exclusion")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="retain isolated fixtures and ANSI logs")
    parser.add_argument("--opencode", default="opencode", help="OpenCode 2.1.4 executable")
    args = parser.parse_args()
    binary = shutil.which(args.opencode)
    if not binary or not shutil.which("git"):
        parser.error("Install OpenCode 2.1.4 and Git before running test:tui.")
    if not (PROJECT / "node_modules/effect").is_dir():
        parser.error("Run npm ci first (local plugin dependencies are required).")
    # Respect platform TMPDIR (including OpenCode's approved temporary directory).
    root = Path(tempfile.mkdtemp(prefix="pr-peek-tui-")).resolve()
    keep = args.keep
    try:
        harness = Harness(root, binary)
        version = run(harness.launch + ["--version"], root, harness.env).strip()
        if not re.search(r"\bv?2\.1\.4\b", version):
            raise RuntimeError(f"Expected OpenCode 2.1.4, got {version!r}; revalidate the host contract first.")
        exercise(harness)
    except (Exception, KeyboardInterrupt) as error:
        keep = True
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    finally:
        if keep:
            print(f"Isolated fixtures/logs: {root}")
        else:
            shutil.rmtree(root)  # Only this invocation's newly-created directory.
    return 0


if __name__ == "__main__":
    sys.exit(main())
