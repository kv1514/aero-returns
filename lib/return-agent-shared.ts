/**
 * Claude return check: shared types, the deterministic drone-limit tool, and the gate that keeps Claude's verdict
 * consistent with the hard limits. Client-safe (no SDK, no secrets); the Claude loop lives in lib/return-agent.ts.
 */
import { z } from 'zod';
import { recommend, type PackageInput } from './simulation';

export const VERDICTS = ['fly_standard', 'fly_priority', 'not_drone_eligible', 'needs_person'] as const;
export const CONDITIONS = ['new', 'like_new', 'used', 'damaged', 'unknown'] as const;
export const DISPOSITIONS = ['restock', 'inspect', 'refurbish', 'return_to_vendor'] as const;
export type Verdict = typeof VERDICTS[number];
export type AgentCheck = { label: string; ok: boolean; detail: string };
export type AgentStep = { tool: string; input: Record<string, unknown>; output: Record<string, unknown> };
export type AgentDecision = { verdict: Verdict; condition: typeof CONDITIONS[number]; matchesDescription: boolean; confidence: number; checks: AgentCheck[]; questions: string[]; disposition: typeof DISPOSITIONS[number]; explanation: string };
/** What a booked return keeps: verified server-side from the stored agent event, never taken from the browser. */
export type ReturnReview = Pick<AgentDecision, 'verdict' | 'condition' | 'disposition' | 'confidence' | 'explanation'> & { eventId: string; at: number; model: string; approvedAt?: number; declinedAt?: number };
export { heldForPerson, HOLD_MESSAGE } from './simulation';
export const VERDICT_LABEL: Record<Verdict, string> = { fly_standard: 'Ready to fly · Standard', fly_priority: 'Ready to fly · Priority', not_drone_eligible: 'Not drone-eligible', needs_person: 'A person needs to check' };
export const DISPOSITION_LABEL: Record<AgentDecision['disposition'], string> = { restock: 'Restock', inspect: 'Inspect first', refurbish: 'Refurbish', return_to_vendor: 'Return to vendor' };

/** Structured-output schema for Claude's final answer. Every field is required and nothing else is allowed. */
export const AGENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'condition', 'matchesDescription', 'confidence', 'checks', 'questions', 'disposition', 'explanation'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] }, condition: { type: 'string', enum: [...CONDITIONS] },
    matchesDescription: { type: 'boolean' }, confidence: { type: 'number' },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'ok', 'detail'], properties: { label: { type: 'string' }, ok: { type: 'boolean' }, detail: { type: 'string' } } } },
    questions: { type: 'array', items: { type: 'string' } }, disposition: { type: 'string', enum: [...DISPOSITIONS] }, explanation: { type: 'string' },
  },
};

export type EligibilityInput = { weightKg: number; dimensionsCm: [number, number, number]; fragile: boolean };
/** The only source of truth for drone limits: the same recommend() the booking uses. Claude calls this as a tool. */
export function checkDroneEligibility(pkg: PackageInput, input: EligibilityInput) {
  const sized = { ...pkg, weight: input.weightKg, dimensions: input.dimensionsCm, fragile: input.fragile };
  const tier = (service: PackageInput['service']) => {
    const ranked = recommend({ ...sized, service }), best = ranked.find(f => !f.reason);
    return { eligible: !!best, reasons: best ? [] : [...new Set(ranked.map(f => f.reason!))], facility: best ? { name: best.name, minutes: best.minutes, price: best.price } : null };
  };
  return { measured: input, limits: { standard: { maxKg: 2.5, maxSideCm: 45 }, priority: { maxKg: 5, maxSideCm: 60 } }, standard: tier('standard'), priority: tier('priority') };
}
export type Eligibility = ReturnType<typeof checkDroneEligibility>;

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : s);
const decisionSchema = z.object({
  verdict: z.enum(VERDICTS), condition: z.enum(CONDITIONS), matchesDescription: z.boolean(), confidence: z.number().finite(),
  checks: z.array(z.object({ label: z.string(), ok: z.boolean(), detail: z.string() })), questions: z.array(z.string()),
  disposition: z.enum(DISPOSITIONS), explanation: z.string(),
});
/**
 * Clamps Claude's answer and enforces the hard rules: the verdict can never fly a package the limit check rejects,
 * and low confidence, a mismatch, or damage always goes to a person.
 */
export function gateDecision(raw: unknown, eligibility: Eligibility): AgentDecision {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = decisionSchema.parse({ ...r, confidence: Math.min(1, Math.max(0, Number(r.confidence))), explanation: clip(r.explanation, 1200), checks: Array.isArray(r.checks) ? r.checks.slice(0, 8).map(c => ({ ...c, label: clip(c?.label, 80), detail: clip(c?.detail, 300) })) : r.checks, questions: Array.isArray(r.questions) ? r.questions.slice(0, 5).map(q => clip(q, 200)) : r.questions });
  const { standard, priority } = eligibility;
  const limit: AgentCheck = { label: 'Drone limits (AERO rules)', ok: standard.eligible || priority.eligible, detail: standard.eligible ? `Fits Standard${standard.facility ? ` · ${standard.facility.name}` : ''}.` : priority.eligible ? `Needs Priority (up to 5 kg, 60 cm per side)${priority.facility ? ` · ${priority.facility.name}` : ''}.` : priority.reasons.join('; ') || 'No compatible facility.' };
  let verdict: Verdict = d.verdict;
  if (!standard.eligible && !priority.eligible) verdict = 'not_drone_eligible';
  else if (verdict === 'fly_standard' && !standard.eligible) verdict = 'fly_priority';
  else if (verdict === 'fly_priority' && !priority.eligible) verdict = standard.eligible ? 'fly_standard' : 'not_drone_eligible';
  else if (verdict === 'not_drone_eligible') verdict = 'needs_person'; // Claude saw a reason the rules did not: a person decides.
  if (verdict !== 'not_drone_eligible' && (d.confidence < .85 || !d.matchesDescription || d.condition === 'damaged' || d.condition === 'unknown')) verdict = 'needs_person';
  return { ...d, verdict, checks: [limit, ...d.checks.filter(c => !/drone limit/i.test(c.label))] };
}
