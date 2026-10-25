'use client';
import { useEffect, useState } from 'react';
import { Battery, Radio, Satellite } from 'lucide-react';
import { stamp, useLiveSync, type LiveStatus, type LiveSync } from './live-sync';

const STATUS: Record<Exclude<LiveStatus, 'off'>, string> = { connecting: 'Connecting…', live: 'Live via SpacetimeDB', error: 'Unavailable' };
const NOTE: Record<Exclude<LiveStatus, 'live' | 'off'>, string> = {
  connecting: 'Connecting to SpacetimeDB. Until it is live, Fleet reads drone state from the server every few seconds.',
  error: 'SpacetimeDB is unreachable or did not accept this browser. Fleet keeps reading drone state from the server.',
};
const KIND: Record<string, string> = { demo: 'Demo account', account: 'Signed-in account', guest: 'Guest session' };
const words = (v: string) => (v ? v.replace(/_/g, ' ').toLowerCase() : '—');
const ago = (ms: number) => (ms < 5000 ? 'just now' : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);

/**
 * The Fleet card for one live-sync state. Only aggregate counts and this session's own rows, never a key, identity or token.
 * Nothing at all while sync is off (not configured, or not known yet), so Fleet looks exactly as it does without SpacetimeDB.
 */
export function LiveSyncCard({ sync, now }: { sync: LiveSync; now: number }) {
  const { status, stats, account, fleet } = sync, accounts = stats ? stats.demoAccounts + stats.signedInAccounts + stats.guestAccounts : 0;
  if (status === 'off') return null;
  return <section className="fleet live-sync" aria-labelledby="live-sync-title"><div className="fleet-card">
    <div className="live-sync-head"><h3 id="live-sync-title"><Radio size={17} />Live sync · SpacetimeDB</h3><span className={`live-sync-status ${status}`} role="status"><i />{STATUS[status]}</span></div>
    {status !== 'live' ? <p className="live-sync-note">{NOTE[status]}</p> : <>
      <div className="fleet-tiles live-sync-tiles">
        <div><span>Simulated flights</span><strong>{stats?.activeSimFlights ?? 0}</strong><small>in progress across all customers</small></div>
        <div><span>Live drones online</span><strong>{stats?.liveDronesOnline ?? 0}</strong><small>linked and reporting, all owners</small></div>
        <div><span>Accounts seen</span><strong>{accounts}</strong><small>{stats ? `${stats.demoAccounts} demo · ${stats.signedInAccounts} signed in · ${stats.guestAccounts} guest with returns` : 'No count yet'}</small></div>
        <div><span>This session</span><strong className="live-sync-kind">{account ? KIND[account.kind] ?? 'Account' : '—'}</strong><small>{account ? `${account.returnsActive} active of ${account.returnsTotal} ${account.returnsTotal === 1 ? 'return' : 'returns'}` : 'Not synced yet'}</small></div>
      </div>
      <h4 className="live-sync-sub">Your drones</h4>
      {fleet.length === 0 ? <p className="live-sync-note">None of your drones has reported through the bridge yet.</p> : <ul className="live-sync-drones">{[...fleet].sort((a, b) => a.droneId.localeCompare(b.droneId)).map(d => <li key={d.droneId} className={d.stale ? 'stale' : ''}>
        <div><strong>{d.droneId}</strong><span className={`fleet-dot ${d.stale ? 'stale' : 'live'}`} aria-hidden="true" /><span>{d.stale ? 'Signal lost' : 'Online'}</span>{d.onMission && <span className="live-sync-tag">On a mission</span>}</div>
        <small>{words(d.state)} · {d.phase ? words(d.phase) : 'no mission'}{d.fault ? ` · ${words(d.fault)}` : ''} · <Battery size={12} /> {d.battery >= 0 ? `${Math.round(d.battery)}%` : '—'} · <Satellite size={12} /> {d.sats} · {d.armed ? 'armed' : 'disarmed'} · updated {ago(Math.max(0, now - stamp(d.updatedAt)))}</small>
      </li>)}</ul>}
    </>}
  </div></section>;
}

/** Live-sync card mounted under the Fleet console. It adds nothing to the console's own polling or controls. */
export default function LiveSyncPanel() {
  const sync = useLiveSync(), [now, setNow] = useState(0);
  useEffect(() => { const tick = () => setNow(Date.now()), timer = setInterval(tick, 1000); const first = setTimeout(tick, 0); return () => { clearInterval(timer); clearTimeout(first); }; }, []);
  return <LiveSyncCard sync={sync} now={now} />;
}
