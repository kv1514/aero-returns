import { env } from 'cloudflare:workers';
import { integrations } from '@/lib/integration-server';
import { collectEvidence, type Evidence } from '@/lib/evidence';
export const dynamic = 'force-dynamic';
// Anonymous and aggregate-only, so it needs no session and sets no cookie. A short per-isolate memo keeps judge traffic off D1.
const TTL = 30_000;
let memo: { at: number; body: Evidence } | null = null;
export async function GET() {
  const now = Date.now();
  if (!memo || now - memo.at >= TTL) { const { anthropic, apify } = integrations(); memo = { at: now, body: await collectEvidence(env.DB, { anthropic, apify }, now) }; }
  return Response.json(memo.body, { headers: { 'Cache-Control': 'public, max-age=30' } });
}
