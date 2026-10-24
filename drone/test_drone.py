"""Unit tests for drone/run_bridge.py and drone/stub_server.py (stdlib only, no hardware).

    python3 -I drone/test_drone.py
"""

from __future__ import annotations

import http.server
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
import aero_protocol as proto  # noqa: E402
import run_bridge  # noqa: E402
import stub_server  # noqa: E402

DRONE, KEY = stub_server.TEST_DRONE_ID, stub_server.TEST_DRONE_KEY


class ConnectResolutionTest(unittest.TestCase):
    def test_explicit_string_passes_through(self):
        self.assertEqual(run_bridge.resolve_connect("udpin:0.0.0.0:14550"), "udpin:0.0.0.0:14550")

    def test_auto_prefers_mavros_bridge(self):
        out = run_bridge.resolve_connect("auto", listening=lambda p: p == 5770,
                                         exists=lambda p: True, find=lambda g: ["/dev/x"])
        self.assertEqual(out, "tcp:127.0.0.1:5770")

    def test_auto_falls_back_to_udev_alias(self):
        out = run_bridge.resolve_connect("auto", listening=lambda p: False,
                                         exists=lambda p: p == "/dev/aircart_fc", find=lambda g: [])
        self.assertEqual(out, "/dev/aircart_fc")

    def test_auto_then_by_id(self):
        out = run_bridge.resolve_connect("auto", listening=lambda p: False, exists=lambda p: False,
                                         find=lambda g: ["/dev/serial/by-id/usb-ArduPilot_X-if00"])
        self.assertEqual(out, "/dev/serial/by-id/usb-ArduPilot_X-if00")

    def test_auto_without_anything_is_loud(self):
        with self.assertRaisesRegex(SystemExit, "no flight controller"):
            run_bridge.resolve_connect("auto", listening=lambda p: False, exists=lambda p: False,
                                       find=lambda g: [])

    def test_port_listening_reads_proc(self):
        with tempfile.NamedTemporaryFile("w", suffix=".tcp", delete=False) as fh:
            fh.write("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid\n"
                     "   0: 0100007F:168A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000\n"
                     "   1: 0100007F:1F90 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000\n")
        try:
            self.assertTrue(run_bridge.port_listening(5770, fh.name))
            self.assertFalse(run_bridge.port_listening(8080, fh.name))  # established, not listening
            self.assertFalse(run_bridge.port_listening(5771, fh.name))
        finally:
            os.unlink(fh.name)


class ArgvTest(unittest.TestCase):
    BASE = {"AERO_SERVER": "https://app.example", "AERO_FENCE_CENTER": "37.1,-122.2", "AERO_FENCE_RADIUS": "300"}

    def test_minimal_dry_run(self):
        argv = run_bridge.build_argv(dict(self.BASE), "tcp:127.0.0.1:5770")
        self.assertEqual(argv, ["--vehicle", "mavlink", "--connect", "tcp:127.0.0.1:5770", "--transport", "https",
                                "--server", "https://app.example", "--fence-center", "37.1,-122.2",
                                "--fence-radius", "300"])
        self.assertNotIn("--live", argv)

    def test_live_and_options(self):
        env = dict(self.BASE, AERO_LIVE="1", AERO_CRUISE_ALT="10", AERO_MAX_ALT="60", AERO_BATTERY_FLOOR="30",
                   AERO_LINK_TIMEOUT="20", AERO_STATE_FILE="/tmp/s.json", AERO_EXTRA_ARGS="--verbose")
        argv = run_bridge.build_argv(env, "/dev/aircart_fc")
        for flag, value in (("--cruise-alt", "10"), ("--max-alt", "60"), ("--battery-floor", "30"),
                            ("--link-timeout", "20"), ("--state-file", "/tmp/s.json")):
            self.assertEqual(argv[argv.index(flag) + 1], value)
        self.assertIn("--live", argv)
        self.assertEqual(argv[-1], "--verbose")

    def test_live_needs_an_explicit_yes(self):
        for value in ("0", "no", "", "false", "maybe"):
            self.assertNotIn("--live", run_bridge.build_argv(dict(self.BASE, AERO_LIVE=value), "x"), value)

    def test_missing_settings_are_named(self):
        with self.assertRaisesRegex(SystemExit, "AERO_FENCE_CENTER, AERO_FENCE_RADIUS"):
            run_bridge.build_argv({"AERO_SERVER": "https://x"}, "x")

    def test_bridge_accepts_the_argv(self):
        """The stock bridge's own parser must take what we build (mavlink needs fence args)."""
        sys.path.insert(0, str(run_bridge.BRIDGE_DIR))
        import aero_bridge
        argv = run_bridge.build_argv(dict(self.BASE, AERO_CRUISE_ALT="10"), "tcp:127.0.0.1:5770")
        args, settings = aero_bridge.configure(argv, env={"AERO_DRONE_ID": DRONE, "AERO_DRONE_KEY": KEY})
        self.assertEqual(args.connect, "tcp:127.0.0.1:5770")
        self.assertEqual(settings.fence_center, (37.1, -122.2))
        self.assertEqual(settings.cruise_alt, 10.0)
        self.assertFalse(args.live)


