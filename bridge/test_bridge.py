#!/usr/bin/env python3
"""Tests for the AERO bridge. Standard library only: no pymavlink, pyserial or network.

Run with:  python3 -I bridge/test_bridge.py
      or:  cd bridge && python3 -m unittest -v test_bridge
"""
import contextlib
import email.utils
import http.server
import io
import json
import logging
import math
import os
import queue
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import aero_bridge as bridge  # noqa: E402
import aero_protocol as proto  # noqa: E402

VECTORS = json.loads((HERE.parent / 'tests' / 'fixtures' / 'drone-link-vectors.json').read_text())
DRONE = VECTORS['droneId']
KEY = VECTORS['key']
OTHER_KEY = 'ab' * 32
HOME = (37.871900, -122.258500)
logging.getLogger('aero').setLevel(logging.CRITICAL + 1)  # quiet; assertLogs re-enables per test

# Inputs of tests/fixtures/generate-drone-vectors.mjs
VECTOR_INPUTS = {
    'goto': proto.Command(DRONE, 7, 1761312400, 'GOTO', (37.871234, -122.258901, 30)),
    'takeoff': proto.Command(DRONE, 6, 1761312400, 'TAKEOFF', (30,)),
    'abort': proto.Command(DRONE, 8, 1761312400, 'ABORT', ()),
    'telemetry': proto.Telemetry(DRONE, 1761312345123, 1761312345, 37.8712345, -122.2589012, 29.84, 87, 213, 11.8,
                                 3, 14, 'ENROUTE', 'GUIDED'),
    'ack': proto.Ack(DRONE, 1761312346000, 1761312346, 7, 'DONE'),
    'rejected': proto.Ack(DRONE, 1761312347000, 1761312347, 9, 'REJECTED', 'FENCE'),
}


def format_any(value):
    if isinstance(value, proto.Command):
        return proto.format_command(value)
    if isinstance(value, proto.Telemetry):
        return proto.format_telemetry(value)
    return proto.format_ack(value)


class ProtocolVectorTests(unittest.TestCase):
    def test_key_derivation_matches_typescript(self):
        self.assertEqual(proto.derive_drone_key(VECTORS['master'], DRONE, VECTORS['keyVersion']), KEY)

    def test_every_vector_line_is_reproduced(self):
        self.assertEqual(set(VECTOR_INPUTS), set(VECTORS['lines']))
        for name, value in VECTOR_INPUTS.items():
            with self.subTest(name):
                self.assertEqual(proto.sign_line(KEY, format_any(value)), VECTORS['lines'][name])

    def test_vectors_verify_and_parse_back(self):
        for name, line in VECTORS['lines'].items():
            with self.subTest(name):
                body = proto.verify_line(KEY, line)
                self.assertEqual(body, line[:-18])
                parsed = proto.parse_command_body(body) if line.startswith('AC1') else proto.parse_drone_body(body)
                self.assertIsNotNone(parsed)
                self.assertEqual(proto.line_drone_id(line), DRONE)
        goto = proto.parse_command_body(proto.verify_line(KEY, VECTORS['lines']['goto']))
        self.assertEqual(goto, proto.Command(DRONE, 7, 1761312400, 'GOTO', (37.871234, -122.258901, 30.0)))
        telemetry = proto.parse_drone_body(proto.verify_line(KEY, VECTORS['lines']['telemetry']))
        self.assertEqual((telemetry.kind, telemetry.lat, telemetry.alt, telemetry.heading, telemetry.state),
                         ('telemetry', 37.871234, 29.8, 213, 'ENROUTE'))
        rejected = proto.parse_drone_body(proto.verify_line(KEY, VECTORS['lines']['rejected']))
        self.assertEqual((rejected.kind, rejected.cmd_seq, rejected.status, rejected.reason),
                         ('ack', 9, 'REJECTED', 'FENCE'))

    def test_tampered_lines_are_rejected(self):
        line = VECTORS['lines']['goto']
        body, sig = line[:-18], line[-16:]
        bad = [
            line.replace('30.0', '31.0'),                     # body changed
            body + ' ~' + sig[:-1] + ('0' if sig[-1] != '0' else '1'),
            body + ' ~' + sig.upper(),                        # uppercase hex is not accepted
            body + '  ~' + sig,                               # extra space becomes part of the body
            body + '~' + sig,
            body + ' ~' + sig[:15],
            body,
            '',
            'x' * 201 + ' ~' + sig,                           # body longer than 200 characters
            body.replace(' GOTO', '\nGOTO') + ' ~' + sig,     # line terminators never match
            '\x1c' + line,                                    # JS trim() keeps \x1c, so the HMAC fails
        ]
        for candidate in bad:
            with self.subTest(candidate=candidate[:40]):
                self.assertIsNone(proto.verify_line(KEY, candidate))
        self.assertIsNone(proto.verify_line(OTHER_KEY, line))
        self.assertEqual(proto.verify_line(KEY, '﻿ ' + line + ' \r\n'), body)  # JS trim() strips these

    def test_key_and_secret_checks(self):
        with self.assertRaises(ValueError):
            proto.derive_drone_key('too-short', DRONE, 1)
        with self.assertRaises(ValueError):
            proto.sign_line(KEY.upper(), 'AC1 tst001 1 1 PING')
        with self.assertRaises(ValueError):
            proto.verify_line('abc', VECTORS['lines']['goto'])


class NumberFormattingTests(unittest.TestCase):
    def test_to_fixed_matches_javascript(self):
        # Expected values printed by Node 24 for Number.prototype.toFixed.
        cases = [(0.5, 0, '1'), (2.5, 0, '3'), (-2.5, 0, '-3'), (0.25, 1, '0.3'), (-0.04, 1, '-0.0'),
                 (-0.0, 1, '0.0'), (1.005, 2, '1.00'), (-1e-7, 6, '-0.000000'), (29.84, 1, '29.8'),
                 (37.8712345, 6, '37.871234'), (0.05, 1, '0.1'), (0.15, 1, '0.1'), (0.35, 1, '0.3'),
                 (1.45, 1, '1.4'), (123.4567895, 6, '123.456789'), (30, 1, '30.0')]
        for value, digits, expected in cases:
            with self.subTest(value=value, digits=digits):
                self.assertEqual(proto.js_to_fixed(value, digits), expected)

    def test_math_round_matches_javascript(self):
        cases = [(2.5, 3), (-2.5, -2), (-0.5, 0), (0.49999999999999994, 0), (86.5, 87), (-1, -1), (359.6, 360)]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(proto.js_round(value), expected)

    def test_telemetry_heading_wraps_like_js(self):
        t = VECTOR_INPUTS['telemetry']
        line = proto.format_telemetry(proto.Telemetry(**{**t.__dict__, 'heading': 359.6, 'battery': -1}))
        self.assertEqual(line.split(' ')[7:9], ['-1', '0'])
        line = proto.format_telemetry(proto.Telemetry(**{**t.__dict__, 'heading': -10}))
        self.assertEqual(line.split(' ')[8], '350')  # wrapped into [0, 360) like the TS formatter

    def test_format_command_validation(self):
        good = VECTOR_INPUTS['goto']
        for bad in (proto.Command('TST001', 7, 1, 'GOTO', good.args), proto.Command(DRONE, 0, 1, 'GOTO', good.args),
                    proto.Command(DRONE, 2 ** 53, 1, 'PING'), proto.Command(DRONE, 7, 1, 'GOTO', (1.0, 2.0)),
                    proto.Command(DRONE, 7, 1, 'FLIP'), proto.Command(DRONE, 7, 1, 'TAKEOFF', (math.nan,))):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    proto.format_command(bad)
        self.assertEqual(proto.format_command(proto.Command(DRONE, 9, 1761312400.9, 'PING')),
                         'AC1 tst001 9 1761312400 PING')


