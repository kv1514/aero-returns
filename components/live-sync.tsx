'use client';
/**
 * SpacetimeDB live sync in the browser (docs/SPACETIMEDB.md). Off unless GET /api/live-sync says it is configured; then the
 * generated bindings load on demand, this browser connects with its own SpacetimeDB identity, the Worker grants that identity
 * this session's rows (POST /api/live-sync), and the hook mirrors the subscribed rows. D1 stays the source of truth: screens
 * keep their own fetches and only use this to refetch sooner. The token stays in this browser's storage and the AERO
 * Worker; it is never rendered. When this browser's account changes, the Worker revokes the identity and a new one takes over.
 */
import { useEffect, useState } from 'react';
import type { DbConnection } from '@/lib/stdb/module_bindings';
import type { FleetStatsRow, MyAccountRow, MyDroneRow, MyReturnRow } from '@/lib/stdb/module_bindings/types';

export type LiveStatus = 'off' | 'connecting' | 'live' | 'error';
export type LiveSync = { status: LiveStatus; account: MyAccountRow | null; fleet: MyDroneRow[]; returns: MyReturnRow[]; stats: FleetStatsRow | null };
export const TOKEN_KEY = 'aero:stdb-token', ACCOUNT_KEY = 'aero:stdb-account', REGRANT_MS = 30 * 60_000, RETRY_MS = 30_000, RESTART_MS = 60_000;
// fleet_stats is the only shared data: counts, no per-flight rows.
const SHARED = ['SELECT * FROM fleet_stats'], OWNER = ['SELECT * FROM my_account', 'SELECT * FROM my_fleet', 'SELECT * FROM my_returns'];
export const OFF: LiveSync = { status: 'off', account: null, fleet: [], returns: [], stats: null };

/** A row timestamp in epoch milliseconds. */
export const stamp = (t: { toDate(): Date }) => t.toDate().getTime();
/**
 * What a return's row says that its screen does not already know. A simulated row only by state: its progress moves with the
 * clock on every read the screen itself makes, so keying on it would refetch in a loop. A live row also by where the drone is.
 */
export const changeKey = (r: MyReturnRow | undefined) => (!r ? '' : r.mode === 'live' ? `live:${r.state}:${r.progress.toFixed(3)}:${r.etaSeconds}` : `sim:${r.state}`);

const read = (key: string) => { try { return localStorage.getItem(key) || undefined; } catch { return undefined; } };
const write = (key: string, value?: string) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* storage blocked: a new identity next time */ } };
/** ACCOUNT_KEY holds "<identity>:<account key it was last granted>" for this browser's current identity. */
const stored = () => { const [identity = '', account = ''] = (read(ACCOUNT_KEY) ?? '').split(':'); return { identity, account }; };
/** Forgets this browser's identity and its account; the next connection starts a new identity. */
const forget = () => { write(TOKEN_KEY); write(ACCOUNT_KEY); };
/**
 * Asks the Worker to let this identity see this session's rows, naming the account it was last granted. 409: that was another
 * account, so the Worker revoked it; 403: SpacetimeDB refused the pair; "stale": another tab of this browser moved to a new identity.
 */
