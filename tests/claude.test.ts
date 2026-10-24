import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICKUP_SCHEMA, REVIEW_SCHEMA, shapePickup, shapeReview } from '../lib/claude';
import { gatePickupDetection } from '../lib/pickup-guide';
import { gateReview } from '../lib/integrations';

test('structured-output schemas require every field and allow no extras', () => {
  for (const schema of [PICKUP_SCHEMA, REVIEW_SCHEMA]) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  }
});
test('pickup answers are clipped to the image and the gate, never rejected for overshoot', () => {
  const ok = gatePickupDetection(shapePickup({ packageCount: 1, hasBox: true, box: { x: .8, y: .7, width: .4, height: .5 }, description: 'x'.repeat(900), concerns: Array(12).fill('c'.repeat(400)) }));
  assert.ok(ok.box); assert.ok(Math.abs(ok.box!.x + ok.box!.width - 1) < 1e-9); assert.ok(Math.abs(ok.box!.y + ok.box!.height - 1) < 1e-9);
  assert.equal(ok.description.length, 500); assert.equal(ok.concerns.length, 8); assert.equal(ok.concerns[0].length, 250);
  assert.equal(gatePickupDetection(shapePickup({ packageCount: 1, hasBox: false, box: { x: 0, y: 0, width: 0, height: 0 }, description: 'Unclear', concerns: [] })).box, null);
  assert.equal(gatePickupDetection(shapePickup({ packageCount: 1, hasBox: true, box: { x: .99, y: .5, width: .3, height: .3 }, description: '', concerns: [] })).box, null, 'a sliver at the edge falls back to manual marking');
  assert.equal(gatePickupDetection(shapePickup({ packageCount: 2, hasBox: true, box: { x: .1, y: .1, width: .2, height: .2 }, description: '', concerns: [] })).box, null, 'two parcels never auto-select one');
});
test('review answers are clamped and low confidence still routes to a person', () => {
  const review = gateReview(shapeReview({ matchesProduct: true, condition: 'like_new', confidence: 1.4, issues: Array(20).fill('i'), fraudFlags: [], recommendation: 'approve', explanation: 'e'.repeat(3000) }));
  assert.equal(review.confidence, 1); assert.equal(review.issues.length, 15); assert.equal(review.recommendation, 'approve');
  assert.equal(gateReview(shapeReview({ matchesProduct: true, condition: 'used', confidence: .5, issues: [], fraudFlags: [], recommendation: 'approve', explanation: 'ok' })).recommendation, 'manual_review');
});
