#!/usr/bin/env python3
"""Start the AERO bridge on the AirCart drone (Jetson Orin Nano + ArduCopter).

This is the systemd entry point (aero-bridge.service). It reads the drone's
settings from the environment (/etc/aero/bridge.env), works out how to reach
the flight controller, optionally pins the app link to the 4G dongle, and
then hands over to the stock bridge in ../bridge/aero_bridge.py — nothing in
the bridge itself is Jetson-specific.

Flight-controller connection (AERO_CONNECT, default ``auto``):

* On this drone the ROS 2 service ``aircart-ros2`` (MAVROS) owns the FC's USB
  serial port and re-serves the MAVLink stream on ``tcp:127.0.0.1:5770``.
  Two readers on one serial port each lose half the bytes, so ``auto`` uses
  that bridge port whenever it is listening. The bridge then talks to the FC
  through MAVROS's router as a normal GCS (system 255).
* Without MAVROS, ``auto`` opens the ArduPilot USB device directly
  (``/dev/aircart_fc`` udev alias, else ``/dev/serial/by-id/usb-ArduPilot_*``).
* Any explicit pymavlink connection string is passed through unchanged.

Link to the app (AERO_BIND, default empty):

* Empty: the default route. In the field that is the 4G dongle (there is no
  Wi-Fi); on the bench it is Wi-Fi.
* ``nm:<connection>`` (e.g. ``nm:lte-dongle``) or an interface name: pin the
  HTTPS link to that interface, so a bench test proves the cellular path
  while Wi-Fi is still up. The modem's RNDIS interface name changes on every
  modem boot, which is why the NetworkManager connection name is resolved at
  start. Through this dongle only IPv6 works (the modem's IPv4 NAT passes
  nothing), so pinned connections try IPv6 first and reach IPv4-only hosts
  through the carrier's NAT64 (well-known prefix 64:ff9b::/96, verified).
* The pin is checked before the bridge starts: if the dongle is down or the
  app does not answer through it but does answer on the default route
  (Wi-Fi / a phone hotspot), the launcher says so loudly and uses the default
  route, so a dead SIM does not stop a demo. ``AERO_BIND_STRICT=1`` turns
  that fallback off.

Geofence (AERO_FENCE_CENTER): ``lat,lon`` or ``auto``, which waits for the
flight controller's first 3D fix with 6+ satellites and centres the fence on
the drone's position at service start (the launch pad).
"""

from __future__ import annotations

import glob
import http.client
import ipaddress
import os
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
BRIDGE_DIR = HERE.parent / "bridge"
MAVROS_BRIDGE_PORT = 5770
MAVROS_BRIDGE = f"tcp:127.0.0.1:{MAVROS_BRIDGE_PORT}"
FC_ALIAS = "/dev/aircart_fc"
FC_GLOB = "/dev/serial/by-id/usb-ArduPilot_*-if00"
DEFAULT_NAT64_PREFIX = "64:ff9b::"


def say(msg: str) -> None:
    print(f"[run_bridge] {msg}", flush=True)


# --- flight controller -------------------------------------------------------

def port_listening(port: int, proc_net: str = "/proc/net/tcp") -> bool:
    """Is something LISTENing on 127.0.0.1:<port>? Read from /proc so the
    check itself never opens a connection to MAVROS's router."""
    want = f":{port:04X}"
    try:
        with open(proc_net) as fh:
            next(fh)
            for line in fh:
                parts = line.split()
                if len(parts) > 3 and parts[1].endswith(want) and parts[3] == "0A":
                    return True
    except OSError:
        pass
    return False


