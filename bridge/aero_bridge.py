#!/usr/bin/env python3
"""AERO bridge: the AERO web app's signed text link <-> MAVLink.

Runs on a drone's companion computer (or a laptop wired to the flight controller). It
polls the app over HTTPS (4G data) or exchanges SMS through a 4G/GSM modem, validates
every command locally, and flies a PX4 or ArduPilot multicopter through pymavlink, or
the built-in fake vehicle, which needs no hardware and no dependencies.

Hackathon prototype. The pilot in command keeps an RC transmitter with override
authority and the autopilot's own failsafes stay enabled. See bridge/README.md and
docs/DRONE_LINK.md.
"""
from __future__ import annotations

import argparse
import http.client
import json
import logging
import math
import os
import queue
import re
import signal
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aero_protocol as proto  # noqa: E402

log = logging.getLogger('aero')
USER_AGENT = 'aero-bridge/1.0'

# --- Local safety limits -----------------------------------------------------------
HARD_MAX_ALT_M = 120.0       # 400 ft
HARD_MAX_FENCE_M = 2000.0
MIN_FLIGHT_ALT_M = 2.0       # TAKEOFF/GOTO targets below this are rejected (ALTITUDE)
ALT_TOLERANCE_M = 1.5        # TAKEOFF / GOTO altitude reached
GOTO_TOLERANCE_M = 3.0       # GOTO horizontal arrival
HOME_TOLERANCE_M = 5.0       # RTL on the ground this close to home needs no flight
MODE_GRACE_S = 2.5           # an unexpected flight mode for this long fails the command
HOLD_SETTLE_S = 8.0
SMS_MIN_LINK_TIMEOUT_S = 45.0
LOOP_PERIOD_S = 0.05
CLOCK_TOLERANCE_S = 5.0      # a trusted time source this far off replaces an unsynced system clock
PLAUSIBLE_UNIX = (1735689600, 3155760000)  # 2025-01-01 .. 2070-01-01; outside is a modem's default clock

ENDING_KINDS = frozenset({'LAND', 'RTL', 'ABORT'})
RTL_MODES = frozenset({'RTL', 'SMART_RTL', 'AUTO_RTL', 'AUTO.RTL'})
LAND_MODES = frozenset({'LAND', 'AUTO.LAND', 'AUTO.PRECLAND'})
TAKEOFF_MODES = frozenset({'AUTO.TAKEOFF', 'TAKEOFF'})


class BridgeError(Exception):
    """A fatal configuration or start-up problem, reported without a traceback."""


class VehicleError(Exception):
    """A vehicle action could not be started. `reason` is a protocol REASON token."""

    def __init__(self, reason: str, detail: str = ''):
        super().__init__(detail or reason)
        self.reason = reason if proto.REASON.fullmatch(reason) else 'VEHICLE_ERROR'


# --- Geodesy ---------------------------------------------------------------------
EARTH_RADIUS_M = 6371008.8


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def local_offset_m(lat1: float, lon1: float, lat2: float, lon2: float) -> Tuple[float, float]:
    """(north, east) metres from point 1 to point 2; flat-earth, fine within a few km."""
    north = math.radians(lat2 - lat1) * EARTH_RADIUS_M
    east = math.radians(lon2 - lon1) * EARTH_RADIUS_M * math.cos(math.radians((lat1 + lat2) / 2))
    return north, east