class ParserStrictnessTests(unittest.TestCase):
    def test_command_parser(self):
        ok = {
            'AC1 tst001 7 1761312400 GOTO 37.871234 -122.258901 30.0': ('GOTO', (37.871234, -122.258901, 30.0)),
            'AC1 tst001 7 1761312400 TAKEOFF 30': ('TAKEOFF', (30.0,)),
            'AC1 tst001 0007 1761312400 PING': ('PING', ()),
            'AC1 tst001 7 1761312400 GOTO -90 -180 0': ('GOTO', (-90.0, -180.0, 0.0)),  # range edges
        }
        for body, (kind, args) in ok.items():
            with self.subTest(body):
                cmd = proto.parse_command_body(body)
                self.assertEqual((cmd.type, cmd.args), (kind, args))
        bad = [
            'AT1 tst001 7 1761312400 PING', 'AC1 TST001 7 1761312400 PING', 'AC1 tst01 7 1761312400 PING',
            'AC1 tst001 7 1761312400 FLIP', 'AC1 tst001 7 1761312400 PING 1', 'AC1 tst001 7 1761312400 TAKEOFF',
            'AC1 tst001 7 1761312400 GOTO 37.8 -122.2', 'AC1 tst001 0 1761312400 PING',
            'AC1 tst001 +7 1761312400 PING', 'AC1 tst001 -7 1761312400 PING', 'AC1 tst001 7 4102444801 PING',
            'AC1 tst001 7 1761312400 TAKEOFF 1e3', 'AC1 tst001 7 1761312400 TAKEOFF .5',
            'AC1 tst001 7 1761312400 TAKEOFF 30.12345678', 'AC1 tst001 7 1761312400 TAKEOFF 1000.1',
            'AC1 tst001 7 1761312400 TAKEOFF 1000',  # in range, but DECIMAL allows only 3 integer digits
            'AC1 tst001 7 1761312400 GOTO -181 0 30', 'AC1 tst001 7 1761312400 GOTO 90.1 0 30',
            'AC1 tst001 7 1761312400 GOTO 37.8 -122.2 120.1', 'AC1 tst001 7 1761312400 GOTO 37.8 -122.2 -1.5',
            'AC1 tst001 7 1761312400 TAKEOFF 120.1', 'AC1 tst001 7 1761312400  PING',
            'AC1 tst001 7 1761312400 PING ', 'AC1 tst001 7 1761312400 TAKEOFF ٣٠',
            'AC1 tst001 7 1761312400 TAKEOFF 30\n', 'AC1 tst001 99999999999999999 1761312400 PING',
            'AC1 tst001 9007199254740992 1761312400 PING', '',
        ]
        for body in bad:
            with self.subTest(body):
                self.assertIsNone(proto.parse_command_body(body))

    def test_drone_parser(self):
        base = 'AT1 tst001 1761312345123 1761312345 37.871234 -122.258901 29.8 87 213 11.8 3 14 ENROUTE GUIDED'
        self.assertIsNotNone(proto.parse_drone_body(base))
        tokens = base.split(' ')
        replacements = {4: '90.1', 5: '-180.5', 6: '1000.1', 7: '-2', 8: '360', 9: '100.5', 10: '9', 11: '100',
                        12: 'FLYING', 13: 'AUTO-LOITER', 2: '0', 3: '4102444801'}
        for index, value in replacements.items():
            with self.subTest(index=index, value=value):
                mutated = tokens.copy()
                mutated[index] = value
                self.assertIsNone(proto.parse_drone_body(' '.join(mutated)))
        self.assertIsNone(proto.parse_drone_body(base + ' extra'))
        self.assertIsNotNone(proto.parse_drone_body(base.replace('GUIDED', 'AUTO.LOITER')))
        self.assertIsNotNone(proto.parse_drone_body('AK1 tst001 5 1761312346 7 ACCEPTED'))
        for body in ('AK1 tst001 5 1761312346 7 DONE fence', 'AK1 tst001 5 1761312346 7 DONE ',
                     'AK1 tst001 5 1761312346 7 OK', 'AK1 tst001 5 1761312346 0 DONE',
                     'AK1 tst001 5 1761312346 7 DONE A B', 'AK1 tst001 5 1761312346 7 DONE ' + 'X' * 25):
            with self.subTest(body):
                self.assertIsNone(proto.parse_drone_body(body))

    def test_line_drone_id(self):
        self.assertEqual(proto.line_drone_id(VECTORS['lines']['ack']), DRONE)
        self.assertIsNone(proto.line_drone_id('AX1 tst001 1'))
        self.assertIsNone(proto.line_drone_id('AC1'))


# --- Commander rig --------------------------------------------------------------------------
class SimClock:
    def __init__(self):
        self.t = 1000.0

    def mono(self):
        return self.t

    def wall(self):
        return 1761312000.0 + self.t

    def advance(self, dt):
        self.t += dt


class DryRunVehicle(bridge.FakeVehicle):
    live = False

    def _refuse(self, *args):
        raise AssertionError('a movement command reached the vehicle in dry-run mode')

    takeoff = goto = hold = land = rtl = _refuse


class Rig:
    """Commander + store + outbox on a simulated clock. `clock` and `vehicle` may be passed in
    (a MAVLink vehicle on a FakeAutopilot); `wall` is the bridge's clock, the SimClock's wall
    is the true time (the server's)."""

    def __init__(self, vehicle_cls=bridge.FakeVehicle, state_dir=None, battery=95.0, home=HOME, clock=None,
                 vehicle=None, wall=None, link_kind='poll', **overrides):
        self.clock = clock or SimClock()
        self.vehicle = vehicle or vehicle_cls(*home, clock=self.clock.mono, battery=battery)
        self.wall = wall or self.clock.wall
        self.state_dir = state_dir or tempfile.mkdtemp(prefix='aero-test-')
        self.store = bridge.StateStore(os.path.join(self.state_dir, 'state.json'), DRONE)
        self.outbox = bridge.Outbox(DRONE, KEY, bridge.SeqCounter(self.wall), wall=self.wall)
        self.link = bridge.LinkHealth(link_kind, clock=self.clock.mono)
        settings = dict(drone_id=DRONE, key=KEY, fence_center=HOME, fence_radius=1000.0, max_alt=60.0,
                        cruise_alt=30.0, battery_floor=30.0, link_timeout=20.0)
        settings.update(overrides)
        self.commander = bridge.Commander(bridge.Settings(**settings), self.vehicle, self.store, self.outbox,
                                          self.link, wall=self.wall, mono=self.clock.mono)
        self.seq = 100

    def line(self, kind, *args, seq=None, expires_in=30, drone_id=DRONE, key=KEY):
        seq = self.seq + 1 if seq is None else seq
        self.seq = max(self.seq, seq)
        body = proto.format_command(proto.Command(drone_id, seq, int(self.clock.wall()) + expires_in, kind, args))
        return seq, proto.sign_line(key, body)

    def send(self, kind, *args, **kwargs):
        seq, line = self.line(kind, *args, **kwargs)
        self.commander.handle_line(line)
        return seq

    def step(self, dt=0.5, link_ok=True):
        self.clock.advance(dt)
        self.vehicle.poll()
        if link_ok:
            self.link.ok()
        return self.commander.tick()

    def run_until(self, predicate, limit_s, dt=0.5, link_ok=True):
        states, end = [], self.clock.t + limit_s
        while self.clock.t < end:
            states.append(self.step(dt, link_ok))
            if predicate():
                return states
        raise AssertionError(f'condition not met within {limit_s} simulated seconds')

    def status(self, seq):
        entry = self.store.ack_for(seq)
        return entry[0] if entry else None

    def finished(self, seq):
        return lambda: self.status(seq) in ('DONE', 'FAILED')

    def ack_messages(self):
        """Drain the outbox through the real signing/parsing path: [proto.Ack]."""
        lines, ids = self.outbox.build(include_telemetry=False)
        self.outbox.confirm(ids)
        messages = [proto.parse_drone_body(proto.verify_line(KEY, line)) for line in lines]
        assert all(isinstance(msg, proto.Ack) for msg in messages), lines
        return messages

    def acks(self):
        """[(cmdSeq, status, reason)] of the drained acks."""
        return [(msg.cmd_seq, msg.status, msg.reason) for msg in self.ack_messages()]

    def takeoff(self, alt=30.0):
        seq = self.send('TAKEOFF', alt)
        self.run_until(self.finished(seq), 60)
        assert self.status(seq) == 'DONE'
        self.acks()


# --- A MAVLink autopilot without pymavlink ------------------------------------------------------
class _Msg:
    """A received MAVLink message, with the pymavlink accessors MavlinkVehicle uses."""

    def __init__(self, kind, **fields):
        self.__dict__.update(fields)
        self._kind = kind

    def get_type(self):
        return self._kind

    def get_srcSystem(self):
        return 1

    def get_srcComponent(self):
        return 1