def device_holders(path: str) -> list[str]:
    """Other processes with the tty open (``fuser``), or [] if none/unknown."""
    try:
        out = subprocess.run(["fuser", path], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [p for p in out.stdout.split() if p.isdigit() and int(p) != os.getpid()]


def resolve_connect(spec: str, *, listening=port_listening, exists=os.path.exists,
                    find=glob.glob) -> str:
    spec = (spec or "auto").strip()
    if spec != "auto":
        return spec
    if listening(MAVROS_BRIDGE_PORT):
        return MAVROS_BRIDGE
    if exists(FC_ALIAS):
        return FC_ALIAS
    found = sorted(find(FC_GLOB))
    if found:
        return found[0]
    raise SystemExit("[run_bridge] no flight controller: MAVROS's bridge "
                     f"{MAVROS_BRIDGE} is not listening and no ArduPilot USB device exists "
                     "(is aircart-ros2 running? is the FC plugged in?)")


# --- 4G interface pinning ----------------------------------------------------

def resolve_interface(spec: str) -> str:
    spec = (spec or "").strip()
    if not spec.startswith("nm:"):
        return spec
    name = spec[3:]
    out = subprocess.run(["nmcli", "-g", "GENERAL.STATE,GENERAL.DEVICES", "con", "show", name],
                         capture_output=True, text=True, timeout=10, check=False)
    lines = [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]
    if out.returncode != 0:
        raise SystemExit(f"[run_bridge] NetworkManager connection {name!r} not found "
                         f"({' '.join(out.stderr.split()) or 'nmcli rc ' + str(out.returncode)})")
    if len(lines) < 2:  # nmcli prints no GENERAL.* fields for an inactive profile
        raise SystemExit(f"[run_bridge] NetworkManager connection {name!r} is not active; is the 4G dongle up?")
    state, device = lines[0], lines[1]
    if state != "activated" or not device:
        raise SystemExit(f"[run_bridge] NetworkManager connection {name!r} is {state}, not activated")
    return device


def nat64(ipv4: str, prefix: str) -> str:
    net = ipaddress.IPv6Network(f"{prefix}/96", strict=False)
    return str(ipaddress.IPv6Address(int(net.network_address) | int(ipaddress.IPv4Address(ipv4))))


def candidates(host: str, port: int, nat64_prefix: Optional[str]) -> list[tuple[int, tuple]]:
    """Addresses to try: IPv6 first, then NAT64-synthesised IPv6 for an
    IPv4-only host, then the (dead on this dongle) IPv4 as a last resort."""
    infos = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    v6 = [(f, sa) for f, _t, _p, _c, sa in infos if f == socket.AF_INET6]
    v4 = [(f, sa) for f, _t, _p, _c, sa in infos if f == socket.AF_INET]
    out = list(v6)
    if not v6 and nat64_prefix:
        out += [(socket.AF_INET6, (nat64(sa[0], nat64_prefix), port, 0, 0)) for _f, sa in v4]
    return out + v4


def open_pinned_socket(host: str, port: int, interface: str, timeout: float,
                       nat64_prefix: Optional[str]) -> socket.socket:
    last: Optional[BaseException] = None
    for family, sockaddr in candidates(host, port, nat64_prefix):
        s = socket.socket(family, socket.SOCK_STREAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode())
            s.settimeout(timeout)
            s.connect(sockaddr)
            return s
        except OSError as e:
            last = e
            s.close()
    raise OSError(f"{host}:{port} unreachable via {interface}: {last}")


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    interface = ""
    nat64_prefix: Optional[str] = DEFAULT_NAT64_PREFIX

    def connect(self) -> None:
        host = self.host
        if host in ("localhost", "127.0.0.1", "::1"):
            return super().connect()  # loopback (tests) never goes out of the dongle
        sock = open_pinned_socket(host, self.port, self.interface, self.timeout, self.nat64_prefix)
        ctx = getattr(self, "_context", None)
        if ctx is None:
            import ssl
            ctx = ssl.create_default_context()
        self.sock = ctx.wrap_socket(sock, server_hostname=host)


def build_pinned_opener(interface: str, nat64_prefix: Optional[str]) -> urllib.request.OpenerDirector:
    """An opener whose HTTPS connections leave through ``interface``.
    pymavlink's loopback TCP to MAVROS is untouched."""
    conn_cls = type("PinnedHTTPSConnection", (PinnedHTTPSConnection,),
                    {"interface": interface, "nat64_prefix": nat64_prefix})

    class Handler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(conn_cls, req, context=self._context)

    return urllib.request.build_opener(Handler())


def install_pinned_opener(interface: str, nat64_prefix: Optional[str]) -> None:
    """Make every urllib.request.urlopen (the bridge's HTTPS transport) leave
    through ``interface``."""
    urllib.request.install_opener(build_pinned_opener(interface, nat64_prefix))


def probe(url: str, opener: urllib.request.OpenerDirector, timeout: float = 12.0) -> Optional[str]:
    """None if ``url`` answers through ``opener`` (any HTTP status counts: Cloudflare
    returns 403 to urllib's default user agent, 401 to an unsigned drone line),
    else a one-line reason."""
    req = urllib.request.Request(url, headers={"User-Agent": "aero-bridge-launcher/1"})
    try:
        with opener.open(req, timeout=timeout) as resp:
            resp.read(64)
        return None
    except urllib.error.HTTPError:
        return None
    except Exception as e:  # noqa: BLE001 — any failure means "not this way"
        return " ".join(str(e).split()) or type(e).__name__


def choose_link(bind: str, server: str, nat64_prefix: Optional[str], *, strict: bool = False,
                resolve=resolve_interface, build=build_pinned_opener, check=probe):
    """Decide how the bridge reaches the app: (opener to install or None, what to log).

    A pinned link is only used when the app actually answers through it; when
    it does not but the default route works (Wi-Fi, a phone hotspot), the
    default route is used instead so a dead SIM does not stop a demo."""
    bind = (bind or "").strip()
    if not bind:
        return None, "app link on the default route"
    try:
        iface = resolve(bind)
    except SystemExit as e:
        if strict:
            raise
        return None, f"WARNING: {str(e).replace('[run_bridge] ', '')} — using the default route instead"
    opener = build(iface, nat64_prefix)
    url = server.rstrip("/") + "/"
    err = check(url, opener)
    if err is None:
        return opener, f"app link pinned to {iface} ({bind}); IPv6 first, NAT64 prefix {nat64_prefix or 'off'}"
    if strict:
        raise SystemExit(f"[run_bridge] {server} does not answer through {iface}: {err}")
    if check(url, urllib.request.build_opener()) is None:
        return None, (f"WARNING: {server} does not answer through {iface} ({err}) but does on the "
                      "default route — using the default route (Wi-Fi/hotspot). Is the SIM out of data?")
    return opener, (f"WARNING: {server} answers neither through {iface} ({err}) nor on the default "
                    f"route; staying pinned to {iface}, the bridge keeps retrying")


# --- geofence centre from the FC's GPS ---------------------------------------

def gps_position(connect: str, baud: Optional[int] = None, *, timeout_s: float = 3600.0,
                 min_fix: int = 3, min_sats: int = 6, connection_factory=None, log=say):
    """Block until the flight controller reports a 3D fix with enough
    satellites, then return its (lat, lon). Used for AERO_FENCE_CENTER=auto."""
    if connection_factory is None:
        os.environ.setdefault("MAVLINK20", "1")
        from pymavlink import mavutil
        connection_factory = lambda: mavutil.mavlink_connection(  # noqa: E731
            connect, baud=baud or 115200, source_system=255, source_component=190)
    m = connection_factory()
    deadline = time.monotonic() + timeout_s
    next_log = 0.0
    next_request = 0.0
    fix = sats = 0
    pos = None
    try:
        while time.monotonic() < deadline:
            msg = m.recv_match(type=["HEARTBEAT", "GPS_RAW_INT", "GLOBAL_POSITION_INT"],
                               blocking=True, timeout=2.0)
            now = time.monotonic()
            if msg is not None:
                kind = msg.get_type()
                if kind == "HEARTBEAT" and msg.get_srcComponent() == 1 and now >= next_request:
                    # Nobody has asked the FC for GPS yet (the bridge does so later): EXTENDED_STATUS
                    # (GPS_RAW_INT) and POSITION (GLOBAL_POSITION_INT) at 2 Hz, repeated until data flows.
                    for stream_id in (2, 6):
                        m.mav.request_data_stream_send(msg.get_srcSystem(), 1, stream_id, 2, 1)
                    next_request = now + 5.0
                elif kind == "GPS_RAW_INT":
                    fix, sats = msg.fix_type, msg.satellites_visible
                elif kind == "GLOBAL_POSITION_INT" and (msg.lat or msg.lon):
                    pos = (msg.lat / 1e7, msg.lon / 1e7)
                if fix >= min_fix and sats >= min_sats and pos is not None:
                    return pos
            if now >= next_log:
                log(f"waiting for GPS: fix type {fix}, {sats} satellites (need {min_fix}/{min_sats})")
                next_log = now + 10.0
    finally:
        try:
            m.close()
        except Exception:  # noqa: BLE001
            pass
    raise SystemExit(f"[run_bridge] no usable GPS fix after {timeout_s:.0f} s (fix {fix}, {sats} sats)")


# --- bridge command line -----------------------------------------------------

def truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on", "live")


def build_argv(env, connect: str) -> list[str]:
    missing = [k for k in ("AERO_SERVER", "AERO_FENCE_CENTER", "AERO_FENCE_RADIUS") if not env.get(k, "").strip()]
    if missing:
        raise SystemExit(f"[run_bridge] not configured: set {', '.join(missing)} "
                         "(and AERO_DRONE_ID / AERO_DRONE_KEY) in /etc/aero/bridge.env")
    argv = ["--vehicle", "mavlink", "--connect", connect,
            "--transport", "https", "--server", env["AERO_SERVER"].strip(),
            "--fence-center", env["AERO_FENCE_CENTER"].strip(),
            "--fence-radius", env["AERO_FENCE_RADIUS"].strip()]
    for var, flag in (("AERO_MAX_ALT", "--max-alt"), ("AERO_CRUISE_ALT", "--cruise-alt"),
                      ("AERO_BATTERY_FLOOR", "--battery-floor"), ("AERO_LINK_TIMEOUT", "--link-timeout"),
                      ("AERO_STATE_FILE", "--state-file"), ("AERO_SOURCE_SYSTEM", "--source-system"),
                      ("AERO_BAUD", "--baud")):
        if env.get(var, "").strip():
            argv += [flag, env[var].strip()]
    if truthy(env.get("AERO_LIVE")):
        argv.append("--live")
    if truthy(env.get("AERO_VERBOSE")):
        argv.append("--verbose")
    argv += shlex.split(env.get("AERO_EXTRA_ARGS", ""))
    return argv


def main() -> int:
    env = os.environ
    connect = resolve_connect(env.get("AERO_CONNECT", "auto"))
    if connect.startswith("/dev/"):
        holders = device_holders(connect)
        if holders:
            raise SystemExit(f"[run_bridge] {connect} is already open by pid {', '.join(holders)} "
                             "(MAVROS?). Two readers on one serial port each lose half the bytes; "
                             "use the MAVROS bridge (AERO_CONNECT=auto with aircart-ros2 running) "
                             "or stop the other reader.")
    say(f"flight controller: {connect}" + (" (through MAVROS's router)" if connect == MAVROS_BRIDGE else ""))
    env = dict(env)
    server = env.get("AERO_SERVER", "").strip()
    prefix = env.get("AERO_NAT64_PREFIX", DEFAULT_NAT64_PREFIX).strip() or None
    opener, how = choose_link(env.get("AERO_BIND", ""), server, prefix,
                              strict=truthy(env.get("AERO_BIND_STRICT")))
    if opener is not None:
        urllib.request.install_opener(opener)
    say(how)
    if env.get("AERO_FENCE_CENTER", "").strip().lower() == "auto":
        say("AERO_FENCE_CENTER=auto: centring the geofence on the drone's GPS position (waiting for a fix)")
        baud = int(env["AERO_BAUD"]) if env.get("AERO_BAUD", "").strip() else None
        lat, lon = gps_position(connect, baud)
        env["AERO_FENCE_CENTER"] = f"{lat:.7f},{lon:.7f}"
        say(f"geofence centre from GPS: {env['AERO_FENCE_CENTER']}, radius {env.get('AERO_FENCE_RADIUS', '?')} m")
    argv = build_argv(env, connect)
    if "--live" not in argv:
        say("DRY RUN (AERO_LIVE is not set): the bridge reports telemetry but refuses every movement command")
    sys.path.insert(0, str(BRIDGE_DIR))
    import aero_bridge  # noqa: E402  (sets MAVLINK20 before pymavlink is imported)
    return aero_bridge.main(argv)


if __name__ == "__main__":
    sys.exit(main())