def offset_position(lat: float, lon: float, north: float, east: float) -> Tuple[float, float]:
    lat2 = lat + math.degrees(north / EARTH_RADIUS_M)
    lon2 = lon + math.degrees(east / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    return lat2, lon2


def _approach(value: float, target: float, step: float) -> float:
    if abs(target - value) <= step:
        return target
    return value + step if target > value else value - step


def _finite(value, default: float = 0.0) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return default
    return value if math.isfinite(value) else default


def _clamp(value, lo: float, hi: float, default: float = 0.0) -> float:
    return min(hi, max(lo, _finite(value, default)))


# --- Vehicle model ---------------------------------------------------------------
MAV_LANDED_STATE_UNDEFINED, MAV_LANDED_STATE_ON_GROUND, MAV_LANDED_STATE_IN_AIR = 0, 1, 2
MAV_LANDED_STATE_TAKEOFF, MAV_LANDED_STATE_LANDING = 3, 4


@dataclass
class Snapshot:
    """What the bridge knows about the vehicle right now."""
    connected: bool = False
    have_position: bool = False
    lat: float = 0.0
    lon: float = 0.0
    rel_alt: float = 0.0            # metres above home
    heading: float = 0.0
    speed: float = 0.0              # ground speed m/s
    battery: float = -1.0           # percent, -1 unknown
    fix: int = 0                    # MAVLink GPS_FIX_TYPE
    sats: int = 0
    armed: bool = False
    landed_state: int = MAV_LANDED_STATE_UNDEFINED
    mode: str = 'UNKNOWN'
    home: Optional[Tuple[float, float]] = None

    @property
    def airborne(self) -> bool:
        if self.landed_state in (MAV_LANDED_STATE_IN_AIR, MAV_LANDED_STATE_TAKEOFF, MAV_LANDED_STATE_LANDING):
            return True
        if self.landed_state == MAV_LANDED_STATE_ON_GROUND:
            return False
        return self.armed and self.rel_alt > 1.0

    @property
    def landed(self) -> bool:
        """On the ground with motors disarmed (the DONE condition for LAND/RTL/ABORT)."""
        return not self.airborne and not self.armed


class Vehicle:
    """Interface shared by the fake vehicle and the MAVLink backend.

    Action methods return once the action has started and raise VehicleError otherwise.
    `bridge_modes` holds the flight modes the last action is expected to leave the
    vehicle in; any other mode while airborne means the pilot or the autopilot took over.
    The commander empties it when that happens or the vehicle disarms.
    """
    autopilot = 'UNKNOWN'
    live = False

    def __init__(self):
        self.bridge_modes: FrozenSet[str] = frozenset()

    def describe(self) -> str:
        return self.autopilot

    def connect(self, stop: threading.Event) -> bool:
        return True

    def poll(self) -> None:
        pass

    def snapshot(self) -> Snapshot:
        raise NotImplementedError

    def takeoff(self, alt: float) -> None:
        raise NotImplementedError

    def goto(self, lat: float, lon: float, alt: float) -> None:
        raise NotImplementedError

    def hold(self) -> None:
        raise NotImplementedError

    def land(self) -> None:
        raise NotImplementedError

    def rtl(self) -> None:
        raise NotImplementedError

    def refresh(self) -> None:
        """Re-send the current position target (called every few seconds during GOTO)."""

    def close(self) -> None:
        pass


class FakeVehicle(Vehicle):
    """Kinematic multicopter for demos and tests: no autopilot and no dependencies.

    poll() integrates the motion up to clock(); pass a simulated clock to step it fast.
    """
    autopilot = 'FAKE'
    live = True
    CRUISE_MS = 10.0
    CLIMB_MS = 2.0
    DESCENT_MS = 1.5
    RTL_ALT_M = 15.0
    DRAIN_AIRBORNE = 0.08   # % per second (about 20 minutes from full)
    DRAIN_ARMED = 0.01
    MAX_STEP_S = 0.1

    def __init__(self, home_lat: float, home_lon: float, clock: Callable[[], float] = time.monotonic,
                 battery: float = 95.0):
        super().__init__()
        self.clock = clock
        self.home = (float(home_lat), float(home_lon))
        self.lat, self.lon = self.home
        self.alt = 0.0
        self.armed = False
        self.mode = 'STABILIZE'
        self.phase = 'ground'   # ground takeoff hover goto land rtl
        self.battery = float(battery)
        self.fix, self.sats = 3, 14
        self.heading = 0.0
        self.speed = 0.0
        self.target: Optional[Tuple[float, float, float]] = None
        self._rtl_alt, self._rtl_stage = self.RTL_ALT_M, 'climb'
        self._last = clock()

    def describe(self) -> str:
        return f'fake vehicle at {self.lat:.6f},{self.lon:.6f}'

    @property
    def airborne(self) -> bool:
        return self.phase != 'ground'

    def connect(self, stop: threading.Event) -> bool:
        log.info('fake vehicle ready at %.6f,%.6f (battery %.0f%%); no MAVLink is involved',
                 self.lat, self.lon, self.battery)
        return True

    def poll(self) -> None:
        now = self.clock()
        dt, self._last = max(0.0, now - self._last), now
        while dt > 1e-9:
            step = min(dt, self.MAX_STEP_S)
            self._step(step)
            dt -= step

    def _step(self, dt: float) -> None:
        moved = 0.0
        if self.phase == 'takeoff':
            self.alt = _approach(self.alt, self.target[2], self.CLIMB_MS * dt)
            if self.alt == self.target[2]:
                self.phase = 'hover'
        elif self.phase == 'goto':
            moved = self._fly(self.target[0], self.target[1], dt)
            self._climb_to(self.target[2], dt)
            if (self.lat, self.lon, self.alt) == self.target:
                self.phase = 'hover'
        elif self.phase == 'land':
            self._descend(dt)
        elif self.phase == 'rtl':
            if self._rtl_stage == 'climb':
                self._climb_to(self._rtl_alt, dt)
                if self.alt >= self._rtl_alt:
                    self._rtl_stage = 'return'
            elif self._rtl_stage == 'return':
                moved = self._fly(self.home[0], self.home[1], dt)
                if (self.lat, self.lon) == self.home:
                    self._rtl_stage = 'descend'
            else:
                self._descend(dt)
        self.speed = moved / dt
        drain = self.DRAIN_AIRBORNE if self.airborne else self.DRAIN_ARMED if self.armed else 0.0
        self.battery = max(0.0, self.battery - drain * dt)

    def _fly(self, lat: float, lon: float, dt: float) -> float:
        north, east = local_offset_m(self.lat, self.lon, lat, lon)
        dist = math.hypot(north, east)
        step = self.CRUISE_MS * dt
        if dist <= step:
            self.lat, self.lon = lat, lon
            return dist
        self.heading = math.degrees(math.atan2(east, north)) % 360.0
        self.lat, self.lon = offset_position(self.lat, self.lon, north * step / dist, east * step / dist)
        return step

    def _climb_to(self, alt: float, dt: float) -> None:
        rate = self.CLIMB_MS if alt > self.alt else self.DESCENT_MS
        self.alt = _approach(self.alt, alt, rate * dt)

    def _descend(self, dt: float) -> None:
        self.alt = max(0.0, self.alt - self.DESCENT_MS * dt)
        if self.alt <= 0.0:
            self.phase, self.armed, self.target = 'ground', False, None  # auto-disarm on touchdown

    def _set(self, mode: str, phase: str, target) -> None:
        self.mode, self.phase, self.target = mode, phase, target
        self.bridge_modes = frozenset({mode})

    def takeoff(self, alt: float) -> None:
        if self.airborne:
            self._set('GUIDED', 'goto', (self.lat, self.lon, float(alt)))
            return
        if self.fix < 3:
            raise VehicleError('NO_GPS')
        if self.battery <= 0:
            raise VehicleError('ARM_DENIED')
        self.armed = True
        self._set('GUIDED', 'takeoff', (self.lat, self.lon, float(alt)))

    def goto(self, lat: float, lon: float, alt: float) -> None:
        if not self.airborne:
            raise VehicleError('NOT_AIRBORNE')
        self._set('GUIDED', 'goto', (float(lat), float(lon), float(alt)))

    def hold(self) -> None:
        if self.airborne:
            self._set('BRAKE', 'hover', None)

    def land(self) -> None:
        if self.airborne:
            self._set('LAND', 'land', None)
        else:
            self.armed = False

    def rtl(self) -> None:
        if not self.airborne:
            raise VehicleError('NOT_AIRBORNE')
        self._rtl_alt, self._rtl_stage = max(self.RTL_ALT_M, self.alt), 'climb'
        self._set('RTL', 'rtl', None)

    def snapshot(self) -> Snapshot:
        landed_state = {'ground': MAV_LANDED_STATE_ON_GROUND, 'takeoff': MAV_LANDED_STATE_TAKEOFF,
                        'land': MAV_LANDED_STATE_LANDING}.get(self.phase, MAV_LANDED_STATE_IN_AIR)
        return Snapshot(connected=True, have_position=True, lat=self.lat, lon=self.lon, rel_alt=self.alt,
                        heading=self.heading, speed=self.speed, battery=self.battery, fix=self.fix,
                        sats=self.sats, armed=self.armed, landed_state=landed_state, mode=self.mode,
                        home=self.home)


# --- MAVLink backend ---------------------------------------------------------------
MAV_TYPE_GCS = 6
MAV_AUTOPILOT_ARDUPILOTMEGA = 3
MAV_AUTOPILOT_INVALID = 8
MAV_AUTOPILOT_PX4 = 12
MAV_STATE_ACTIVE = 4
MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1
MAV_MODE_FLAG_SAFETY_ARMED = 128
MAV_CMD_NAV_RETURN_TO_LAUNCH = 20
MAV_CMD_NAV_LAND = 21
MAV_CMD_NAV_TAKEOFF = 22
MAV_CMD_DO_SET_MODE = 176
MAV_CMD_DO_SET_HOME = 179
MAV_CMD_DO_REPOSITION = 192
MAV_CMD_COMPONENT_ARM_DISARM = 400
MAV_CMD_SET_MESSAGE_INTERVAL = 511
MAV_CMD_REQUEST_MESSAGE = 512
MAV_FRAME_GLOBAL = 0
MAV_FRAME_GLOBAL_RELATIVE_ALT_INT = 6
MAV_DO_REPOSITION_FLAGS_CHANGE_MODE = 1
MAV_DATA_STREAM_ALL = 0
MAV_RESULT_ACCEPTED, MAV_RESULT_UNSUPPORTED, MAV_RESULT_IN_PROGRESS = 0, 3, 5
MAV_RESULT_NAMES = {0: 'ACCEPTED', 1: 'TEMPORARILY_REJECTED', 2: 'DENIED', 3: 'UNSUPPORTED', 4: 'FAILED',
                    5: 'IN_PROGRESS', 6: 'CANCELLED'}
POSITION_ONLY_TYPE_MASK = 0b110111111000  # use lat/lon/alt, ignore velocity, accel, yaw, yaw rate
MULTIROTOR_TYPES = frozenset({2, 3, 4, 13, 14, 15, 29, 35})
# message id -> rate (Hz): SYS_STATUS, GPS_RAW_INT, GLOBAL_POSITION_INT, VFR_HUD, BATTERY_STATUS,
# HOME_POSITION, EXTENDED_SYS_STATE
MESSAGE_RATES = ((1, 1.0), (24, 1.0), (33, 4.0), (74, 2.0), (147, 1.0), (242, 0.2), (245, 1.0))
HOME_POSITION_ID = 242

ARDUCOPTER_MODES = {
    0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 7: 'CIRCLE',
    9: 'LAND', 11: 'DRIFT', 13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE', 18: 'THROW',
    19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL', 22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG',
    25: 'SYSTEMID', 26: 'AUTOROTATE', 27: 'AUTO_RTL', 28: 'TURTLE',
}
ARDUCOPTER_MODE_IDS = {name: number for number, name in ARDUCOPTER_MODES.items()}
PX4_MAIN_MODES = {1: 'MANUAL', 2: 'ALTCTL', 3: 'POSCTL', 4: 'AUTO', 5: 'ACRO', 6: 'OFFBOARD', 7: 'STABILIZED',
                  8: 'RATTITUDE', 9: 'SIMPLE', 10: 'TERMINATION'}
PX4_AUTO_SUB_MODES = {1: 'READY', 2: 'TAKEOFF', 3: 'LOITER', 4: 'MISSION', 5: 'RTL', 6: 'LAND', 8: 'FOLLOW',
                      9: 'PRECLAND', 10: 'VTOL_TAKEOFF'}
PX4_MODE_IDS = {'AUTO.TAKEOFF': (4, 2), 'AUTO.LOITER': (4, 3), 'AUTO.RTL': (4, 5), 'AUTO.LAND': (4, 6)}


def px4_mode_name(custom_mode: int) -> str:
    main, sub = (custom_mode >> 16) & 0xFF, (custom_mode >> 24) & 0xFF
    if main == 4:
        return 'AUTO.' + PX4_AUTO_SUB_MODES.get(sub, str(sub))
    return PX4_MAIN_MODES.get(main, f'MODE{main}')


def parse_connect_string(text: str, baud: int) -> Tuple[str, int]:
    """Accept pymavlink strings plus serial:///dev/x[:baud] (MAVSDK style)."""
    if text.startswith('serial:'):
        path = text[len('serial:'):]
        path = path[2:] if path.startswith('//') else path
        match = re.fullmatch(r'(.+?):(\d{4,7})', path)
        if match:
            path, baud = match.group(1), int(match.group(2))
        return path, baud
    return text, baud


class MavlinkVehicle(Vehicle):
    """PX4 or ArduPilot multicopter over pymavlink (imported lazily on connect)."""
    HEARTBEAT_PERIOD_S = 1.0
    LINK_TIMEOUT_S = 3.0

    def __init__(self, connect: str, baud: int = 57600, live: bool = False,
                 home: Optional[Tuple[float, float]] = None, source_system: int = 255,
                 source_component: int = 190, clock: Callable[[], float] = time.monotonic):
        super().__init__()
        self.device, self.baud = parse_connect_string(connect, baud)
        self.live = bool(live)
        self.mission_home = home          # the fence centre: the drone's home pad
        self.source_system, self.source_component = source_system, source_component
        self.clock = clock
        self.m = None
        self.mavutil = None
        self.target_system: Optional[int] = None
        self.target_component: Optional[int] = None
        self.mav_type: Optional[int] = None
        self._hb_tx = self._hb_rx = self._pos_rx = self._ess_rx = self._hud_rx = -1e9
        self._stream_req = self._home_req = -1e9
        self._armed = False
        self._mode = 'UNKNOWN'
        self._lat = self._lon = self._rel_alt = 0.0
        self._amsl: Optional[float] = None
        self._gpi_heading = self._gpi_speed = self._hud_heading = self._hud_speed = 0.0
        self._battery = -1.0
        self._fix = self._sats = 0
        self._landed_state = MAV_LANDED_STATE_UNDEFINED
        self._ap_home: Optional[Tuple[float, float, float]] = None
        self._base_home: Optional[Tuple[float, float, float]] = None  # autopilot home seen at the home pad
        self._acks: Dict[int, int] = {}
        self._goto_target: Optional[Tuple[float, float, float]] = None
        self._last_text = ('', -1e9)

    def describe(self) -> str:
        return f'{self.autopilot} on {self.device}'

    # connection ---------------------------------------------------------------
    def connect(self, stop: threading.Event) -> bool:
        os.environ.setdefault('MAVLINK20', '1')
        try:
            from pymavlink import mavutil
        except ImportError as exc:
            raise BridgeError('--vehicle mavlink needs pymavlink: pip install -r bridge/requirements.txt') from exc
        self.mavutil = mavutil
        self.m = mavutil.mavlink_connection(self.device, baud=self.baud, source_system=self.source_system,
                                            source_component=self.source_component, autoreconnect=True)
        log.info('waiting for an autopilot heartbeat on %s', self.device)
        next_note, ignored = self.clock() + 10.0, set()
        while not stop.is_set():
            self._heartbeat_tick(self.clock())
            msg = self.m.recv_match(type='HEARTBEAT', blocking=True, timeout=0.5)
            if msg is not None and msg.type != MAV_TYPE_GCS and msg.autopilot != MAV_AUTOPILOT_INVALID:
                if msg.autopilot in (MAV_AUTOPILOT_PX4, MAV_AUTOPILOT_ARDUPILOTMEGA):
                    break
                if msg.autopilot not in ignored:
                    ignored.add(msg.autopilot)
                    log.warning('ignoring heartbeat from unsupported autopilot type %d', msg.autopilot)
            if self.clock() >= next_note:
                log.info('still waiting for an autopilot heartbeat on %s', self.device)
                next_note += 10.0
        else:
            return False
        self.target_system, self.target_component = msg.get_srcSystem(), msg.get_srcComponent()
        self.m.target_system, self.m.target_component = self.target_system, self.target_component
        self.autopilot = 'PX4' if msg.autopilot == MAV_AUTOPILOT_PX4 else 'ARDUPILOT'
        self.mav_type = msg.type
        if msg.type not in MULTIROTOR_TYPES:
            log.warning('MAV_TYPE %d is not a multicopter; this bridge is written for multicopters only', msg.type)
        now = self.clock()
        self._handle(msg, now)
        self._request_streams(now)
        log.info('connected to %s autopilot (system %d, component %d), mode %s', self.autopilot,
                 self.target_system, self.target_component, self._mode)
        return True

    def close(self) -> None:
        if self.m is not None:
            try:
                self.m.close()
            except OSError:
                pass

    def _heartbeat_tick(self, now: float) -> None:
        """GCS heartbeat at 1 Hz: if the bridge dies, the autopilot's GCS failsafe trips."""
        if now - self._hb_tx >= self.HEARTBEAT_PERIOD_S:
            self._hb_tx = now
            self.m.mav.heartbeat_send(MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID, 0, 0, MAV_STATE_ACTIVE)

    def _send_long(self, command: int, params: Sequence[float], confirmation: int = 0) -> None:
        p = (list(params) + [0.0] * 7)[:7]
        self.m.mav.command_long_send(self.target_system, self.target_component, command, confirmation, *p)

    def _request_streams(self, now: float) -> None:
        self._stream_req = now
        for msg_id, hz in MESSAGE_RATES:
            self._send_long(MAV_CMD_SET_MESSAGE_INTERVAL, [msg_id, 1e6 / hz])
        if self.autopilot == 'ARDUPILOT':
            self.m.mav.request_data_stream_send(self.target_system, self.target_component, MAV_DATA_STREAM_ALL, 4, 1)
        self._request_home(now)

    def _request_home(self, now: float) -> None:
        self._home_req = now
        self._send_long(MAV_CMD_REQUEST_MESSAGE, [HOME_POSITION_ID])

    # receiving ----------------------------------------------------------------
    def poll(self) -> None:
        now = self.clock()
        self._heartbeat_tick(now)
        for _ in range(500):
            msg = self.m.recv_match(blocking=False)
            if msg is None:
                break
            self._handle(msg, now)
        if now - self._pos_rx > 5.0 and now - self._stream_req > 15.0:
            self._request_streams(now)
        elif self._ap_home is None and now - self._home_req > 10.0:
            self._request_home(now)

    def _pump(self, wait: float) -> None:
        self._heartbeat_tick(self.clock())
        msg = self.m.recv_match(blocking=True, timeout=wait)
        if msg is not None:
            self._handle(msg, self.clock())
            self.poll()

    def _mode_name(self, msg) -> str:
        if not msg.base_mode & MAV_MODE_FLAG_CUSTOM_MODE_ENABLED:
            return 'UNKNOWN'
        if self.autopilot == 'PX4':
            return px4_mode_name(msg.custom_mode)
        if self.mav_type in MULTIROTOR_TYPES or self.mav_type is None:
            return ARDUCOPTER_MODES.get(msg.custom_mode, f'MODE{msg.custom_mode}')
        return self.mavutil.mode_string_v10(msg)

    def _handle(self, msg, now: float) -> None:
        kind = msg.get_type()
        if kind == 'BAD_DATA' or msg.get_srcSystem() != self.target_system:
            return
        if kind == 'HEARTBEAT':
            if msg.get_srcComponent() != self.target_component:
                return
            self._hb_rx = now
            self._armed = bool(msg.base_mode & MAV_MODE_FLAG_SAFETY_ARMED)
            self._mode = self._mode_name(msg)
        elif kind == 'GLOBAL_POSITION_INT':
            self._lat, self._lon = msg.lat / 1e7, msg.lon / 1e7
            self._rel_alt, self._amsl = msg.relative_alt / 1000.0, msg.alt / 1000.0
            if msg.hdg != 65535:
                self._gpi_heading = msg.hdg / 100.0
            self._gpi_speed = math.hypot(msg.vx, msg.vy) / 100.0
            self._pos_rx = now
        elif kind == 'GPS_RAW_INT':
            self._fix = int(msg.fix_type)
            self._sats = 0 if msg.satellites_visible == 255 else int(msg.satellites_visible)
        elif kind == 'SYS_STATUS':
            if msg.battery_remaining >= 0:
                self._battery = float(msg.battery_remaining)
        elif kind == 'BATTERY_STATUS':
            if msg.id == 0 and msg.battery_remaining >= 0:
                self._battery = float(msg.battery_remaining)
        elif kind == 'VFR_HUD':
            self._hud_speed, self._hud_heading, self._hud_rx = float(msg.groundspeed), float(msg.heading), now
        elif kind == 'EXTENDED_SYS_STATE':
            self._landed_state, self._ess_rx = int(msg.landed_state), now
        elif kind == 'HOME_POSITION':
            self._ap_home = (msg.latitude / 1e7, msg.longitude / 1e7, msg.altitude / 1000.0)
            if self.mission_home and distance_m(self._ap_home[0], self._ap_home[1], *self.mission_home) <= 30.0:
                self._base_home = self._ap_home
        elif kind == 'COMMAND_ACK':
            if getattr(msg, 'target_system', 0) in (0, self.source_system):
                self._acks[msg.command] = msg.result
        elif kind == 'STATUSTEXT':
            text = msg.text.decode('ascii', 'replace') if isinstance(msg.text, bytes) else str(msg.text)
            text = text.rstrip('\x00').strip()
            last_text, last_time = self._last_text
            if text and (text != last_text or now - last_time > 5.0):
                self._last_text = (text, now)
                log.log(logging.WARNING if msg.severity <= 4 else logging.INFO, 'autopilot: %s', text)

    def snapshot(self) -> Snapshot:
        now = self.clock()
        hud_fresh = now - self._hud_rx < 3.0
        return Snapshot(
            connected=self.m is not None and now - self._hb_rx < self.LINK_TIMEOUT_S,
            have_position=self._pos_rx > -1e9, lat=self._lat, lon=self._lon, rel_alt=self._rel_alt,
            heading=self._hud_heading if hud_fresh else self._gpi_heading,
            speed=self._hud_speed if hud_fresh else self._gpi_speed,
            battery=self._battery, fix=self._fix, sats=self._sats, armed=self._armed,
            landed_state=self._landed_state if now - self._ess_rx < 5.0 else MAV_LANDED_STATE_UNDEFINED,
            mode=self._mode, home=self._base_home[:2] if self._base_home else self.mission_home)

    # commands -----------------------------------------------------------------
    def _require_live(self) -> None:
        if not self.live:  # defence in depth: the commander already rejects with DRY_RUN
            raise VehicleError('DRY_RUN')

    def _wait_for(self, predicate: Callable[[], bool], timeout: float) -> bool:
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            if predicate():
                return True
            self._pump(0.05)
        return predicate()

    def _await_ack(self, command: int, timeout: float) -> Optional[int]:
        self._wait_for(lambda: command in self._acks, timeout)
        return self._acks.get(command)

    def _command_long(self, command: int, params: Sequence[float], timeout: float = 1.5,
                      attempts: int = 3) -> Optional[int]:
        for attempt in range(attempts):
            self._acks.pop(command, None)
            self._send_long(command, params, confirmation=attempt)
            result = self._await_ack(command, timeout)
            if result is not None:
                return result
        return None

    def _command_int(self, command: int, frame: int, params: Sequence[float], lat: float, lon: float,
                     alt: float, timeout: float = 1.5, attempts: int = 3) -> Optional[int]:
        p1, p2, p3, p4 = params
        for _ in range(attempts):
            self._acks.pop(command, None)
            self.m.mav.command_int_send(self.target_system, self.target_component, frame, command, 0, 0,
                                        p1, p2, p3, p4, int(round(lat * 1e7)), int(round(lon * 1e7)), alt)
            result = self._await_ack(command, timeout)
            if result is not None:
                return result
        return None

    @staticmethod
    def _accepted(result: Optional[int]) -> bool:
        return result in (MAV_RESULT_ACCEPTED, MAV_RESULT_IN_PROGRESS)

    def _set_mode(self, name: str, timeout: float = 3.0) -> None:
        self._require_live()
        if self._mode == name:
            return
        if self.autopilot == 'PX4':
            main, sub = PX4_MODE_IDS[name]
            result = self._command_long(MAV_CMD_DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, main, sub])
        else:
            number = ARDUCOPTER_MODE_IDS[name]
            result = self._command_long(MAV_CMD_DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, number])
            if result in (None, MAV_RESULT_UNSUPPORTED):  # older firmware: legacy SET_MODE message
                self.m.mav.set_mode_send(self.target_system, MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, number)
                result = None
        if result is not None and not self._accepted(result):
            raise VehicleError('MODE_DENIED', f'{name}: {MAV_RESULT_NAMES.get(result, result)}')
        if not self._wait_for(lambda: self._mode == name, timeout):
            raise VehicleError('MODE_TIMEOUT', f'{name} not confirmed by heartbeat')
        log.info('flight mode set to %s', name)

    def _arm(self) -> None:
        if self._armed:
            return
        result = self._command_long(MAV_CMD_COMPONENT_ARM_DISARM, [1], timeout=4.0, attempts=1)
        if result is not None and not self._accepted(result):
            raise VehicleError('ARM_DENIED', MAV_RESULT_NAMES.get(result, str(result)))
        if not self._wait_for(lambda: self._armed, 4.0):
            raise VehicleError('ARM_TIMEOUT')

    def _on_ground(self) -> bool:
        """Fresh evidence that the vehicle is on the ground: an EXTENDED_SYS_STATE from the last
        1.5 s saying so or, without one, no height above home."""
        if self.clock() - self._ess_rx < 1.5:
            return self._landed_state == MAV_LANDED_STATE_ON_GROUND
        return self._rel_alt < 1.0

    def _disarm_on_ground(self) -> None:
        if self._armed and self._on_ground():
            self._command_long(MAV_CMD_COMPONENT_ARM_DISARM, [0], attempts=1)

    def _fresh_position(self, timeout: float = 1.0) -> bool:
        """Wait for a GLOBAL_POSITION_INT handled after now (after arming or a home change)."""
        since = self.clock()
        return self._wait_for(lambda: self._pos_rx > since, timeout)

    def _home_amsl(self) -> Optional[float]:
        if self._ap_home is not None:
            return self._ap_home[2]
        if self._amsl is not None:
            return self._amsl - self._rel_alt  # relative_alt is measured from home
        return None

    def _arming_home_amsl(self) -> Optional[float]:
        """PX4 resets home when it arms, and relative_alt is measured from that new home. Take
        it from one GLOBAL_POSITION_INT sent after arming (AMSL minus relative altitude of the
        same sample), not from a HOME_POSITION cached before arming, which can be metres off."""
        self._request_home(self.clock())
        if not self._fresh_position() or self._amsl is None:
            return self._home_amsl()
        self._ap_home = (self._lat, self._lon, self._amsl - self._rel_alt)
        return self._ap_home[2]

    def _pin_home(self) -> bool:
        """Arming moves the autopilot's home to the arming point. When that is not the home
        pad (re-arming at the pickup or drop pad), put home back so RTL, including the
        autopilot's own failsafe RTL, flies to the home pad and not to the customer.

        Returns True when home was moved back, False when no move was needed (armed on the
        home pad). When the autopilot does not take the home pad, it disarms and raises
        HOME_NOT_SET: every RTL would otherwise land at the customer's pad."""
        if not self.mission_home:
            return False
        lat, lon, alt = self._base_home or (self.mission_home[0], self.mission_home[1], None)
        away = distance_m(self._lat, self._lon, lat, lon)
        if away <= 10.0:
            return False  # armed on the home pad: the autopilot's own home is the best one
        alt = alt if alt is not None else self._home_amsl()
        result = None
        if alt is not None:
            result = self._command_int(MAV_CMD_DO_SET_HOME, MAV_FRAME_GLOBAL, [0, 0, 0, 0], lat, lon, alt)
        if self._accepted(result):
            self._ap_home = (lat, lon, alt)
            log.info('home reset to the home pad %.6f,%.6f after arming %.0f m away from it', lat, lon, away)
            self._fresh_position()  # relative_alt now refers to the new home
            return True
        self._disarm_on_ground()
        detail = 'home altitude unknown' if alt is None else \
            f'DO_SET_HOME {MAV_RESULT_NAMES.get(result, "not acknowledged")}'
        raise VehicleError('HOME_NOT_SET', f'{detail} {away:.0f} m from the home pad; RTL would land here')

    def takeoff(self, alt: float) -> None:
        self._require_live()
        snap = self.snapshot()
        if snap.airborne:
            self._reposition(snap.lat, snap.lon, alt)
            return
        if self.autopilot == 'ARDUPILOT':
            self._set_mode('GUIDED')
            self._arm()
            self._pin_home()
            params = [0, 0, 0, 0, 0, 0, alt]  # alt above home
            modes = frozenset({'GUIDED'})
        else:
            self._arm()
            home_amsl = self._ap_home[2] if self._pin_home() else self._arming_home_amsl()
            if home_amsl is None:
                self._disarm_on_ground()
                raise VehicleError('NO_POSITION')
            nan = float('nan')  # PX4: param7 is AMSL; NaN lat/lon/yaw = current
            params = [-1, 0, 0, nan, nan, nan, home_amsl + alt]
            modes = frozenset({'AUTO.TAKEOFF', 'AUTO.LOITER'})
        self._goto_target = None
        self.bridge_modes = modes  # before sending: a takeoff that does start is always supervised
        self._send_takeoff(params, modes)

    def _send_takeoff(self, params: Sequence[float], modes: FrozenSet[str]) -> None:
        """NAV_TAKEOFF without blind retries. A retry after a lost COMMAND_ACK reaches a vehicle
        that is already climbing, and ArduCopter rejects it ("can't takeoff again"), so the
        outcome is read from the vehicle's state, not from the ack alone."""
        self._fresh_position()
        base_alt, result = self._rel_alt, None
        for attempt in range(2):
            sent = self.clock()
            result = self._command_long(MAV_CMD_NAV_TAKEOFF, params, timeout=3.0, attempts=1)
            if self._accepted(result):
                return

            def climbing() -> bool:
                lifting = self._ess_rx > sent and self._landed_state in (MAV_LANDED_STATE_TAKEOFF,
                                                                          MAV_LANDED_STATE_IN_AIR)
                return self._armed and self._mode in modes and (self._rel_alt - base_alt > 0.5 or lifting)

            if self._wait_for(climbing, 3.0):
                log.warning('NAV_TAKEOFF answered %s, but the vehicle is armed and climbing in %s: '
                            'taking it as the takeoff in progress', MAV_RESULT_NAMES.get(result, 'nothing'),
                            self._mode)
                return
            grounded = self._ess_rx > sent and self._on_ground() and self._rel_alt - base_alt <= 0.5
            if result is not None or not grounded or attempt:
                break
            log.warning('NAV_TAKEOFF was not acknowledged and the vehicle is still on the ground; sending it again')
        self._disarm_on_ground()
        raise VehicleError('TAKEOFF_DENIED', MAV_RESULT_NAMES.get(result, 'no ack'))

    def _reposition(self, lat: float, lon: float, alt: float) -> None:
        if self.autopilot == 'ARDUPILOT':
            self._set_mode('GUIDED')
            self._goto_target = (lat, lon, alt)
            self._send_position_target()
            self.bridge_modes = frozenset({'GUIDED'})
            return
        home_amsl = self._home_amsl()
        if home_amsl is None:
            raise VehicleError('NO_POSITION')
        result = self._command_int(MAV_CMD_DO_REPOSITION, MAV_FRAME_GLOBAL,
                                   [-1, MAV_DO_REPOSITION_FLAGS_CHANGE_MODE, 0, float('nan')],
                                   lat, lon, home_amsl + alt)
        if not self._accepted(result):
            raise VehicleError('GOTO_DENIED', MAV_RESULT_NAMES.get(result, 'no ack'))
        self.bridge_modes = frozenset({'AUTO.LOITER'})

    def _send_position_target(self) -> None:
        lat, lon, alt = self._goto_target
        self.m.mav.set_position_target_global_int_send(
            0, self.target_system, self.target_component, MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
            POSITION_ONLY_TYPE_MASK, int(round(lat * 1e7)), int(round(lon * 1e7)), alt, 0, 0, 0, 0, 0, 0, 0, 0)

    def goto(self, lat: float, lon: float, alt: float) -> None:
        self._require_live()
        if not self.snapshot().airborne:
            raise VehicleError('NOT_AIRBORNE')
        self._reposition(lat, lon, alt)

    def refresh(self) -> None:
        if self.live and self.autopilot == 'ARDUPILOT' and self._goto_target and self._mode == 'GUIDED':
            self._send_position_target()

    def hold(self) -> None:
        self._require_live()
        self._goto_target = None
        if self.autopilot == 'ARDUPILOT':  # record only the mode actually set: LOITER is also a pilot mode
            try:
                self._set_mode('BRAKE')
                self.bridge_modes = frozenset({'BRAKE'})
            except VehicleError as exc:
                log.warning('BRAKE unavailable (%s); using LOITER', exc.reason)
                self._set_mode('LOITER')
                self.bridge_modes = frozenset({'LOITER'})
            return
        snap = self.snapshot()
        try:
            self._reposition(snap.lat, snap.lon, snap.rel_alt)
        except VehicleError as exc:
            log.warning('hold by reposition failed (%s); switching to AUTO.LOITER', exc.reason)
            self._set_mode('AUTO.LOITER')
        self.bridge_modes = frozenset({'AUTO.LOITER'})

    def land(self) -> None:
        self._require_live()
        self._goto_target = None
        name = 'AUTO.LAND' if self.autopilot == 'PX4' else 'LAND'
        try:
            self._set_mode(name)
        except VehicleError as exc:
            log.warning('%s mode failed (%s); sending MAV_CMD_NAV_LAND', name, exc.reason)
            nan = float('nan') if self.autopilot == 'PX4' else 0.0
            result = self._command_long(MAV_CMD_NAV_LAND, [0, 0, 0, nan, nan, nan, nan if self.autopilot == 'PX4' else 0])
            if not self._accepted(result):
                raise VehicleError('LAND_DENIED', MAV_RESULT_NAMES.get(result, 'no ack')) from exc
        self.bridge_modes = frozenset({name})

    def rtl(self) -> None:
        self._require_live()
        self._goto_target = None
        modes = {'AUTO.RTL', 'AUTO.LAND'} if self.autopilot == 'PX4' else {'RTL', 'SMART_RTL', 'AUTO_RTL', 'LAND'}
        result = self._command_long(MAV_CMD_NAV_RETURN_TO_LAUNCH, [])
        if not (self._accepted(result) and self._wait_for(lambda: self._mode in modes, 3.0)):
            log.warning('MAV_CMD_NAV_RETURN_TO_LAUNCH: %s; trying RTL mode', MAV_RESULT_NAMES.get(result, 'no ack'))
            try:
                self._set_mode('AUTO.RTL' if self.autopilot == 'PX4' else 'RTL')
            except VehicleError as exc:
                raise VehicleError('RTL_DENIED', exc.reason) from exc
        self.bridge_modes = frozenset(modes)


