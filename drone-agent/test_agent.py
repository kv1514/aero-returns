"""Tests for aero_agent.py. Standard library only: python3 drone-agent/test_agent.py"""
import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aero_agent as a  # noqa: E402

HOME = (-122.2585, 37.8719)
DRONE_ID = "6f1c2a54-9a0e-4c1e-9a55-0d6a4a4e8b10"


def north(m):
    return a.move(HOME, 0, m)


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def setup(allow=True):
    clock, sim = Clock(), a.SimVehicle(HOME)
    pilot = a.Pilot(sim, allow_flight=allow, clock=clock, config=a.Config(HOME, 500, 40, 30))
    return clock, sim, pilot


def fly(clock, sim, pilot, seconds, link=True, until=None):
    for _ in range(int(seconds / 0.2)):
        clock.t += 0.2
        sim.step(0.2)
        if link:
            pilot.link_ok()
        pilot.tick()
        if until and until():
            return True
    return False


def statuses(pilot, cid):
    return [x["status"] for x in pilot.acks if x["commandId"] == cid]


class Geometry(unittest.TestCase):
    def test_distance_and_move_agree(self):
        self.assertAlmostEqual(a.distance((0, 0), (1, 0)), 111194.93, places=1)
        self.assertAlmostEqual(a.distance(HOME, north(250)), 250, delta=0.5)
        self.assertAlmostEqual(a.bearing(HOME, a.move(HOME, 90, 100)), 90, delta=0.5)


class Credentials(unittest.TestCase):
    def test_token(self):
        self.assertEqual(a.parse_token(f"aero_{DRONE_ID}.{'a' * 64}"), (DRONE_ID, "a" * 64))
        with self.assertRaises(ValueError):
            a.parse_token("aero_nope.123")

    def test_sms_code_matches_website_vector(self):
        # Same vector as tests/drone-protocol.test.ts
        key = hashlib.sha256(("c" * 64).encode()).hexdigest()
        self.assertEqual(a.sms_code(key, DRONE_ID, "LAND", 6_000_000), "60398080")

    def test_sms_verifier(self):
        clock = Clock(6_000_000 * a.SMS_WINDOW_S + 10)
        v = a.SmsVerifier(DRONE_ID, "c" * 64, clock)
        code = a.sms_code(v.key, DRONE_ID, "LAND", 6_000_000)
        cmd, err = v.parse(f"aero land {code}")
        self.assertEqual((cmd.command, err), ("LAND", None))
        self.assertIsNone(v.parse(f"AERO LAND {code}")[0], "codes are single use")
        self.assertIsNone(v.parse("AERO LAND 12345678")[0])
        self.assertIsNone(v.parse("hello")[0])
        old = a.sms_code(v.key, DRONE_ID, "RTL", 5_999_999)
        self.assertEqual(v.parse(f"AERO RTL {old}")[0].command, "RTL", "previous window still valid")
        stale = a.sms_code(v.key, DRONE_ID, "HOLD", 5_999_990)
        self.assertIsNone(v.parse(f"AERO HOLD {stale}")[0])
        body = "GOTO 37.872000 -122.258500 30"
        goto, _ = v.parse(f"AERO {body} {a.sms_code(v.key, DRONE_ID, body, 6_000_000)}")
        self.assertEqual((goto.command, goto.point, goto.alt_m), ("GOTO", (-122.2585, 37.872), 30.0))

    def test_parse_cmgl(self):
        raw = '+CMGL: 3,"REC UNREAD","+14155550123",,"26/10/24,10:00:00-28"\r\nAERO LAND 12345678\r\n\r\nOK\r\n'
        self.assertEqual(a.parse_cmgl(raw), [(3, "+14155550123", "AERO LAND 12345678")])


