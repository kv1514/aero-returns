import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The root layout imports CSS, which Node cannot load: stub .css modules with an in-thread hook so the real metadata and viewport exports are tested.
// module.registerHooks needs Node 22.15+ and package.json allows 22.13, so on older Node the three tests that read the layout are skipped instead of the whole file failing to load.
const skip = typeof nodeModule.registerHooks === 'function' ? false : 'needs module.registerHooks (Node 22.15+) to load app/layout.tsx';
if (!skip) nodeModule.registerHooks({ load: (url, context, next) => /\.css(\?|$)/.test(url) ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const layout = skip ? undefined : await import('../app/layout');
const { MetadataHead, ViewportHead, mergeMetadata } = await import('vinext/shims/metadata');
// The generator only writes files when run directly, so importing it just reads its device and icon lists.
const { SPLASH, ICONS, splashFile } = await import('../scripts/generate-pwa-assets.mjs');

const publicFile = (url: string) => join('public', url.replace(/^\//, ''));
// Width, height and colour type from the IHDR chunk, plus whether any chunk adds transparency (tRNS).
function png(url: string) {
  const bytes = readFileSync(publicFile(url));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${url} is not a PNG`);
  const chunks: string[] = [];
  for (let at = 8; at < bytes.length; at += 12 + bytes.readUInt32BE(at)) chunks.push(bytes.toString('latin1', at + 4, at + 8));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25], transparent: bytes[25] === 4 || bytes[25] === 6 || chunks.includes('tRNS') };
}
const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
type Icon = { src: string; sizes: string; type: string; purpose?: string };
type Startup = { url: string; media: string };
const startup = layout ? (layout.metadata.appleWebApp as { startupImage: Startup[] }).startupImage : [];

test('manifest has the install fields for iOS and Android', () => {
  assert.equal(manifest.name, 'AirCart — Returns, without the trip.');
  assert.equal(manifest.short_name, 'AirCart');
  for (const key of ['start_url', 'scope', 'id']) assert.equal(manifest[key], '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait');
  assert.equal(manifest.background_color, '#ffffff');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/);
  assert.ok(manifest.description.length > 20);
  assert.ok(Array.isArray(manifest.categories) && manifest.categories.length > 0);
  assert.notEqual(manifest.prefer_related_applications, true);
  for (const shortcut of manifest.shortcuts ?? []) assert.match(shortcut.url, /^\/[a-z]/, 'shortcuts stay inside the scope');
});

test('manifest icons exist at the sizes they claim', () => {
  const icons: Icon[] = manifest.icons;
  const has = (size: number, purpose: string) => icons.some(icon => icon.sizes === `${size}x${size}` && (icon.purpose ?? 'any').split(' ').includes(purpose));
  assert.ok(has(192, 'any') && has(512, 'any') && has(512, 'maskable'));
  for (const icon of icons) {
    assert.equal(icon.type, 'image/png');
    const [width, height] = icon.sizes.split('x').map(Number), image = png(icon.src);
    assert.deepEqual([image.width, image.height], [width, height], icon.src);
    assert.equal(image.transparent, false, `${icon.src} is opaque`);
  }
});

test('apple-touch-icon is 180px with no transparency and the PNG favicon is 32px', () => {
  const apple = png('/apple-touch-icon.png');
  assert.deepEqual([apple.width, apple.height, apple.colorType, apple.transparent], [180, 180, 2, false]);
  const favicon = png('/icons/favicon-32.png');
  assert.deepEqual([favicon.width, favicon.height], [32, 32]);
  for (const icon of ICONS) assert.ok(existsSync(publicFile(icon.file)), `${icon.file} is generated`);
});

test('layout links the manifest, icons and home-screen settings', { skip }, () => {
  const { metadata, viewport } = layout!;
  assert.equal(metadata.manifest, '/manifest.webmanifest');
  const icons = metadata.icons as { icon: { url: string }[]; apple: { url: string; sizes?: string }[] };
  assert.ok(icons.icon.some(icon => icon.url === '/favicon.svg'), 'keeps the SVG favicon');
  assert.ok(icons.icon.some(icon => icon.url === '/icons/favicon-32.png'));
  assert.deepEqual(icons.apple.map(icon => [icon.url, icon.sizes]), [['/apple-touch-icon.png', '180x180']]);
  for (const icon of [...icons.icon, ...icons.apple]) assert.ok(existsSync(publicFile(icon.url)), icon.url);
  const apple = metadata.appleWebApp as { capable: boolean; title: string; statusBarStyle: string };
  assert.deepEqual([apple.capable, apple.title], [true, 'AirCart']);
  assert.ok(['default', 'black', 'black-translucent'].includes(apple.statusBarStyle));
  assert.deepEqual([viewport.width, viewport.initialScale, viewport.viewportFit], ['device-width', 1, 'cover']);
  const theme = viewport.themeColor as { media: string; color: string }[];
  assert.deepEqual(theme.map(entry => entry.media), ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']);
  // The app stays light in system dark mode, so no theme colour may differ from the white page and manifest.
  for (const entry of theme) assert.equal(entry.color, manifest.theme_color, entry.media);
  const source = readFileSync('app/layout.tsx', 'utf8');
  assert.ok(source.indexOf("'./pwa.css'") > source.indexOf("'./ride.css'"), 'pwa.css loads after ride.css');
});

test('every current iPhone gets a portrait splash screen of the exact pixel size', { skip }, () => {
  const sizes = startup.map(image => {
    const [, width, height, ratio] = image.media.match(/^screen and \(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: portrait\)$/)!.map(Number);
    const file = png(image.url);
    assert.deepEqual([file.width, file.height], [width * ratio, height * ratio], image.url);
    return `${file.width}x${file.height}`;
  });
  for (const required of ['1320x2868', '1290x2796', '1206x2622', '1179x2556', '1170x2532', '1125x2436', '1284x2778', '828x1792', '750x1334', '640x1136']) assert.ok(sizes.includes(required), required);
  assert.equal(new Set(startup.map(image => image.media)).size, startup.length, 'no two splash screens share a media query');
  assert.deepEqual(startup.map(image => image.url), SPLASH.map(device => '/' + splashFile(device)), 'layout and generator list the same devices');
});

test('server-rendered head carries the manifest, apple tags and viewport-fit, also on pages with their own metadata', { skip }, () => {
  const merged = mergeMetadata([layout!.metadata as never, { title: 'AirCart Fleet — live drone console' }]);
  const head = renderToStaticMarkup(createElement(MetadataHead, { metadata: merged })) + renderToStaticMarkup(createElement(ViewportHead, { viewport: layout!.viewport as never }));
  for (const tag of ['<link rel="manifest" href="/manifest.webmanifest"/>', '<link rel="apple-touch-icon" href="/apple-touch-icon.png" type="image/png" sizes="180x180"/>', '<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>', '<meta name="apple-mobile-web-app-capable" content="yes"/>', '<meta name="mobile-web-app-capable" content="yes"/>', '<meta name="apple-mobile-web-app-title" content="AirCart"/>', 'name="apple-mobile-web-app-status-bar-style"', 'viewport-fit=cover', '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"/>', '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: dark)"/>']) assert.ok(head.includes(tag), tag);
  assert.equal(head.match(/rel="apple-touch-startup-image"/g)?.length, startup.length);
  assert.ok(head.includes(`<link rel="apple-touch-startup-image" href="/splash/iphone-1179x2556.png" media="${startup.find(image => image.url.endsWith('1179x2556.png'))!.media}"/>`));
  assert.ok(head.includes('<title>AirCart Fleet — live drone console</title>'));
});

// Live tracking and drone telemetry must never come from a cache, so AirCart installs without a service worker.
test('no service worker is registered or shipped', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : /\.(tsx?|jsx?|mjs)$/.test(name) ? [path] : []; });
  assert.deepEqual(['app', 'components', 'lib', 'hooks'].flatMap(files).filter(path => /serviceWorker\s*\.\s*register/.test(readFileSync(path, 'utf8'))), []);
  assert.deepEqual(readdirSync('public').filter(name => /^(sw|service-worker|workbox).*\.js$/.test(name)), []);
});
