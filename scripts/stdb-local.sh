#!/usr/bin/env bash
# A local, in-memory SpacetimeDB for AERO development: listens on 127.0.0.1:3010 and serves the module in spacetime/ as
# database aero-fleet-local, with WORKER_IDENTITY set to a local Worker identity kept in $STDB_LOCAL_DIR/worker.json
# (mode 600). It never talks to Maincloud: the CLI runs with its own scratch config and every call names the local server.
#
#   STDB_LOCAL_DIR=<scratch dir> scripts/stdb-local.sh [start|restart|stop|status]
#
# start (default) starts the server if it is not running and (re)publishes the module; restart starts from empty data.
# The JWT keys and the Worker identity survive restarts, so a Worker token in .dev.vars keeps working. Prints the
# identity, never the token. Point the app at it with SPACETIMEDB_URI=http://127.0.0.1:3010,
# SPACETIMEDB_DATABASE=aero-fleet-local and SPACETIMEDB_TOKEN=<token from worker.json>.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${STDB_LOCAL_DIR:-${TMPDIR:-/tmp}/aero-stdb-local}"
addr=127.0.0.1:3010 host=http://127.0.0.1:3010 db=aero-fleet-local
spacetime="${SPACETIME:-$HOME/.local/bin/spacetime}"
mkdir -p "$dir/data" && chmod 700 "$dir"
cli() { "$spacetime" --config-path "$dir/cli.toml" "$@" </dev/null; }
json() { python3 -I -c 'import sys,json; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$@"; }
listener() { lsof -nP -t -iTCP:3010 -sTCP:LISTEN 2>/dev/null | head -1; }
up() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$host/v1/ping")" = 200 ]; }

stop() {
  local pid; pid="$(listener)"
  [ -n "$pid" ] || { echo "SpacetimeDB is not running on $addr."; return; }
  # Only ever stop a SpacetimeDB server, never some other program that happens to hold the port.
  ps -o command= -p "$pid" | grep -q spacetimedb || { echo "Port 3010 is held by another program (pid $pid); not stopping it." >&2; exit 1; }
  kill "$pid"; for _ in $(seq 50); do [ -z "$(listener)" ] && break; sleep 0.1; done
  echo "Stopped SpacetimeDB on $addr."
}

keys() { # ES256 (P-256) keys in PKCS#8 PEM, made once; spacetime start would otherwise write them to ~/.config/spacetime.
  [ -s "$dir/jwt-priv.pem" ] && [ -s "$dir/jwt-pub.pem" ] && return
  (umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$dir/ec.pem"
    openssl pkcs8 -topk8 -nocrypt -in "$dir/ec.pem" -out "$dir/jwt-priv.pem"
    openssl ec -in "$dir/ec.pem" -pubout -out "$dir/jwt-pub.pem" 2>/dev/null; rm -f "$dir/ec.pem")
  rm -f "$dir/cli.toml" "$dir/worker.json" # tokens signed by older keys no longer verify
}

start() {
  up && { echo "SpacetimeDB already running on $addr."; return; }
  keys
  [ -s "$dir/cli.toml" ] || printf 'default_server = "aero-local"\n\n[[server_configs]]\nnickname = "aero-local"\nhost = "%s"\nprotocol = "http"\n' "$addr" > "$dir/cli.toml"
  nohup "$spacetime" --config-path "$dir/cli.toml" start --listen-addr "$addr" --in-memory --non-interactive --data-dir "$dir/data" \
    --jwt-priv-key-path "$dir/jwt-priv.pem" --jwt-pub-key-path "$dir/jwt-pub.pem" </dev/null >"$dir/server.log" 2>&1 &
  for _ in $(seq 100); do up && break; sleep 0.2; done
  up || { echo "SpacetimeDB did not start; see $dir/server.log" >&2; exit 1; }
  echo "Started SpacetimeDB (in memory) on $addr."
}

worker() { # Reuse the saved Worker identity while its token still verifies; otherwise mint a new one.
  if [ -s "$dir/worker.json" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "$host/v1/identity/$(json "$dir/worker.json" identity)/verify" -H "Authorization: Bearer $(json "$dir/worker.json" token)")" = 204 ]; then return; fi
  (umask 077; curl -fsS -X POST "$host/v1/identity" > "$dir/worker.json.tmp" && mv "$dir/worker.json.tmp" "$dir/worker.json"); chmod 600 "$dir/worker.json"
}

publish() {
  [ -d "$root/spacetime/node_modules/spacetimedb" ] || npm ci --prefix "$root/spacetime" --no-audit --no-fund
  worker
  local id; id="$(json "$dir/worker.json" identity)"
  WORKER_IDENTITY="$id" cli publish "$db" --server "$host" -p "$root/spacetime" --delete-data=on-conflict -y | tail -3
  chmod 600 "$dir/cli.toml" # it now holds the local owner token the CLI minted
  echo "Database: $db at $host"
  echo "Worker identity: $id (token in $dir/worker.json, never printed)"
}

case "${1:-start}" in
  start) start; publish ;;
  restart) stop; start; publish ;;
  stop) stop ;;
  status) if up; then echo "SpacetimeDB running on $addr (pid $(listener))."; [ -s "$dir/worker.json" ] && echo "Worker identity: $(json "$dir/worker.json" identity)"; else echo "SpacetimeDB is not running on $addr."; fi ;;
  *) echo "Usage: scripts/stdb-local.sh [start|restart|stop|status]" >&2; exit 2 ;;
esac