class FakeAutopilot:
    """Stands in for a pymavlink connection to ArduCopter or PX4 at the message level: arms
    (which resets home), changes modes, takes off at 2 m/s and answers commands. Options
    reproduce the failure cases: lost acks or commands, refused commands or modes, a slow
    takeoff start, and a pre-arm home altitude that differs from the one set at arming."""
    GROUND = 100.0
    PX4_IDS = {'POSCTL': (3, 0), **bridge.PX4_MODE_IDS}

    def __init__(self, clock, kind='ARDUPILOT', position=HOME, home_error=0.0):
        self.clock, self.kind = clock, kind
        self.mav = self
        self.target_system = self.target_component = 0
        self.lat, self.lon = position
        self.amsl = self.GROUND
        self.home = (position[0], position[1], self.GROUND + home_error)
        self.armed = self.flying = False
        self.mode = 'STABILIZE' if kind == 'ARDUPILOT' else 'POSCTL'
        self.climb_to, self.climb_at, self.takeoff_delay = None, 0.0, 0.0
        self.lose_ack, self.lose_command = set(), set()  # command ids, once each
        self.refuse, self.refuse_modes = {}, set()        # command id -> MAV_RESULT; mode names
        self.sent = []                                    # (command id, params) from the bridge
        self.inbox, self._t, self._due = [], clock.t, {}

    def count(self, command):
        return sum(1 for c, _ in self.sent if c == command)

    # what the bridge calls on m and m.mav
    def heartbeat_send(self, *args):
        pass

    request_data_stream_send = set_position_target_global_int_send = set_mode_send = heartbeat_send

    def close(self):
        pass

    def command_long_send(self, target_system, target_component, command, confirmation, *params):
        self.sent.append((command, params))
        if command in self.lose_command:
            self.lose_command.discard(command)
            return
        result = self._command(command, params)
        if command in self.lose_ack:
            self.lose_ack.discard(command)
        else:
            self.inbox.append(_Msg('COMMAND_ACK', command=command, result=result, target_system=255))

    def command_int_send(self, target_system, target_component, frame, command, current, autocontinue,
                         p1, p2, p3, p4, x, y, z):
        self.sent.append((command, (p1, p2, p3, p4, x, y, z)))
        result = self.refuse.get(command, 0) if command == bridge.MAV_CMD_DO_SET_HOME else 3
        if result == 0:
            self.home = (x / 1e7, y / 1e7, z)
        self.inbox.append(_Msg('COMMAND_ACK', command=command, result=result, target_system=255))

    def _command(self, command, p):
        if command in self.refuse:
            return self.refuse[command]
        if command == bridge.MAV_CMD_DO_SET_MODE:
            name = bridge.ARDUCOPTER_MODES[int(p[1])] if self.kind == 'ARDUPILOT' else \
                {ids: name for name, ids in self.PX4_IDS.items()}[(int(p[1]), int(p[2]))]
            if name in self.refuse_modes:
                return 2
            self.mode = name
        elif command == bridge.MAV_CMD_COMPONENT_ARM_DISARM:
            if p[0] == 1:
                self.armed, self.home = True, (self.lat, self.lon, self.amsl)  # arming resets home
            elif self.flying or self.climb_to is not None:
                return 4
            else:
                self.armed = False
        elif command == bridge.MAV_CMD_NAV_TAKEOFF:
            if not self.armed or (self.kind == 'ARDUPILOT' and self.mode != 'GUIDED'):
                return 2
            if self.flying or self.climb_to is not None:
                return 4  # ArduCopter: "can't takeoff again"
            self.climb_to = self.home[2] + p[6] if self.kind == 'ARDUPILOT' else p[6]
            self.climb_at = self.clock.t + self.takeoff_delay
            if self.kind == 'PX4':
                self.mode = 'AUTO.TAKEOFF'
        elif command == bridge.MAV_CMD_REQUEST_MESSAGE:
            if int(p[0]) == bridge.HOME_POSITION_ID:
                self.inbox.append(self._message('home'))
        elif command != bridge.MAV_CMD_SET_MESSAGE_INTERVAL:
            return 3
        return 0

    # what the autopilot sends
    def _landed_state(self):
        if self.climb_to is not None and self._t >= self.climb_at:
            return bridge.MAV_LANDED_STATE_TAKEOFF
        return bridge.MAV_LANDED_STATE_IN_AIR if self.flying else bridge.MAV_LANDED_STATE_ON_GROUND

    def _message(self, name):
        if name == 'hb':
            custom = bridge.ARDUCOPTER_MODE_IDS[self.mode] if self.kind == 'ARDUPILOT' else \
                (self.PX4_IDS[self.mode][1] << 24) | (self.PX4_IDS[self.mode][0] << 16)
            return _Msg('HEARTBEAT', type=2, autopilot=3 if self.kind == 'ARDUPILOT' else 12,
                        base_mode=1 | (128 if self.armed else 0), custom_mode=custom, system_status=4)
        if name == 'gpi':
            return _Msg('GLOBAL_POSITION_INT', lat=round(self.lat * 1e7), lon=round(self.lon * 1e7),
                        alt=round(self.amsl * 1000), relative_alt=round((self.amsl - self.home[2]) * 1000),
                        vx=0, vy=0, vz=0, hdg=0)
        if name == 'ess':
            return _Msg('EXTENDED_SYS_STATE', vtol_state=0, landed_state=self._landed_state())
        if name == 'gps':
            return _Msg('GPS_RAW_INT', fix_type=3, satellites_visible=14)
        if name == 'sys':
            return _Msg('SYS_STATUS', battery_remaining=88)
        return _Msg('HOME_POSITION', latitude=round(self.home[0] * 1e7), longitude=round(self.home[1] * 1e7),
                    altitude=round(self.home[2] * 1000))

    def _advance(self):
        while self._t + 1e-9 < self.clock.t:
            dt = min(0.1, self.clock.t - self._t)
            self._t += dt
            if self.climb_to is not None and self._t >= self.climb_at:
                self.amsl = bridge._approach(self.amsl, self.climb_to, 2.0 * dt)
                if self.amsl == self.climb_to:
                    self.climb_to, self.flying = None, True
                    if self.kind == 'PX4':
                        self.mode = 'AUTO.LOITER'
            for name, period in (('hb', 1.0), ('gpi', 0.25), ('ess', 1.0), ('gps', 1.0), ('sys', 1.0),
                                 ('home', 5.0)):
                if self._t >= self._due.get(name, 0.0):
                    self._due[name] = self._t + period
                    self.inbox.append(self._message(name))

    def recv_match(self, type=None, blocking=False, timeout=None):
        deadline = self.clock.t + (timeout or 0.0)
        while True:
            self._advance()
            while self.inbox:
                msg = self.inbox.pop(0)
                if type is None or msg.get_type() == type:
                    return msg
            if not blocking or self.clock.t >= deadline:
                return None
            self.clock.t += 0.02


def mavlink_rig(kind='ARDUPILOT', **autopilot_options):
    """A Rig flying a live MavlinkVehicle connected to a FakeAutopilot (no pymavlink)."""
    clock = SimClock()
    autopilot = FakeAutopilot(clock, kind, **autopilot_options)
    vehicle = bridge.MavlinkVehicle('udpin:0.0.0.0:14550', live=True, home=HOME, clock=clock.mono)
    vehicle.m, vehicle.autopilot, vehicle.mav_type = autopilot, kind, 2
    vehicle.target_system = vehicle.target_component = 1
    vehicle._request_streams(clock.t)
    rig = Rig(clock=clock, vehicle=vehicle)
    for _ in range(6):  # heartbeat, position, GPS and home before the first command
        rig.step()
    return rig, autopilot


