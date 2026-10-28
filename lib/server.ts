import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { session } from './session';
import { attachLive, liveReturnRequest } from './drone-server';
import { assignDrone, bookedReview, control, createReturn, settle, snapshot, type ReturnRecord } from './simulation';
import { packageSchema, validationMessage } from './request-flow';
import type { ReturnReview } from './return-agent-shared';
import { publishReturn } from './spacetime-server';
export { session, packageSchema };
const actionSchema = z.object({ action: z.enum(['load','pause','resume','advance','reset','cancel','speed','fail','retry','approve','decline']), rate: z.number().optional() });
export async function handle(request: Request, id?: string): Promise<Response> {
  let identity:Awaited<ReturnType<typeof session>>;
  try{identity=await session(request);}catch{return Response.json({error:'Your account session expired or is unavailable. Open Your account to sign in again.'},{status:401,headers:{'Cache-Control':'private, no-store'}});}
  const {owner,cookie}=identity;
  // Drain an unread body before any early reply: answering without consuming it breaks the next request on a kept-alive connection.
  const reply = async (value: unknown, status = 200) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && !request.bodyUsed) await request.arrayBuffer().catch(() => undefined);
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  };
  try {
    const db = env.DB; if (!db) return reply({ error: 'Demo storage is unavailable. Please try again shortly.' }, 503);
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) return reply({ error: 'Request origin is not allowed.' }, 403);
      if (Number(request.headers.get('content-length') || 0) > 12000) return reply({ error: 'Request is too large.' }, 413);
    }
    const now = Date.now();
    if (!id && request.method === 'GET') {
      const rows = await db.prepare('SELECT record FROM returns WHERE owner = ? ORDER BY created_at DESC LIMIT 100').bind(owner).all<{record: string}>();
      return reply({ returns: await attachLive(db, owner, rows.results.map(row => settle(JSON.parse(row.record), now)), now), now });
    }
    if (!id && request.method === 'POST') {
      const raw = await request.text(); if (raw.length > 12000) return reply({ error: 'Request is too large.' }, 413);
      const { agentEventId, ...pkg } = packageSchema.extend({ agentEventId: z.string().uuid().optional() }).parse(JSON.parse(raw));
      const count = await db.prepare('SELECT COUNT(*) AS n FROM returns WHERE owner = ? AND created_at > ?').bind(owner, now - 3600000).first<{n: number}>();
      if ((count?.n || 0) >= 40) return reply({ error: 'You have created 40 demos this hour. Please reuse a return or try again later.' }, 429);
      // The server picks the drone, never the browser: the nearest one not already flying this owner's other active simulated returns.
      const recent = await db.prepare('SELECT record FROM returns WHERE owner = ? ORDER BY created_at DESC LIMIT 20').bind(owner).all<{ record: string }>();
      const others = recent.results.flatMap(row => { try { return [JSON.parse(row.record) as ReturnRecord]; } catch { return []; } });
      const r = createReturn(pkg, crypto.randomUUID(), now, assignDrone(pkg.pickup, others, now));
      // A Claude return check is attached only from this owner's own completed agent event, never from browser input.
      if (agentEventId) {
        const event = await db.prepare("SELECT result, created_at FROM integration_events WHERE id = ? AND owner = ? AND kind = 'agent' AND status = 'complete'").bind(agentEventId, owner).first<{ result: string; created_at: number }>();
        if (event) { const s = JSON.parse(event.result) as Omit<ReturnReview, 'eventId' | 'at'>; r.review = bookedReview({ verdict: s.verdict, condition: s.condition, disposition: s.disposition, confidence: s.confidence, explanation: s.explanation, model: s.model, eventId: agentEventId, at: event.created_at }); }
      }
      await db.prepare('INSERT INTO returns (id, owner, created_at, version, record) VALUES (?, ?, ?, ?, ?)').bind(r.id, owner, now, 0, JSON.stringify(r)).run();
      publishReturn(owner, r, now, true);
      return reply({ record: r, now }, 201);
    }
    if (!id) return reply({ error: 'Not found.' }, 404);
    const row = await db.prepare('SELECT record, version FROM returns WHERE id = ? AND owner = ?').bind(id, owner).first<{record: string; version: number}>();
    if (!row) return reply({ error: 'This return is not available in this session.' }, 404);
    const existing: ReturnRecord = JSON.parse(row.record);
    if (existing.live) { const live = await liveReturnRequest(db, owner, existing, row.version, request, now); return reply(live.body, live.status); }
    let r = settle(existing, now);
    if (request.method === 'PATCH') {
      const raw = await request.text(); if (raw.length > 1000) return reply({ error: 'Request is too large.' }, 413);
      const { action, rate } = actionSchema.parse(JSON.parse(raw)); r = control(r, action, now, rate);
    }
    if (request.method !== 'GET' && request.method !== 'PATCH') return reply({ error: 'Method not allowed.' }, 405);
    if (JSON.stringify(r) !== JSON.stringify(existing)) {
      r.version = row.version + 1;
      const result = await db.prepare('UPDATE returns SET version = ?, record = ? WHERE id = ? AND owner = ? AND version = ?').bind(r.version, JSON.stringify(r), id, owner, row.version).run();
      if (result.meta.changes === 0) {
        // A read only persists newly crossed milestones; if another tab saved first, serve its newer record instead.
        if (request.method === 'GET') { const latest = await db.prepare('SELECT record FROM returns WHERE id = ? AND owner = ?').bind(id, owner).first<{ record: string }>(); if (latest) { const fresh = settle(JSON.parse(latest.record), now); return reply({ record: fresh, telemetry: snapshot(fresh, now), now }); } }
        return reply({ error: 'This return changed in another tab. Please try again.' }, 409);
      }
    }
    publishReturn(owner, r, now, r.version !== existing.version); // counts change only when a booking or milestone is saved
    return reply({ record: r, telemetry: snapshot(r, now), now });
  } catch (error) {
    if (error instanceof z.ZodError) return reply({ error: validationMessage(error) }, 400);
    if (error instanceof SyntaxError) return reply({ error: 'Invalid request.' }, 400);
    const message = error instanceof Error ? error.message : 'Unable to update this return.';
    if (/No compatible|Wait until|Confirm package|Choose |has ended|cannot be cancelled|Live flight|A person must|waiting for a person/.test(message)) return reply({ error: message }, 400);
    console.error('AERO storage operation failed', error);
    return reply({ error: 'Could not reach demo storage. Your last saved return is safe; retry in a moment.' }, 503);
  }
}
