/** Server-only Claude vision calls with structured JSON output. Callers validate the result with their own gates. */
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
export type ClaudeImage = { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };
export class ClaudeUnavailable extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

const box = { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } };
const strings = { type: 'array', items: { type: 'string' } };
/** `hasBox` instead of a nullable box keeps the schema to plain required fields. */
export const PICKUP_SCHEMA = { type: 'object', additionalProperties: false, required: ['packageCount', 'hasBox', 'box', 'description', 'concerns'], properties: { packageCount: { type: 'integer' }, hasBox: { type: 'boolean' }, box, description: { type: 'string' }, concerns: strings } };
export const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, required: ['matchesProduct', 'condition', 'confidence', 'issues', 'fraudFlags', 'recommendation', 'explanation'], properties: { matchesProduct: { type: 'boolean' }, condition: { type: 'string', enum: ['new', 'like_new', 'used', 'damaged'] }, confidence: { type: 'number' }, issues: strings, fraudFlags: strings, recommendation: { type: 'string', enum: ['approve', 'manual_review', 'reject'] }, explanation: { type: 'string' } } };

/** One vision request that must come back as JSON matching `schema`. Refusals and truncation become ClaudeUnavailable. */
export async function claudeJSON(options: { apiKey: string; model: string; system: string; images: ClaudeImage[]; text: string; schema: Record<string, unknown> }): Promise<unknown> {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 1, timeout: 60_000 });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: options.model,
      max_tokens: 16000,
      // A safety decline on the primary model is retried server-side on Anthropic's recommended fallback.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: options.schema } },
      system: options.system,
      messages: [{ role: 'user', content: [...options.images.map(image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } })), { type: 'text' as const, text: options.text }] }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new ClaudeUnavailable('The configured Claude API key was rejected. Check ANTHROPIC_API_KEY.', 503);
    if (error instanceof Anthropic.RateLimitError) throw new ClaudeUnavailable('Claude is busy right now. Try again in a minute.', 429);
    if (error instanceof Anthropic.BadRequestError) throw new ClaudeUnavailable(`Claude could not process this request${/model/i.test(error.message) ? ' with the configured ANTHROPIC_MODEL' : ''}.`, 502);
    if (error instanceof Anthropic.APIError) throw new ClaudeUnavailable(`Claude is unavailable (HTTP ${error.status ?? 'error'}). Try again.`, 502);
    throw new ClaudeUnavailable('Could not reach Claude. Try again.', 502);
  }
  if (response.stop_reason === 'refusal') throw new ClaudeUnavailable('Claude declined to review this photo. Use manual review instead.', 422);
  if (response.stop_reason === 'max_tokens') throw new ClaudeUnavailable('Claude’s answer was cut off. Try again.', 502);
  const text = response.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
  try { return JSON.parse(text); } catch { throw new ClaudeUnavailable('Claude returned an incomplete answer. Try again.', 502); }
}

const clip = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : value);
const clipList = (value: unknown, items: number, max: number) => (Array.isArray(value) ? value.slice(0, items).map(v => clip(v, max)) : value);
/** Trims model text to the gates' limits so a long but valid answer is not rejected outright. */
export function shapePickup(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const b = r.box as Record<string, number> | undefined, n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const x = Math.min(1, Math.max(0, n(b?.x))), y = Math.min(1, Math.max(0, n(b?.y))), width = Math.min(n(b?.width), 1 - x), height = Math.min(n(b?.height), 1 - y);
  // A box that sticks out of the frame is clipped to it; one too small to use falls back to manual marking.
  const box = r.hasBox && width >= .02 && height >= .02 ? { x, y, width, height } : null;
  return { packageCount: r.packageCount, box, description: clip(r.description, 500), concerns: clipList(r.concerns, 8, 250) };
}
export function shapeReview(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const confidence = typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : r.confidence;
  return { ...r, confidence, issues: clipList(r.issues, 15, 500), fraudFlags: clipList(r.fraudFlags, 15, 500), explanation: clip(r.explanation, 2000) };
}