class ValidatorTests(unittest.TestCase):
    def test_expired_command(self):
        rig = Rig()
        seq = rig.send('TAKEOFF', 30.0, expires_in=-1)
        self.assertEqual(rig.acks(), [(seq, 'REJECTED', 'EXPIRED')])
        self.assertFalse(rig.vehicle.armed)

    def test_replay_duplicates_and_restart(self):
        rig = Rig()
        seq, line = rig.line('PING', seq=5)
        rig.commander.handle_line(line)
        self.assertEqual(rig.acks(), [(5, 'DONE', None)])
        rig.commander.handle_line(line)  # the server repeats until acked: re-send the ack, nothing else
        self.assertEqual(rig.acks(), [(5, 'DONE', None)])
        rig.send('PING', seq=3)
        self.assertEqual(rig.acks(), [(3, 'REJECTED', 'REPLAY')])
        rig.send('PING', seq=5, expires_in=60)  # same seq, different content: still only the old ack
        self.assertEqual(rig.acks(), [(5, 'DONE', None)])
        restarted = Rig(state_dir=rig.state_dir)
        self.assertEqual(restarted.store.last_cmd_seq, 5)
        restarted.commander.handle_line(line)
        restarted.send('PING', seq=4)
        self.assertEqual(restarted.acks(), [(5, 'DONE', None), (4, 'REJECTED', 'REPLAY')])

    def test_bad_signature_and_other_drone_are_ignored(self):
        rig = Rig()
        _, line = rig.line('TAKEOFF', 30.0)
        rig.commander.handle_line(line[:-1] + ('0' if line[-1] != '0' else '1'))
        rig.send('TAKEOFF', 30.0, key=OTHER_KEY)
        rig.send('TAKEOFF', 30.0, drone_id='other01')
        rig.commander.handle_line('garbage')
        self.assertEqual(rig.acks(), [])
        self.assertFalse(rig.vehicle.armed)
        self.assertEqual(rig.store.last_cmd_seq, 0)

    def test_fence(self):
        rig = Rig()
        rig.takeoff()
        north = bridge.offset_position(*HOME, 1500.0, 0.0)
        seq = rig.send('GOTO', north[0], north[1], 30.0)
        inside = bridge.offset_position(*HOME, 900.0, 0.0)
        ok = rig.send('GOTO', inside[0], inside[1], 30.0)
        self.assertEqual(rig.acks(), [(seq, 'REJECTED', 'FENCE'), (ok, 'ACCEPTED', None)])
        outside_home = bridge.offset_position(*HOME, 0.0, 1200.0)
        far = Rig(home=outside_home)
        seq = far.send('TAKEOFF', 30.0)
        self.assertEqual(far.acks(), [(seq, 'REJECTED', 'FENCE')])

    def test_altitude_limits(self):
        rig = Rig()
        high, low = rig.send('TAKEOFF', 61.0), rig.send('TAKEOFF', 1.0)
        self.assertEqual(rig.acks(), [(high, 'REJECTED', 'ALTITUDE'), (low, 'REJECTED', 'ALTITUDE')])
        rig.takeoff()
        seq = rig.send('GOTO', HOME[0], HOME[1], 70.0)
        self.assertEqual(rig.acks(), [(seq, 'REJECTED', 'ALTITUDE')])

    def test_bad_args_and_not_airborne(self):
        rig = Rig()
        rig.send('GOTO', 100.0, -122.0, 30.0)  # out of range: fails strict parsing and is ignored, never acked
        ground = rig.send('GOTO', HOME[0], HOME[1], 30.0)
        self.assertEqual(rig.acks(), [(ground, 'REJECTED', 'NOT_AIRBORNE')])

    def test_no_gps(self):
        rig = Rig()
        rig.vehicle.fix = 2
        seq = rig.send('TAKEOFF', 30.0)
        self.assertEqual(rig.acks(), [(seq, 'REJECTED', 'NO_GPS')])

    def test_low_battery_and_its_exceptions(self):
        rig = Rig(battery=20.0)
        takeoff, hold = rig.send('TAKEOFF', 30.0), rig.send('HOLD')
        land, rtl, abort = rig.send('LAND'), rig.send('RTL'), rig.send('ABORT')
        self.assertEqual(rig.acks(), [
            (takeoff, 'REJECTED', 'LOW_BATT'),
            (hold, 'ACCEPTED', None), (hold, 'DONE', None),       # HOLD is never refused for battery
            (land, 'ACCEPTED', None), (land, 'DONE', None),       # already landed
            (rtl, 'ACCEPTED', None), (rtl, 'DONE', None),         # on the ground at home
            (abort, 'ACCEPTED', None), (abort, 'DONE', None)])
        airborne = Rig()
        airborne.takeoff()
        airborne.vehicle.battery = 20.0
        goto = airborne.send('GOTO', HOME[0], HOME[1], 40.0)
        rtl = airborne.send('RTL')
        self.assertEqual(airborne.acks(), [(goto, 'REJECTED', 'LOW_BATT'), (rtl, 'ACCEPTED', None)])
        airborne.run_until(airborne.finished(rtl), 120)
        self.assertEqual(airborne.status(rtl), 'DONE')

    def test_dry_run_sends_nothing(self):
        rig = Rig(vehicle_cls=DryRunVehicle)
        with self.assertLogs('aero', level='WARNING') as logs:
            takeoff = rig.send('TAKEOFF', 30.0)
        ping, land, abort = rig.send('PING'), rig.send('LAND'), rig.send('ABORT')
        self.assertTrue(any('DRY RUN' in line for line in logs.output))
        self.assertEqual(rig.acks(), [(takeoff, 'REJECTED', 'DRY_RUN'), (ping, 'DONE', None),
                                      (land, 'REJECTED', 'DRY_RUN'), (abort, 'REJECTED', 'DRY_RUN')])
        self.assertEqual(rig.store.last_cmd_seq, ping)

    def test_supersede_preempt_and_abort_latch(self):
        rig = Rig()
        rig.takeoff()
        far = bridge.offset_position(*HOME, 800.0, 0.0)
        goto = rig.send('GOTO', far[0], far[1], 30.0)
        rig.run_until(lambda: rig.vehicle.speed > 5, 10)
        hold = rig.send('HOLD')
        rig.run_until(rig.finished(hold), 20)
        self.assertEqual(rig.acks(), [(goto, 'ACCEPTED', None), (goto, 'FAILED', 'SUPERSEDED'),
                                      (hold, 'ACCEPTED', None), (hold, 'DONE', None)])
        goto2 = rig.send('GOTO', far[0], far[1], 30.0)
        abort = rig.send('ABORT')
        latched = rig.send('GOTO', far[0], far[1], 30.0)
        self.assertEqual(rig.acks(), [(goto2, 'ACCEPTED', None), (goto2, 'FAILED', 'SUPERSEDED'),
                                      (abort, 'ACCEPTED', None), (latched, 'REJECTED', 'ABORT_ACTIVE')])
        rig.run_until(rig.finished(abort), 200)
        self.assertEqual(rig.status(abort), 'DONE')
        self.assertLess(bridge.distance_m(rig.vehicle.lat, rig.vehicle.lon, *HOME), 1.0)
        self.assertFalse(rig.vehicle.armed)

    def test_rtl_from_the_ground_climbs_first(self):
        rig = Rig()
        rig.takeoff()
        pad = bridge.offset_position(*HOME, 300.0, 200.0)
        goto = rig.send('GOTO', pad[0], pad[1], 30.0)
        rig.run_until(rig.finished(goto), 120)
        land = rig.send('LAND')
        rig.run_until(rig.finished(land), 60)
        rtl = rig.send('RTL')
        states = rig.run_until(rig.finished(rtl), 300)
        self.assertEqual(rig.status(rtl), 'DONE')
        self.assertIn('TAKEOFF', states)
        self.assertIn('RTL', states)
        self.assertLess(bridge.distance_m(rig.vehicle.lat, rig.vehicle.lon, *HOME), 1.0)

    def test_rtl_from_a_remote_pad_is_gated_like_a_takeoff(self):
        pad = bridge.offset_position(*HOME, 150.0, 0.0)

        def landed_at_pad(**options):
            rig = Rig(**options)
            rig.vehicle.lat, rig.vehicle.lon = pad  # landed and disarmed at a customer's pad
            return rig

        low = landed_at_pad(battery=5.0)
        rtl, abort = low.send('RTL'), low.send('ABORT')
        for _ in range(20):
            low.step()
        self.assertEqual(low.acks(), [(rtl, 'REJECTED', 'LOW_BATT'),
                                      (abort, 'ACCEPTED', None), (abort, 'DONE', None)])  # ABORT never lifts off
        self.assertEqual((low.vehicle.armed, low.vehicle.alt), (False, 0.0))
        outside, nofix = landed_at_pad(fence_radius=100.0), landed_at_pad()
        nofix.vehicle.fix = 2
        for rig, reason in ((outside, 'FENCE'), (nofix, 'NO_GPS')):
            with self.subTest(reason):
                seq = rig.send('RTL')
                self.assertEqual(rig.acks(), [(seq, 'REJECTED', reason)])
                self.assertFalse(rig.vehicle.armed)
        aborting = landed_at_pad()
        aborting.vehicle.armed = True  # armed on the pad: ABORT disarms it, and an RTL must not undo that
        abort, rtl = aborting.send('ABORT'), aborting.send('RTL')
        self.assertEqual(aborting.acks(), [(abort, 'ACCEPTED', None), (rtl, 'REJECTED', 'ABORT_ACTIVE')])

    def test_link_loss_holds_then_returns(self):
        rig = Rig()
        rig.takeoff()
        far = bridge.offset_position(*HOME, 900.0, 0.0)
        goto = rig.send('GOTO', far[0], far[1], 30.0)
        rig.step()
        rig.acks()
        rig.run_until(lambda: rig.vehicle.mode == 'BRAKE', 25, link_ok=False)
        self.assertGreaterEqual(rig.link.down_for(), 20.0)
        self.assertEqual(rig.status(goto), 'FAILED')
        self.assertEqual(rig.acks(), [(goto, 'FAILED', 'LINK_LOST')])
        rig.run_until(lambda: rig.vehicle.mode == 'RTL', 25, link_ok=False)
        self.assertGreaterEqual(rig.link.down_for(), 40.0)
        rig.run_until(lambda: not rig.vehicle.armed, 300, link_ok=False)
        self.assertLess(bridge.distance_m(rig.vehicle.lat, rig.vehicle.lon, *HOME), 1.0)

    def test_link_loss_leaves_a_pilot_mode_alone(self):
        rig = Rig()
        rig.takeoff()
        rig.vehicle.mode = 'LOITER'  # the RC pilot switched modes
        rig.run_until(lambda: rig.link.down_for() > 45, 50, link_ok=False)
        self.assertEqual(rig.vehicle.mode, 'LOITER')
        self.assertTrue(rig.vehicle.airborne)

    def test_link_loss_still_covers_a_hover_between_commands(self):
        rig = Rig()
        rig.takeoff()  # TAKEOFF is DONE: hovering in GUIDED, waiting for the next command
        rig.run_until(lambda: rig.vehicle.mode == 'BRAKE', 25, link_ok=False)
        rig.run_until(lambda: rig.vehicle.mode == 'RTL', 25, link_ok=False)

    def test_mode_changed_ends_the_bridge_flight(self):
        rig = Rig()
        rig.takeoff()
        far = bridge.offset_position(*HOME, 800.0, 0.0)
        goto = rig.send('GOTO', far[0], far[1], 30.0)
        rig.step()
        rig.vehicle.mode, rig.vehicle.phase = 'LOITER', 'hover'  # the RC pilot takes over
        rig.run_until(rig.finished(goto), 10)
        self.assertEqual(rig.acks(), [(goto, 'ACCEPTED', None), (goto, 'FAILED', 'MODE_CHANGED')])
        rig.vehicle.mode = 'GUIDED'  # later back in the bridge's old mode, e.g. from a ground station
        rig.run_until(lambda: rig.link.down_for() > 45, 50, link_ok=False)
        self.assertEqual(rig.vehicle.mode, 'GUIDED')

    def test_restart_fails_commands_that_were_running(self):
        rig = Rig()
        seq = rig.send('TAKEOFF', 30.0)
        rig.step()
        self.assertEqual(rig.acks(), [(seq, 'ACCEPTED', None)])
        restarted = Rig(state_dir=rig.state_dir)
        self.assertEqual(restarted.acks(), [(seq, 'FAILED', 'BRIDGE_RESTART')])
        self.assertEqual(restarted.status(seq), 'FAILED')

    def test_undelivered_acks_survive_a_restart(self):
        rig = Rig()
        rig.takeoff()
        land = rig.send('LAND')
        self.assertEqual(rig.acks(), [(land, 'ACCEPTED', None)])  # the server has it
        rig.run_until(rig.finished(land), 120)  # touches down; DONE is queued but never delivered
        restarted = Rig(state_dir=rig.state_dir)
        restarted.clock.advance(600)
        messages = restarted.ack_messages()
        self.assertEqual([(m.cmd_seq, m.status, m.reason) for m in messages], [(land, 'DONE', None)])
        self.assertEqual(messages[0].ts, int(restarted.clock.wall()))  # signed again when sent
        self.assertEqual(Rig(state_dir=rig.state_dir).acks(), [])  # delivered: not sent a third time


