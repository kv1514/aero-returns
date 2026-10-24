// Regenerate with: node tests/fixtures/generate-drone-vectors.mjs > tests/fixtures/drone-link-vectors.json
import { deriveDroneKey, signLine, formatCommand, formatTelemetry, formatAck } from '../../lib/drone-protocol.ts';
const master = 'aero-test-master-secret-0123456789abcdef', droneId = 'tst001';
const key = await deriveDroneKey(master, droneId, 1);
const bodies = {
  goto: formatCommand({ droneId, seq: 7, expires: 1761312400, type: 'GOTO', args: [37.871234, -122.258901, 30] }),
  takeoff: formatCommand({ droneId, seq: 6, expires: 1761312400, type: 'TAKEOFF', args: [30] }),
  abort: formatCommand({ droneId, seq: 8, expires: 1761312400, type: 'ABORT', args: [] }),
  telemetry: formatTelemetry({ droneId, seq: 1761312345123, ts: 1761312345, lat: 37.8712345, lon: -122.2589012, alt: 29.84, battery: 87, heading: 213, speed: 11.8, fix: 3, sats: 14, state: 'ENROUTE', mode: 'GUIDED' }),
  ack: formatAck({ droneId, seq: 1761312346000, ts: 1761312346, cmdSeq: 7, status: 'DONE' }),
  rejected: formatAck({ droneId, seq: 1761312347000, ts: 1761312347, cmdSeq: 9, status: 'REJECTED', reason: 'FENCE' }),
};
const lines = {};
for (const [name, body] of Object.entries(bodies)) lines[name] = await signLine(key, body);
console.log(JSON.stringify({ master, droneId, keyVersion: 1, key, lines }, null, 2));
