#!/usr/bin/env python3
"""A stand-in for the AERO app's drone link (/api/drone/link), for tests and
for driving the drone from a laptop without the app.

It speaks the same signed line protocol as the Worker (bridge/aero_protocol.py
does the formatting, parsing and HMAC), for one drone:

* ``POST /api/drone/link`` — exactly what the bridge expects: verified
  telemetry and acks in, pending AC1 command lines out. A command is repeated
  until the bridge acks it (ACCEPTED, DONE, REJECTED or FAILED) or it expires.
* ``POST /stub/command``  ``{"type": "GOTO", "args": [lat, lon, alt]}`` → ``{"seq": n}``
* ``GET  /stub/state``    → the last telemetry, every ack, the pending queue.

    export AERO_DRONE_ID=... AERO_DRONE_KEY=...        # same values the bridge uses
    python3 drone/stub_server.py serve --port 8480     # then point the bridge at http://<host>:8480
    python3 drone/stub_server.py send TAKEOFF 10
    python3 drone/stub_server.py send GOTO 37.872100 -122.258300 10
    python3 drone/stub_server.py wait 2                # block until cmd 2 is DONE/REJECTED/FAILED
    python3 drone/stub_server.py state

No auth beyond the drone key and no TLS: loopback or a trusted LAN only.
"""

from __future__ import annotations

import argparse
import dataclasses
import http.server
import json
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
import aero_protocol as proto  # noqa: E402

TEST_DRONE_ID = "aircart01"
TEST_DRONE_KEY = "8f1e6a2c0d4b7e9f3a5c1b2d4e6f8a0c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a"


class Link:
    """Server-side state for one drone."""

    def __init__(self, drone_id: str, key: str, expiry_s: int = 30):
        self.drone_id, self.key, self.expiry_s = drone_id, key, expiry_s
        self.lock = threading.Lock()
        self.cmd_seq = 0
        self.pending: dict[int, tuple[proto.Command, str]] = {}
        self.acks: dict[int, list[dict[str, Any]]] = {}
        self.telemetry: Optional[proto.Telemetry] = None
        self.telemetry_at: Optional[float] = None
        self.last_seq = 0
        self.posts = 0

    def queue(self, kind: str, args: tuple[float, ...]) -> int:
        with self.lock:
            self.cmd_seq += 1
            cmd = proto.Command(self.drone_id, self.cmd_seq, int(time.time()) + self.expiry_s, kind, tuple(args))
            self.pending[cmd.seq] = (cmd, proto.sign_line(self.key, proto.format_command(cmd)))
            return cmd.seq

    def ingest(self, raw: str) -> int:
        """Verify and apply the bridge's lines; return how many were valid."""
        valid = 0
        now = time.time()
        with self.lock:
            self.posts += 1
            for line in raw.splitlines():
                body = proto.verify_line(self.key, line)
                msg = proto.parse_drone_body(body) if body else None
                if msg is None or msg.drone_id != self.drone_id:
                    continue
                valid += 1
                if isinstance(msg, proto.Telemetry):
                    if msg.seq > self.last_seq:
                        self.last_seq, self.telemetry, self.telemetry_at = msg.seq, msg, now
                else:
                    self.acks.setdefault(msg.cmd_seq, []).append(
                        {"status": msg.status, "reason": msg.reason, "t": now})
                    self.pending.pop(msg.cmd_seq, None)
        return valid

    def pending_lines(self) -> list[str]:
        now = time.time()
        with self.lock:
            for seq in [s for s, (c, _l) in self.pending.items() if c.expires < now]:
                self.pending.pop(seq)
            return [line for _seq, (_c, line) in sorted(self.pending.items())]

    def status(self, seq: int) -> Optional[str]:
        with self.lock:
            acks = self.acks.get(seq)
            return acks[-1]["status"] if acks else None

    def state(self) -> dict[str, Any]:
        with self.lock:
            tel = dataclasses.asdict(self.telemetry) if self.telemetry else None
            return {
                "drone_id": self.drone_id,
                "telemetry": tel,
                "telemetry_age_s": None if self.telemetry_at is None else round(time.time() - self.telemetry_at, 1),
                "acks": {str(k): v for k, v in self.acks.items()},
                "pending": sorted(self.pending),
                "posts": self.posts,
            }


