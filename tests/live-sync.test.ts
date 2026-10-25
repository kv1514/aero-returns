import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Timestamp } from 'spacetimedb';
import { changeKey, OFF, type LiveSync } from '../components/live-sync';
import { LiveSyncCard } from '../components/live-sync-panel';
import type { MyReturnRow } from '../lib/stdb/module_bindings/types';

const t0 = Date.UTC(2026, 9, 25, 17, 0), at = (ms: number) => Timestamp.fromDate(new Date(ms));
const row = (over: Partial<MyReturnRow> = {}): MyReturnRow => ({ returnId: 'r1', ownerKey: 'k'.repeat(32), mode: 'simulated', state: 'EN_ROUTE_TO_PICKUP', progress: 0.25, etaSeconds: 180, droneLabel: 'AERO-217', updatedAt: at(t0), ...over });
const render = (sync: LiveSync) => renderToStaticMarkup(createElement(LiveSyncCard, { sync, now: t0 })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a simulated return refetches only when its state changes, so its own reads never loop; a live one also when the drone moves', () => {
  assert.equal(changeKey(undefined), '');
  assert.equal(changeKey(row()), changeKey(row({ progress: 0.3, etaSeconds: 170, updatedAt: at(t0 + 2000) })), 'the clock moved, nothing new');
  assert.notEqual(changeKey(row()), changeKey(row({ state: 'ARRIVED_AT_PICKUP' })));
  const live = row({ mode: 'live', droneLabel: 'Live drone' });
  assert.equal(changeKey(live), changeKey({ ...live, updatedAt: at(t0 + 1000) }), 'a repeat report of the same position');
  assert.notEqual(changeKey(live), changeKey({ ...live, progress: 0.26 }));
  assert.notEqual(changeKey(live), changeKey({ ...live, etaSeconds: 170 }));
});

test('Fleet says "Live via SpacetimeDB" only while live, shows nothing while sync is off, and never shows a key or coordinates', () => {
  assert.equal(renderToStaticMarkup(createElement(LiveSyncCard, { sync: OFF, now: t0 })), '', 'no card without SpacetimeDB: Fleet looks as it did');
  for (const status of ['connecting', 'error'] as const) {
    const text = render({ ...OFF, status, stats: { id: 0, demoAccounts: 1, signedInAccounts: 0, guestAccounts: 0, activeSimFlights: 1, liveDronesOnline: 1 } });
    assert.doesNotMatch(text, /Live via SpacetimeDB/, status); assert.doesNotMatch(text, /Accounts seen/, status);
  }
  const key = 'k'.repeat(32), text = render({
    status: 'live', stats: { id: 0, demoAccounts: 2, signedInAccounts: 1, guestAccounts: 3, activeSimFlights: 9, liveDronesOnline: 1 },
    account: { accountKey: key, kind: 'account', returnsTotal: 4, returnsActive: 1, firstSeen: at(t0 - 9e5), lastSeen: at(t0) },
    fleet: [{ droneId: 'bench-1', ownerKey: key, lat: 37.87, lng: -122.26, alt: 12, heading: 90, speed: 4, battery: 81.6, sats: 14, state: 'ENROUTE', phase: 'TO_PICKUP', fault: '', armed: true, stale: false, onMission: true, transport: 'https', updatedAt: at(t0 - 3000) }],
    returns: [row()],
  });
  assert.match(text, /Live via SpacetimeDB/);
  assert.match(text, /Simulated flights 9 in progress across all customers/, 'the module\'s count; no per-flight rows reach a browser');
  assert.match(text, /Accounts seen 6 2 demo · 1 signed in · 3 guest with returns/);
  assert.match(text, /This session Signed-in account 1 active of 4 returns/);
  assert.match(text, /bench-1 Online On a mission enroute · to pickup · 82% · 14 · armed · updated just now/);
  assert.doesNotMatch(text, new RegExp(key), 'the owner key stays out of the page');
  assert.doesNotMatch(text, /37\.87|-122\.26/, 'no coordinates on the card');
});

test('the bindings load only after the server says sync is on, and the customer app labels while live and slows only a simulated return\'s poll', () => {
  const hook = readFileSync('components/live-sync.tsx', 'utf8'), app = readFileSync('components/aero-app.tsx', 'utf8'), panel = readFileSync('components/live-sync-panel.tsx', 'utf8');
  for (const source of [hook, app, panel]) assert.doesNotMatch(source, /^import (?!type )[^;]*(module_bindings|'spacetimedb')/m, 'no runtime import of the SDK outside the dynamic import');
  assert.match(hook, /if \(closed \|\| !cfg\?\.enabled[^;]*\) return;[\s\S]*import\('@\/lib\/stdb\/module_bindings'\)/);
  assert.match(app, /slowPoll=synced&&!record\?\.live;/, 'a live flight keeps the 2 s poll, so "Drone signal lost" never waits for 8 s');
  assert.match(app, /setInterval\(\(\)=>void refresh\(\),slowPoll\?8000:2000\)/);
  assert.equal(app.match(/Live via SpacetimeDB/g)?.length, 1); assert.match(app, /\{synced&&syncRow&&<span className="stdb-chip"/);
  assert.match(app, /\{synced&&<div className="stdb-shared">/);
});

test('a browser subscribes only to counts and its own views, and a changed account gets a new identity', () => {
  const hook = readFileSync('components/live-sync.tsx', 'utf8');
  const queries = [...hook.matchAll(/'SELECT \* FROM (\w+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(queries, ['fleet_stats', 'my_account', 'my_fleet', 'my_returns'], 'no per-flight or raw table subscription');
  assert.match(hook, /if \(result === 'rotate'\) \{ forget\(\); return restart\(\); \}/, 'a revoked identity is forgotten, never reused');
  assert.match(hook, /body: JSON\.stringify\(\{ identity, token, account: last\.account \|\| undefined \}\)/, 'the grant names the account this identity was last granted');
  assert.match(hook, /const restart = \(token\?: string\) => \{ if \(Date\.now\(\) - restarted < RESTART_MS\) return fail\(\);/, 'restarts are rate-limited');
});
