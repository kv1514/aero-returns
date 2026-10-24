import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import DemoRoom from '../components/demo-room';

const html = renderToStaticMarkup(createElement(DemoRoom));
const text = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];

test('the judge room claims only what has happened: no physical drone has flown', () => {
  assert.doesNotMatch(text, /really flies|actually flies|indoor drone/i);
  assert.match(text, /Built for a real drone, pilot in command\./);
  assert.match(text, /the drone link built to fly it \(hardware\)/);
  assert.match(text, /A full mission has run end to end with the bridge’s simulated vehicle; fly SITL before real hardware/);
});

test('team coaching and sponsor research sit in one collapsed section after the judge-facing content', () => {
  const team = html.indexOf('<details class="jr-team" id="team">');
  assert.ok(team > 0, 'collapsed by default');
  assert.ok(html.indexOf('Keep the demo honest.') < team, 'build status stays judge-facing');
  for (const heading of ['YOUR THREE-MINUTE STORY', 'Before you pitch', 'The full opportunity map.', 'Resolve these before submission.']) assert.ok(html.indexOf(heading) > team, `${heading} is inside the team section`);
  assert.match(text, /For the AERO team Pitch script, rehearsal checklist, prize research and open questions\. Not part of the judging\./);
});

test('open questions use readable source names, never raw data keys', () => {
  assert.doesNotMatch(text, /\b(hiveAndDevpost|linkedSponsorBrief|oldSite|currentSite|hive|devpost|sponsor):/);
  assert.match(text, /Hive and Devpost: \$1,500/); assert.match(text, /Linked sponsor brief: Four categories/); assert.match(text, /Old site: live\.calhacks\.io/);
});

test('the judge room links to docs that describe the Cloudflare Worker, not the Sites-era handoff or README', () => {
  assert.doesNotMatch(html, /HANDOFF\.md/);
  assert.match(html, /docs\/DEPLOY\.md/);
  // The README still has Sites-era setup lines, and GitHub shows it at the repo root and for any #anchor on it.
  const links = [...html.matchAll(/href="(https:\/\/github\.com\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(links.length >= 4);
  for (const link of links) assert.match(link, /^https:\/\/github\.com\/kv1514\/aero-returns\/(blob|tree)\/main\/(?!README)/, link);
  assert.match(html, /AGENTS\.md#behavior-contracts/);
  // Only the open track renders, so the other tracks' links are checked in the source: never the bare repo or a README anchor.
  const source = readFileSync(new URL('../components/demo-room.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /href=\{GH\}|\$\{GH\}(?!\/(blob|tree)\/main\/)|README/);
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string) {
  const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)); return .2126 * r + .7152 * g + .0722 * b; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + .05) / (lo + .05);
}
const tokens = (selector: string) => Object.fromEntries([...css.match(new RegExp(`${selector.replace(/[[\]]/g, '\\$&')}\\{([^}]*)\\}`))![1].matchAll(/(--[\w-]+):(#[0-9a-f]{6}|#[0-9a-f]{3})\b/g)].map(([, k, v]) => [k, v.length === 4 ? `#${[...v.slice(1)].map(c => c + c).join('')}` : v]));
test('labels, badges and text tokens are at least 4.5:1 in light and dark, and follow the saved settings', () => {
  const light = tokens('\n.jr'), dark = { ...light, ...tokens('body[data-theme=dark] .jr') };
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    for (const [ink, bg] of [['--ux-ink', '--ux-bg'], ['--ux-muted', '--ux-bg'], ['--ux-muted', '--ux-soft'], ['--jr-good-ink', '--jr-good-bg'], ['--jr-warn-ink', '--jr-warn-bg']]) assert.ok(contrast(t[ink], t[bg]) >= 4.5, `${name} ${ink} on ${bg}: ${contrast(t[ink], t[bg]).toFixed(2)}`);
  }
  assert.match(css, /body\[data-font=true\] \.jr\{--jr-font:var\(--font\);--jr-head:var\(--font\)\}/);
  assert.match(css, /body\[data-contrast=true\] \.jr\{/);
});
test('no judge-room text is smaller than 12 px, and sizes follow the text-size setting', () => {
  const sizes = [...css.matchAll(/font(?:-size)?:(?:\d{3} )?(?:calc\((\d+)px \* var\(--font-scale,1\)\)|(\d+)px)/g)];
  assert.ok(sizes.length > 40);
  for (const [match, scaled, fixed] of sizes) { assert.ok(Number(scaled ?? fixed) >= 12, match); assert.ok(scaled, `${match} ignores --font-scale`); }
  assert.match(css, /\.jr \.ready-label,\.jr \.setup-label,\.jr \.fit-badge\{font-size:calc\(12px \* var\(--font-scale,1\)\)/);
  assert.match(css, /\.jr \.demo-checklist button\{font-size:calc\(14px \* var\(--font-scale,1\)\)/);
});
test('the Claude return check link opens booking directly, and the path names the buttons home shows', () => {
  assert.match(html, /<a class="jr-where" href="\/\?new=1">Booking · Claude return check<\/a>/);
  assert.match(text, /On \/, tap Try a sample return code\./);
  assert.doesNotMatch(text, /tap New return/);
});