class Handler(http.server.BaseHTTPRequestHandler):
    server: "StubServer"

    def _send(self, code: int, body: bytes, ctype: str = "text/plain") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_POST(self) -> None:  # noqa: N802
        link = self.server.link
        if self.path == "/api/drone/link":
            raw = self._body().decode("ascii", "replace")
            if link.ingest(raw) == 0:
                return self._send(401, b"Unauthorized.")
            return self._send(200, "\n".join(link.pending_lines()).encode("ascii"))
        if self.path == "/stub/command":
            try:
                req = json.loads(self._body() or b"{}")
                kind = str(req["type"]).upper()
                args = tuple(float(a) for a in req.get("args", []))
                if kind not in proto.ARG_COUNT or len(args) != proto.ARG_COUNT[kind]:
                    raise ValueError(f"{kind} takes {proto.ARG_COUNT.get(kind)} args")
                seq = link.queue(kind, args)
            except (KeyError, ValueError, TypeError) as e:
                return self._send(400, f"bad command: {e}".encode())
            return self._send(200, json.dumps({"seq": seq}).encode(), "application/json")
        self._send(404, b"not found")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/stub/state":
            return self._send(200, json.dumps(self.server.link.state()).encode(), "application/json")
        self._send(404, b"not found")

    def log_message(self, *args) -> None:
        if self.server.verbose:
            super().log_message(*args)


class StubServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr: tuple[str, int], link: Link, verbose: bool = False):
        super().__init__(addr, Handler)
        self.link, self.verbose = link, verbose

    @property
    def url(self) -> str:
        host, port = self.server_address[:2]
        return f"http://{host}:{port}"


def serve(host: str, port: int, link: Link, verbose: bool = False) -> StubServer:
    srv = StubServer((host, port), link, verbose)
    threading.Thread(target=srv.serve_forever, name="stub-server", daemon=True).start()
    return srv


# --- client side (CLI) ---------------------------------------------------------

def _json(url: str, path: str, body: Optional[dict] = None, timeout: float = 10.0) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url.rstrip("/") + path, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def send(url: str, kind: str, args: list[float]) -> int:
    return int(_json(url, "/stub/command", {"type": kind, "args": args})["seq"])


def wait(url: str, seq: int, timeout: float, poll: float = 1.0) -> Optional[dict]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        acks = _json(url, "/stub/state")["acks"].get(str(seq), [])
        if acks and acks[-1]["status"] in ("DONE", "REJECTED", "FAILED"):
            return acks[-1]
        time.sleep(poll)
    return None


def credentials(env=os.environ) -> tuple[str, str]:
    drone_id = env.get("AERO_DRONE_ID", "").strip() or TEST_DRONE_ID
    key = env.get("AERO_DRONE_KEY", "").strip().lower() or TEST_DRONE_KEY
    if not proto.DRONE_ID.fullmatch(drone_id) or len(key) != 64:
        raise SystemExit("AERO_DRONE_ID must be 6-16 [a-z0-9]; AERO_DRONE_KEY 64 hex characters")
    return drone_id, key


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--url", default="http://127.0.0.1:8480", help="stub server base URL for client commands")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8480)
    s.add_argument("--expiry", type=int, default=30, help="command expiry in s (the app uses 30 over HTTPS)")
    s.add_argument("-v", "--verbose", action="store_true")
    c = sub.add_parser("send")
    c.add_argument("type", choices=proto.COMMAND_TYPES)
    c.add_argument("args", nargs="*", type=float)
    w = sub.add_parser("wait")
    w.add_argument("seq", type=int)
    w.add_argument("--timeout", type=float, default=120.0)
    sub.add_parser("state")
    a = p.parse_args(argv)
    if a.cmd == "serve":
        drone_id, key = credentials()
        srv = serve(a.host, a.port, Link(drone_id, key, a.expiry), a.verbose)
        print(f"stub AERO link for drone {drone_id} at {srv.url} (Ctrl-C to stop)", flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return 0
    if a.cmd == "send":
        seq = send(a.url, a.type, a.args)
        print(seq)
        return 0
    if a.cmd == "wait":
        out = wait(a.url, a.seq, a.timeout)
        print(json.dumps(out) if out else "timeout")
        return 0 if out and out["status"] == "DONE" else 1
    print(json.dumps(_json(a.url, "/stub/state"), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
