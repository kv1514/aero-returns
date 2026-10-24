"""AERO drone link v1: stdlib-only Python mirror of lib/drone-protocol.ts.

Byte-for-byte compatible with the TypeScript reference: same token order, the same
number formatting (JavaScript ``Number.prototype.toFixed`` and ``Math.round``), the
same strict parsers and HMAC-SHA256 signatures truncated to 16 hex characters.
See docs/DRONE_LINK.md. tests/fixtures/drone-link-vectors.json must keep passing.
"""
from __future__ import annotations

import hashlib
import hmac as _hmac
import math
import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Optional, Sequence, Tuple, Union

COMMAND_TYPES = ('PING', 'TAKEOFF', 'GOTO', 'HOLD', 'LAND', 'RTL', 'ABORT')
DRONE_STATES = ('IDLE', 'ARMED', 'TAKEOFF', 'ENROUTE', 'HOLD', 'LANDING', 'LANDED', 'RTL', 'ERROR')
ACK_STATUSES = ('ACCEPTED', 'DONE', 'REJECTED', 'FAILED')
ARG_COUNT = {'PING': 0, 'TAKEOFF': 1, 'GOTO': 3, 'HOLD': 0, 'LAND': 0, 'RTL': 0, 'ABORT': 0}
# [min, max] per argument; altitudes are meters above home within the 120 m cap.
ARG_RANGES = {'TAKEOFF': ((0, 120),), 'GOTO': ((-90, 90), (-180, 180), (0, 120))}
MAX_SAFE_INTEGER = 2 ** 53 - 1
MAX_UNIX = 4102444800  # 2100-01-01, the TS parser's upper bound for timestamps

# The TS regexes use ASCII \d and an end anchor that never matches before a trailing
# newline. re.fullmatch with explicit [0-9] classes reproduces that exactly.
DRONE_ID = re.compile(r'[a-z0-9]{6,16}')
REASON = re.compile(r'[A-Z0-9_]{1,24}')
MODE = re.compile(r'[A-Za-z0-9_.]{1,20}')
_DECIMAL = re.compile(r'-?[0-9]{1,3}(?:\.[0-9]{1,7})?')
_INTEGER = re.compile(r'[0-9]{1,16}')
_BATTERY = re.compile(r'-?[0-9]{1,3}')
_HEADING = re.compile(r'[0-9]{1,3}')
_FIX = re.compile(r'[0-9]')
_SATS = re.compile(r'[0-9]{1,2}')
_HEX = re.compile(r'(?:[0-9a-f]{2})+')
_SIG = re.compile(r'[0-9a-f]{16}')
_TAG = re.compile(r'A[TKC]1')

# String.prototype.trim() removes ECMAScript WhiteSpace and LineTerminator characters.
# Python's str.strip() uses a different set (it strips \x1c-\x1f and \x85, keeps ﻿).
_JS_WHITESPACE = ('\t\n\x0b\x0c\r \xa0        '
                  '        　﻿')
_JS_LINE_TERMINATORS = frozenset('\n\r  ')  # what JS '.' does not match

Number = Union[int, float]


@dataclass(frozen=True)
class Command:
    drone_id: str
    seq: int
    expires: int
    type: str
    args: Tuple[float, ...] = ()


@dataclass(frozen=True)
class Telemetry:
    drone_id: str
    seq: int
    ts: Number
    lat: float
    lon: float
    alt: float
    battery: Number
    heading: Number
    speed: float
    fix: int
    sats: int
    state: str
    mode: str
    kind = 'telemetry'


@dataclass(frozen=True)
class Ack:
    drone_id: str
    seq: int
    ts: Number
    cmd_seq: int
    status: str
    reason: Optional[str] = None
    kind = 'ack'


# --- JavaScript number semantics -------------------------------------------------

def js_to_fixed(x: Number, digits: int) -> str:
    """Number.prototype.toFixed(digits) for |x| < 1e21.

    toFixed rounds the exact binary value of the double half away from zero; Decimal(x)
    is that exact value, so ROUND_HALF_UP on it matches. (Rounding repr(x) would not:
    37.8712345 is stored as 37.87123449999..., which JS formats as 37.871234.)
    """
    x = float(x)
    if math.isnan(x):
        return 'NaN'
    if math.isinf(x):
        return 'Infinity' if x > 0 else '-Infinity'
    if x == 0:
        x = 0.0  # (-0).toFixed() has no minus sign
    if abs(x) >= 1e21:
        return js_number_to_string(x)
    with localcontext() as ctx:
        ctx.prec = 60
        value = Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    return format(value, 'f')


def js_round(x: Number) -> int:
    """Math.round: nearest integer, ties toward +infinity (Math.round(-2.5) == -2)."""
    x = float(x)
    if not math.isfinite(x):
        raise ValueError('Math.round of a non-finite value has no integer form')
    floor = math.floor(x)
    return int(floor) + 1 if x - floor >= 0.5 else int(floor)