# --- Time -------------------------------------------------------------------------------
def system_clock_synced() -> Optional[bool]:
    """Kernel clock status on Linux (adjtimex): True while NTP, chrony or timesyncd keeps the
    clock synchronized, False when it is not (STA_UNSYNC: set at boot, by fake-hwclock or an
    RTC), None where it cannot be told."""
    try:
        import ctypes
        import ctypes.util
        libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
        timex = ctypes.create_string_buffer(512)  # struct timex with modes = 0: a read-only query
        state = libc.adjtimex(timex)
    except (OSError, AttributeError, TypeError):
        return None
    return None if state < 0 else state != 5  # 5 = TIME_ERROR


class WallClock:
    """Unix time for message timestamps and command expiry: the system clock, plus an offset
    while the system clock is not NTP-synced and a trusted source (the modem's network time,
    the server's Date header) disagrees with it by more than CLOCK_TOLERANCE_S."""

    def __init__(self, system: Callable[[], float] = time.time,
                 synced: Callable[[], Optional[bool]] = system_clock_synced):
        self.system, self.synced = system, synced
        self.offset = 0.0
        self.source: Optional[str] = None   # the trusted source last seen
        self._warned = -1e9

    def __call__(self) -> float:
        return self.system() + self.offset

    def calibrate(self, reference: float, source: str) -> None:
        if not PLAUSIBLE_UNIX[0] <= reference < PLAUSIBLE_UNIX[1]:
            return
        first, self.source = self.source is None, source
        delta = reference - self.system()
        if self.synced():
            if self.offset:
                log.info('system clock is NTP-synced now; no longer using %s', source)
                self.offset = 0.0
            if abs(delta) > CLOCK_TOLERANCE_S and time.monotonic() - self._warned > 600:
                self._warned = time.monotonic()
                log.warning('the NTP-synced system clock is %+.0f s off %s; keeping the system clock',
                            -delta, source)
            return
        if abs(delta) <= CLOCK_TOLERANCE_S:
            if self.offset:
                log.info('system clock agrees with %s again; using the system clock', source)
                self.offset = 0.0
            elif first:
                log.info('system clock agrees with %s (%+.1f s)', source, -delta)
            return
        if abs(delta - self.offset) > 2.0:
            log.warning('system clock is %+.0f s off %s and not NTP-synced: using %s for timestamps and '
                        'command expiry', -delta, source, source)
            self.offset = delta


