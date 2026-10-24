import { env } from 'cloudflare:workers';
import { session } from '@/lib/session';
import { merchantView, scopeOf } from '@/lib/merchant';
export const dynamic = 'force-dynamic';
const LIMIT = 100;
/** Read-only merchant desk over this owner's returns. It never changes a return, approves a refund, or calls a provider. */
export async function GET(request: Request) {
  let identity: Awaited<ReturnType<typeof session>>;
  try { identity = await session(request); } catch { return Response.json({ error: 'Your account session expired or is unavailable. Open Your account in the customer app to sign in again.' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } }); }
  const { owner, cookie } = identity;
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  try {
    const db = env.DB; if (!db) return reply({ error: 'Demo storage is unavailable. Please try again shortly.' }, 503);
    const rows = await db.prepare('SELECT record FROM returns WHERE owner = ? ORDER BY created_at DESC LIMIT ?').bind(owner, LIMIT).all<{ record: string }>();
    const now = Date.now(), records = rows.results.map(row => { try { return JSON.parse(row.record) as unknown; } catch { return null; } });
    return reply({ ...merchantView(records, now), limit: LIMIT, now, scope: scopeOf(owner) });
  } catch (error) {
    console.error('AERO merchant desk failed', error);
    return reply({ error: 'Could not load the returns desk. Your returns are safe; retry in a moment.' }, 503);
  }
}