class PinningTest(unittest.TestCase):
    def test_nat64_well_known_prefix(self):
        self.assertEqual(run_bridge.nat64("140.82.112.6", "64:ff9b::"), "64:ff9b::8c52:7006")

    def test_candidates_prefer_ipv6_then_nat64_then_ipv4(self):
        infos = [(socket.AF_INET, 1, 6, "", ("140.82.112.6", 443))]
        with mock.patch.object(socket, "getaddrinfo", return_value=infos):
            out = run_bridge.candidates("ipv4only.example", 443, "64:ff9b::")
        self.assertEqual([(f, sa[0]) for f, sa in out],
                         [(socket.AF_INET6, "64:ff9b::8c52:7006"), (socket.AF_INET, "140.82.112.6")])
        infos6 = [(socket.AF_INET6, 1, 6, "", ("2606::1", 443, 0, 0))] + infos
        with mock.patch.object(socket, "getaddrinfo", return_value=infos6):
            out = run_bridge.candidates("dual.example", 443, "64:ff9b::")
        self.assertEqual([sa[0] for _f, sa in out], ["2606::1", "140.82.112.6"])  # no NAT64 when AAAA exists

    def test_nm_resolution_parses_nmcli(self):
        done = mock.Mock(returncode=0, stdout="activated\nenxabc\n")
        with mock.patch.object(run_bridge.subprocess, "run", return_value=done):
            self.assertEqual(run_bridge.resolve_interface("nm:lte-dongle"), "enxabc")
        down = mock.Mock(returncode=0, stdout="", stderr="")  # inactive profile: no GENERAL fields
        with mock.patch.object(run_bridge.subprocess, "run", return_value=down):
            with self.assertRaisesRegex(SystemExit, "not active"):
                run_bridge.resolve_interface("nm:lte-dongle")
        unknown = mock.Mock(returncode=10, stdout="", stderr="Error: x - no such connection profile.")
        with mock.patch.object(run_bridge.subprocess, "run", return_value=unknown):
            with self.assertRaisesRegex(SystemExit, "not found"):
                run_bridge.resolve_interface("nm:x")
        self.assertEqual(run_bridge.resolve_interface("eth0"), "eth0")
        self.assertEqual(run_bridge.resolve_interface(""), "")

    def test_pinned_opener_leaves_loopback_alone(self):
        """A pinned opener must still reach a loopback http:// stub (tests, bench)."""
        link = stub_server.Link(DRONE, KEY)
        srv = stub_server.serve("127.0.0.1", 0, link)
        try:
            run_bridge.install_pinned_opener("lo", "64:ff9b::")
            with urllib.request.urlopen(srv.url + "/stub/state", timeout=5) as resp:
                self.assertEqual(json.loads(resp.read())["drone_id"], DRONE)
        finally:
            urllib.request.install_opener(None)
            srv.shutdown()
            srv.server_close()


class LinkChoiceTest(unittest.TestCase):
    SERVER = "https://app.example"

    def test_no_bind_means_default_route(self):
        self.assertEqual(run_bridge.choose_link("", self.SERVER, None), (None, "app link on the default route"))

    def test_pinned_when_the_app_answers_through_it(self):
        opener = object()
        got, how = run_bridge.choose_link("nm:lte-dongle", self.SERVER, "64:ff9b::", resolve=lambda b: "enx1",
                                          build=lambda i, p: opener, check=lambda url, o: None)
        self.assertIs(got, opener)
        self.assertIn("pinned to enx1", how)

    def test_dongle_down_falls_back_to_default_route(self):
        def resolve(_b):
            raise SystemExit("[run_bridge] NetworkManager connection 'lte-dongle' is not active; is the 4G dongle up?")
        got, how = run_bridge.choose_link("nm:lte-dongle", self.SERVER, None, resolve=resolve)
        self.assertIsNone(got)
        self.assertIn("not active", how); self.assertIn("default route", how)
        with self.assertRaises(SystemExit):
            run_bridge.choose_link("nm:lte-dongle", self.SERVER, None, resolve=resolve, strict=True)

    def test_dead_sim_falls_back_when_default_route_works(self):
        answers = iter(["timed out", None])  # pinned probe fails, default-route probe succeeds
        got, how = run_bridge.choose_link("enx1", self.SERVER, None, build=lambda i, p: object(),
                                          check=lambda url, o: next(answers))
        self.assertIsNone(got)
        self.assertIn("out of data", how)

    def test_stays_pinned_when_nothing_works(self):
        opener = object()
        got, how = run_bridge.choose_link("enx1", self.SERVER, None, build=lambda i, p: opener,
                                          check=lambda url, o: "no route")
        self.assertIs(got, opener)
        self.assertIn("keeps retrying", how)


