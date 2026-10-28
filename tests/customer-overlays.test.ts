import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('app/ride.css', 'utf8'), app = readFileSync('components/aero-app.tsx', 'utf8');

// The map toast is placed by `.ux-stage~.toast`: it must stay a sibling after the map section, or the rules stop matching and it covers the telemetry row again.
test('map toast sits below the telemetry row, not over the Simulated / Live label', () => {
  const stage = app.indexOf('<section className="tracking-canvas ux-stage">'), end = app.indexOf('</section>', stage), toast = app.indexOf('{!shown&&toastView}');
  assert.ok(stage > 0 && end > stage && toast > end, 'toast renders after the ux-stage section');
  assert.match(css, /\.ux-map-chips\{anchor-name:--ux-chips\}/);
  assert.match(css, /\.ux-stage~\.toast\{top:calc\(max\(anchor\(--ux-chips bottom/);
  assert.match(css, /@media\(max-width:760px\)\{\.ux-stage~\.toast\{top:calc\(anchor\(--ux-chips bottom/);
  assert.match(css, /\.ux-stage:is\(:has\(\.ux-sheet\.open\),:has\(\.ux-error\)\)~\.toast\{top:auto;bottom:/);
});

test('pickup guide heading and frame controls use the dialog text tokens', () => {
  assert.match(css, /:is\([^)]*\.pickup-adjust summary[^)]*\)\{color:var\(--m-muted\)!important/);
  assert.match(css, /\.modal \.modal-shell \.pickup-ai h4\{color:var\(--m-ink\)\}/);
});
