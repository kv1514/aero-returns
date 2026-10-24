#!/usr/bin/env python3
"""AERO drone agent.

Runs on the drone's companion computer (for example a Raspberry Pi with a 4G modem)
and links the flight controller to the AERO website:

  flight controller --MAVLink--> aero_agent.py --HTTPS over 4G--> /api/drone/sync

Every second it reports telemetry and receives the next command (FLY_ROUTE, HOLD,
LAND, RTL, PING). If mobile data drops, signed SMS commands still work through the
modem. Safety checks run here as well as on the server:

  * motion commands are refused unless the agent was started with --allow-flight
  * every waypoint must be inside the geofence around home, at or below max altitude
  * low battery or leaving the geofence triggers RTL
  * losing the website link holds position after 15 s and returns home after 45 s

Supported vehicles: ArduPilot Copter over MAVLink (pymavlink), or --sim for a
built-in simulated drone that needs no hardware.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import logging
import math
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

VERSION = "1.0.0"
EARTH_RADIUS_M = 6371000.0
WAYPOINT_RADIUS_M = 4.0
LINK_HOLD_S = 15.0
LINK_RTL_S = 45.0
CRITICAL_BATTERY_PCT = 20.0
SMS_WINDOW_S = 300
# Switching the RC transmitter to one of these modes takes control away from the agent.
MANUAL_MODES = {"STABILIZE", "ALT_HOLD", "POSHOLD", "ACRO", "SPORT", "DRIFT", "FLOWHOLD", "MANUAL"}
TOKEN_RE = re.compile(r"^aero_([a-f0-9-]{36})\.([a-f0-9]{64})$")
SMS_RE = re.compile(
    r"^\s*AERO\s+(HOLD|LAND|RTL|STATUS|GOTO\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+))\s+(\d{8})\s*$",
    re.IGNORECASE,
)
log = logging.getLogger("aero")


# --- Geometry (points are (lng, lat) like the website) -------------------------------
def distance(a, b) -> float:
    r = math.pi / 180
    dlat, dlng = (b[1] - a[1]) * r, (b[0] - a[0]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[1] * r) * math.cos(b[1] * r) * math.sin(dlng / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(h), math.sqrt(max(0.0, 1 - h)))


def bearing(a, b) -> float:
    r = math.pi / 180
    dlng = (b[0] - a[0]) * r
    y = math.sin(dlng) * math.cos(b[1] * r)
    x = math.cos(a[1] * r) * math.sin(b[1] * r) - math.sin(a[1] * r) * math.cos(b[1] * r) * math.cos(dlng)
    return (math.atan2(y, x) / r + 360) % 360


def move(p, heading_deg: float, meters: float):
    """Short-distance flat-earth step, accurate to centimetres over a few km."""
    rad = math.radians(heading_deg)
    dlat = meters * math.cos(rad) / 111_195.0
    dlng = meters * math.sin(rad) / (111_195.0 * max(0.01, math.cos(math.radians(p[1]))))
    return (p[0] + dlng, p[1] + dlat)


# --- Credentials and SMS signing ---------------------------------------------------
def parse_token(token: str):
    m = TOKEN_RE.match(token.strip())
    if not m:
        raise ValueError("Token must look like aero_<drone-id>.<64 hex characters>. Copy it from the Fly page.")
    return m.group(1), m.group(2)


def sms_code(token_hash: str, drone_id: str, body: str, window: int) -> str:
    mac = hmac.new(token_hash.encode(), f"{drone_id}|{body}|{window}".encode(), hashlib.sha256).hexdigest()
    return f"{int(mac[:8], 16) % 100_000_000:08d}"


@dataclass
class SmsCommand:
    command: str
    point: tuple | None = None
    alt_m: float | None = None


class SmsVerifier:
    """Accepts `AERO <COMMAND> <8-digit code>` signed by the website; each code works once."""

    def __init__(self, drone_id: str, secret: str, clock=time.time):
        self.drone_id, self.key, self.clock, self.used = drone_id, hashlib.sha256(secret.encode()).hexdigest(), clock, set()

    def parse(self, text: str):
        m = SMS_RE.match(text)
        if not m:
            return None, "Not an AERO command."
        body = " ".join(text.split()[1:-1]).upper()
        code = m.group(5)
        window = int(self.clock() // SMS_WINDOW_S)
        if code in self.used or not any(hmac.compare_digest(code, sms_code(self.key, self.drone_id, body, w)) for w in (window, window - 1, window + 1)):
            return None, "Code is wrong, expired or already used."
        self.used.add(code)
        word = body.split()[0]
        if word == "GOTO":
            lat, lng, alt = float(m.group(2)), float(m.group(3)), float(m.group(4))
            return SmsCommand("GOTO", (lng, lat), alt), None
        return SmsCommand(word), None


# --- Vehicles ------------------------------------------------------------------------
@dataclass
class VehicleState:
    lng: float = 0.0
    lat: float = 0.0
    alt_m: float = 0.0
    heading: float = 0.0
    ground_speed: float = 0.0
    battery: float = 100.0
    gps_fix: int = 0
    satellites: int = 0
    armed: bool = False
    mode: str = "UNKNOWN"
    on_ground: bool = True

    @property
    def point(self):
        return (self.lng, self.lat)


class SimVehicle:
    """A simple physics model so the full website <-> drone loop can be tested without hardware."""

    CRUISE_CLIMB, DESCENT = 2.5, 1.5

    def __init__(self, home=(-122.2585, 37.8719)):
        self.s = VehicleState(lng=home[0], lat=home[1], gps_fix=3, satellites=14, mode="GUIDED")
        self.home = home
        self.target = None  # (point, alt, speed)
        self.action = "idle"  # idle | takeoff | goto | hold | land | rtl
        self.released = False

    def state(self) -> VehicleState:
        return self.s

    def arm_and_takeoff(self, alt):
        self.s.armed, self.s.on_ground, self.s.mode = True, False, "GUIDED"
        self.target, self.action = (self.s.point, alt, 0.0), "takeoff"

    def goto(self, point, alt, speed):
        self.target, self.action, self.s.mode = (point, alt, speed), "goto", "GUIDED"

    def hold(self):
        self.target, self.action, self.s.mode = (self.s.point, self.s.alt_m, 0.0), "hold", "LOITER"

    def land(self):
        self.action, self.s.mode = "land", "LAND"

    def rtl(self):
        self.action, self.s.mode = "rtl", "RTL"

    def release(self):
        self.released = True

    def step(self, dt: float):
        s = self.s
        if s.armed:
            s.battery = max(0.0, s.battery - dt * (0.05 + 0.004 * s.ground_speed))
        if self.action in ("takeoff", "goto", "hold") and self.target:
            point, alt, speed = self.target
            s.alt_m += max(-self.DESCENT * dt, min(self.CRUISE_CLIMB * dt, alt - s.alt_m))
            self._fly_towards(point, speed, dt)
        elif self.action == "rtl":
            if distance(s.point, self.home) > 1.0:
                s.alt_m += min(self.CRUISE_CLIMB * dt, max(0.0, 30 - s.alt_m))
                self._fly_towards(self.home, 8.0, dt)
            else:
                self.action = "land"
        if self.action == "land":
            s.ground_speed = 0.0
            s.alt_m = max(0.0, s.alt_m - self.DESCENT * dt)
            if s.alt_m <= 0.05:
                s.alt_m, s.armed, s.on_ground, self.action, s.mode = 0.0, False, True, "idle", "GUIDED"

    def _fly_towards(self, point, speed, dt):
        s = self.s
        remaining = distance(s.point, point)
        if remaining < 0.05 or speed <= 0:
            s.ground_speed = 0.0
            return
        s.heading = bearing(s.point, point)
        step = min(remaining, speed * dt)
        s.lng, s.lat = point if step >= remaining else move(s.point, s.heading, step)
        s.ground_speed = step / dt if dt else 0.0

    def close(self):
        pass


class MavlinkVehicle:
    """ArduPilot Copter over MAVLink. Tested against ArduPilot SITL; use GUIDED-capable firmware."""

    def __init__(self, connection: str, baud: int = 57600):
        from pymavlink import mavutil  # imported here so --sim works without pymavlink

        self.mavutil = mavutil
        self.m = mavutil.mavlink_connection(connection, baud=baud, source_system=255)
        log.info("Waiting for flight controller heartbeat on %s ...", connection)
        if not self.m.wait_heartbeat(timeout=30):
            raise RuntimeError("No heartbeat from the flight controller. Check wiring, baud rate and SERIALx_PROTOCOL=2.")
        self.s = VehicleState()
        self.lock = threading.Lock()
        self.command_acks = {}  # MAV_CMD id -> MAV_RESULT, filled by the reader thread
        for msg_id, hz in ((33, 4), (24, 1), (1, 1), (245, 1), (74, 4)):  # position, GPS, status, landed, VFR_HUD
            self.m.mav.command_long_send(self.m.target_system, self.m.target_component,
                                         mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0, msg_id, 1_000_000 / hz, 0, 0, 0, 0, 0)
        self.running = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        mav = self.mavutil.mavlink
        while self.running:
            msg = self.m.recv_match(blocking=True, timeout=1)
            if msg is None:
                continue
            kind = msg.get_type()
            with self.lock:
                s = self.s
                if kind == "GLOBAL_POSITION_INT":
                    s.lat, s.lng, s.alt_m = msg.lat / 1e7, msg.lon / 1e7, msg.relative_alt / 1000
                    if msg.hdg != 65535:
                        s.heading = msg.hdg / 100
                    s.ground_speed = math.hypot(msg.vx, msg.vy) / 100
                elif kind == "GPS_RAW_INT":
                    s.gps_fix, s.satellites = msg.fix_type, msg.satellites_visible
                elif kind == "SYS_STATUS" and msg.battery_remaining >= 0:
                    s.battery = float(msg.battery_remaining)
                elif kind == "HEARTBEAT" and msg.type != mav.MAV_TYPE_GCS and msg.autopilot != mav.MAV_AUTOPILOT_INVALID:
                    s.armed = bool(msg.base_mode & mav.MAV_MODE_FLAG_SAFETY_ARMED)
                    s.mode = self.m.flightmode
                    if not s.armed:
                        s.on_ground = True
                elif kind == "EXTENDED_SYS_STATE":
                    s.on_ground = msg.landed_state == mav.MAV_LANDED_STATE_ON_GROUND
                elif kind == "COMMAND_ACK":
                    self.command_acks[msg.command] = msg.result

    def state(self) -> VehicleState:
        with self.lock:
            return VehicleState(**self.s.__dict__)

    def _mode(self, name):
        mapping = self.m.mode_mapping() or {}
        if name not in mapping:
            raise RuntimeError(f"Flight controller has no {name} mode.")
        self.m.set_mode(mapping[name])

    def arm_and_takeoff(self, alt):
        self._mode("GUIDED")
        self.m.arducopter_arm()
        deadline = time.time() + 10
        while not self.state().armed:
            if time.time() > deadline:
                raise RuntimeError("Motors did not arm. Check pre-arm messages in your ground station.")
            time.sleep(0.2)
        self.m.mav.command_long_send(self.m.target_system, self.m.target_component,
                                     self.mavutil.mavlink.MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0, 0, 0, 0, float(alt))

    def goto(self, point, alt, speed):
        mav = self.mavutil.mavlink
        self._mode("GUIDED")
        self.m.mav.command_long_send(self.m.target_system, self.m.target_component,
                                     mav.MAV_CMD_DO_CHANGE_SPEED, 0, 1, float(speed), -1, 0, 0, 0, 0)
        self.m.mav.set_position_target_global_int_send(
            0, self.m.target_system, self.m.target_component, mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
            0b110111111000, int(point[1] * 1e7), int(point[0] * 1e7), float(alt), 0, 0, 0, 0, 0, 0, 0, 0)

    def hold(self):
        try:
            self._mode("BRAKE")
        except RuntimeError:
            self._mode("LOITER")

    def land(self):
        self._mode("LAND")

    def rtl(self):
        self._mode("RTL")

    def release(self):
        """Open the payload gripper (ArduPilot GRIPPER_ENABLE=1, servo or EPM)."""
        mav = self.mavutil.mavlink
        with self.lock:
            self.command_acks.pop(mav.MAV_CMD_DO_GRIPPER, None)
        self.m.mav.command_long_send(self.m.target_system, self.m.target_component,
                                     mav.MAV_CMD_DO_GRIPPER, 0, 1, 0, 0, 0, 0, 0, 0)  # gripper 1, 0 = release
        deadline = time.time() + 3
        while time.time() < deadline:
            with self.lock:
                result = self.command_acks.get(mav.MAV_CMD_DO_GRIPPER)
            if result is not None:
                if result != mav.MAV_RESULT_ACCEPTED:
                    raise RuntimeError(f"Gripper refused the release (result {result}). Check GRIPPER_ENABLE.")
                return
            time.sleep(0.1)
        raise RuntimeError("No answer from the gripper. Check GRIPPER_ENABLE and wiring.")

    def close(self):
        self.running = False


# --- Pilot: runs commands safely on any vehicle --------------------------------------
@dataclass
class Config:
    home: tuple | None = None
    geofence_m: float = 500.0
    max_alt_m: float = 40.0
    min_battery_pct: float = 30.0

    @classmethod
    def from_server(cls, data: dict) -> "Config":
        home = data.get("home")
        return cls(tuple(home) if home else None, float(data.get("geofenceM", 500)), float(data.get("maxAltM", 40)), float(data.get("minBatteryPct", 30)))


@dataclass
class Pilot:
    vehicle: object
    allow_flight: bool
    clock: callable = time.time
    config: Config = field(default_factory=Config)
    state: str = "landed"
    command_id: str | None = None
    route: list = field(default_factory=list)
    waypoint: int = 0
    alt: float = 0.0
    speed: float = 6.0
    land_at_end: bool = True
    last_link: float = 0.0
    link_action: str | None = None
    in_control: bool = False  # True only while the agent itself is flying the drone
    release_at_end: bool = False  # drop the package after landing at the last waypoint
    payload: str = "unknown"  # loaded / empty / unknown, reported to the website
    mode_set_at: float = -1e9  # telemetry can lag a mode change; ignore manual modes briefly after one
    message: str = ""
    acks: list = field(default_factory=list)
    seen: set = field(default_factory=set)

    def __post_init__(self):
        self.last_link = self.clock()

    # ----- commands
    def ack(self, command_id, status, message=""):
        if command_id:
            self.acks.append({"commandId": command_id, "status": status, "message": message[:200]})
        if message:
            self.message = message
        log.info("%s %s %s", command_id or "-", status, message)

    def check_route(self, waypoints, alt) -> str | None:
        s, c = self.vehicle.state(), self.config
        if not self.allow_flight:
            return "Observe-only: restart the agent with --allow-flight."
        if s.gps_fix < 3:
            return "No 3D GPS fix."
        if s.battery < c.min_battery_pct:
            return f"Battery {s.battery:.0f}% is below {c.min_battery_pct:.0f}%."
        if c.home is None:
            return "No home point yet."
        if alt > c.max_alt_m or alt < 5:
            return f"Altitude must be 5-{c.max_alt_m:.0f} m."
        for i, p in enumerate(waypoints):
            if distance(c.home, p) > c.geofence_m:
                return f"Waypoint {i + 1} is outside the {c.geofence_m:.0f} m geofence."
        return None

    def handle(self, command: dict):
        cid, kind, params = command.get("id"), command.get("type"), command.get("params") or {}
        if cid in self.seen:
            return
        self.seen.add(cid)
        try:
            if kind == "PING":
                self.ack(cid, "done", "Pong from the drone.")
            elif kind in ("HOLD", "LAND", "RTL"):
                # Safety commands are always obeyed, even in observe-only mode.
                self._cancel_route("superseded by " + kind)
                getattr(self.vehicle, kind.lower())()
                self.in_control, self.mode_set_at = True, self.clock()
                self.state = {"HOLD": "holding", "LAND": "landing", "RTL": "returning"}[kind]
                self.command_id = cid
                self.ack(cid, "accepted" if kind != "HOLD" else "done", f"{kind} engaged.")
                if kind == "HOLD":
                    self.command_id = None
            elif kind == "FLY_ROUTE":
                waypoints = [tuple(p) for p in params.get("waypoints", [])]
                alt, speed = float(params.get("altM", 0)), float(params.get("speedMs", 6))
                refused = self.check_route(waypoints, alt) if waypoints else "Route has no waypoints."
                if refused:
                    self.ack(cid, "failed", refused)
                    return
                self._cancel_route("replaced by a new flight")
                self.command_id, self.route, self.waypoint, self.alt, self.speed = cid, waypoints, 0, alt, max(1.0, min(15.0, speed))
                self.land_at_end = bool(params.get("land", True))
                # A drop-off leg is only sent after a person confirmed loading at the pickup.
                self.release_at_end = bool(params.get("release", False)) and self.land_at_end
                if self.release_at_end:
                    self.payload = "loaded"
                self.in_control, self.mode_set_at = True, self.clock()
                s = self.vehicle.state()
                if s.on_ground or not s.armed:
                    self.vehicle.arm_and_takeoff(alt)
                    self.state = "taking_off"
                else:
                    self._go()
                self.ack(cid, "accepted", f"Flying {len(waypoints)} waypoint(s) at {alt:.0f} m.")
            else:
                self.ack(cid, "failed", f"Unknown command {kind}.")
        except Exception as exc:  # never leave the drone without a decision
            log.exception("Command failed")
            self.ack(cid, "failed", str(exc))
            self._safe_hold()

    def handle_sms(self, sms: SmsCommand):
        if sms.command == "GOTO":
            self.handle({"id": f"sms-{int(self.clock() * 1000)}", "type": "FLY_ROUTE", "params": {"waypoints": [sms.point], "altM": sms.alt_m, "speedMs": 6, "land": False}})
        elif sms.command in ("HOLD", "LAND", "RTL"):
            self.handle({"id": f"sms-{int(self.clock() * 1000)}", "type": sms.command})

    def _cancel_route(self, why):
        if self.command_id:
            self.ack(self.command_id, "failed", f"Command {why}.")
        self.command_id, self.route, self.release_at_end = None, [], False

    def _go(self):
        self.vehicle.goto(self.route[self.waypoint], self.alt, self.speed)
        self.state, self.mode_set_at = "en_route", self.clock()

    def _safe_hold(self):
        try:
            if not self.vehicle.state().on_ground:
                self.vehicle.hold()
                self.state = "holding"
        except Exception:
            log.exception("Hold failed")
            self.state = "error"

    # ----- called ~5x per second
    def tick(self):
        s, now = self.vehicle.state(), self.clock()
        airborne = not s.on_ground
        # The RC pilot always wins: a manual mode switch ends agent control immediately.
        if self.in_control and now - self.mode_set_at > 3 and str(s.mode).upper() in MANUAL_MODES:
            self._cancel_route("cancelled: the pilot took manual control")
            self.in_control, self.state, self.link_action = False, "idle" if airborne else "landed", None
            self.message = "Pilot took manual control."
            log.warning(self.message)
        # Agent failsafes only apply to flights the agent is flying.
        if self.in_control and airborne and self.state not in ("returning", "landing"):
            if s.battery < CRITICAL_BATTERY_PCT:
                self._failsafe("RTL", f"Battery critical ({s.battery:.0f}%). Returning home.")
            elif self.config.home and distance(self.config.home, s.point) > self.config.geofence_m + 30:
                self._failsafe("RTL", "Left the geofence. Returning home.")
        offline = now - self.last_link
        if self.in_control and airborne and self.state not in ("returning", "landing") and offline > LINK_HOLD_S and self.link_action is None:
            self.link_action = "hold"
            self._cancel_route("stopped: website link lost")
            self.vehicle.hold()
            self.state = "holding"
            self.message = "Website link lost. Holding position."
        if self.in_control and airborne and offline > LINK_RTL_S and self.link_action == "hold":
            self.link_action = "rtl"
            self._failsafe("RTL", "Website link lost for 45 s. Returning home.")
        # Mission progress.
        if self.state == "taking_off" and s.alt_m >= self.alt * 0.9:
            self._go()
        elif self.state == "en_route" and self.route and distance(s.point, self.route[self.waypoint]) <= WAYPOINT_RADIUS_M:
            if self.waypoint + 1 < len(self.route):
                self.waypoint += 1
                self._go()
            elif self.land_at_end:
                self.vehicle.land()
                self.state = "landing"
            else:
                self.vehicle.hold()
                self.state = "holding"
                self.ack(self.command_id, "done", "Arrived. Hovering at the destination.")
                self.command_id, self.route = None, []
        if self.state in ("landing", "returning") and s.on_ground and not s.armed:
            self.state = "landed"
            status, note = "done", "Landed."
            if self.release_at_end:
                try:
                    self.vehicle.release()
                    self.payload, note = "empty", "Landed. Package released."
                except Exception as exc:  # report it; the website marks the delivery for attention
                    status, note = "failed", f"Landed, but the package release failed: {exc}"
                self.release_at_end = False
            if self.command_id:
                self.ack(self.command_id, status, note)
            self.command_id, self.route = None, []
        if s.on_ground and not s.armed:
            self.in_control = False
            if self.state in ("idle", "holding"):
                self.state = "landed"

    def _failsafe(self, action, message):
        self._cancel_route("stopped by a failsafe")
        getattr(self.vehicle, action.lower())()
        self.mode_set_at = self.clock()
        self.state = "returning" if action == "RTL" else "holding"
        self.message = message
        log.warning(message)

    def link_ok(self):
        self.last_link = self.clock()
        if self.link_action:
            self.message = "Website link restored."
        self.link_action = None

    def telemetry(self, link: str, simulated: bool) -> dict:
        s = self.vehicle.state()
        return {
            "lat": s.lat, "lng": s.lng, "altM": round(s.alt_m, 2), "headingDeg": round(s.heading % 360, 1),
            "groundSpeedMs": round(s.ground_speed, 2), "batteryPct": round(max(0.0, min(100.0, s.battery)), 1),
            "gpsFix": int(s.gps_fix), "satellites": int(s.satellites), "armed": bool(s.armed), "mode": str(s.mode)[:32],
            "state": self.state, "flightAllowed": self.allow_flight, "link": link, "activeCommandId": self.command_id,
            "waypointIndex": self.waypoint if self.route else None, "message": self.message[:200], "simulated": simulated,
            "agentVersion": VERSION, "payload": self.payload,
        }


# --- Website link --------------------------------------------------------------------
class Website:
    def __init__(self, server: str, token: str, timeout: float = 8.0):
        self.url = server.rstrip("/") + "/api/drone/sync"
        self.token, self.timeout = token, timeout

    def sync(self, telemetry: dict, acks: list) -> dict:
        data = json.dumps({"telemetry": telemetry, "acks": acks}).encode()
        req = urllib.request.Request(self.url, data=data, method="POST", headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "User-Agent": f"aero-agent/{VERSION}"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise RuntimeError(f"Website returned {exc.code}: {detail}") from exc


# --- 4G modem SMS --------------------------------------------------------------------
class Modem:
    """Reads (and optionally answers) texts through the modem's AT command port, e.g. /dev/ttyUSB2."""

    def __init__(self, port: str, baud: int = 115200):
        import serial  # pyserial

        self.port = serial.Serial(port, baud, timeout=2)
        self._at("AT")
        self._at("AT+CMGF=1")  # text mode

    def _at(self, command: str, timeout: float = 4.0) -> str:
        self.port.reset_input_buffer()
        self.port.write((command + "\r").encode())
        out, deadline = "", time.time() + timeout
        while time.time() < deadline:
            out += self.port.read(self.port.in_waiting or 1).decode(errors="replace")
            if re.search(r"\r?\n(OK|ERROR|\+CMS ERROR[^\n]*)\r?\n", out):
                break
        return out

    def unread(self):
        raw = self._at('AT+CMGL="REC UNREAD"')
        return parse_cmgl(raw)

    def delete(self, index: int):
        self._at(f"AT+CMGD={index}")

    def send(self, number: str, text: str):
        self.port.write(f'AT+CMGS="{number}"\r'.encode())
        time.sleep(0.5)
        self.port.write(text.encode()[:160] + b"\x1a")
        time.sleep(2)


