import { env } from 'cloudflare:workers';
import { session } from '@/lib/session';
import { merchantView, questionEventIds, questionsByEvent, scopeOf, withQuestions } from '@/lib/merchant';
import { sessionFailure, unsupported } from '@/lib/http';
export const dynamic = 'force-dynamic';
const LIMIT = 100;
/** Read-only merchant desk over this owner's returns. It never changes a return, approves a refund, or calls a provider. */
export async function GET(request: Request) {
  let identity: Awaited<ReturnType<typeof session>>;
  try { identity = await session(request); } catch { return sessionFailure(request); }
  const { owner, cookie } = identity;
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  try {
    const db = env.DB; if (!db) return reply({ error: 'Demo storage is unavailable. Please try again shortly.' }, 503);
    const rows = await db.prepare('SELECT record FROM returns WHERE owner = ? ORDER BY created_at DESC LIMIT ?').bind(owner, LIMIT).all<{ record: string }>();
    const now = Date.now(), records = rows.results.map(row => { try { return JSON.parse(row.record) as unknown; } catch { return null; } }), view = merchantView(records, now);
    // Claude's questions for the held returns come from this owner's own completed agent events, never from the browser.
    // They only add context for the reviewer, so a failed read still shows the desk.
    const ids = questionEventIds(view.rows); let events: { id: string; result: string }[] = [];
    if (ids.length) try { events = (await db.prepare(`SELECT id, result FROM integration_events WHERE owner = ? AND kind = 'agent' AND status = 'complete' AND id IN (${ids.map(() => '?').join(', ')})`).bind(owner, ...ids).all<{ id: string; result: string }>()).results; } catch (error) { console.error('AERO merchant desk could not read Claude’s questions', error); }
    return reply({ ...withQuestions(view, questionsByEvent(events)), limit: LIMIT, now, scope: scopeOf(owner) });
  } catch (error) {
    console.error('AERO merchant desk failed', error);
    return reply({ error: 'Could not load the returns desk. Your returns are safe; retry in a moment.' }, 503);
  }
}
const no = unsupported('GET');
export const POST = no, PUT = no, DELETE = no, PATCH = no, OPTIONS = no;
