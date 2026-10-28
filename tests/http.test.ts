import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_SESSION_EXPIRED, DEMO_SESSION_INVALID, METHODS, allowHeader, brokenDemo, sessionFailure, unsupported, type Method } from '../lib/http';

const at = (method: string, cookie?: string) => new Request('https://aero.example/api/returns', { method, headers: cookie ? { cookie } : {} });
const id = '11111111-1111-4111-8111-111111111111';

test('an unsupported method gets a JSON 405 with an Allow header; OPTIONS gets 204 with the same Allow', async () => {
  const no = unsupported('GET', 'POST');
  const refused = no(at('DELETE'));
  assert.equal(refused.status, 405);
  assert.match(refused.headers.get('content-type') || '', /application\/json/);
  assert.equal(refused.headers.get('allow'), 'GET, HEAD, OPTIONS, POST');
  assert.deepEqual(await refused.json(), { error: 'Method not allowed.' });
  const options = no(at('OPTIONS'));
  assert.equal(options.status, 204); assert.equal(options.headers.get('allow'), 'GET, HEAD, OPTIONS, POST'); assert.equal(await options.text(), '');
  assert.equal(allowHeader(['POST']), 'OPTIONS, POST', 'HEAD only comes with GET');
});

const routes = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? routes(path) : name === 'route.ts' ? [path] : []; });
test('every API route answers every method, and its Allow header lists exactly the methods it implements', () => {
  const files = routes('app/api');
  assert.ok(files.length >= 20, `found ${files.length} routes`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const implemented = [...source.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)\b\s*(?:=|\()(?!\s*no\b)/g)].map(m => m[1] as Method);
    const allowed = source.match(/unsupported\(([^)]*)\)/)?.[1].match(/[A-Z]+/g) ?? [];
    const refused = [...source.matchAll(/\b(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)\s*=\s*no\b/g)].map(m => m[1] as Method);
    assert.deepEqual([...allowed].sort(), [...implemented].sort(), `${file}: unsupported() must list the implemented methods`);
    const covered = new Set<Method>([...implemented, ...refused, ...(implemented.includes('GET') ? ['HEAD' as const] : [])]);
    assert.deepEqual(METHODS.filter(m => !covered.has(m)), [], `${file}: methods left to vinext's bare 405`);
    assert.equal(refused.filter(m => implemented.includes(m)).length, 0, `${file}: a method is both implemented and refused`);
  }
});

test('a broken demo cookie gets one 401 message and is cleared; an expired account gets the account message', async () => {
  for (const cookie of ['aero_demo_active=1; aero_demo_id=bogus', 'aero_demo_active=1']) {
    const response = brokenDemo(at('GET', cookie))!;
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: DEMO_SESSION_INVALID, sessionError: true });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('set-cookie') || '', /^aero_demo_active=;.*Max-Age=0; Secure$/);
  }
  assert.equal(brokenDemo(at('GET', `aero_demo_active=1; aero_demo_id=${id}`)), null, 'a valid demo session goes on to the route');
  assert.equal(brokenDemo(at('GET', 'aero_demo_id=bogus')), null, 'an inactive demo token is not a session');
  assert.equal(brokenDemo(at('GET')), null);
  const expired = sessionFailure(at('GET'), { user: null });
  assert.deepEqual(await expired.json(), { user: null, error: ACCOUNT_SESSION_EXPIRED, sessionError: true });
  assert.equal(expired.headers.get('set-cookie'), null);
});

test('routes that resolve a session answer a failure with the shared sessionFailure, not their own 401 text', () => {
  for (const file of ['lib/drone-server.ts', 'app/api/merchant/route.ts', 'lib/integration-server.ts', 'lib/amazon-server.ts']) assert.match(readFileSync(file, 'utf8'), /catch\s*\{\s*return sessionFailure\(request/, file);
  for (const file of ['app/api/returns/route.ts', 'app/api/returns/[id]/route.ts']) assert.equal(readFileSync(file, 'utf8').match(/brokenDemo\(request\) \?\?/g)?.length, 2, file);
});