class GpsPositionTest(unittest.TestCase):
    class Msg:
        def __init__(self, kind, **fields):
            self.kind = kind; self.__dict__.update(fields)
        def get_type(self): return self.kind
        def get_srcSystem(self): return 1
        def get_srcComponent(self): return 1

    class Conn:
        def __init__(self, msgs):
            self.msgs = list(msgs); self.closed = False
            self.mav = mock.Mock()
        def recv_match(self, **kw):
            return self.msgs.pop(0) if self.msgs else None
        def close(self): self.closed = True

    def test_waits_for_fix_and_satellites_then_returns_position(self):
        M = self.Msg
        conn = self.Conn([M("HEARTBEAT"), M("GPS_RAW_INT", fix_type=1, satellites_visible=0),
                          M("GLOBAL_POSITION_INT", lat=378719000, lon=-1222585000),
                          M("GPS_RAW_INT", fix_type=3, satellites_visible=5),
                          M("GPS_RAW_INT", fix_type=3, satellites_visible=8)])
        logs = []
        pos = run_bridge.gps_position("/dev/ttyACM0", connection_factory=lambda: conn, log=logs.append)
        self.assertEqual(pos, (37.8719, -122.2585))
        self.assertTrue(conn.closed)
        self.assertEqual(conn.mav.request_data_stream_send.call_count, 2)  # status + position streams
        self.assertTrue(any("waiting for GPS" in l for l in logs))

    def test_timeout_is_loud_and_streams_are_requested_through_mavros_too(self):
        conn = self.Conn([self.Msg("HEARTBEAT")])
        with self.assertRaisesRegex(SystemExit, "no usable GPS fix"):
            run_bridge.gps_position("tcp:127.0.0.1:5770", connection_factory=lambda: conn, timeout_s=0.01, log=lambda m: None)
        self.assertEqual(conn.mav.request_data_stream_send.call_count, 2)
        self.assertTrue(conn.closed)


class StubServerTest(unittest.TestCase):
    def setUp(self):
        self.link = stub_server.Link(DRONE, KEY, expiry_s=30)
        self.srv = stub_server.serve("127.0.0.1", 0, self.link)
        self.url = self.srv.url

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def post_link(self, body: str):
        req = urllib.request.Request(self.url + "/api/drone/link", data=body.encode(), method="POST",
                                     headers={"Content-Type": "text/plain"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def telemetry(self, seq, state="IDLE"):
        t = proto.Telemetry(DRONE, seq, int(time.time()), 37.8719, -122.2585, 0.0, 95, 90, 0.0, 3, 12, state, "GUIDED")
        return proto.sign_line(KEY, proto.format_telemetry(t))

    def test_rejects_unsigned_and_wrong_drone(self):
        self.assertEqual(self.post_link("AT1 aircart01 1 1 0 0 0 -1 0 0 0 0 IDLE X ~0000000000000000")[0], 401)
        other = proto.sign_line("0" * 64, proto.format_telemetry(
            proto.Telemetry(DRONE, 2, int(time.time()), 0, 0, 0, -1, 0, 0, 0, 0, "IDLE", "X")))
        self.assertEqual(self.post_link(other)[0], 401)

    def test_command_round_trip(self):
        seq = stub_server.send(self.url, "TAKEOFF", [10])
        self.assertEqual(seq, 1)
        status, body = self.post_link(self.telemetry(1000))
        self.assertEqual(status, 200)
        cmd = proto.parse_command_body(proto.verify_line(KEY, body.strip()))
        self.assertEqual((cmd.type, cmd.args, cmd.seq), ("TAKEOFF", (10.0,), 1))
        # repeated until acked
        self.assertEqual(self.post_link(self.telemetry(1001))[1].strip(), body.strip())
        ack = proto.sign_line(KEY, proto.format_ack(proto.Ack(DRONE, 1002, int(time.time()), 1, "ACCEPTED")))
        status, body = self.post_link(ack + "\n" + self.telemetry(1003, "TAKEOFF"))
        self.assertEqual((status, body), (200, ""))
        done = proto.sign_line(KEY, proto.format_ack(proto.Ack(DRONE, 1004, int(time.time()), 1, "DONE")))
        self.post_link(done)
        self.assertEqual(self.link.status(1), "DONE")
        self.assertEqual(stub_server.wait(self.url, 1, timeout=2)["status"], "DONE")
        state = json.loads(urllib.request.urlopen(self.url + "/stub/state", timeout=5).read())
        self.assertEqual(state["telemetry"]["state"], "TAKEOFF")
        self.assertEqual(state["pending"], [])

    def test_old_telemetry_seq_is_ignored(self):
        self.post_link(self.telemetry(50, "HOLD"))
        self.post_link(self.telemetry(40, "IDLE"))
        self.assertEqual(self.link.telemetry.state, "HOLD")

    def test_expired_commands_drop_out(self):
        self.link.expiry_s = -1
        stub_server.send(self.url, "PING", [])
        self.assertEqual(self.post_link(self.telemetry(7))[1], "")

    def test_bad_command_is_400(self):
        req = urllib.request.Request(self.url + "/stub/command", data=b'{"type":"GOTO","args":[1]}', method="POST")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(cm.exception.code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=1)
