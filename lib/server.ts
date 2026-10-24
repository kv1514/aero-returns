import { env } from 'cloudflare:workers';
import { z } from 'zod';
import {verifiedAccount} from './supabase-server';
import { control, createReturn, settle, snapshot, type ReturnRecord } from './simulation';
const packageSchema = z.object({
  retailer: z.enum(['Amazon', 'Nike', 'Zara', 'Other']), method: z.enum(['qr', 'label']),
  weight: z.number().finite().positive().max(20), dimensions: z.tuple([z.number().positive().max(150), z.number().positive().max(150), z.number().positive().max(150)]),
  fragile: z.boolean(), address: z.string().trim().min(3).max(160), pickup: z.tuple([z.number().min(-122.31).max(-122.24), z.number().min(37.85).max(37.90)]),
  instructions: z.string().max(500), service: z.enum(['standard', 'priority']), returnReference: z.string().max(150).optional(),
});
const actionSchema = z.object({ action: z.enum(['load','pause','resume','advance','reset','cancel','speed','fail','retry']), rate: z.number().optional() });
export async function session(request: Request) {
  const account=await verifiedAccount();
  if(account)return {owner:account.owner,cookie:''};
  const user = request.headers.get('oai-authenticated-user-id');
  if (user) return { owner: `user:${user}`, cookie: '' };
  const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)aero_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
  const token = cookie || crypto.randomUUID();
  return { owner: `guest:${token}`, cookie: cookie ? '' : `aero_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}` };
}
export async function handle(request: Request, id?: string): Promise<Response> {
  let identity:Awaited<ReturnType<typeof session>>;
  try{identity=await session(request);}catch{return Response.json({error:'Your account session expired or is unavailable. Open Your account to sign in again.'},{status:401,headers:{'Cache-Control':'private, no-store'}});}
  const {owner,cookie}=identity;
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
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
      return reply({ returns: rows.results.map(row => settle(JSON.parse(row.record), now)), now });
    }
    if (!id && request.method === 'POST') {
      const raw = await request.text(); if (raw.length > 12000) return reply({ error: 'Request is too large.' }, 413);
      const pkg = packageSchema.parse(JSON.parse(raw));
      const count = await db.prepare('SELECT COUNT(*) AS n FROM returns WHERE owner = ? AND created_at > ?').bind(owner, now - 3600000).first<{n: number}>();
      if ((count?.n || 0) >= 40) return reply({ error: 'You have created 40 demos this hour. Please reuse a return or try again later.' }, 429);
      const r = createReturn(pkg, crypto.randomUUID(), now);
      await db.prepare('INSERT INTO returns (id, owner, created_at, version, record) VALUES (?, ?, ?, ?, ?)').bind(r.id, owner, now, 0, JSON.stringify(r)).run();
      return reply({ record: r, now }, 201);
    }
    if (!id) return reply({ error: 'Not found.' }, 404);
    const row = await db.prepare('SELECT record, version FROM returns WHERE id = ? AND owner = ?').bind(id, owner).first<{record: string; version: number}>();
    if (!row) return reply({ error: 'This return is not available in this session.' }, 404);
    const existing: ReturnRecord = JSON.parse(row.record); let r = settle(existing, now);
    if (request.method === 'PATCH') {
      const raw = await request.text(); if (raw.length > 1000) return reply({ error: 'Request is too large.' }, 413);
      const { action, rate } = actionSchema.parse(JSON.parse(raw)); r = control(r, action, now, rate);
    }
    if (request.method !== 'GET' && request.method !== 'PATCH') return reply({ error: 'Method not allowed.' }, 405);
    if (JSON.stringify(r) !== JSON.stringify(existing)) {
      r.version = row.version + 1;
      const result = await db.prepare('UPDATE returns SET version = ?, record = ? WHERE id = ? AND owner = ? AND version = ?').bind(r.version, JSON.stringify(r), id, owner, row.version).run();
      if (result.meta.changes === 0) return reply({ error: 'This return changed in another tab. Please try again.' }, 409);
    }
    return reply({ record: r, telemetry: snapshot(r, now), now });
  } catch (error) {
    if (error instanceof z.ZodError) return reply({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' · ') }, 400);
    if (error instanceof SyntaxError) return reply({ error: 'Invalid request.' }, 400);
    const message = error instanceof Error ? error.message : 'Unable to update this return.';
    if (/No compatible|Wait until|Confirm package|Choose |has ended|cannot be cancelled/.test(message)) return reply({ error: message }, 400);
    console.error('AERO storage operation failed', error);
    return reply({ error: 'Could not reach demo storage. Your last saved return is safe; retry in a moment.' }, 503);
  }
}