async function grant(identity: string, token: string) {
  const last = stored(); if (last.identity && last.identity !== identity) return 'stale';
  const res = await fetch('/api/live-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity, token, account: last.account || undefined }) }).catch(() => null);
  if (!res?.ok) return res?.status === 409 ? 'rotate' : res?.status === 403 ? 'refused' : 'retry';
  const body = await res.json().catch(() => null) as { account?: unknown } | null;
  if (typeof body?.account === 'string' && stored().identity === identity) write(ACCOUNT_KEY, `${identity}:${body.account}`);
  return 'granted';
}

/** "live" only while connected, the shared rows are subscribed and this session's grant and rows are in place; "error" while the connection is down. */
export function useLiveSync(): LiveSync {
  const [sync, setSync] = useState<LiveSync>(OFF);
  useEffect(() => {
    // gen numbers the connections: callbacks of a replaced one (a new identity, a retried first attempt) go quiet.
    let closed = false, conn: DbConnection | null = null, gen = 0, ownerGen = 0, online = false, shared = false, owner = false, failed = false, lost = false, restarted = -RESTART_MS;
    let lib: { Db: typeof DbConnection; uri: string; database: string } | null = null;
    let queued: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined, again: ReturnType<typeof setTimeout> | undefined, regrant: ReturnType<typeof setInterval> | undefined;
    // One state update per burst of row events (a transaction touches several tables).
    const publish = () => { queued = undefined; if (closed || !conn) return; const db = conn.db; setSync({ status: failed || lost ? 'error' : online && shared && owner ? 'live' : 'connecting', account: [...db.myAccount.iter()][0] ?? null, fleet: [...db.myFleet.iter()], returns: [...db.myReturns.iter()], stats: [...db.fleetStats.iter()][0] ?? null }); };
    const queue = () => { if (!queued && !closed) queued = setTimeout(publish, 100); };
    const fail = () => { failed = true; queue(); };
    // A new identity (or another tab's) at most once a minute, so a server that keeps refusing cannot loop this.
    const restart = (token?: string) => { if (Date.now() - restarted < RESTART_MS) return fail(); restarted = Date.now(); start(token); };
    const ownerRows = async (c: DbConnection, n: number, identity: string, token: string) => {
      clearTimeout(retry); const result = await grant(identity, token); if (closed || n !== gen) return;
      if (result === 'refused') return fail();
      if (result === 'rotate') { forget(); return restart(); }
      if (result === 'stale') return restart(read(TOKEN_KEY));
      if (result === 'retry') { retry = setTimeout(() => void ownerRows(c, n, identity, token), RETRY_MS); return; }
      // The grant is what the my_* views filter on, so they are subscribed only once it exists. Reconnects replay the subscription.
      if (ownerGen !== n) { ownerGen = n; c.subscriptionBuilder().onApplied(() => { if (n === gen) { owner = true; queue(); } }).onError(() => { if (n === gen) fail(); }).subscribe(OWNER); }
    };
    function start(token: string | undefined) {
      if (!lib || closed) return;
      const { Db, uri, database } = lib, n = ++gen, old = conn;
      online = shared = owner = false; clearTimeout(retry); clearTimeout(again); clearInterval(regrant); old?.disconnect();
      conn = Db.builder().withUri(uri).withDatabaseName(database).withToken(token).withAutomaticReconnect()
        .onConnect((c, identity, fresh) => {
          if (n !== gen) return;
          const id = identity.toHexString(); write(TOKEN_KEY, fresh); if (stored().identity !== id) write(ACCOUNT_KEY, `${id}:`);
          online = true; failed = lost = false; queue();
          c.subscriptionBuilder().onApplied(() => { if (n === gen) { shared = true; queue(); } }).onError(() => { if (n === gen) fail(); }).subscribe(SHARED);
          void ownerRows(c, n, id, fresh);
          // Grants lapse after two hours; renewing every 30 min also keeps this account's last-seen time current.
          regrant = setInterval(() => { if (online) void ownerRows(c, n, id, fresh); }, REGRANT_MS);
        })
        .onAutomaticReconnect((c, identity, fresh) => { if (n !== gen) return; write(TOKEN_KEY, fresh); online = true; lost = false; queue(); void ownerRows(c, n, identity.toHexString(), fresh); })
        // While the SDK reconnects (backoff up to 30 s) the screens say so and go back to polling every 2 s.
        .onDisconnect((_ctx, _error, nextAttempt) => { if (n !== gen) return; online = shared = owner = false; lost = true; if (nextAttempt === undefined) failed = true; queue(); })
        .onConnectError((_ctx, error, nextAttempt) => {
          if (closed || n !== gen || nextAttempt !== undefined) return;
          // A stored token this server refuses (another server signed it) is forgotten once, and this browser connects as a new
          // identity. A network failure keeps it, and the SDK does not retry a first connection, so this tries again in 30 s.
          const refused = error.name === 'WebSocketTokenError' && ((error as Error & { status?: number }).status ?? 500) < 500;
          if (token && refused) { forget(); restart(); } else { fail(); again = setTimeout(() => start(read(TOKEN_KEY)), RETRY_MS); }
        })
        .build();
      for (const table of [conn.db.myAccount, conn.db.myFleet, conn.db.myReturns, conn.db.fleetStats]) { table.onInsert(queue); table.onUpdate(queue); table.onDelete(queue); }
    }
    void (async () => {
      const cfg = await fetch('/api/live-sync', { cache: 'no-store' }).then(r => (r.ok ? r.json() as Promise<{ enabled?: boolean; uri?: string; database?: string }> : null)).catch(() => null);
      if (closed || !cfg?.enabled || !cfg.uri || !cfg.database) return;
      setSync({ ...OFF, status: 'connecting' });
      try {
        const [{ DbConnection: Db }, { setGlobalLogLevel }] = await Promise.all([import('@/lib/stdb/module_bindings'), import('spacetimedb')]);
        setGlobalLogLevel('warn'); // no info line per connect; failed attempts still log, at most one per backoff step
        lib = { Db, uri: cfg.uri, database: cfg.database }; start(read(TOKEN_KEY));
      }
      catch { if (!closed) setSync({ ...OFF, status: 'error' }); }
    })();
    return () => { closed = true; clearTimeout(queued); clearTimeout(retry); clearTimeout(again); clearInterval(regrant); conn?.disconnect(); };
  }, []);
  return sync;
}