# --- Persistence, sequencing and the outgoing queue ------------------------------------
class SeqCounter:
    """seq = max(previous + 1, unix milliseconds): strictly increasing, survives restarts."""

    def __init__(self, wall: Callable[[], float] = time.time):
        self._wall = wall
        self._prev = 0
        self._lock = threading.Lock()

    def next(self) -> int:
        with self._lock:
            self._prev = max(self._prev + 1, int(self._wall() * 1000))
            return self._prev


def _valid_ack(status, reason) -> bool:
    return status in proto.ACK_STATUSES and (reason is None or (isinstance(reason, str) and
                                                               proto.REASON.fullmatch(reason) is not None))


class StateStore:
    """Highest executed cmdSeq, the last ack of recent commands and the acks the server has
    not received yet (the outbox), in a small JSON file. Thread-safe: the transport thread
    saves the outbox as acks are delivered."""
    MAX_ACKS = 64

    def __init__(self, path, drone_id: str):
        self.path = Path(path).expanduser()
        self.drone_id = drone_id
        self.last_cmd_seq = 0
        self.acks: Dict[int, Tuple[str, Optional[str]]] = {}
        self.outbox: List[Tuple[int, str, Optional[str]]] = []
        self._lock = threading.RLock()
        self._load()

    def _load(self) -> None:
        try:
            raw = self.path.read_text(encoding='utf-8')
        except FileNotFoundError:
            return
        except OSError as exc:
            raise BridgeError(f'cannot read state file {self.path}: {exc}') from exc
        try:
            data = json.loads(raw)
            if data.get('droneId') != self.drone_id:
                raise ValueError(f'it belongs to drone {data.get("droneId")!r}')
            last = data.get('lastCmdSeq', 0)
            if not isinstance(last, int) or isinstance(last, bool) or last < 0:
                raise ValueError('lastCmdSeq is not a non-negative integer')
            acks = {}
            for seq, (status, reason) in (data.get('acks') or {}).items():
                if not _valid_ack(status, reason):
                    raise ValueError(f'bad ack entry for {seq}')
                acks[int(seq)] = (status, reason)
            outbox = []
            for seq, status, reason in data.get('outbox') or []:  # absent in files from older bridges
                if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1 or not _valid_ack(status, reason):
                    raise ValueError(f'bad outbox entry for {seq}')
                outbox.append((seq, status, reason))
        except (ValueError, TypeError, AttributeError) as exc:
            raise BridgeError(f'state file {self.path} is invalid ({exc}). Fix it or move it away; '
                              'removing it resets replay protection.') from exc
        self.last_cmd_seq, self.acks, self.outbox = last, acks, outbox

    def save(self) -> None:
        with self._lock:
            data = {'version': 1, 'droneId': self.drone_id, 'lastCmdSeq': self.last_cmd_seq,
                    'acks': {str(k): [s, r] for k, (s, r) in sorted(self.acks.items())},
                    'outbox': [list(entry) for entry in self.outbox]}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix='.aero-bridge-', suffix='.tmp', dir=str(self.path.parent))
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                    json.dump(data, handle, indent=1)
                    handle.write('\n')
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise

    def ack_for(self, seq: int) -> Optional[Tuple[str, Optional[str]]]:
        return self.acks.get(seq)

    def in_flight(self) -> List[int]:
        return sorted(seq for seq, (status, _) in self.acks.items() if status == 'ACCEPTED')

    def mark_executed(self, seq: int) -> None:
        with self._lock:
            self.last_cmd_seq = max(self.last_cmd_seq, seq)
            self.save()

    def record_ack(self, seq: int, status: str, reason: Optional[str] = None) -> None:
        with self._lock:
            self.acks[seq] = (status, reason)
            for old in sorted(self.acks)[:-self.MAX_ACKS]:
                del self.acks[old]
            self.save()

    def save_outbox(self, entries: Sequence[Tuple[int, str, Optional[str]]]) -> None:
        with self._lock:
            self.outbox = list(entries)[-self.MAX_ACKS:]
            self.save()


@dataclass
class _PendingAck:
    id: int
    cmd_seq: int
    status: str
    reason: Optional[str]


class Outbox:
    """Thread-safe queue of acks plus the latest telemetry. Lines are signed when sent, so
    every transmission (including a retry) carries a fresh seq and timestamp. `persist`, when
    set, receives the queued acks after every change, so they survive a bridge restart."""
    MAX_LINES = 20

    def __init__(self, drone_id: str, key: str, seq: SeqCounter, wall: Callable[[], float] = time.time):
        self.drone_id, self.key, self.seq, self.wall = drone_id, key, seq, wall
        self._lock = threading.Lock()
        self._acks: List[_PendingAck] = []
        self._next_id = 1
        self._telemetry: Optional[dict] = None
        self.airborne = False
        self.persist: Optional[Callable[[List[Tuple[int, str, Optional[str]]]], None]] = None

    def _changed(self) -> None:  # called with the lock held, so saves happen in order
        if self.persist is not None:
            try:
                self.persist([(a.cmd_seq, a.status, a.reason) for a in self._acks])
            except OSError as exc:  # never let a full disk stop the link
                log.error('cannot save the ack queue in the state file: %s', exc)

    def set_telemetry(self, fields: dict) -> None:
        with self._lock:
            self._telemetry = dict(fields)

    def add_ack(self, cmd_seq: int, status: str, reason: Optional[str] = None) -> None:
        with self._lock:
            if any(a.cmd_seq == cmd_seq and a.status == status and a.reason == reason for a in self._acks):
                return
            self._acks.append(_PendingAck(self._next_id, cmd_seq, status, reason))
            self._next_id += 1
            self._changed()

    def pending(self) -> List[Tuple[int, str, Optional[str]]]:
        with self._lock:
            return [(a.cmd_seq, a.status, a.reason) for a in self._acks]

    def _ack_line(self, a: _PendingAck) -> str:
        body = proto.format_ack(proto.Ack(self.drone_id, self.seq.next(), math.floor(self.wall()),
                                          a.cmd_seq, a.status, a.reason))
        return proto.sign_line(self.key, body)

    def _telemetry_line(self) -> Optional[str]:
        if self._telemetry is None:
            return None
        body = proto.format_telemetry(proto.Telemetry(self.drone_id, self.seq.next(), math.floor(self.wall()),
                                                      **self._telemetry))
        if proto.parse_drone_body(body) is None:  # never send a line the server would reject
            log.error('internal error: telemetry failed the protocol self-check: %s', body)
            return None
        return proto.sign_line(self.key, body)

    def build(self, include_telemetry: bool = True) -> Tuple[List[str], List[int]]:
        """Signed lines for one HTTPS POST: acks first, then telemetry (newest seq last)."""
        with self._lock:
            acks = self._acks[:self.MAX_LINES - 1]
            lines = [self._ack_line(a) for a in acks]
            if include_telemetry:
                line = self._telemetry_line()
                if line:
                    lines.append(line)
            return lines, [a.id for a in acks]

    def next_ack(self) -> Optional[Tuple[int, str]]:
        with self._lock:
            return (self._acks[0].id, self._ack_line(self._acks[0])) if self._acks else None

    def telemetry_line(self) -> Optional[str]:
        with self._lock:
            return self._telemetry_line()

    def confirm(self, ids: Sequence[int]) -> None:
        done = set(ids)
        with self._lock:
            kept = [a for a in self._acks if a.id not in done]
            if len(kept) != len(self._acks):
                self._acks = kept
                self._changed()