class EndToEndTests(unittest.TestCase):
    def test_fake_vehicle_takeoff_goto_land(self):
        started = time.monotonic()
        rig = Rig()
        self.assertEqual(rig.step(), 'IDLE')
        states = []
        takeoff = rig.send('TAKEOFF', 30.0)
        states += rig.run_until(rig.finished(takeoff), 60)
        target = bridge.offset_position(*HOME, 400.0, -150.0)
        goto = rig.send('GOTO', target[0], target[1], 35.0)
        states += rig.run_until(rig.finished(goto), 120)
        mid_line = rig.outbox.telemetry_line()
        land = rig.send('LAND')
        states += rig.run_until(rig.finished(land), 60)
        states.append(rig.step())
        self.assertEqual(rig.acks(), [(takeoff, 'ACCEPTED', None), (takeoff, 'DONE', None),
                                      (goto, 'ACCEPTED', None), (goto, 'DONE', None),
                                      (land, 'ACCEPTED', None), (land, 'DONE', None)])
        for state in ('TAKEOFF', 'ENROUTE', 'LANDING'):
            self.assertIn(state, states)
        self.assertEqual(states[-1], 'LANDED')
        self.assertLess(bridge.distance_m(rig.vehicle.lat, rig.vehicle.lon, *target), bridge.GOTO_TOLERANCE_M)
        self.assertFalse(rig.vehicle.armed)
        self.assertLess(rig.vehicle.battery, 95.0)
        telemetry = proto.parse_drone_body(proto.verify_line(KEY, mid_line))
        self.assertEqual((telemetry.kind, telemetry.alt, telemetry.mode), ('telemetry', 35.0, 'GUIDED'))
        self.assertLess(bridge.distance_m(telemetry.lat, telemetry.lon, *target), 3.0)
        final = proto.parse_drone_body(proto.verify_line(KEY, rig.outbox.telemetry_line()))
        self.assertEqual((final.state, final.alt, final.speed), ('LANDED', 0.0, 0.0))
        self.assertLess(time.monotonic() - started, 2.0)


class OutboxAndStateTests(unittest.TestCase):
    def test_outbox_orders_acks_before_telemetry_and_resigns_retries(self):
        wall = [1761312000.0]
        outbox = bridge.Outbox(DRONE, KEY, bridge.SeqCounter(lambda: wall[0]), wall=lambda: wall[0])
        self.assertEqual(outbox.build(), ([], []))
        outbox.add_ack(7, 'ACCEPTED')
        outbox.add_ack(7, 'ACCEPTED')  # duplicate collapses
        outbox.add_ack(7, 'DONE')
        snap = bridge.Snapshot(connected=True, have_position=True, lat=HOME[0], lon=HOME[1], heading=-10, fix=8,
                               sats=255, battery=101, rel_alt=2000, speed=150, mode='Position Hold')
        outbox.set_telemetry(bridge.telemetry_fields(snap, 'HOLD'))
        lines, ids = outbox.build()
        self.assertEqual([line[:3] for line in lines], ['AK1', 'AK1', 'AT1'])
        parsed = [proto.parse_drone_body(proto.verify_line(KEY, line)) for line in lines]
        seqs = [m.seq for m in parsed]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(set(seqs)), 3)
        t = parsed[2]
        self.assertEqual((t.heading, t.fix, t.sats, t.battery, t.alt, t.speed, t.mode),
                         (350, 6, 99, 100, 999.9, 100.0, 'PositionHold'))
        retry, _ = outbox.build()  # not confirmed: same acks again, freshly signed
        self.assertGreater(proto.parse_drone_body(proto.verify_line(KEY, retry[0])).seq, seqs[-1])
        outbox.confirm(ids)
        self.assertEqual(outbox.pending(), [])

    def test_seq_counter(self):
        wall = [1000.0]
        counter = bridge.SeqCounter(lambda: wall[0])
        self.assertEqual([counter.next(), counter.next()], [1000000, 1000001])
        wall[0] = 999.0  # clock stepped back
        self.assertEqual(counter.next(), 1000002)
        wall[0] = 2000.0
        self.assertEqual(counter.next(), 2000000)

    def test_state_store_rejects_corrupt_or_foreign_files(self):
        directory = tempfile.mkdtemp(prefix='aero-test-')
        path = os.path.join(directory, 'state.json')
        store = bridge.StateStore(path, DRONE)
        store.mark_executed(12)
        store.record_ack(12, 'DONE')
        self.assertEqual(bridge.StateStore(path, DRONE).ack_for(12), ('DONE', None))
        with self.assertRaises(bridge.BridgeError):
            bridge.StateStore(path, 'other01')
        Path(path).write_text('{not json')
        with self.assertRaises(bridge.BridgeError):
            bridge.StateStore(path, DRONE)
        older = {'version': 1, 'droneId': DRONE, 'lastCmdSeq': 3, 'acks': {'3': ['DONE', None]}}  # no outbox
        Path(path).write_text(json.dumps(older))
        self.assertEqual((bridge.StateStore(path, DRONE).last_cmd_seq, bridge.StateStore(path, DRONE).outbox),
                         (3, []))
        for outbox in ([[3, 'DONE', 'not a reason']], [[0, 'DONE', None]], [[3, 'DONE']], ['x']):
            with self.subTest(outbox=outbox):
                Path(path).write_text(json.dumps({**older, 'outbox': outbox}))
                with self.assertRaises(bridge.BridgeError):
                    bridge.StateStore(path, DRONE)


