/** Shared API answers. No Worker bindings, so tests import it directly. */
import { demoMode, demoToken, exitDemoCookie } from './demo-account';

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const;
export type Method = typeof METHODS[number];
/** The Allow header for a route that implements `methods`: HEAD comes with GET and OPTIONS is always answered, sorted like vinext's own. */
export const allowHeader = (methods: Method[]) => [...new Set<Method>([...methods, ...(methods.includes('GET') ? ['HEAD' as const] : []), 'OPTIONS'])].sort().join(', ');
/**
 * Answers every method a route does not implement. vinext sends a bare 405 with no body or Allow header for a method a
 * route.ts does not export, so each route exports this for the rest: OPTIONS gets 204 + Allow, anything else a JSON 405 + Allow.
 */
export function unsupported(...methods: Method[]) {
  const headers = { Allow: allowHeader(methods), 'Cache-Control': 'no-store' };
  return (request: Request) => (request.method === 'OPTIONS' ? new Response(null, { status: 204, headers }) : Response.json({ error: 'Method not allowed.' }, { status: 405, headers }));
}
/**
 * The request body as text, or null once it reaches `limit` bytes. It stops reading there, so a body sent without a
 * Content-Length (chunked) is never buffered whole before it is refused.
 */
export async function readBody(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') || 0) >= limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size >= limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}
export const DEMO_SESSION_INVALID = 'Your demo session was invalid, so AirCart left the demo account. Start it again from Your account.';
export const ACCOUNT_SESSION_EXPIRED = 'Your account session expired or is unavailable. Open Your account to sign in again.';
/** An unresolvable session (invalid demo cookie, expired account) is an explained 401, never an empty 500. Broken demo mode is cleared so the next load starts cleanly. */
export function sessionFailure(request: Request, extra: Record<string, unknown> = {}) {
  const demo = demoMode(request.headers.get('cookie'));
  return Response.json({ ...extra, error: demo ? DEMO_SESSION_INVALID : ACCOUNT_SESSION_EXPIRED, sessionError: true }, { status: 401, headers: { 'Cache-Control': 'private, no-store', ...(demo ? { 'Set-Cookie': exitDemoCookie(request) } : {}) } });
}
/** The demo flag is on but its token is missing or malformed, so session() would throw: the same 401 and cookie clear as every other route. */
export function brokenDemo(request: Request) {
  const cookie = request.headers.get('cookie');
  return demoMode(cookie) && !demoToken(cookie) ? sessionFailure(request) : null;
}