class LinkHealth:
    """Is the AERO server reachable? 'poll' links (HTTPS) count the time since the last good
    exchange. 'push' links (SMS) only see their own side: the time since sending started to
    fail, or since the modem lost its network registration ('radio'). A server or Twilio
    outage is invisible to them, because the modem keeps sending fine."""

    def __init__(self, kind: str = 'poll', clock: Callable[[], float] = time.monotonic):
        self.kind, self.clock = kind, clock
        self._lock = threading.Lock()
        self._last_ok = clock()
        self._failing: Dict[str, float] = {}   # source -> failing since

    def ok(self, source: str = 'send') -> None:
        with self._lock:
            if source == 'send':
                self._last_ok = self.clock()
            self._failing.pop(source, None)

    def fail(self, source: str = 'send') -> None:
        with self._lock:
            self._failing.setdefault(source, self.clock())

    def down_for(self, now: Optional[float] = None) -> float:
        now = self.clock() if now is None else now
        with self._lock:
            if self.kind == 'poll':
                return max(0.0, now - self._last_ok)
            return max(0.0, now - min(self._failing.values())) if self._failing else 0.0


class Throttle:
    """Log the first failure, then at most every `interval` seconds, then the recovery."""

    def __init__(self, interval: float = 30.0):
        self.interval, self._last, self._count = interval, 0.0, 0

    def report(self, message: str) -> None:
        now = time.monotonic()
        self._count += 1
        if self._count == 1 or now - self._last >= self.interval:
            self._last = now
            log.warning('%s%s', message, f' ({self._count} failures so far)' if self._count > 1 else '')

    def clear(self, message: str) -> None:
        if self._count:
            log.info('%s again after %d failure(s)', message, self._count)
        self._count = 0


# --- Telemetry mapping -------------------------------------------------------------

def sanitize_mode(mode: str) -> str:
    mode = re.sub(r'[^A-Za-z0-9_.]', '_', ''.join(str(mode).split()))[:20]
    return mode or 'UNKNOWN'


def telemetry_fields(snap: Snapshot, state: str) -> dict:
    """Clamp a snapshot into the ranges the server's strict parser accepts."""
    battery = _finite(snap.battery, -1.0)
    return dict(
        lat=_clamp(snap.lat, -90.0, 90.0), lon=_clamp(snap.lon, -180.0, 180.0),
        alt=_clamp(snap.rel_alt, -100.0, 999.9),
        battery=-1 if battery < 0 else min(100.0, battery),
        heading=_finite(snap.heading) % 360.0,
        speed=_clamp(snap.speed, 0.0, 100.0),
        fix=int(_clamp(snap.fix, 0, 6)),   # GPS_FIX_TYPE 7 (static) and 8 (PPP) report as 6
        sats=int(_clamp(snap.sats, 0, 99)),
        state=state, mode=sanitize_mode(snap.mode))


def derive_state(snap: Snapshot, job: Optional['Job'], has_flown: bool) -> str:
    """Map the vehicle snapshot and the running command to a protocol STATE."""
    if not snap.connected:
        return 'ERROR'
    kind = job.kind if job else None
    climbing = job is not None and job.phase == 'climb'
    if not snap.armed:
        return 'LANDED' if has_flown else 'IDLE'
    if not snap.airborne:
        if kind == 'TAKEOFF' or climbing:
            return 'TAKEOFF'
        if snap.mode in LAND_MODES or snap.mode in RTL_MODES:
            return 'LANDING'
        return 'ARMED'
    if snap.mode in RTL_MODES:
        return 'RTL'
    if snap.mode in LAND_MODES or snap.landed_state == MAV_LANDED_STATE_LANDING:
        return 'LANDING'
    if kind == 'TAKEOFF' or snap.mode in TAKEOFF_MODES or snap.landed_state == MAV_LANDED_STATE_TAKEOFF:
        return 'TAKEOFF'
    if kind == 'GOTO':
        return 'ENROUTE'
    if kind in ('RTL', 'ABORT'):
        return 'RTL'
    if kind == 'LAND':
        return 'LANDING'
    return 'ENROUTE' if snap.speed > 1.5 else 'HOLD'


# --- Command execution ---------------------------------------------------------------
@dataclass
class Settings:
    drone_id: str
    key: str
    fence_center: Tuple[float, float]
    fence_radius: float
    max_alt: float = 60.0
    cruise_alt: float = 30.0
    battery_floor: float = 30.0
    link_timeout: float = 20.0


@dataclass
class Job:
    kind: str                         # TAKEOFF GOTO HOLD LAND RTL ABORT
    cmd_seq: Optional[int]            # None for the bridge's own link-loss actions
    started: float
    deadline: float = 0.0
    alt: Optional[float] = None       # TAKEOFF target or RTL climb altitude
    target: Optional[Tuple[float, float, float]] = None
    phase: str = 'run'                # run | climb (RTL from the ground) | rtl | land
    label: str = ''
    off_mode_since: Optional[float] = None
    was_airborne: bool = False
    last_refresh: float = 0.0

    @property
    def name(self) -> str:
        return self.label or f'cmd {self.cmd_seq} {self.kind}'


def describe_command(cmd: proto.Command) -> str:
    if cmd.type == 'GOTO':
        return f'GOTO {cmd.args[0]:.6f},{cmd.args[1]:.6f} {cmd.args[2]:.1f} m'
    if cmd.type == 'TAKEOFF':
        return f'TAKEOFF {cmd.args[0]:.1f} m'
    return cmd.type


