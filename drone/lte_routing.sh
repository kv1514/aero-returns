#!/bin/bash
# One-time root setup so the 4G dongle is used ONLY by things that bind to it
# (the AERO bridge via AERO_BIND, `curl --interface lte0`, `ssh -o BindInterface=lte0`)
# and never by the rest of the Jetson. Idempotent. Usage:  sudo bash drone/lte_routing.sh
#
# Why (all measured on 2026-10-24, details in README "The 4G link"):
#  * Most Wi-Fi networks have no IPv6, so the dongle was the Jetson's only IPv6
#    default route and every dual-stack host (Claude Code, Firefox, apt, ...)
#    silently went out over 4G: 56 MB in one afternoon on a plan sized for
#    ~1 KB/s of command traffic, until the carrier stopped passing packets.
#  * This kernel (6.8 tegra) has no CONFIG_IPV6_MULTIPLE_TABLES, so IPv6 policy
#    routing (separate table + `ip rule`) is impossible. Instead lte-dongle gets
#    an `unreachable ::/0` route with a lower metric than its own default and no
#    IPv4 default at all: unbound sockets hit the unreachable route and fall back
#    to IPv4 over Wi-Fi; sockets bound to the dongle do a strict per-interface
#    lookup, skip it and reach the real gateway.
#  * After every modem reboot ModemManager claims the SIM7600 and NetworkManager
#    then drops the RNDIS interface ("removed"), so lte-dongle never comes back
#    without a replug. A udev rule hides the modem from ModemManager and names
#    the interface lte0 instead of a MAC-derived enx… that changes every boot.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

echo "== udev: hide the modem from ModemManager, name its NIC lte0"
cat > /etc/udev/rules.d/70-lte-dongle.rules <<'RULES'
# SIMCom SIM7600G-H 4G dongle in RNDIS mode (AirCart Jetson). See drone/lte_routing.sh.
SUBSYSTEM=="usb", ATTR{idVendor}=="1e0e", ATTR{idProduct}=="9011", ENV{ID_MM_DEVICE_IGNORE}="1"
SUBSYSTEM=="net", ACTION=="add", ATTRS{idVendor}=="1e0e", ATTRS{idProduct}=="9011", NAME="lte0"
RULES
udevadm control --reload

echo "== NetworkManager profile lte-dongle"
nmcli con mod lte-dongle \
    connection.interface-name lte0 connection.autoconnect yes connection.autoconnect-priority 10 \
    ipv4.method auto ipv4.never-default yes ipv4.route-table 0 ipv4.routing-rules "" ipv4.dns-priority 200 \
    ipv6.method auto ipv6.never-default no ipv6.route-table 0 ipv6.routing-rules "" \
    ipv6.routes "::/0 :: 1 type=unreachable" ipv6.dns-priority 200
nmcli -g connection.interface-name,ipv4.never-default,ipv6.routes con show lte-dongle | tr '\n' ' '; echo

echo "== release the modem from ModemManager and re-enumerate the dongle"
systemctl restart ModemManager 2>/dev/null || true
found=0
for d in /sys/bus/usb/devices/*; do
    [ -r "$d/idVendor" ] || continue
    [ "$(cat "$d/idVendor")" = 1e0e ] && [ "$(cat "$d/idProduct")" = 9011 ] || continue
    found=1; echo "re-enumerating USB device $(basename "$d")"
    echo 0 > "$d/authorized"; sleep 2; echo 1 > "$d/authorized"
done
[ $found = 1 ] || echo "dongle not on the USB bus — plug it in; the rules apply when it appears"

echo -n "waiting for lte-dongle on lte0 "
for _ in $(seq 1 45); do
    [ "$(nmcli -g GENERAL.STATE con show lte-dongle 2>/dev/null)" = activated ] && break
    echo -n .; sleep 1
done; echo
if [ "$(nmcli -g GENERAL.DEVICES con show lte-dongle 2>/dev/null)" != lte0 ]; then
    echo "lte-dongle is not up on lte0 — unplug and replug the dongle, then run:  bash drone/check.sh"; exit 1
fi
echo "IPv6 default routes now:"; ip -6 route show default | sed 's/^/    /'
echo -n "unbound lookup (must NOT say lte0): "; ip -6 route get 2606:4700:4700::1111 2>&1 | head -1
echo -n "bound-to-lte0 lookup (must say lte0): "; ip -6 route get 2606:4700:4700::1111 oif lte0 2>&1 | head -1
echo "done — verify with: bash drone/check.sh"
