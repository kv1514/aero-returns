import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_SCHEMA, checkDroneEligibility, gateDecision } from '../lib/return-agent-shared';
import { DEMO_PACKAGE } from '../lib/simulation';

const answer = (patch: Record<string, unknown> = {}) => ({ verdict: 'fly_standard', condition: 'like_new', matchesDescription: true, confidence: .93, checks: [{ label: 'Photo matches description', ok: true, detail: 'Headphones in box' }], questions: [], disposition: 'restock', explanation: 'Looks unused.', ...patch });
const small = checkDroneEligibility(DEMO_PACKAGE, { weightKg: 1.2, dimensionsCm: [28, 20, 12], fragile: false });
const heavy = checkDroneEligibility(DEMO_PACKAGE, { weightKg: 4, dimensionsCm: [40, 30, 20], fragile: false });
const huge = checkDroneEligibility(DEMO_PACKAGE, { weightKg: 9, dimensionsCm: [90, 40, 40], fragile: false });

test('the eligibility tool is the booking rule set, per tier', () => {
  assert.equal(small.standard.eligible, true); assert.ok(small.standard.facility);
  assert.equal(heavy.standard.eligible, false); assert.equal(heavy.priority.eligible, true);
  assert.equal(huge.priority.eligible, false); assert.ok(huge.priority.reasons.length > 0);
});
test('structured-output schema requires every field', () => {
  assert.deepEqual([...AGENT_SCHEMA.required].sort(), Object.keys(AGENT_SCHEMA.properties).sort());
  assert.equal(AGENT_SCHEMA.additionalProperties, false);
});
test('Claude can never fly a package the drone limits reject', () => {
  assert.equal(gateDecision(answer(), small).verdict, 'fly_standard');
  assert.equal(gateDecision(answer(), heavy).verdict, 'fly_priority', 'standard is upgraded when only priority fits');
  assert.equal(gateDecision(answer({ verdict: 'fly_priority' }), huge).verdict, 'not_drone_eligible');
  assert.equal(gateDecision(answer({ verdict: 'needs_person' }), huge).verdict, 'not_drone_eligible');
  assert.equal(gateDecision(answer({ verdict: 'not_drone_eligible' }), small).verdict, 'needs_person', 'a model-only refusal goes to a person, not a silent rejection');
});
test('uncertainty, mismatches and damage always go to a person', () => {
  assert.equal(gateDecision(answer({ confidence: .6 }), small).verdict, 'needs_person');
  assert.equal(gateDecision(answer({ matchesDescription: false }), small).verdict, 'needs_person');
  assert.equal(gateDecision(answer({ condition: 'damaged' }), small).verdict, 'needs_person');
  assert.equal(gateDecision(answer({ condition: 'unknown' }), small).verdict, 'needs_person');
});
test('answers are clamped, and the rule check is always the first listed check', () => {
  const d = gateDecision(answer({ confidence: 4, explanation: 'x'.repeat(5000), questions: Array(9).fill('q'), checks: [...Array(12)].map((_, i) => ({ label: i ? `c${i}` : 'Drone limits guess', ok: true, detail: 'd' })) }), small);
  assert.equal(d.confidence, 1); assert.equal(d.explanation.length, 1200); assert.equal(d.questions.length, 5);
  assert.equal(d.checks[0].label, 'Drone limits (AirCart rules)'); assert.ok(!d.checks.slice(1).some(c => /drone limit/i.test(c.label)));
  assert.throws(() => gateDecision({ verdict: 'teleport' }, small));
});