class Commander:
    """Validates commands, runs one movement command at a time, detects completion,
    produces acks and telemetry, and applies the local link-loss failsafe."""

    def __init__(self, settings: Settings, vehicle: Vehicle, store: StateStore, outbox: Outbox,
                 link: LinkHealth, wall: Callable[[], float] = time.time,
                 mono: Callable[[], float] = time.monotonic):
        self.s, self.vehicle, self.store, self.outbox, self.link = settings, vehicle, store, outbox, link
        self.wall, self.mono = wall, mono
        self.job: Optional[Job] = None
        self.has_flown = False
        self.state = 'IDLE'
        self._labels: Dict[int, str] = {}
        self._failsafe_stage = 0
        self._link_lost = False
        self._off_mode_since: Optional[float] = None
        self._seen: dict = {}
        if store.outbox:  # the server never got these: re-send them, freshly signed
            log.warning('re-sending %d ack(s) the server had not received when the bridge stopped',
                        len(store.outbox))
        for seq, status, reason in store.outbox:
            outbox.add_ack(seq, status, reason)
        outbox.persist = store.save_outbox
        for seq in store.in_flight():
            log.warning('cmd %d was running when the bridge stopped; reporting FAILED BRIDGE_RESTART', seq)
            self._ack(seq, 'FAILED', 'BRIDGE_RESTART')

    # incoming -----------------------------------------------------------------
    def handle_line(self, line: str) -> None:
        body = proto.verify_line(self.s.key, line)
        if body is None:
            log.debug('ignored a line without a valid signature')
            return
        cmd = proto.parse_command_body(body)
        if cmd is None:
            log.warning('ignored a signed line that is not a valid command: %.80s', body)
            return
        if cmd.drone_id != self.s.drone_id:
            log.debug('ignored a command for drone %s', cmd.drone_id)
            return
        self.handle_command(cmd)

    def handle_command(self, cmd: proto.Command) -> None:
        previous = self.store.ack_for(cmd.seq)
        if previous is not None:  # re-delivery of a command we already answered: a no-op
            log.debug('cmd %d repeated; re-sending %s', cmd.seq, previous[0])
            self.outbox.add_ack(cmd.seq, *previous)
            return
        self._labels[cmd.seq] = describe_command(cmd)
        now, snap = self.mono(), self.vehicle.snapshot()
        reason = self.validate(cmd, snap)
        if reason == 'DRY_RUN':
            log.warning('DRY RUN: cmd %d %s not sent to the vehicle (start with --live to fly)',
                        cmd.seq, self._labels[cmd.seq])
        if reason:
            self._ack(cmd.seq, 'REJECTED', reason)
            return
        self.store.mark_executed(cmd.seq)  # persisted before anything reaches the vehicle
        if cmd.type == 'PING':
            self._ack(cmd.seq, 'DONE')
            return
        self._start(cmd.type, cmd.args, cmd.seq, snap, now)

    def validate(self, cmd: proto.Command, snap: Snapshot) -> Optional[str]:
        """Return a REJECTED reason, or None when the command may run."""
        kind, args = cmd.type, cmd.args
        if self.wall() > cmd.expires:
            return 'EXPIRED'
        if cmd.seq <= self.store.last_cmd_seq:
            return 'REPLAY'
        if kind == 'PING':
            return None
        if kind == 'GOTO' and not (-90 <= args[0] <= 90 and -180 <= args[1] <= 180):
            return 'BAD_ARGS'
        # An RTL on the ground away from home climbs first: a takeoff, so it gets a takeoff's checks.
        climbs = kind == 'RTL' and not snap.airborne and not self._near_home(snap)
        lifts = kind == 'TAKEOFF' or climbs
        moves = lifts or kind == 'GOTO'
        if (moves or kind == 'HOLD') and not snap.connected:
            return 'NO_VEHICLE'
        if moves and self.job is not None and self.job.kind == 'ABORT':
            return 'ABORT_ACTIVE'
        if moves and snap.fix < 3:
            return 'NO_GPS'
        if kind == 'GOTO' and not self._inside_fence(args[0], args[1]):
            return 'FENCE'
        if lifts and not self._inside_fence(snap.lat, snap.lon):
            return 'FENCE'
        alt = args[0] if kind == 'TAKEOFF' else args[2] if kind == 'GOTO' else None
        if alt is not None and not MIN_FLIGHT_ALT_M <= alt <= self.s.max_alt:
            return 'ALTITUDE'
        if moves and 0 <= snap.battery < self.s.battery_floor:  # HOLD, LAND, ABORT, airborne RTL: exempt
            return 'LOW_BATT'
        if not self.vehicle.live:
            return 'DRY_RUN'
        if kind == 'GOTO' and not snap.airborne:
            return 'NOT_AIRBORNE'
        return None

    def _inside_fence(self, lat: float, lon: float) -> bool:
        return distance_m(lat, lon, *self.s.fence_center) <= self.s.fence_radius

    @staticmethod
    def _near_home(snap: Snapshot) -> bool:
        return snap.home is not None and distance_m(snap.lat, snap.lon, *snap.home) <= HOME_TOLERANCE_M

    # execution ----------------------------------------------------------------
    def _ack(self, seq: int, status: str, reason: Optional[str] = None) -> None:
        self.store.record_ack(seq, status, reason)
        self.outbox.add_ack(seq, status, reason)
        level = logging.INFO if status in ('ACCEPTED', 'DONE') else logging.WARNING
        log.log(level, 'cmd %d %s: %s%s', seq, self._labels.get(seq, ''), status, f' {reason}' if reason else '')

    def _start(self, kind: str, args: Sequence[float], cmd_seq: Optional[int], snap: Snapshot, now: float,
               label: str = '') -> bool:
        old, self.job = self.job, None
        if old is not None and old.cmd_seq is not None:
            self._ack(old.cmd_seq, 'FAILED', 'SUPERSEDED' if cmd_seq is not None else 'LINK_LOST')
        try:
            job = self._begin(kind, args, cmd_seq, snap, now, label)
        except VehicleError as exc:
            detail = f' (autopilot: {exc})' if str(exc) != exc.reason else ''
            log.error('%s could not start: %s%s', label or f'cmd {cmd_seq} {kind}', exc.reason, detail)
            if cmd_seq is not None:
                self._ack(cmd_seq, 'FAILED', exc.reason)
            return False
        if cmd_seq is not None:
            self._ack(cmd_seq, 'ACCEPTED')
        if job is None:  # already satisfied, e.g. LAND while landed
            if cmd_seq is not None:
                self._ack(cmd_seq, 'DONE')
            else:
                log.info('%s: nothing to do', label)
        else:
            self.job = job
            if cmd_seq is None:
                log.warning('%s started', label)
        return True

    def _return_budget(self, snap: Snapshot) -> float:
        home = snap.home or self.s.fence_center
        return 120.0 + distance_m(snap.lat, snap.lon, *home) / 2.0 + 2.0 * max(snap.rel_alt, self.s.cruise_alt)

    def _begin(self, kind: str, args: Sequence[float], cmd_seq: Optional[int], snap: Snapshot, now: float,
               label: str) -> Optional[Job]:
        v = self.vehicle
        job = Job(kind, cmd_seq, started=now, label=label, last_refresh=now)
        if kind == 'TAKEOFF':
            job.alt = args[0]
            v.takeoff(job.alt)
            job.deadline = now + 30.0 + abs(job.alt - max(snap.rel_alt, 0.0))
        elif kind == 'GOTO':
            job.target = (args[0], args[1], args[2])
            v.goto(*job.target)
            job.deadline = now + 60.0 + distance_m(snap.lat, snap.lon, args[0], args[1]) / 2.0 \
                + abs(args[2] - snap.rel_alt)
        elif kind == 'HOLD':
            if not snap.airborne:
                return None
            v.hold()
            job.deadline = now + 30.0
        elif kind == 'LAND':
            if snap.landed:
                return None
            v.land()
            job.deadline = now + 60.0 + 2.0 * max(snap.rel_alt, 0.0)
        elif not snap.airborne:  # RTL / ABORT on the ground
            if kind == 'ABORT' or self._near_home(snap):
                if not snap.armed:
                    return None
                v.land()  # never take off; LAND mode disarms on the ground
                job.phase, job.deadline = 'land', now + 60.0
                return job
            job.alt, job.phase = self.s.cruise_alt, 'climb'
            v.takeoff(job.alt)
            job.deadline = now + 30.0 + job.alt + self._return_budget(snap)
        else:
            job.phase = self._return(kind)
            job.deadline = now + self._return_budget(snap)
        return job

    def _return(self, kind: str) -> str:
        try:
            self.vehicle.rtl()
            return 'rtl'
        except VehicleError as exc:
            if kind != 'ABORT':
                raise
            log.warning('ABORT: RTL unavailable (%s); landing at the current position', exc.reason)
            self.vehicle.land()
            return 'land'

    def _evaluate(self, job: Job, snap: Snapshot, now: float) -> Optional[Tuple[str, Optional[str]]]:
        if snap.airborne:
            job.was_airborne = True
        modes = self.vehicle.bridge_modes
        if snap.connected and snap.airborne and modes and snap.mode not in modes:
            job.off_mode_since = job.off_mode_since if job.off_mode_since is not None else now
            if now - job.off_mode_since >= MODE_GRACE_S:
                log.warning('%s: flight mode is now %s, set outside the bridge (RC pilot or autopilot failsafe)',
                            job.name, snap.mode)
                return 'FAILED', 'MODE_CHANGED'
        else:
            job.off_mode_since = None
        if job.kind == 'TAKEOFF' or job.phase == 'climb':
            if job.was_airborne and not snap.armed:
                return 'FAILED', 'DISARMED'
            if job.phase == 'climb' and snap.airborne and snap.rel_alt >= job.alt - ALT_TOLERANCE_M:
                try:
                    job.phase = self._return(job.kind)
                except VehicleError as exc:
                    return 'FAILED', exc.reason
                log.info('%s: climbed to %.1f m, returning to launch', job.name, snap.rel_alt)
            elif job.kind == 'TAKEOFF' and snap.airborne and abs(snap.rel_alt - job.alt) <= ALT_TOLERANCE_M:
                return 'DONE', None
        elif job.kind == 'GOTO':
            if not snap.armed:
                return 'FAILED', 'DISARMED'
            lat, lon, alt = job.target
            if distance_m(snap.lat, snap.lon, lat, lon) <= GOTO_TOLERANCE_M and \
                    abs(snap.rel_alt - alt) <= ALT_TOLERANCE_M:
                return 'DONE', None
            if now - job.last_refresh >= 5.0:
                job.last_refresh = now
                try:
                    self.vehicle.refresh()
                except VehicleError:
                    pass
        elif job.kind == 'HOLD':
            if not snap.airborne:
                return 'DONE', None
            if (not modes or snap.mode in modes) and (snap.speed < 1.0 or now - job.started >= HOLD_SETTLE_S):
                return 'DONE', None
        elif snap.landed:  # LAND, and RTL/ABORT after the climb
            return 'DONE', None
        if now > job.deadline:
            return 'FAILED', 'TIMEOUT'
        return None

    def tick(self) -> str:
        """Advance the running command and the failsafe; refresh telemetry. Returns STATE."""
        now, snap = self.mono(), self.vehicle.snapshot()
        self._note_changes(snap)
        if snap.airborne:
            self.has_flown = True
        job = self.job
        if job is not None:
            outcome = self._evaluate(job, snap, now)
            if outcome is not None and self.job is job:
                self.job = None
                status, reason = outcome
                if reason == 'MODE_CHANGED':
                    self._release_control()
                if job.cmd_seq is not None:
                    self._ack(job.cmd_seq, status, reason)
                else:
                    log.log(logging.INFO if status == 'DONE' else logging.WARNING, '%s: %s%s', job.name, status,
                            f' {reason}' if reason else '')
        if self.job is None:
            self._watch_control(snap, now)
        self._link_failsafe(snap, now)
        state = derive_state(snap, self.job, self.has_flown)
        if state != self.state:
            log.info('state %s -> %s', self.state, state)
            self.state = state
        if snap.have_position:
            self.outbox.set_telemetry(telemetry_fields(snap, state))
        self.outbox.airborne = snap.airborne
        return state

    def _release_control(self) -> None:
        """Forget the modes the bridge set: from now on this flight is not the bridge's."""
        self.vehicle.bridge_modes = frozenset()
        self._off_mode_since = None

    def _watch_control(self, snap: Snapshot, now: float) -> None:
        """Between commands, notice that the bridge is no longer the one flying: the vehicle
        disarmed (that flight is over), or the RC pilot or an autopilot failsafe picked another
        mode. The link-loss failsafe then never takes over a flight the bridge is not flying,
        even if the pilot later passes through one of the bridge's old modes. While the vehicle
        hovers in the mode of the bridge's last command, it is still the bridge's flight."""
        modes = self.vehicle.bridge_modes
        if not modes or not snap.connected:
            self._off_mode_since = None
        elif not snap.armed:
            self._release_control()
        elif snap.airborne and snap.mode not in modes:
            self._off_mode_since = now if self._off_mode_since is None else self._off_mode_since
            if now - self._off_mode_since >= MODE_GRACE_S:
                log.warning('flight mode is now %s, set outside the bridge (RC pilot or autopilot failsafe); '
                            'the bridge leaves this flight alone until its next command', snap.mode)
                self._release_control()
        else:
            self._off_mode_since = None

    def _note_changes(self, snap: Snapshot) -> None:
        seen = self._seen
        if seen.get('connected') != snap.connected:
            if seen:
                (log.info if snap.connected else log.warning)('vehicle link %s', 'up' if snap.connected else 'LOST')
            seen['connected'] = snap.connected
        if not snap.connected:
            return
        if seen.get('mode') != snap.mode:
            if 'mode' in seen:
                log.info('flight mode %s -> %s', seen['mode'], snap.mode)
            seen['mode'] = snap.mode
        if seen.get('armed') != snap.armed:
            if 'armed' in seen:
                log.info('vehicle %s', 'ARMED' if snap.armed else 'DISARMED')
            seen['armed'] = snap.armed
        outside = snap.airborne and snap.have_position and not self._inside_fence(snap.lat, snap.lon)
        if outside and not seen.get('outside'):
            log.warning('vehicle is outside the local geofence (%.0f m from the centre)',
                        distance_m(snap.lat, snap.lon, *self.s.fence_center))
        seen['outside'] = outside
        low = snap.airborne and 0 <= snap.battery < self.s.battery_floor
        if low and not seen.get('low'):
            log.warning('battery %.0f%% is below the floor of %.0f%%', snap.battery, self.s.battery_floor)
        seen['low'] = low

    def _link_failsafe(self, snap: Snapshot, now: float) -> None:
        timeout = self.s.link_timeout
        down = self.link.down_for(now)
        if down < timeout:
            if self._link_lost:
                log.info('server link restored')
            self._link_lost, self._failsafe_stage = False, 0
            return
        if not self._link_lost:
            self._link_lost = True
            log.warning('server link lost: no successful exchange for %.0f s', down)
        if not snap.airborne:
            return
        if self._failsafe_stage == 0:
            self._failsafe_stage = 1
            self._failsafe_action('HOLD', down, snap, now)
        elif self._failsafe_stage == 1 and down >= 2 * timeout:
            self._failsafe_stage = 2
            self._failsafe_action('RTL', down, snap, now)

    def _failsafe_action(self, action: str, down: float, snap: Snapshot, now: float) -> None:
        job = self.job
        if job is not None and job.kind in ENDING_KINDS:
            log.warning('server link down %.0f s; %s continues', down, job.name)
            return
        if snap.mode not in self.vehicle.bridge_modes:
            log.warning('server link down %.0f s while airborne in %s, a mode the bridge did not set; '
                        'not intervening', down, snap.mode)
            return
        if not self.vehicle.live:
            log.warning('DRY RUN: server link down %.0f s; would %s', down, action)
            return
        log.warning('server link down %.0f s while airborne: %s', down,
                    'holding position' if action == 'HOLD' else 'returning to launch')
        # The link-loss RTL uses ABORT semantics: falls back to LAND, blocks TAKEOFF/GOTO.
        self._start('HOLD' if action == 'HOLD' else 'ABORT', (), None, snap, now, label=f'link-loss {action}')