class FakeModem:
    """The Modem methods SmsTransport uses: an inbox, a sent list, network time and registration."""

    def __init__(self, inbox=(), network_time=None, registered=True):
        self.sent, self.deleted, self.inbox = [], [], list(inbox)
        self.time, self.reg = network_time, registered

    def send_sms(self, number, text):
        self.sent.append((number, text))

    def list_unread(self):
        inbox, self.inbox = self.inbox, []
        return inbox

    def delete(self, index):
        self.deleted.append(index)

    def network_time(self):
        return self.time() if callable(self.time) else self.time

    def registered(self):
        return self.reg


class FakeSerial:
    """Scripted AT command port for Modem: replies[command] = reply lines, otherwise 'OK'."""

    def __init__(self, replies):
        self.replies, self.written, self._pending = replies, [], []

    def reset_input_buffer(self):
        self._pending = []

    def write(self, data):
        command = data.decode('ascii').strip()
        self.written.append(command)
        self._pending = [line.encode('ascii') + b'\r\n' for line in self.replies.get(command, ['OK'])]

    def readline(self):
        return self._pending.pop(0) if self._pending else b''

    def close(self):
        pass


MODEM_OK = {'AT+CPIN?': ['+CPIN: READY', 'OK'], 'AT+CSCS?': ['+CSCS: "IRA"', 'OK'],
            'AT+CREG?': ['+CREG: 0,1', 'OK']}


def scripted_modem(replies):
    modem = bridge.Modem.__new__(bridge.Modem)  # no pyserial needed
    modem.ser = FakeSerial(replies)
    return modem


def utc(*fields):
    return datetime(*fields, tzinfo=timezone.utc).timestamp()


class SmsTests(unittest.TestCase):
    def test_cmgl_parsing_and_command_extraction(self):
        lines = ['+CMGL: 3,"REC UNREAD","+15551234567",,"26/10/24,10:00:00-28"',
                 'Sent from your Twilio trial account - AC1 tst001 7 1761312400 PING ~0123456789abcdef',
                 '+CMGL: 4,"REC UNREAD","+15559990000",,"26/10/24,10:00:01-28"', 'hello']
        messages = bridge.parse_cmgl(lines)
        self.assertEqual([(i, s) for i, s, _ in messages], [(3, '+15551234567'), (4, '+15559990000')])
        self.assertEqual(bridge.extract_command_lines(messages[0][2]),
                         ['AC1 tst001 7 1761312400 PING ~0123456789abcdef'])
        self.assertEqual(bridge.extract_command_lines('hello'), [])
        self.assertTrue(bridge.same_number('+15551234567', '15551234567'))
        self.assertTrue(bridge.same_number('+1 (555) 123-4567', '5551234567'))
        self.assertFalse(bridge.same_number('+15551234567', '+15551234568'))
        self.assertFalse(bridge.same_number('', '+15551234567'))

    def test_sms_cycle(self):
        rig = Rig()
        _, command = rig.line('PING')
        inbound, stop = queue.Queue(), threading.Event()
        link = bridge.LinkHealth('push')
        sms = bridge.SmsTransport('/dev/null', 115200, '+15551234567', rig.outbox, inbound, link, stop)
        modem = FakeModem([(1, '+15551234567', command), (2, '+15550000000', command)])
        rig.step()
        sms.cycle(modem)
        self.assertEqual(modem.deleted, [1, 2])
        self.assertEqual(inbound.qsize(), 1)  # the unknown sender is ignored
        self.assertEqual([text[:3] for _, text in modem.sent], ['AT1'])
        rig.commander.handle_line(inbound.get_nowait())
        sms.cycle(modem)  # the ack goes out immediately; telemetry waits for its 60 s ground period
        self.assertEqual([text[:3] for _, text in modem.sent], ['AT1', 'AK1'])
        self.assertTrue(all(number == '+15551234567' for number, _ in modem.sent))
        self.assertEqual(rig.outbox.pending(), [])
        self.assertEqual(link.down_for(), 0.0)

    def test_push_link_health_sees_only_the_modem_side(self):
        t = [100.0]
        link = bridge.LinkHealth('push', clock=lambda: t[0])
        t[0] = 500.0
        self.assertEqual(link.down_for(), 0.0)  # sends succeed: a server or Twilio outage is invisible
        link.fail('radio')
        t[0] = 530.0
        link.ok()  # a successful send does not put the modem back on the network
        self.assertEqual(link.down_for(), 30.0)
        link.fail()
        t[0] = 540.0
        link.ok('radio')
        self.assertEqual(link.down_for(), 10.0)  # the send failure still counts
        link.ok()
        self.assertEqual(link.down_for(), 0.0)

    def test_lost_network_registration_holds_the_drone(self):
        rig = Rig(link_kind='push', link_timeout=45.0)
        rig.takeoff()
        sms = bridge.SmsTransport('/dev/null', 115200, '+15551234567', rig.outbox, queue.Queue(), rig.link,
                                  threading.Event())
        modem = FakeModem(registered=False)
        with self.assertLogs('aero', level='WARNING') as logs:
            sms.cycle(modem)
        self.assertTrue(any('not registered' in line for line in logs.output))
        rig.run_until(lambda: rig.vehicle.mode == 'BRAKE', 50)  # sends keep "working"; the radio does not
        self.assertGreaterEqual(rig.link.down_for(), 45.0)
        modem.reg, sms._next_poll = True, 0.0
        sms.cycle(modem)
        self.assertEqual(rig.link.down_for(), 0.0)

    def test_modem_init_insists_on_ira(self):
        modem = scripted_modem(MODEM_OK)
        modem.init()
        self.assertIn('AT+CSCS="IRA"', modem.ser.written)
        self.assertIn('AT+CTZU=1', modem.ser.written)
        for replies in ({'AT+CSCS="IRA"': ['ERROR']}, {'AT+CSCS?': ['+CSCS: "GSM"', 'OK']}):
            with self.subTest(replies=replies):
                with self.assertRaises(bridge.ModemError):
                    scripted_modem({**MODEM_OK, **replies}).init()

    def test_modem_network_time_and_registration(self):
        modem = scripted_modem({'AT+CCLK?': ['+CCLK: "26/10/24,10:00:00-28"', 'OK'],
                                'AT+CREG?': ['+CREG: 0,0', 'OK'], 'AT+CEREG?': ['+CEREG: 0,5', 'OK']})
        self.assertEqual(modem.network_time(), utc(2026, 10, 24, 17, 0, 0))
        self.assertTrue(modem.registered())  # LTE (EPS) registration carries SMS too
        modem = scripted_modem({'AT+CCLK?': ['ERROR'], 'AT+CREG?': ['+CREG: 2,3,"1A2B","01C3D4E",7', 'OK'],
                                'AT+CEREG?': ['ERROR']})
        self.assertIsNone(modem.network_time())
        self.assertFalse(modem.registered())
        self.assertIsNone(scripted_modem({'AT+CREG?': ['ERROR'], 'AT+CEREG?': ['ERROR']}).registered())