def js_remainder(a: int, b: int) -> int:
    """JavaScript % on integers: the result takes the sign of the dividend."""
    r = abs(a) % abs(b)
    return -r if a < 0 else r


def js_number_to_string(n: Number) -> str:
    """String(n) for the integers and plain floats the protocol uses."""
    if isinstance(n, bool):
        raise TypeError('booleans are not protocol numbers')
    if isinstance(n, int):
        return str(n)
    n = float(n)
    if math.isnan(n):
        return 'NaN'
    if math.isinf(n):
        return 'Infinity' if n > 0 else '-Infinity'
    if n == 0:
        return '0'
    if n.is_integer() and abs(n) < 1e21:
        return str(int(n))
    text = repr(n)
    if 'e' in text:  # JS writes 1e-7 / 1e+21 where Python writes 1e-07 / 1e+21
        mantissa, exponent = text.split('e')
        sign = '-' if exponent.startswith('-') else '+'
        text = f'{mantissa}e{sign}{int(exponent.lstrip("+-"))}'
    return text


def _floor_int(n: Number) -> int:
    return int(math.floor(n))


def _coord(n: Number) -> str:
    return js_to_fixed(n, 6)


def _meters(n: Number) -> str:
    return js_to_fixed(n, 1)


def _utf16_len(text: str) -> int:
    return len(text.encode('utf-16-le', 'surrogatepass')) // 2


def _utf8(text: str) -> bytes:
    """TextEncoder.encode: lone surrogates become U+FFFD instead of raising."""
    try:
        return text.encode('utf-8')
    except UnicodeEncodeError:
        repaired = text.encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace')
        return repaired.encode('utf-8')


# --- Keys and signatures ---------------------------------------------------------

def _unhex(value: str) -> bytes:
    if not isinstance(value, str) or not _HEX.fullmatch(value):
        raise ValueError('Drone key must be lowercase hex.')
    return bytes.fromhex(value)


def _hmac_hex(key: bytes, text: str) -> str:
    return _hmac.new(key, _utf8(text), hashlib.sha256).hexdigest()


def derive_drone_key(master_secret: str, drone_id: str, version: int) -> str:
    """Per-drone 32-byte key (lowercase hex) derived from the Worker's DRONE_LINK_SECRET."""
    if _utf16_len(master_secret) < 32:
        raise ValueError('DRONE_LINK_SECRET must be at least 32 characters.')
    return _hmac_hex(_utf8(master_secret), f'aero-drone-key:{drone_id}:{js_number_to_string(version)}')


def sign_line(key_hex: str, body: str) -> str:
    return f'{body} ~{_hmac_hex(_unhex(key_hex), body)[:16]}'


def verify_line(key_hex: str, line: str) -> Optional[str]:
    """Return the unsigned body when the 64-bit truncated HMAC matches, otherwise None.

    Mirrors /^(.{1,200}) ~([0-9a-f]{16})$/ applied to line.trim(); the signature is
    compared in constant time.
    """
    key = _unhex(key_hex)
    if not isinstance(line, str):
        return None
    text = line.strip(_JS_WHITESPACE)
    if len(text) < 19 or text[-18:-16] != ' ~':
        return None
    body, sig = text[:-18], text[-16:]
    if not _SIG.fullmatch(sig) or not 1 <= _utf16_len(body) <= 200:
        return None
    if any(ch in _JS_LINE_TERMINATORS for ch in body):
        return None
    expected = _hmac_hex(key, body)[:16]
    return body if _hmac.compare_digest(expected, sig) else None


def line_drone_id(line: str) -> Optional[str]:
    tokens = line.strip(_JS_WHITESPACE).split(' ')
    tag = tokens[0]
    drone_id = tokens[1] if len(tokens) > 1 else ''
    return drone_id if _TAG.fullmatch(tag) and DRONE_ID.fullmatch(drone_id) else None


# --- Formatting ------------------------------------------------------------------

def format_command(c: Command) -> str:
    seq_ok = isinstance(c.seq, (int, float)) and not isinstance(c.seq, bool) and float(c.seq).is_integer() \
        and 1 <= c.seq <= MAX_SAFE_INTEGER
    if not isinstance(c.drone_id, str) or not DRONE_ID.fullmatch(c.drone_id) or not seq_ok:
        raise ValueError('Invalid command identity.')
    count = ARG_COUNT.get(c.type)
    if count is None or len(c.args) != count or not all(math.isfinite(float(a)) for a in c.args):
        raise ValueError(f'{c.type} needs {count} numeric arguments.')
    if c.type == 'GOTO':
        args = [_coord(c.args[0]), _coord(c.args[1]), _meters(c.args[2])]
    else:
        args = [_meters(a) for a in c.args]
    return ' '.join(['AC1', c.drone_id, js_number_to_string(c.seq), str(_floor_int(c.expires)), c.type, *args])