# --- HTTPS transport -------------------------------------------------------------------
class HttpsTransport(threading.Thread):
    """POST one telemetry line plus queued acks to /api/drone/link every second; the
    response holds the pending AC1 commands."""
    PERIOD_S = 1.0
    TIMEOUT_S = 5.0

    def __init__(self, server: str, outbox: Outbox, inbound: 'queue.Queue[str]', link: LinkHealth,
                 stop: threading.Event, wall: Optional[WallClock] = None):
        super().__init__(name='aero-https', daemon=True)
        self.url = server.rstrip('/') + '/api/drone/link'
        self.outbox, self.inbound, self.link, self.stop = outbox, inbound, link, stop
        self.wall = wall if wall is not None else WallClock()
        self._problem = Throttle()

    def run(self) -> None:
        log.info('HTTPS link to %s, every %.0f s', self.url, self.PERIOD_S)
        while not self.stop.is_set():
            started = time.monotonic()
            try:
                self.exchange_once()
            except Exception:  # keep the link thread alive whatever happens
                log.exception('unexpected error in the HTTPS transport')
                self.link.fail()
            self.stop.wait(max(0.05, self.PERIOD_S - (time.monotonic() - started)))

    def exchange_once(self) -> Optional[List[str]]:
        lines, ack_ids = self.outbox.build()
        if not lines:
            return None  # no vehicle position yet
        request = urllib.request.Request(self.url, data='\n'.join(lines).encode('ascii'), method='POST',
                                         headers={'Content-Type': 'text/plain', 'User-Agent': USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=self.TIMEOUT_S) as response:
                text = response.read(65536).decode('utf-8', 'replace')
                date = response.headers.get('Date')
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read(200).decode('utf-8', 'replace')
            except OSError:
                detail = ''
            self.link.fail()
            self._problem.report(f'server answered HTTP {exc.code} {" ".join(detail.split())[:120]}'.rstrip())
            return None
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as exc:
            self.link.fail()
            self._problem.report(f'server unreachable: {getattr(exc, "reason", exc)}')
            return None
        self.outbox.confirm(ack_ids)
        self.link.ok()
        self._problem.clear('server reachable')
        self._check_clock(date)
        commands = [line.strip() for line in text.splitlines() if line.strip()]
        for line in commands:
            self.inbound.put(line)
        return commands

    def _check_clock(self, date_header: Optional[str]) -> None:
        """The server's Date header is the clock that sets command expiry: an unsynced local
        clock that is off by more than a few seconds is replaced by it."""
        if not date_header:
            return
        try:
            server_time = parsedate_to_datetime(date_header).timestamp()
        except (TypeError, ValueError, IndexError, OverflowError):
            return
        self.wall.calibrate(server_time, 'the server clock')


# --- SMS transport ---------------------------------------------------------------------
class ModemError(Exception):
    pass


_CMGL_HEADER = re.compile(r'\+CMGL:\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"')
_CCLK = re.compile(r'\+CCLK:\s*"(\d\d)/(\d\d)/(\d\d),(\d\d):(\d\d):(\d\d)([+-]\d{1,2})?"')
_REGISTRATION = re.compile(r'\+C(?:E|G)?REG:\s*\d+\s*,\s*(\d+)')
REGISTERED_STATES = frozenset({1, 5, 6, 7, 9, 10})  # home or roaming, including "SMS only" and CSFB variants
PHONE_NUMBER = re.compile(r'\+?[0-9]{6,15}')


def parse_cclk(text: str) -> Optional[float]:
    """Unix time from an AT+CCLK? reply, '+CCLK: "yy/MM/dd,hh:mm:ss±zz"': local time with zz
    quarter-hours east of UTC (3GPP TS 27.007). None when malformed, or when the modem has no
    network time and still shows its default clock (1980, 2004, 2070, ...)."""
    match = _CCLK.search(text or '')
    if match is None:
        return None
    yy, month, day, hour, minute, second = (int(g) for g in match.groups()[:6])
    try:
        local = datetime(2000 + yy, month, day, hour, minute, second, tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None
    unix = local - int(match.group(7) or 0) * 900
    return unix if PLAUSIBLE_UNIX[0] <= unix < PLAUSIBLE_UNIX[1] else None


def parse_registration(text: str) -> Optional[bool]:
    """Registered or not from an AT+CREG? / AT+CEREG? reply ('+CREG: <n>,<stat>[,...]')."""
    match = _REGISTRATION.search(text or '')
    return None if match is None else int(match.group(1)) in REGISTERED_STATES


def parse_cmgl(lines: Sequence[str]) -> List[Tuple[int, str, str]]:
    """Parse a text-mode AT+CMGL response into (index, sender, text) tuples."""
    messages: List[list] = []
    for line in lines:
        match = _CMGL_HEADER.match(line)
        if match:
            messages.append([int(match.group(1)), match.group(3), []])
        elif messages:
            messages[-1][2].append(line)
    return [(index, sender, '\n'.join(text)) for index, sender, text in messages]


def extract_command_lines(text: str) -> List[str]:
    """AC1 lines inside an SMS. Starts at 'AC1 ' so that a prefix the SMS provider adds
    (Twilio trial accounts prepend 'Sent from your Twilio trial account - ') is dropped."""
    lines = []
    for raw in text.splitlines():
        index = raw.find('AC1 ')
        if index >= 0:
            lines.append(raw[index:].strip())
    return lines


def same_number(a: str, b: str) -> bool:
    da, db = re.sub(r'[^0-9]', '', a or ''), re.sub(r'[^0-9]', '', b or '')
    if not da or not db:
        return False
    n = min(len(da), len(db), 10)
    return da[-n:] == db[-n:]


class Modem:
    """Minimal text-mode AT command driver for a 4G/GSM modem (pyserial). It uses the IRA
    (ASCII) character set only: in the GSM set '~' and '_', which every line contains, are
    other characters, so a modem without IRA cannot carry the link at all."""

    def __init__(self, port: str, baud: int = 115200):
        try:
            import serial
        except ImportError as exc:
            raise BridgeError('--transport sms needs pyserial: pip install -r bridge/requirements.txt') from exc
        self.ser = serial.Serial(port, baudrate=baud, timeout=0.5, write_timeout=5)

    def close(self) -> None:
        try:
            self.ser.close()
        except OSError:
            pass

    def _collect(self, timeout: float, echo: Optional[str] = None) -> List[str]:
        lines, deadline = [], time.monotonic() + timeout
        while time.monotonic() < deadline:
            raw = self.ser.readline()
            if not raw:
                continue
            line = raw.decode('utf-8', 'replace').strip()
            if not line or line == echo:
                continue
            if line == 'OK':
                return lines
            if line == 'ERROR' or line.startswith(('+CME ERROR', '+CMS ERROR')):
                raise ModemError(f'{echo or "modem"}: {line}')
            lines.append(line)
        raise ModemError(f'{echo or "modem"}: no response')

    def command(self, command: str, timeout: float = 5.0) -> List[str]:
        self.ser.reset_input_buffer()
        self.ser.write(command.encode('ascii') + b'\r')
        return self._collect(timeout, command)

    def init(self) -> None:
        self.command('AT')
        self.command('ATE0')
        for optional in ('AT+CMEE=1',):
            try:
                self.command(optional)
            except ModemError:
                pass
        pin = ' '.join(self.command('AT+CPIN?'))
        if 'READY' not in pin:
            raise ModemError(f'SIM not ready ({pin}); remove the SIM PIN')
        self.command('AT+CMGF=1')
        try:
            self.command('AT+CSCS="IRA"')
        except ModemError as exc:
            raise ModemError(f'the modem refuses character set IRA ({exc}); without it the "~" and "_" '
                             'in every line arrive garbled and the server rejects them') from exc
        try:
            charset = ' '.join(self.command('AT+CSCS?'))
        except ModemError:
            charset = 'IRA'  # cannot read it back; the set command was accepted
        if 'IRA' not in charset:
            raise ModemError(f'the modem kept character set {charset or "unknown"} instead of IRA')
        # network time updates (NITZ) into the modem clock; 7-bit text; delete already-read SMS
        for optional in ('AT+CTZU=1', 'AT+CSMP=17,167,0,0', 'AT+CMGD=1,1'):
            try:
                self.command(optional)
            except ModemError:
                log.debug('modem does not support %s', optional)
        try:
            log.info('modem registration: %s', ' '.join(self.command('AT+CREG?')))
        except ModemError:
            pass

    def network_time(self) -> Optional[float]:
        """The modem clock as Unix time once the network has set it (NITZ), otherwise None."""
        try:
            return parse_cclk(' '.join(self.command('AT+CCLK?')))
        except ModemError:
            return None

    def registered(self) -> Optional[bool]:
        """Registered on a mobile network (circuit-switched or LTE), not registered, or None
        when the modem answers neither query."""
        states = []
        for query in ('AT+CREG?', 'AT+CEREG?'):
            try:
                states.append(parse_registration(' '.join(self.command(query))))
            except ModemError:
                pass
        states = [state for state in states if state is not None]
        return any(states) if states else None

    def send_sms(self, number: str, text: str, timeout: float = 60.0) -> None:
        if not PHONE_NUMBER.fullmatch(number) or any(c in text for c in '\r\n\x1a\x1b'):
            raise ModemError('refusing to send a malformed SMS')
        self.ser.reset_input_buffer()
        self.ser.write(f'AT+CMGS="{number}"\r'.encode('ascii'))
        buffer, deadline = b'', time.monotonic() + 10.0
        while b'>' not in buffer:
            if time.monotonic() > deadline or b'ERROR' in buffer:
                self.ser.write(b'\x1b')  # cancel the prompt
                raise ModemError(f'AT+CMGS: no prompt ({buffer.decode("ascii", "replace").strip()})')
            buffer += self.ser.read(self.ser.in_waiting or 1)
        self.ser.write(text.encode('ascii', 'replace') + b'\x1a')
        self._collect(timeout, 'AT+CMGS')

    def list_unread(self) -> List[Tuple[int, str, str]]:
        return parse_cmgl(self.command('AT+CMGL="REC UNREAD"', timeout=15.0))

    def delete(self, index: int) -> None:
        self.command(f'AT+CMGD={int(index)}')


class SmsTransport(threading.Thread):
    """Text lines over SMS: acks right away, telemetry every 15 s airborne / 60 s on the
    ground, and AT+CMGL polling for commands (deleted once read). It also watches the modem's
    network registration and reads its network time, neither of which costs an SMS."""
    POLL_S = 5.0
    AIRBORNE_PERIOD_S = 15.0
    GROUND_PERIOD_S = 60.0
    CLOCK_PERIOD_S = 600.0       # re-read the modem's network time
    CLOCK_RETRY_S = 60.0         # while it has none

    def __init__(self, port: str, baud: int, number: str, outbox: Outbox, inbound: 'queue.Queue[str]',
                 link: LinkHealth, stop: threading.Event, modem_factory: Callable[..., Modem] = Modem,
                 wall: Optional[WallClock] = None):
        super().__init__(name='aero-sms', daemon=True)
        self.port, self.baud, self.number = port, baud, number
        self.outbox, self.inbound, self.link, self.stop = outbox, inbound, link, stop
        self.modem_factory = modem_factory
        self.wall = wall
        self._problem = Throttle(60.0)
        self._clock_problem = Throttle(600.0)
        self._next_telemetry = 0.0
        self._next_poll = 0.0
        self._next_clock = 0.0
        self._registered: Optional[bool] = None
        self._was_airborne = False

    def run(self) -> None:
        modem = None
        while not self.stop.is_set():
            try:
                if modem is None:
                    candidate = self.modem_factory(self.port, self.baud)
                    try:
                        candidate.init()
                    except BaseException:  # not usable: open and initialise it again next time
                        candidate.close()
                        raise
                    modem, self._next_clock = candidate, 0.0
                    log.info('SMS link via %s to %s', self.port, self.number)
                self.cycle(modem)
            except ModemError as exc:
                self.link.fail()
                self._problem.report(f'SMS: {exc}')
                self.stop.wait(5.0)
            except (OSError, BridgeError) as exc:  # serial port trouble: reopen it
                self.link.fail()
                self._problem.report(f'modem {self.port}: {exc}')
                if modem is not None:
                    modem.close()
                modem = None
                self.stop.wait(5.0)
            self.stop.wait(0.25)
        if modem is not None:
            modem.close()

    def _send(self, modem: Modem, line: str) -> None:
        modem.send_sms(self.number, line)
        self.link.ok()
        self._problem.clear('SMS sending works')

    def _sync_clock(self, modem: Modem, now: float) -> None:
        network = modem.network_time()
        if network is not None:
            self._next_clock = now + self.CLOCK_PERIOD_S
            self._clock_problem.clear('modem network time available')
            self.wall.calibrate(network, "the modem's network time")
            return
        self._next_clock = now + self.CLOCK_RETRY_S
        if self.wall.source is None:
            state = {True: 'NTP-synced', False: 'NOT synced: check that it is right'}.get(
                self.wall.synced(), 'of unknown sync state: check that it is right')
            self._clock_problem.report('the modem has no network time yet (NITZ, AT+CCLK?); timestamps and '
                                       f'EXPIRED checks use the system clock, which is {state}')

    def _check_registration(self, modem: Modem) -> None:
        """The one outage the bridge can see without spending SMS: its own modem off the network."""
        registered = modem.registered()
        if registered is None:
            return
        if registered is False and self._registered is not False:
            log.warning('modem is not registered on the mobile network: no SMS can reach the server')
        elif registered and self._registered is False:
            log.info('modem registered on the mobile network again')
        self._registered = registered
        (self.link.ok if registered else self.link.fail)('radio')

    def cycle(self, modem: Modem) -> None:
        now = time.monotonic()
        if self.wall is not None and now >= self._next_clock:
            self._sync_clock(modem, now)  # first, so that acks and command expiry use it
        while True:
            item = self.outbox.next_ack()
            if item is None:
                break
            self._send(modem, item[1])
            self.outbox.confirm([item[0]])
        airborne = self.outbox.airborne
        if airborne and not self._was_airborne:
            self._next_telemetry = now  # report the takeoff right away
        self._was_airborne = airborne
        if now >= self._next_telemetry:
            line = self.outbox.telemetry_line()
            if line:
                self._send(modem, line)
                self._next_telemetry = now + (self.AIRBORNE_PERIOD_S if airborne else self.GROUND_PERIOD_S)
        if now >= self._next_poll:
            self._next_poll = now + self.POLL_S
            self._check_registration(modem)
            for index, sender, text in modem.list_unread():
                if same_number(sender, self.number):
                    for line in extract_command_lines(text):
                        self.inbound.put(line)
                else:
                    log.info('ignored an SMS from an unknown sender (...%s)', sender[-4:])
                modem.delete(index)


# --- Command line ----------------------------------------------------------------------

def latlon(text: str) -> Tuple[float, float]:
    try:
        lat, lon = (float(part) for part in text.split(','))
    except ValueError:
        raise argparse.ArgumentTypeError(f'expected lat,lon, got {text!r}') from None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise argparse.ArgumentTypeError(f'{text!r} is not a valid latitude,longitude')
    return lat, lon


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='aero_bridge.py',
        description='AERO bridge: signed text link (HTTPS or SMS) <-> PX4/ArduPilot MAVLink or a fake vehicle.',
        epilog='Credentials come from the environment: AERO_DRONE_ID and AERO_DRONE_KEY (64 hex characters, '
               'shown in Fleet when the drone is registered). The pilot in command keeps RC override.')
    vehicle = parser.add_argument_group('vehicle')
    vehicle.add_argument('--vehicle', choices=('fake', 'mavlink'), required=True)
    vehicle.add_argument('--connect', default='udpin:0.0.0.0:14550',
                         help='pymavlink connection: udpin:0.0.0.0:14550, tcp:HOST:PORT, /dev/ttyACM0 or '
                              'serial:///dev/serial0 (default: %(default)s)')
    vehicle.add_argument('--baud', type=int, default=57600, help='serial baud rate (default: %(default)s)')
    vehicle.add_argument('--source-system', type=int, default=255,
                         help='MAVLink system id of the bridge; ArduPilot counts GCS heartbeats only from '
                              'SYSID_MYGCS (default: %(default)s)')
    vehicle.add_argument('--live', action='store_true',
                         help='send movement commands to the MAVLink vehicle; without it the bridge is a dry run')
    vehicle.add_argument('--fake-home', type=latlon, help='fake vehicle home lat,lon (default: --fence-center)')
    vehicle.add_argument('--fake-battery', type=float, default=95.0, help='fake starting battery %% (default: 95)')
    link = parser.add_argument_group('link')
    link.add_argument('--transport', choices=('https', 'sms'), required=True)
    link.add_argument('--server', help='AERO app base URL, e.g. https://aero.example.com')
    link.add_argument('--modem', help='modem serial port, e.g. /dev/ttyUSB2')
    link.add_argument('--modem-baud', type=int, default=115200, help='(default: %(default)s)')
    link.add_argument('--sms-to', help="the app's Twilio number in E.164 form, e.g. +15551234567")
    link.add_argument('--link-timeout', type=float, default=20.0,
                      help='seconds without the server while airborne before HOLD; RTL after twice this '
                           '(default: %(default)s; at least 45 for SMS, where only modem send failures '
                           'and network registration loss count)')
    safety = parser.add_argument_group('local safety limits')
    safety.add_argument('--fence-center', type=latlon, help='geofence centre lat,lon: the home pad (required '
                                                            'for mavlink)')
    safety.add_argument('--fence-radius', type=float, help='geofence radius in m, at most 2000 (required for '
                                                           'mavlink; fake default 2000)')
    safety.add_argument('--max-alt', type=float, default=60.0, help='max altitude above home in m, hard cap 120 '
                                                                    '(default: %(default)s)')
    safety.add_argument('--cruise-alt', type=float, default=30.0,
                        help='climb altitude for RTL from the ground (default: %(default)s)')
    safety.add_argument('--battery-floor', type=float, default=30.0,
                        help='reject TAKEOFF, GOTO and an RTL that must climb from a remote pad below this '
                             'battery %% (default: %(default)s)')
    parser.add_argument('--state-file', help='replay-protection state (default: ~/.aero-bridge-<droneId>.json)')
    parser.add_argument('-v', '--verbose', action='store_true', help='debug logging')
    return parser


def configure(argv: Optional[Sequence[str]] = None, env: Optional[dict] = None):
    """Parse and validate arguments and credentials. Returns (args, Settings)."""
    parser = build_parser()
    args = parser.parse_args(argv)
    env = os.environ if env is None else env
    drone_id = env.get('AERO_DRONE_ID', '').strip()
    if not proto.DRONE_ID.fullmatch(drone_id):
        parser.error('set AERO_DRONE_ID to the drone id shown in Fleet (6-16 lowercase letters or digits)')
    key = env.get('AERO_DRONE_KEY', '').strip().lower()
    if not re.fullmatch(r'[0-9a-f]{64}', key):
        parser.error('set AERO_DRONE_KEY to the 64-character hex key shown in Fleet')
    if args.vehicle == 'mavlink':
        if args.fence_center is None or args.fence_radius is None:
            parser.error('--vehicle mavlink requires --fence-center lat,lon and --fence-radius m')
    else:
        args.fake_home = args.fake_home or args.fence_center
        if args.fake_home is None:
            parser.error("--vehicle fake needs --fake-home lat,lon (the drone's home pad in Fleet)")
        args.fence_center = args.fence_center or args.fake_home
        args.fence_radius = HARD_MAX_FENCE_M if args.fence_radius is None else args.fence_radius
    if not 0 < args.fence_radius <= HARD_MAX_FENCE_M:
        parser.error(f'--fence-radius must be in (0, {HARD_MAX_FENCE_M:.0f}] m')
    if not 0 < args.max_alt <= HARD_MAX_ALT_M:
        parser.error(f'--max-alt must be in (0, {HARD_MAX_ALT_M:.0f}] m (hard cap)')
    if not MIN_FLIGHT_ALT_M <= args.cruise_alt <= args.max_alt:
        parser.error(f'--cruise-alt must be between {MIN_FLIGHT_ALT_M:.0f} m and --max-alt')
    if not 0 <= args.battery_floor <= 100:
        parser.error('--battery-floor must be a percentage')
    if args.link_timeout < 5:
        parser.error('--link-timeout must be at least 5 s')
    if args.transport == 'https':
        url = urllib.parse.urlparse(args.server or '')
        if url.scheme not in ('https', 'http') or not url.netloc:
            parser.error('--transport https requires --server https://<your AERO app>')
    else:
        if not args.modem or not args.sms_to:
            parser.error('--transport sms requires --modem /dev/ttyUSBx and --sms-to +1555...')
        if not PHONE_NUMBER.fullmatch(args.sms_to):
            parser.error('--sms-to must be a phone number like +15551234567')
        args.link_timeout = max(args.link_timeout, SMS_MIN_LINK_TIMEOUT_S)
    args.state_file = args.state_file or f'~/.aero-bridge-{drone_id}.json'
    settings = Settings(drone_id=drone_id, key=key, fence_center=args.fence_center,
                        fence_radius=args.fence_radius, max_alt=args.max_alt, cruise_alt=args.cruise_alt,
                        battery_floor=args.battery_floor, link_timeout=args.link_timeout)
    return args, settings


def main(argv: Optional[Sequence[str]] = None) -> int:
    args, settings = configure(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format='%(asctime)s %(levelname)-7s %(message)s', datefmt='%H:%M:%S')
    try:
        store = StateStore(args.state_file, settings.drone_id)
    except BridgeError as exc:
        log.error('%s', exc)
        return 1
    wall = WallClock()
    synced = wall.synced()
    if time.time() < PLAUSIBLE_UNIX[0]:
        log.warning('the system clock is before 2025: until it is corrected (NTP, or the modem network time '
                    'over SMS), stale commands are not recognized as EXPIRED and the server ignores the '
                    "bridge's messages")
    if args.transport == 'sms' and not synced:
        log.warning("SMS link: there is no NTP without mobile data, and the system clock is %s. The bridge "
                    "reads the modem's network time (AT+CTZU=1, AT+CCLK?) and uses it for timestamps and "
                    'command expiry when the system clock is off; until the modem has it, a wrong system '
                    'clock makes EXPIRED checks unreliable', 'not synced' if synced is False else
                    'not known to be synced')
    if args.vehicle == 'fake':
        vehicle: Vehicle = FakeVehicle(*args.fake_home, battery=args.fake_battery)
        if args.live:
            log.info('--live has no effect on the fake vehicle, which always flies')
    else:
        vehicle = MavlinkVehicle(args.connect, baud=args.baud, live=args.live, home=settings.fence_center,
                                 source_system=args.source_system)
    if args.transport == 'https':
        if args.server.startswith('http://') and urllib.parse.urlparse(args.server).hostname not in (
                'localhost', '127.0.0.1', '::1'):
            log.warning('--server uses plain http; use https outside local testing')
    else:
        try:
            import serial  # noqa: F401
        except ImportError:
            log.error('--transport sms needs pyserial: pip install -r bridge/requirements.txt')
            return 1
    link = LinkHealth('poll' if args.transport == 'https' else 'push')
    outbox = Outbox(settings.drone_id, settings.key, SeqCounter(wall), wall=wall)
    inbound: 'queue.Queue[str]' = queue.Queue()
    stop = threading.Event()
    if args.transport == 'https':
        transport: threading.Thread = HttpsTransport(args.server, outbox, inbound, link, stop, wall=wall)
    else:
        transport = SmsTransport(args.modem, args.modem_baud, args.sms_to, outbox, inbound, link, stop, wall=wall)
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    log.info('AERO bridge for drone %s: %s vehicle, %s transport, %s', settings.drone_id, args.vehicle,
             args.transport, 'LIVE' if vehicle.live else 'DRY RUN (start with --live to fly)')
    log.info('local limits: fence %.6f,%.6f radius %.0f m, max altitude %.0f m, battery floor %.0f%%, '
             'link timeout %.0f s, state %s', *settings.fence_center, settings.fence_radius, settings.max_alt,
             settings.battery_floor, settings.link_timeout, store.path)
    commander = None
    try:
        if not vehicle.connect(stop):
            return 0
        commander = Commander(settings, vehicle, store, outbox, link, wall=wall)
        link.ok()  # the link-loss timer starts with the transport, not while waiting for the vehicle
        transport.start()
        failures = 0
        while not stop.is_set():
            try:
                vehicle.poll()
                while True:
                    try:
                        line = inbound.get_nowait()
                    except queue.Empty:
                        break
                    commander.handle_line(line)
                commander.tick()
                failures = 0
            except (BridgeError, KeyboardInterrupt):
                raise
            except Exception:
                failures += 1
                log.exception('error in the bridge loop')
                if failures >= 20:
                    raise
            stop.wait(LOOP_PERIOD_S)
    except KeyboardInterrupt:
        pass
    except BridgeError as exc:
        log.error('%s', exc)
        return 1
    finally:
        stop.set()
        if commander is not None and isinstance(vehicle, MavlinkVehicle):
            snap = vehicle.snapshot()
            (log.warning if snap.airborne or snap.armed else log.info)(
                "bridge stopped. The vehicle was NOT told to land. Without GCS heartbeats the autopilot's "
                'GCS failsafe (PX4 NAV_DLL_ACT, ArduPilot FS_GCS_ENABLE) will act if it is armed; '
                'the RC pilot keeps control.')
        elif commander is not None:
            log.info('bridge stopped; the fake vehicle stops with it')
        vehicle.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