class ClockTests(unittest.TestCase):
    def test_parse_cclk(self):
        self.assertEqual(bridge.parse_cclk('+CCLK: "26/10/24,10:00:00-28"'), utc(2026, 10, 24, 17, 0, 0))
        self.assertEqual(bridge.parse_cclk('+CCLK: "26/10/24,10:00:00+08"'), utc(2026, 10, 24, 8, 0, 0))
        self.assertEqual(bridge.parse_cclk('+CCLK: "26/10/24,10:00:00"'), utc(2026, 10, 24, 10, 0, 0))
        for bad in ('+CCLK: "80/01/06,00:00:30+00"', '+CCLK: "04/01/01,00:01:02+00"',
                    '+CCLK: "70/01/01,00:00:00+00"', '+CCLK: "26/13/24,10:00:00+00"', 'ERROR', ''):
            with self.subTest(bad):
                self.assertIsNone(bridge.parse_cclk(bad))  # modem default clocks are not network time

    def test_wall_clock_corrects_only_an_unsynced_clock(self):
        system, synced = [1761312000.0], [False]
        wall = bridge.WallClock(system=lambda: system[0], synced=lambda: synced[0])
        wall.calibrate(1761312000.0 + 3 * 3600, 'test')  # fake-hwclock restored a time 3 h old
        self.assertEqual(wall(), 1761312000.0 + 3 * 3600)
        wall.calibrate(1761312000.0 + 3 * 3600 + 1, 'test')  # 1 s of jitter changes nothing
        self.assertEqual(wall.offset, 3 * 3600)
        wall.calibrate(1761312003.0, 'test')  # the system clock is right again (within tolerance)
        self.assertEqual(wall.offset, 0.0)
        wall.calibrate(100.0, 'test')  # an implausible reference is ignored
        self.assertEqual(wall.offset, 0.0)
        wall.calibrate(1761312000.0 - 600, 'test')
        self.assertEqual(wall(), 1761312000.0 - 600)
        synced[0] = True  # NTP keeps the system clock: never overridden
        wall.calibrate(1761312000.0 + 3600, 'test')
        self.assertEqual(wall(), 1761312000.0)

    def test_sms_uses_the_modem_network_time(self):
        clock = SimClock()  # its wall() is the true time
        wall = bridge.WallClock(system=lambda: clock.wall() - 3 * 3600, synced=lambda: False)
        rig = Rig(clock=clock, wall=wall)
        stale = rig.send('PING', expires_in=-600)  # expired 10 minutes ago
        self.assertEqual(rig.acks(), [(stale, 'DONE', None)])  # a clock 3 h behind cannot tell
        sms = bridge.SmsTransport('/dev/null', 115200, '+15551234567', rig.outbox, queue.Queue(),
                                  bridge.LinkHealth('push'), threading.Event(), wall=wall)
        rig.step()
        sms.cycle(FakeModem(network_time=clock.wall))
        self.assertAlmostEqual(wall(), clock.wall(), places=3)
        stale, fresh = rig.send('PING', expires_in=-600), rig.send('PING')
        messages = rig.ack_messages()
        self.assertEqual([(m.cmd_seq, m.status, m.reason) for m in messages],
                         [(stale, 'REJECTED', 'EXPIRED'), (fresh, 'DONE', None)])
        self.assertTrue(all(m.ts == int(clock.wall()) for m in messages))

    def test_https_date_header_corrects_an_unsynced_clock(self):
        true = 1761312000.0
        wall = bridge.WallClock(system=lambda: true + 120, synced=lambda: False)
        rig = Rig()
        transport = bridge.HttpsTransport('http://127.0.0.1:9', rig.outbox, queue.Queue(), rig.link,
                                          threading.Event(), wall=wall)
        transport._check_clock(email.utils.formatdate(true, usegmt=True))
        self.assertEqual(wall(), true)


class _LinkHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length'])).decode('ascii')
        self.server.received.append((self.path, self.headers.get('Content-Type'), body))
        reply = self.server.reply.encode('ascii')
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass


class HttpsTransportTests(unittest.TestCase):
    def test_exchange_with_a_local_server(self):
        try:
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _LinkHandler)
        except OSError as exc:
            self.skipTest(f'cannot bind a local port here: {exc}')
        rig = Rig()
        _, command = rig.line('PING')
        server.received, server.reply = [], command + '\n\n'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
        try:
            rig.step()
            rig.outbox.add_ack(3, 'DONE')
            inbound, stop = queue.Queue(), threading.Event()
            link = bridge.LinkHealth('poll')
            transport = bridge.HttpsTransport(f'http://127.0.0.1:{server.server_address[1]}/', rig.outbox, inbound,
                                              link, stop)
            self.assertEqual(transport.exchange_once(), [command])
        finally:
            urllib.request.install_opener(None)
            server.shutdown()
            server.server_close()
        path, content_type, body = server.received[0]
        self.assertEqual((path, content_type), ('/api/drone/link', 'text/plain'))
        self.assertEqual([line[:3] for line in body.split('\n')], ['AK1', 'AT1'])
        self.assertTrue(all(proto.verify_line(KEY, line) for line in body.split('\n')))
        self.assertEqual(rig.outbox.pending(), [])
        self.assertEqual(inbound.get_nowait(), command)

    def test_unreachable_server_keeps_acks(self):
        rig = Rig()
        rig.step()
        rig.outbox.add_ack(3, 'DONE')
        link = bridge.LinkHealth('poll')
        transport = bridge.HttpsTransport('http://127.0.0.1:9', rig.outbox, queue.Queue(), link, threading.Event())
        transport.TIMEOUT_S = 1.0
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
        try:
            self.assertIsNone(transport.exchange_once())
        finally:
            urllib.request.install_opener(None)
        self.assertEqual(rig.outbox.pending(), [(3, 'DONE', None)])


class CliTests(unittest.TestCase):
    ENV = {'AERO_DRONE_ID': DRONE, 'AERO_DRONE_KEY': KEY}

    def configure(self, *argv, env=None):
        return bridge.configure(list(argv), self.ENV if env is None else env)

    def assertCliError(self, *argv, env=None):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            self.configure(*argv, env=env)
        self.assertEqual(caught.exception.code, 2)

    def test_valid_configurations(self):
        args, settings = self.configure('--vehicle', 'fake', '--transport', 'https', '--server',
                                        'http://127.0.0.1:9', '--fake-home', '37.8719,-122.2585')
        self.assertEqual((settings.fence_center, settings.fence_radius, settings.max_alt), ((37.8719, -122.2585),
                                                                                            2000.0, 60.0))
        self.assertTrue(args.state_file.endswith(f'.aero-bridge-{DRONE}.json'))
        args, settings = self.configure('--vehicle', 'mavlink', '--transport', 'sms', '--modem', '/dev/ttyUSB2',
                                        '--sms-to', '+15551234567', '--fence-center', '37.8719,-122.2585',
                                        '--fence-radius', '500')
        self.assertEqual((settings.link_timeout, args.live), (45.0, False))

    def test_invalid_configurations(self):
        fake = ['--vehicle', 'fake', '--transport', 'https', '--server', 'https://aero.example']
        self.assertCliError(*fake)  # no home
        self.assertCliError(*fake, '--fake-home', '37.8,-122.2', '--max-alt', '121')
        self.assertCliError(*fake, '--fake-home', '37.8,-122.2', '--fence-radius', '2500')
        self.assertCliError(*fake, '--fake-home', '37.8,-122.2', '--cruise-alt', '80')
        self.assertCliError(*fake, '--fake-home', '95,0')
        self.assertCliError('--vehicle', 'mavlink', '--transport', 'https', '--server', 'https://aero.example')
        self.assertCliError('--vehicle', 'fake', '--transport', 'https', '--fake-home', '37.8,-122.2')
        self.assertCliError('--vehicle', 'fake', '--transport', 'sms', '--fake-home', '37.8,-122.2')
        self.assertCliError('--vehicle', 'fake', '--transport', 'sms', '--fake-home', '37.8,-122.2', '--modem',
                            '/dev/ttyUSB2', '--sms-to', '+15551234567', '--modem-charset', 'GSM')  # IRA only
        self.assertCliError(*fake, '--fake-home', '37.8,-122.2', env={'AERO_DRONE_ID': DRONE})
        self.assertCliError(*fake, '--fake-home', '37.8,-122.2', env={'AERO_DRONE_ID': 'X', 'AERO_DRONE_KEY': KEY})

    def test_help(self):
        with contextlib.redirect_stdout(io.StringIO()) as out, self.assertRaises(SystemExit) as caught:
            self.configure('--help')
        self.assertEqual(caught.exception.code, 0)
        self.assertIn('--fence-radius', out.getvalue())


