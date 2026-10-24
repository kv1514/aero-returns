#!/bin/bash
# One-time root install of the AERO bridge service on the AirCart Jetson.
# Idempotent. Usage:  sudo bash drone/install.sh
#
# Installs /etc/systemd/system/aero-bridge.service (pointing at this checkout)
# and creates /etc/aero/bridge.env from drone/bridge.env.example if it does
# not exist yet. Fill in AERO_DRONE_ID / AERO_DRONE_KEY from Fleet, then
# `sudo systemctl restart aero-bridge`.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
OWNER="${SUDO_USER:-}"
[ -n "$OWNER" ] && [ "$OWNER" != root ] || { echo "run as 'sudo bash $0' from the normal user account"; exit 1; }
REPO="$(cd .. && pwd)"

sudo -u "$OWNER" python3 -c 'import pymavlink' 2>/dev/null || {
    echo "pymavlink is missing for ${OWNER}'s python3 (the service runs as ${OWNER}: pip3 install --user pymavlink, or apt install python3-pymavlink)"; exit 1; }

echo "== /etc/aero/bridge.env"
install -d -m 755 /etc/aero
if [ ! -f /etc/aero/bridge.env ]; then
    install -m 600 -o root -g "$OWNER" bridge.env.example /etc/aero/bridge.env
    chmod 640 /etc/aero/bridge.env
    echo "created from bridge.env.example — fill in AERO_DRONE_ID and AERO_DRONE_KEY from Fleet"
else
    echo "exists, left unchanged"
fi

echo "== systemd unit aero-bridge"
sed -e "s|@USER@|${OWNER}|g" -e "s|@REPO@|${REPO}|g" aero-bridge.service > /etc/systemd/system/aero-bridge.service
systemctl daemon-reload
systemctl enable aero-bridge.service >/dev/null
systemctl restart aero-bridge.service
sleep 3
systemctl --no-pager --lines=8 status aero-bridge.service || true
echo
echo "done. Logs: journalctl -u aero-bridge -f    Health: bash ${REPO}/drone/check.sh"