def parse_cmgl(raw: str):
    """Parse `+CMGL: <index>,"<stat>","<sender>",...` blocks into (index, sender, text)."""
    messages, lines = [], raw.replace("\r", "").split("\n")
    for i, line in enumerate(lines):
        m = re.match(r'^\+CMGL:\s*(\d+),"[^"]*","([^"]*)"', line)
        if m and i + 1 < len(lines):
            messages.append((int(m.group(1)), m.group(2), lines[i + 1].strip()))
    return messages


# --- Main loop -----------------------------------------------------------------------
def run(args):
    drone_id, secret = parse_token(args.token)
    if args.sim:
        lat, lng = (float(v) for v in args.sim_home.split(","))
        vehicle, simulated = SimVehicle((lng, lat)), True
    else:
        vehicle, simulated = MavlinkVehicle(args.connect, args.baud), False
    pilot = Pilot(vehicle, allow_flight=args.allow_flight)
    website = Website(args.server, args.token)
    verifier = SmsVerifier(drone_id, secret)
    modem = Modem(args.modem) if args.modem else None
    log.info("AERO agent %s for drone %s (%s, flight %s)", VERSION, drone_id[:8], "simulated" if simulated else args.connect,
             "ENABLED" if args.allow_flight else "disabled: observe-only")
    last_sync = last_sms = 0.0
    last_step = time.time()
    try:
        while True:
            now = time.time()
            if simulated:
                vehicle.step(now - last_step)
            last_step = now
            pilot.tick()
            if now - last_sync >= args.interval:
                last_sync = now
                acks, pilot.acks = pilot.acks, []
                try:
                    reply = website.sync(pilot.telemetry(args.link, simulated), acks)
                    pilot.link_ok()
                    pilot.config = Config.from_server(reply.get("config") or {})
                    if reply.get("command"):
                        pilot.handle(reply["command"])
                except Exception as exc:
                    pilot.acks = acks + pilot.acks  # resend next time
                    log.warning("Sync failed: %s", exc)
            if modem and now - last_sms >= 5:
                last_sms = now
                for index, sender, text in modem.unread():
                    command, error = verifier.parse(text)
                    modem.delete(index)
                    if command and command.command == "STATUS":
                        t = pilot.telemetry(args.link, simulated)
                        reply = f"AERO {pilot.state} {t['lat']:.6f},{t['lng']:.6f} alt {t['altM']:.0f}m bat {t['batteryPct']:.0f}%"
                    elif command:
                        pilot.handle_sms(command)
                        reply = f"AERO {command.command} received. {pilot.message}"
                    else:
                        reply = f"AERO ignored: {error}"
                    log.info("SMS from %s: %s -> %s", sender, text, reply)
                    if args.sms_reply and sender:
                        modem.send(sender, reply)
            time.sleep(0.2)
    except KeyboardInterrupt:
        log.info("Stopping. The flight controller keeps its own failsafes.")
    finally:
        vehicle.close()


