import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createReturn, DEMO_PACKAGE, FACILITIES, recommend, type PackageInput } from '../lib/simulation';
import Booking from '../components/booking';
import type { BookingDraft } from '../lib/booking-draft';

const t0 = Date.UTC(2026, 9, 24, 19, 0);
const html = (step: number, pkg: PackageInput = DEMO_PACKAGE) => renderToStaticMarkup(createElement(Booking, { onBook: async () => {}, busy: false, config: { key: '', mapId: 'DEMO_MAP_ID' }, onConfigure: () => {}, draft: { version: 1, updatedAt: t0, step, package: { ...pkg } } satisfies BookingDraft, onDraftChange: () => {}, now: t0 }));
/** The drop-off section of "Choose a ride": from its heading to the simulated-facilities fine print. */
const dropoff = (page: string) => { const from = page.indexOf('Matched to your return'), to = page.indexOf('All facilities and drone participation are simulated'); assert.ok(from > 0 && to > from, 'drop-off section and its fine print render'); return page.slice(from, to); };
const booked = (pkg: PackageInput) => FACILITIES.find(f => f.id === createReturn(pkg, 'ui', t0).facilityId)!;

test('Choose a ride names the facility the server books, as information and never as a picker', () => {
  for (const pkg of [DEMO_PACKAGE, { ...DEMO_PACKAGE, method: 'label' as const }, { ...DEMO_PACKAGE, service: 'priority' as const }]) {
    const page = html(1, pkg), section = dropoff(page), dest = booked(pkg);
    assert.match(section, new RegExp(`Your return goes to</small><strong>${dest.name}</strong>`), `${pkg.method}/${pkg.service}: names the booked facility`);
    assert.equal(section.split('Your return goes to').length, 2, 'exactly one destination');
    assert.doesNotMatch(section, /<button|<input|role="(radio|checkbox|option)"|aria-(checked|selected|pressed)|tabindex|Recommended/i, 'no selectable affordance');
    assert.match(section, />Simulated</, 'keeps the Simulated label');
    assert.match(section, /Auto-matched/);
    assert.match(section, pkg.method === 'qr' ? /return QR code/ : /prepaid label/);
    assert.match(section, /Not used for this return/);
    for (const f of recommend(pkg).filter(f => f.id !== dest.id)) assert.match(section, new RegExp(`<strong>${f.name}</strong><small>${f.reason ? `Can’t take this return · ${f.reason}` : 'Also compatible'}`), `${f.name} is listed with why it is not used`);
  }
  assert.match(html(1), /All facilities and drone participation are simulated\. These are not retailer or carrier agreements\./);
});

test('ride tiers are a single Tab stop (the chosen tier), with their labels unchanged', () => {
  const rides = html(1).match(/<div class="ride-list"[^]*?<\/div><p class="ride-note"/)![0];
  assert.equal(rides.match(/role="radio"/g)?.length, 2);
  assert.equal(rides.match(/tabindex="0"/g)?.length, 1, 'only the chosen tier is in the Tab order');
  assert.match(rides, /role="radio" aria-checked="true"[^>]*tabindex="0"[^>]*data-service="standard"/);
  assert.match(rides, /AERO Standard/); assert.match(rides, /AERO Priority/); assert.match(rides, /Demo · no charge/);
});

test('Review & request keeps the destination in view and says why Request is still off', () => {
  const page = html(2);
  assert.match(page, new RegExp(`RETURN DESTINATION</small><strong>${booked(DEMO_PACKAGE).name}</strong><em class="review-sub">Auto-matched · lowest estimated cost · simulated</em>`));
  assert.match(page, /<p class="footer-hint" id="review-hint">.*Tick “I’ve reviewed the package details” to request\.<\/p>/);
  assert.match(page, /disabled="" aria-describedby="review-hint"[^>]*>Request AERO Standard/);
  assert.match(page, /I’ve reviewed the package details\./);
  for (const label of ['Your package', 'Choose a ride', 'Review &amp; request', 'Start over', 'Back']) assert.ok(page.includes(label), label);
  assert.match(page, /aria-current="step"[^>]*>.*?Review &amp; request/);
});