class Flights(unittest.TestCase):
    def test_flies_a_to_b_and_lands(self):
        clock, sim, pilot = setup()
        b = north(250)
        pilot.handle({"id": "f1", "type": "FLY_ROUTE", "params": {"waypoints": [north(100), b], "altM": 30, "speedMs": 6, "land": True}})
        self.assertEqual(pilot.state, "taking_off")
        self.assertTrue(fly(clock, sim, pilot, 200, until=lambda: pilot.state == "landed"))
        self.assertLess(a.distance(sim.state().point, b), a.WAYPOINT_RADIUS_M + 0.5)
        self.assertFalse(sim.state().armed)
        self.assertEqual(statuses(pilot, "f1"), ["accepted", "done"])
        self.assertFalse(pilot.in_control)

    def test_hover_at_destination(self):
        clock, sim, pilot = setup()
        pilot.handle({"id": "f1", "type": "FLY_ROUTE", "params": {"waypoints": [north(60)], "altM": 20, "land": False}})
        self.assertTrue(fly(clock, sim, pilot, 120, until=lambda: pilot.state == "holding"))
        self.assertGreater(sim.state().alt_m, 15)
        self.assertEqual(statuses(pilot, "f1"), ["accepted", "done"])

    def test_refusals(self):
        clock, sim, pilot = setup(allow=False)
        pilot.handle({"id": "x", "type": "FLY_ROUTE", "params": {"waypoints": [north(50)], "altM": 20}})
        self.assertEqual(statuses(pilot, "x"), ["failed"])
        self.assertIn("Observe-only", pilot.acks[-1]["message"])
        clock, sim, pilot = setup()
        pilot.handle({"id": "far", "type": "FLY_ROUTE", "params": {"waypoints": [north(800)], "altM": 20}})
        pilot.handle({"id": "high", "type": "FLY_ROUTE", "params": {"waypoints": [north(50)], "altM": 90}})
        sim.s.battery = 25
        pilot.handle({"id": "low", "type": "FLY_ROUTE", "params": {"waypoints": [north(50)], "altM": 20}})
        self.assertEqual([x["status"] for x in pilot.acks], ["failed"] * 3)
        self.assertTrue(sim.state().on_ground)
        pilot.handle({"id": "far", "type": "PING"})
        self.assertEqual(len(pilot.acks), 3, "duplicate command ids are ignored")

    def test_land_interrupts_flight(self):
        clock, sim, pilot = setup()
        pilot.handle({"id": "f1", "type": "FLY_ROUTE", "params": {"waypoints": [north(300)], "altM": 30}})
        fly(clock, sim, pilot, 25)
        self.assertEqual(pilot.state, "en_route")
        pilot.handle({"id": "l1", "type": "LAND"})
        self.assertTrue(fly(clock, sim, pilot, 60, until=lambda: pilot.state == "landed"))
        self.assertEqual(statuses(pilot, "f1"), ["accepted", "failed"])
        self.assertEqual(statuses(pilot, "l1"), ["accepted", "done"])
        self.assertGreater(a.distance(sim.state().point, north(300)), 50, "landed where it was, not at B")

    def test_link_loss_holds_then_returns_home(self):
        clock, sim, pilot = setup()
        pilot.handle({"id": "f1", "type": "FLY_ROUTE", "params": {"waypoints": [north(400)], "altM": 30}})
        fly(clock, sim, pilot, 30)
        fly(clock, sim, pilot, a.LINK_HOLD_S + 1, link=False)
        self.assertEqual(pilot.state, "holding")
        self.assertEqual(statuses(pilot, "f1"), ["accepted", "failed"])
        fly(clock, sim, pilot, a.LINK_RTL_S - a.LINK_HOLD_S + 1, link=False)
        self.assertEqual(pilot.state, "returning")
        self.assertTrue(fly(clock, sim, pilot, 200, link=False, until=lambda: pilot.state == "landed"))
        self.assertLess(a.distance(sim.state().point, HOME), 2)

    def test_low_battery_returns_home(self):
        clock, sim, pilot = setup()
        pilot.handle({"id": "f1", "type": "FLY_ROUTE", "params": {"waypoints": [north(400)], "altM": 30}})
        fly(clock, sim, pilot, 25)
        sim.s.battery = 15
        fly(clock, sim, pilot, 1)
        self.assertEqual(pilot.state, "returning")
        self.assertEqual(sim.s.mode, "RTL")

    def test_pilot_manual_takeover_wins(self):
        clock, sim, pilot = setup()
        pilot.handle({"id": "f1", "type": "FLY_ROUTE", "params": {"waypoints": [north(400)], "altM": 30}})
        fly(clock, sim, pilot, 25)
        sim.s.mode = "STABILIZE"  # RC transmitter mode switch
        fly(clock, sim, pilot, 0.4)
        self.assertFalse(pilot.in_control)
        self.assertEqual(statuses(pilot, "f1"), ["accepted", "failed"])
        self.assertIn("manual", pilot.message)
        sim.s.battery = 10
        fly(clock, sim, pilot, 1, link=False)
        self.assertEqual(sim.s.mode, "STABILIZE", "agent failsafes never override a manual pilot")

    def test_delivery_pickup_then_dropoff_releases_package(self):
        clock, sim, pilot = setup()
        pilot.handle({"id": "pick", "type": "FLY_ROUTE", "params": {"waypoints": [north(80)], "altM": 20, "land": True}})
        self.assertTrue(fly(clock, sim, pilot, 120, until=lambda: statuses(pilot, "pick") == ["accepted", "done"]))
        self.assertEqual(pilot.state, "landed")
        self.assertFalse(sim.released, "a pickup leg never drops anything")
        pilot.handle({"id": "drop", "type": "FLY_ROUTE", "params": {"waypoints": [north(220)], "altM": 20, "land": True, "release": True}})
        self.assertEqual(pilot.telemetry("4g", True)["payload"], "loaded")
        self.assertTrue(fly(clock, sim, pilot, 120, until=lambda: statuses(pilot, "drop") == ["accepted", "done"]))
        self.assertTrue(sim.released)
        self.assertEqual(pilot.telemetry("4g", True)["payload"], "empty")
        self.assertIn("released", pilot.acks[-1]["message"])
        self.assertLess(a.distance(sim.state().point, north(220)), a.WAYPOINT_RADIUS_M + 0.5)

    def test_release_failure_is_reported(self):
        clock, sim, pilot = setup()

        def jammed():
            raise RuntimeError("servo jammed")
        sim.release = jammed
        pilot.handle({"id": "drop", "type": "FLY_ROUTE", "params": {"waypoints": [north(60)], "altM": 15, "land": True, "release": True}})
        self.assertTrue(fly(clock, sim, pilot, 120, until=lambda: statuses(pilot, "drop") == ["accepted", "failed"]))
        self.assertIn("servo jammed", pilot.acks[-1]["message"])
        self.assertEqual(pilot.payload, "loaded")

    def test_sms_goto_and_telemetry_shape(self):
        clock, sim, pilot = setup()
        pilot.handle_sms(a.SmsCommand("GOTO", north(80), 25))
        self.assertTrue(fly(clock, sim, pilot, 120, until=lambda: pilot.state == "holding"))
        t = pilot.telemetry("4g", True)
        self.assertEqual(set(t) >= {"lat", "lng", "altM", "batteryPct", "gpsFix", "state", "flightAllowed", "link"}, True)
        self.assertIn(t["state"], {"idle", "arming", "taking_off", "en_route", "holding", "landing", "returning", "landed", "error"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