def format_telemetry(t: Telemetry) -> str:
    """Same as the TS formatter: no range checks except heading, which wraps into [0, 360)."""
    return ' '.join([
        'AT1', t.drone_id, js_number_to_string(t.seq), str(_floor_int(t.ts)),
        _coord(t.lat), _coord(t.lon), _meters(t.alt),
        str(js_round(t.battery)), str(js_remainder(js_remainder(js_round(t.heading), 360) + 360, 360)), _meters(t.speed),
        js_number_to_string(t.fix), js_number_to_string(t.sats), t.state, t.mode,
    ])


def format_ack(a: Ack) -> str:
    tokens = ['AK1', a.drone_id, js_number_to_string(a.seq), str(_floor_int(a.ts)),
              js_number_to_string(a.cmd_seq), a.status]
    if a.reason:
        tokens.append(a.reason)
    return ' '.join(tokens)


# --- Strict parsing --------------------------------------------------------------

def _num(tokens: Sequence[str], index: int, pattern: re.Pattern, lo: float, hi: float, integer: bool):
    if index >= len(tokens) or not pattern.fullmatch(tokens[index]):
        return None
    value = int(tokens[index]) if integer else float(tokens[index])
    return value if lo <= value <= hi else None


def parse_drone_body(body: str) -> Union[Telemetry, Ack, None]:
    """Strict parser for drone -> server bodies (signature already removed)."""
    t = body.split(' ')
    if len(t) < 2 or not DRONE_ID.fullmatch(t[1]):
        return None
    seq = _num(t, 2, _INTEGER, 1, MAX_SAFE_INTEGER, True)
    ts = _num(t, 3, _INTEGER, 1, MAX_UNIX, True)
    if seq is None or ts is None:
        return None
    if t[0] == 'AT1' and len(t) == 14:
        lat = _num(t, 4, _DECIMAL, -90, 90, False)
        lon = _num(t, 5, _DECIMAL, -180, 180, False)
        alt = _num(t, 6, _DECIMAL, -100, 999.9, False)
        battery = _num(t, 7, _BATTERY, -1, 100, True)
        heading = _num(t, 8, _HEADING, 0, 359, True)
        speed = _num(t, 9, _DECIMAL, 0, 100, False)
        fix = _num(t, 10, _FIX, 0, 8, True)
        sats = _num(t, 11, _SATS, 0, 99, True)
        state, mode = t[12], t[13]
        if any(v is None for v in (lat, lon, alt, battery, heading, speed, fix, sats)):
            return None
        if state not in DRONE_STATES or not MODE.fullmatch(mode):
            return None
        return Telemetry(t[1], seq, ts, lat, lon, alt, battery, heading, speed, fix, sats, state, mode)
    if t[0] == 'AK1' and len(t) in (6, 7):
        cmd_seq = _num(t, 4, _INTEGER, 1, MAX_SAFE_INTEGER, True)
        status = t[5]
        reason = t[6] if len(t) == 7 else None
        if cmd_seq is None or status not in ACK_STATUSES or (reason is not None and not REASON.fullmatch(reason)):
            return None
        return Ack(t[1], seq, ts, cmd_seq, status, reason or None)
    return None


def parse_command_body(body: str) -> Optional[Command]:
    """Strict parser for server -> drone command bodies (signature already removed).

    Same per-argument ranges as the TS reference: GOTO lat/lon/alt, TAKEOFF alt, with
    altitudes in [0, 120] m. The bridge still re-checks fence and altitude limits.
    """
    t = body.split(' ')
    kind = t[4] if len(t) > 4 else ''
    if t[0] != 'AC1' or len(t) < 2 or not DRONE_ID.fullmatch(t[1]) or kind not in ARG_COUNT \
            or len(t) != 5 + ARG_COUNT[kind]:
        return None
    seq = _num(t, 2, _INTEGER, 1, MAX_SAFE_INTEGER, True)
    expires = _num(t, 3, _INTEGER, 1, MAX_UNIX, True)
    ranges = ARG_RANGES.get(kind, ())
    args = [_num(t, 5 + i, _DECIMAL, lo, hi, False) for i, (lo, hi) in enumerate(ranges)]
    if seq is None or expires is None or any(a is None for a in args):
        return None
    return Command(t[1], seq, expires, kind, tuple(args))


__all__ = [
    'COMMAND_TYPES', 'DRONE_STATES', 'ACK_STATUSES', 'ARG_COUNT', 'ARG_RANGES', 'DRONE_ID', 'REASON', 'MODE',
    'Command', 'Telemetry', 'Ack', 'derive_drone_key', 'sign_line', 'verify_line', 'line_drone_id',
    'format_command', 'format_telemetry', 'format_ack', 'parse_drone_body', 'parse_command_body',
    'js_to_fixed', 'js_round', 'js_remainder', 'js_number_to_string',
]
