#!/bin/bash
# Bench/field health check for the AERO bridge on the AirCart Jetson.
# Usage:  bash drone/check.sh        (exit 0 = bridge up, FC seen, app reachable)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENVF=/etc/aero/bridge.env
fail=0
echo -n "config:       "
if [ -r "$ENVF" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENVF"; set +a
    [ -n "${AERO_DRONE_ID:-}" ] && [ -n "${AERO_DRONE_KEY:-}" ] && echo "drone ${AERO_DRONE_ID}, server ${AERO_SERVER:-?}" \
        || { echo "AERO_DRONE_ID / AERO_DRONE_KEY not set in $ENVF"; fail=1; }
else
    echo "$ENVF not readable (run: sudo bash drone/install.sh; membership of the owner group)"; fail=1
fi
echo -n "live:         "; case "${AERO_LIVE:-}" in 1|true|yes|on|live) echo "LIVE — the bridge will arm and fly";; *) echo "dry run (AERO_LIVE unset)";; esac
echo -n "service:      "; systemctl is-active aero-bridge 2>/dev/null || fail=1
echo -n "MAVROS port:  "; if ss -ltn | grep -q ':5770 '; then echo "tcp:127.0.0.1:5770 listening (aircart-ros2 up)"; else echo "not listening — bridge uses the USB device directly"; fi
echo -n "FC device:    "; ls -l /dev/aircart_fc 2>/dev/null | awk '{print $NF" ("$(NF-2)")"}' || echo "absent"
echo -n "clock:        "; timedatectl show -p NTPSynchronized --value 2>/dev/null | sed 's/yes/NTP synced/;s/no/NOT synced — commands expire after 30 s/'
echo -n "4G dongle:    "
dev=$(nmcli -g GENERAL.DEVICES con show lte-dongle 2>/dev/null)
if [ -n "$dev" ]; then
    code=$(timeout 15 curl -6 -s -o /dev/null -w '%{http_code}' --interface "$dev" "${AERO_SERVER:-https://aero-returns.kv15.workers.dev}/" 2>/dev/null)
    [ "$code" = 200 ] && echo "$dev reaches the app over IPv6 (HTTP $code)" || { echo "$dev: app not reachable (HTTP ${code:-none})"; fail=1; }
else
    echo "lte-dongle connection is down"; fail=1
fi
echo -n "4G policy:    "
if [ -n "$dev" ]; then
    if ip -6 route show default | grep -q '^unreachable' && ip -6 route show default | grep -q "dev $dev"; then
        case "$(ip -6 route get 2606:4700:4700::1111 2>&1 | head -1)" in
            *"dev $dev"*) echo "LEAK: unbound IPv6 traffic goes out the dongle (run: sudo bash drone/lte_routing.sh)"; fail=1;;
            *) echo "dongle reachable only by sockets bound to $dev";;
        esac
    else
        echo "shadow route missing: the whole Jetson may use the dongle (run: sudo bash drone/lte_routing.sh)"; fail=1
    fi
    pfx=$(ip -6 -o addr show dev "$dev" scope global 2>/dev/null | awk '{print $4}' | cut -d: -f1-4 | head -1)
    n=$(ss -tnH state established 2>/dev/null | awk -v p="$pfx" 'p!="" && index($3,"["p)==1' | wc -l)
    echo "4G sockets:   $n established connections through the dongle"
fi
echo "bridge log (last 6 lines):"
journalctl -u aero-bridge -n 6 --no-pager -o cat 2>/dev/null | sed 's/^/    /' || echo "    (no journal access)"
[ $fail = 0 ] && echo "OK" || echo "PROBLEMS"
exit $fail
