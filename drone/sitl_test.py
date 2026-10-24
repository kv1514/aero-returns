#!/usr/bin/env python3
"""End-to-end proof on ArduCopter SITL: the app's commands, flown by the stock
bridge, through MAVROS, exactly as on the drone.

    python3 drone/sitl_test.py            # bridge -> MAVROS (/sitl namespace) -> SITL
    python3 drone/sitl_test.py --direct   # bridge -> SITL directly (no ROS needed)

What it does: starts ArduCopter SITL at the test home, (by default) a second
MAVROS instance in the ``/sitl`` namespace that re-serves SITL on
tcp:127.0.0.1:5771 the way ``aircart-ros2`` re-serves the real FC on :5770,
the stub app link (drone/stub_server.py, the real signed protocol), and the
bridge via drone/run_bridge.py with AERO_LIVE=1. Then it sends what the app
would send for a return: TAKEOFF <alt>, GOTO <pad> <alt>, LAND — and checks
every ack and the reported position. It never touches the real FC or the
aircart-ros2 service. Takes about 3–4 minutes at real time.

Needs ~/dev/ardupilot built for SITL (build/sitl/bin/arducopter), and for the
MAVROS path the Jetson's ROS 2 workspace (deploy/ros2/env.sh of the AirCart
checkout). Exit 0 = PASS.
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stub_server  # noqa: E402
from run_bridge import port_listening  # noqa: E402

HOME = (37.871900, -122.258500)
SITL_PORT, MAVROS_PORT = 5760, 5771
ROS_ENV = Path.home() / "dev/aircart_ws/deploy/ros2/env.sh"


def offset(lat: float, lon: float, north_m: float, east_m: float) -> tuple[float, float]:
    return (lat + north_m / 111320.0, lon + east_m / (111320.0 * math.cos(math.radians(lat))))


def dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class Procs:
    def __init__(self) -> None:
        self.items: list[tuple[str, subprocess.Popen, int]] = []

    def spawn(self, name: str, cmd, log: Path, *, env=None, cwd=None, shell=False,
              stop_signal: int = signal.SIGINT) -> subprocess.Popen:
        fh = open(log, "wb")
        p = subprocess.Popen(cmd, cwd=cwd, env=env, shell=shell, stdout=fh, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        self.items.append((name, p, stop_signal))
        return p

    def check(self) -> None:
        for name, p, _s in self.items:
            if p.poll() is not None:
                raise RuntimeError(f"{name} exited early with code {p.returncode}")

    def stop(self) -> None:
        for name, p, sig in reversed(self.items):
            if p.poll() is None:
                try:
                    os.killpg(p.pid, sig)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 12.0
        for name, p, _s in reversed(self.items):
            while p.poll() is None and time.monotonic() < deadline:
                time.sleep(0.2)
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                p.wait()


def wait_for(pred: Callable[[], bool], timeout: float, what: str, procs: Optional[Procs] = None,
             interval: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if procs is not None:
            procs.check()
        if pred():
            return
        time.sleep(interval)
    raise TimeoutError(f"{what} (after {timeout:.0f} s)")


def tail(path: Path, n: int = 30) -> str:
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return "(no log)"
    return "\n".join("    " + ln for ln in lines[-n:])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--direct", action="store_true", help="bridge straight to SITL's tcp:5760 (no MAVROS, no ROS)")
    ap.add_argument("--ardupilot", default=os.path.expanduser("~/dev/ardupilot"),
                    help="ArduPilot checkout with build/sitl/bin/arducopter")
    ap.add_argument("--ros-env", default=str(ROS_ENV), help="ROS 2 env script to source for MAVROS")
    ap.add_argument("--home", default=f"{HOME[0]},{HOME[1]}", help="SITL home lat,lon (= fence centre)")
    ap.add_argument("--alt", type=float, default=10.0, help="cruise altitude for TAKEOFF/GOTO (m)")
    ap.add_argument("--north", type=float, default=60.0, help="GOTO target offset north of home (m)")
    ap.add_argument("--east", type=float, default=40.0, help="GOTO target offset east of home (m)")
    ap.add_argument("--speedup", type=float, default=1.0, help="SITL speedup (1 = real time)")
    ap.add_argument("--keep", action="store_true", help="keep the temp dir with the logs")
    args = ap.parse_args()

    home = tuple(float(x) for x in args.home.split(","))
    binary = Path(args.ardupilot) / "build/sitl/bin/arducopter"
    params = Path(args.ardupilot) / "Tools/autotest/default_params/copter.parm"
    if not binary.exists():
        print(f"error: no SITL binary at {binary} (build ArduPilot for SITL first)", file=sys.stderr)
        return 2
    for port in (SITL_PORT,) + (() if args.direct else (MAVROS_PORT,)):
        if port_listening(port):
            print(f"error: 127.0.0.1:{port} is busy — another SITL/MAVROS test instance is running", file=sys.stderr)
            return 2
    if not args.direct and not Path(args.ros_env).exists():
        print(f"error: {args.ros_env} not found; pass --ros-env or use --direct", file=sys.stderr)
        return 2

    tmp = Path(tempfile.mkdtemp(prefix="aero-sitl-"))
    procs = Procs()
    srv = None
    t_start = time.monotonic()
    timings: dict[str, float] = {}
    print(f"logs in {tmp}")
    try:
        # 1. SITL ------------------------------------------------------------
        extra = tmp / "extra.parm"
        # Dataflash logging to a slow SD wedges AP_Logger in SITL and blocks arming.
        extra.write_text("LOG_BACKEND_TYPE 0\n")
        cmd = [str(binary), "--model", "quad", "-I0", "--defaults", f"{params},{extra}",
               "--home", f"{home[0]},{home[1]},10,0"]
        if args.speedup != 1.0:
            cmd += ["--speedup", str(args.speedup)]
        print("starting ArduCopter SITL ...")
        procs.spawn("SITL", cmd, tmp / "sitl.log", cwd=tmp, stop_signal=signal.SIGTERM)
        wait_for(lambda: port_listening(SITL_PORT), 30, "SITL listening on 5760", procs)

        # 2. MAVROS in /sitl (the drone's topology) --------------------------
        if args.direct:
            connect = f"tcp:127.0.0.1:{SITL_PORT}"
        else:
            print("starting MAVROS in the /sitl namespace (GCS bridge on 5771) ...")
            script = (f"source '{args.ros_env}' && "
                      "SHARE=$(ros2 pkg prefix aircart_jetson_bringup)/share/aircart_jetson_bringup && "
                      "exec ros2 run mavros mavros_node --ros-args -r __ns:=/sitl "
                      '--params-file "$SHARE/config/mavros.yaml" '
                      f"-p fcu_url:=tcp://127.0.0.1:{SITL_PORT} -p gcs_url:=tcp-l://127.0.0.1:{MAVROS_PORT} "
                      "-p tgt_system:=1 -p tgt_component:=1 -p fcu_protocol:=v2.0")
            procs.spawn("MAVROS", ["bash", "-c", script], tmp / "mavros.log")
            wait_for(lambda: port_listening(MAVROS_PORT), 40, "MAVROS bridge listening on 5771", procs)
            connect = f"tcp:127.0.0.1:{MAVROS_PORT}"

        # 3. the app stand-in ------------------------------------------------
        link = stub_server.Link(stub_server.TEST_DRONE_ID, stub_server.TEST_DRONE_KEY)
        srv = stub_server.serve("127.0.0.1", 0, link)
        print(f"stub app link at {srv.url}")

        # 4. the bridge, exactly as the service runs it ----------------------
        env = dict(os.environ,
                   AERO_DRONE_ID=stub_server.TEST_DRONE_ID, AERO_DRONE_KEY=stub_server.TEST_DRONE_KEY,
                   AERO_SERVER=srv.url, AERO_CONNECT=connect, AERO_LIVE="1",
                   AERO_FENCE_CENTER=f"{home[0]},{home[1]}", AERO_FENCE_RADIUS="500",
                   AERO_CRUISE_ALT=str(args.alt), AERO_MAX_ALT="60", AERO_BATTERY_FLOOR="30",
                   AERO_LINK_TIMEOUT="20", AERO_STATE_FILE=str(tmp / "state.json"), AERO_BIND="",
                   PYTHONUNBUFFERED="1")
        print(f"starting the bridge (LIVE, FC via {connect}) ...")
        bridge_log = tmp / "bridge.log"
        procs.spawn("bridge", [sys.executable, str(HERE / "run_bridge.py")], bridge_log, env=env, cwd=HERE.parent)

        def telemetry():
            return link.state()["telemetry"]

        print("waiting for a 3D fix with 6+ satellites and an idle vehicle (SITL GPS takes ~30 s) ...")
        wait_for(lambda: (t := telemetry()) is not None and t["fix"] >= 3 and t["sats"] >= 6
                 and t["state"] == "IDLE", 120, "fresh telemetry with a 3D fix", procs)
        timings["telemetry"] = time.monotonic() - t_start
        t = telemetry()
        print(f"  telemetry: fix {t['fix']}, {t['sats']} sats, {t['battery']} %, state {t['state']}, mode {t['mode']}")

        # 5. TAKEOFF (the app's first command of every return) ---------------
        print(f"TAKEOFF {args.alt:g} m ...")
        ack = None
        for attempt in range(1, 5):
            seq = stub_server.send(srv.url, "TAKEOFF", [args.alt])
            t0 = time.monotonic()
            ack = stub_server.wait(srv.url, seq, timeout=90)
            if ack and ack["status"] == "DONE":
                break
            # The EKF needs a while after the first fix before ArduCopter arms;
            # the app's operator would simply retry the step.
            print(f"  attempt {attempt}: cmd {seq} -> {ack} ; retrying in 15 s")
            time.sleep(15)
        if not ack or ack["status"] != "DONE":
            raise AssertionError(f"TAKEOFF not DONE: {ack}")
        timings["takeoff"] = time.monotonic() - t0
        t = telemetry()
        print(f"  DONE in {timings['takeoff']:.0f} s; alt {t['alt']:.1f} m, state {t['state']}, mode {t['mode']}")
        assert abs(t["alt"] - args.alt) <= 1.5, f"altitude {t['alt']} m is not within 1.5 m of {args.alt} m"

        # 6. GOTO the pad ----------------------------------------------------
        target = offset(home[0], home[1], args.north, args.east)
        leg = dist_m(home[0], home[1], *target)
        print(f"GOTO {target[0]:.6f},{target[1]:.6f} at {args.alt:g} m ({leg:.0f} m leg) ...")
        seq = stub_server.send(srv.url, "GOTO", [target[0], target[1], args.alt])
        t0 = time.monotonic()
        wait_for(lambda: (a := stub_server.wait(srv.url, seq, timeout=1)) is not None
                 and a["status"] in ("ACCEPTED", "DONE", "REJECTED", "FAILED") or link.status(seq) is not None,
                 15, "GOTO acknowledged", procs)
        assert link.status(seq) in ("ACCEPTED", "DONE"), f"GOTO not accepted: {link.state()['acks'].get(str(seq))}"
        ack = stub_server.wait(srv.url, seq, timeout=150)
        assert ack and ack["status"] == "DONE", f"GOTO not DONE: {ack}"
        timings["goto"] = time.monotonic() - t0
        t = telemetry()
        err = dist_m(t["lat"], t["lon"], *target)
        print(f"  DONE in {timings['goto']:.0f} s; {err:.1f} m from the target, alt {t['alt']:.1f} m, state {t['state']}")
        assert err <= 3.5, f"{err:.1f} m from the target (> 3 m tolerance)"
        assert abs(t["alt"] - args.alt) <= 1.5, f"altitude {t['alt']} m off by more than 1.5 m"

        # 7. LAND at the pad -------------------------------------------------
        print("LAND ...")
        seq = stub_server.send(srv.url, "LAND", [])
        t0 = time.monotonic()
        ack = stub_server.wait(srv.url, seq, timeout=150)
        assert ack and ack["status"] == "DONE", f"LAND not DONE: {ack}"
        timings["land"] = time.monotonic() - t0
        wait_for(lambda: telemetry()["state"] == "LANDED", 15, "LANDED telemetry", procs)
        t = telemetry()
        print(f"  DONE in {timings['land']:.0f} s; state {t['state']}, alt {t['alt']:.1f} m, "
              f"{dist_m(t['lat'], t['lon'], *target):.1f} m from the pad")

        print(f"\nPASS  (bridge via {'SITL directly' if args.direct else 'MAVROS router'}; "
              + ", ".join(f"{k} {v:.0f} s" for k, v in timings.items()) + f"; total {time.monotonic() - t_start:.0f} s)")
        print("bridge log tail:\n" + tail(bridge_log, 12))
        return 0
    except (AssertionError, TimeoutError, RuntimeError) as e:
        print(f"\nFAIL: {e}")
        print("bridge log tail:\n" + tail(tmp / "bridge.log", 40))
        if not args.direct:
            print("mavros log tail:\n" + tail(tmp / "mavros.log", 10))
        return 1
    finally:
        procs.stop()
        if srv is not None:
            srv.shutdown()
            srv.server_close()
        if args.keep:
            print(f"logs kept in {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