def main(argv=None):
    p = argparse.ArgumentParser(description="Link a drone to the AERO website over 4G.")
    p.add_argument("--server", required=True, help="Website URL, e.g. https://aero-returns.example.com")
    p.add_argument("--token", required=True, help="Drone token from the Fly page (aero_<id>.<secret>)")
    vehicle = p.add_mutually_exclusive_group(required=True)
    vehicle.add_argument("--connect", help="MAVLink connection: /dev/serial0, /dev/ttyACM0, udp:127.0.0.1:14550 (SITL)")
    vehicle.add_argument("--sim", action="store_true", help="Use the built-in simulated drone (no hardware)")
    p.add_argument("--baud", type=int, default=57600)
    p.add_argument("--sim-home", default="37.8719,-122.2585", help="Simulated start as lat,lng")
    p.add_argument("--allow-flight", action="store_true", help="Accept motion commands. Without it the drone only reports telemetry.")
    p.add_argument("--modem", help="4G modem AT port for SMS commands, e.g. /dev/ttyUSB2")
    p.add_argument("--sms-reply", action="store_true", help="Text back a confirmation for each SMS command")
    p.add_argument("--link", default="4g", choices=["4g", "lte", "5g", "wifi", "ethernet", "sim", "other"])
    p.add_argument("--interval", type=float, default=1.0, help="Seconds between website syncs")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run(args)


if __name__ == "__main__":
    main()
