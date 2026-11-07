#!/usr/bin/env python3
"""Receives GitHub push webhooks and asks for a deploy at once.

Listens on 127.0.0.1 only; Caddy forwards https://<domain>/_autodeploy/github here. A request
counts only with a valid X-Hub-Signature-256 for the shared secret. A push to the tracked branch
rewrites the trigger file, which a systemd path unit turns into a run of rakazo-autodeploy.
Runs as an unprivileged user: it can write that one file and nothing else. The payload is only
read for its branch; the deploy itself fetches the commit from GitHub.
"""
import hashlib
import hmac
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATH = "/_autodeploy/github"
MAX_BODY = 5 * 1024 * 1024
SECRET = open(os.environ["WEBHOOK_SECRET_FILE"], "rb").read().strip()
BRANCH = os.environ.get("BRANCH", "main")
TRIGGER = os.environ["TRIGGER_FILE"]
PORT = int(os.environ.get("PORT", "9002"))


class Handler(BaseHTTPRequestHandler):
    server_version = "rakazo-autodeploy"
    sys_version = ""

    def reply(self, status: int, text: str) -> None:
        body = (text + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self.reply(405, "POST only")

    def do_POST(self) -> None:
        if self.path != PATH:
            return self.reply(404, "not found")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.reply(400, "bad length")
        if length <= 0 or length > MAX_BODY:
            return self.reply(413, "bad size")
        body = self.rfile.read(length)
        expected = "sha256=" + hmac.new(SECRET, body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(self.headers.get("X-Hub-Signature-256", ""), expected):
            return self.reply(401, "bad signature")
        event = self.headers.get("X-GitHub-Event", "")
        if event == "ping":
            return self.reply(200, "pong")
        if event != "push":
            return self.reply(202, "ignored: not a push")
        try:
            ref = json.loads(body).get("ref")
        except (ValueError, AttributeError):
            return self.reply(400, "bad payload")
        if ref != f"refs/heads/{BRANCH}":
            return self.reply(202, "ignored: other branch")
        with open(TRIGGER, "w") as trigger:
            trigger.write(f"{time.time():.3f}\n")
        return self.reply(202, "deploy started")

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s %s\n" % (self.headers.get("X-GitHub-Delivery", "-") if hasattr(self, "headers") and self.headers else "-", fmt % args))


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