class MavlinkHelperTests(unittest.TestCase):
    """Pure helpers of the MAVLink backend; the backend itself needs pymavlink and SITL."""

    def test_px4_mode_names(self):
        self.assertEqual(bridge.px4_mode_name((3 << 24) | (4 << 16)), 'AUTO.LOITER')
        self.assertEqual(bridge.px4_mode_name((5 << 24) | (4 << 16)), 'AUTO.RTL')
        self.assertEqual(bridge.px4_mode_name(3 << 16), 'POSCTL')
        for name, (main, sub) in bridge.PX4_MODE_IDS.items():
            self.assertEqual(bridge.px4_mode_name((sub << 24) | (main << 16)), name)

    def test_connect_strings(self):
        self.assertEqual(bridge.parse_connect_string('serial:///dev/serial0', 57600), ('/dev/serial0', 57600))
        self.assertEqual(bridge.parse_connect_string('serial:///dev/serial0:921600', 57600),
                         ('/dev/serial0', 921600))
        self.assertEqual(bridge.parse_connect_string('udpin:0.0.0.0:14550', 57600), ('udpin:0.0.0.0:14550', 57600))

    def test_mavlink_backend_imports_lazily(self):
        vehicle = bridge.MavlinkVehicle('udpin:0.0.0.0:14550', home=HOME)
        self.assertFalse(vehicle.live)
        self.assertFalse(vehicle.snapshot().connected)
        with self.assertRaises(bridge.VehicleError) as caught:
            vehicle.takeoff(30.0)
        self.assertEqual(caught.exception.reason, 'DRY_RUN')

    def test_state_mapping(self):
        snap = bridge.Snapshot(connected=True, armed=True, landed_state=2, mode='AUTO.RTL')
        self.assertEqual(bridge.derive_state(snap, None, True), 'RTL')
        self.assertEqual(bridge.derive_state(bridge.Snapshot(connected=False), None, False), 'ERROR')
        self.assertEqual(bridge.derive_state(bridge.Snapshot(connected=True), None, False), 'IDLE')
        self.assertEqual(bridge.derive_state(bridge.Snapshot(connected=True, armed=True, landed_state=1), None,
                                             False), 'ARMED')
        hover = bridge.Snapshot(connected=True, armed=True, landed_state=2, mode='GUIDED', speed=0.2)
        self.assertEqual(bridge.derive_state(hover, None, True), 'HOLD')


class MavlinkBackendTests(unittest.TestCase):
    """MavlinkVehicle and the Commander against FakeAutopilot: commands, acks and modes."""
    NAV_TAKEOFF = bridge.MAV_CMD_NAV_TAKEOFF

    def test_ardupilot_hold_records_only_the_mode_it_set(self):
        for refused, mode in ((set(), 'BRAKE'), ({'BRAKE'}, 'LOITER')):
            with self.subTest(mode):
                rig, autopilot = mavlink_rig('ARDUPILOT')
                autopilot.refuse_modes = refused
                rig.vehicle.hold()
                self.assertEqual((autopilot.mode, rig.vehicle.bridge_modes), (mode, frozenset({mode})))

    def test_pilot_takeover_after_a_hold_is_left_alone(self):
        rig, autopilot = mavlink_rig('ARDUPILOT')
        rig.takeoff()
        hold = rig.send('HOLD')
        rig.run_until(rig.finished(hold), 20)
        self.assertEqual(autopilot.mode, 'BRAKE')
        autopilot.mode = 'LOITER'  # the RC pilot takes over in LOITER, ArduPilot's position hold
        rig.run_until(lambda: rig.link.down_for() > 45, 50, link_ok=False)
        self.assertEqual(autopilot.mode, 'LOITER')
        self.assertEqual(rig.vehicle.bridge_modes, frozenset())

    def test_pilot_takeover_during_the_link_loss_hold_gets_no_rtl(self):
        rig, autopilot = mavlink_rig('ARDUPILOT')
        rig.takeoff()
        rig.run_until(lambda: autopilot.mode == 'BRAKE', 25, link_ok=False)  # stage 1: HOLD
        autopilot.mode = 'LOITER'  # the RC pilot takes over during the outage
        rig.run_until(lambda: rig.link.down_for() > 45, 30, link_ok=False)
        self.assertEqual(autopilot.mode, 'LOITER')

    def test_lost_takeoff_ack_is_the_takeoff_in_progress(self):
        cases = [  # (case, autopilot options, NAV_TAKEOFF commands sent)
            ('ack lost after the takeoff started', dict(lose_ack={self.NAV_TAKEOFF}), 1),
            ('command lost, still on the ground: sent once more', dict(lose_command={self.NAV_TAKEOFF}), 2),
            ('ack lost and a slow start: the repeat is refused while it climbs',
             dict(lose_ack={self.NAV_TAKEOFF}, takeoff_delay=7.0), 2),
        ]
        for case, options, sends in cases:
            with self.subTest(case):
                rig, autopilot = mavlink_rig('ARDUPILOT')
                autopilot.__dict__.update(options)
                seq = rig.send('TAKEOFF', 30.0)
                rig.run_until(rig.finished(seq), 60)
                self.assertEqual(rig.acks(), [(seq, 'ACCEPTED', None), (seq, 'DONE', None)])
                self.assertEqual(autopilot.count(self.NAV_TAKEOFF), sends)
                self.assertEqual(rig.vehicle.bridge_modes, frozenset({'GUIDED'}))

    def test_refused_takeoff_fails_and_disarms(self):
        rig, autopilot = mavlink_rig('ARDUPILOT')
        autopilot.refuse[self.NAV_TAKEOFF] = 2  # DENIED
        seq = rig.send('TAKEOFF', 30.0)
        self.assertEqual(rig.acks(), [(seq, 'FAILED', 'TAKEOFF_DENIED')])
        self.assertEqual((autopilot.count(self.NAV_TAKEOFF), autopilot.armed), (1, False))
        rig.run_until(lambda: not rig.vehicle.snapshot().armed, 5)
        self.assertEqual(rig.vehicle.bridge_modes, frozenset())  # nothing left that the bridge flies

    def test_takeoff_away_from_home_needs_the_home_pad_as_home(self):
        pad = bridge.offset_position(*HOME, 300.0, 0.0)
        rig, autopilot = mavlink_rig('ARDUPILOT', position=pad)
        autopilot.refuse[bridge.MAV_CMD_DO_SET_HOME] = 4  # FAILED
        seq = rig.send('TAKEOFF', 30.0)
        self.assertEqual(rig.acks(), [(seq, 'FAILED', 'HOME_NOT_SET')])
        self.assertEqual((autopilot.count(self.NAV_TAKEOFF), autopilot.armed), (0, False))
        for kind in ('ARDUPILOT', 'PX4'):
            with self.subTest(kind):
                rig, autopilot = mavlink_rig(kind, position=pad)
                seq = rig.send('TAKEOFF', 30.0)
                rig.run_until(rig.finished(seq), 60)
                self.assertEqual(rig.status(seq), 'DONE')
                self.assertLess(bridge.distance_m(autopilot.home[0], autopilot.home[1], *HOME), 0.5)

    def test_px4_takeoff_target_uses_the_home_set_at_arming(self):
        rig, autopilot = mavlink_rig('PX4', home_error=3.0)  # pre-arm HOME_POSITION 3 m above the arming home
        seq = rig.send('TAKEOFF', 30.0)
        rig.run_until(rig.finished(seq), 60)
        self.assertEqual(rig.acks(), [(seq, 'ACCEPTED', None), (seq, 'DONE', None)])
        param7 = [params for command, params in autopilot.sent if command == self.NAV_TAKEOFF][-1][6]
        self.assertAlmostEqual(param7, autopilot.GROUND + 30.0, places=2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
