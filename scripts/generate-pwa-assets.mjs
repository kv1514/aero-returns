// Generates AirCart's home-screen icons and iPhone splash screens from the brand mark. Usage: npm run pwa:assets
// Writes PNGs into public/ (commit them). sharp is already installed through wrangler/miniflare; nothing is downloaded.
// The splash list must match SPLASH in app/layout.tsx; tests/pwa.test.ts checks every linked file and its pixel size.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const INK = '#000000', BG = '#ffffff';
// The header mark in components/aero-app.tsx (viewBox 0 0 30 30): the ink A with a background-coloured flight line cut through it.
const MARK = `<path d="M2 25 12 4h6l10 21H19L15 14l-5 11Z" fill="${INK}"/><path d="m4 22 20-8" stroke="${BG}" stroke-width="2.5"/>`;
const MARK_BOX = { x: 2, y: 4, w: 26, h: 21 };

const markAt = (cx, cy, width) => { const s = width / MARK_BOX.w; return `<g transform="translate(${cx - (MARK_BOX.x + MARK_BOX.w / 2) * s} ${cy - (MARK_BOX.y + MARK_BOX.h / 2) * s}) scale(${s})">${MARK}</g>`; };
const svg = (w, h, body, view = `0 0 ${w} ${h}`) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${view}"><rect width="100%" height="100%" fill="${BG}"/>${body}</svg>`;

// Square icons: white, opaque, mark centred. Maskable keeps the mark inside the 80% safe circle (diagonal ≈ 0.64 of the canvas).
export const ICONS = [
  { file: 'icons/icon-192.png', size: 192, mark: 0.62 },
  { file: 'icons/icon-512.png', size: 512, mark: 0.62 },
  { file: 'icons/icon-maskable-512.png', size: 512, mark: 0.5 },
  { file: 'apple-touch-icon.png', size: 180, mark: 0.6 },
  { file: 'icons/favicon-32.png', size: 32, mark: 0.84 },
];
// Portrait iPhones as [device-width, device-height, device-pixel-ratio] in CSS points.
/** @type {[number, number, number][]} */
export const SPLASH = [
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [430, 932, 3], // 14 Pro Max, 15 Plus / Pro Max, 16 Plus
  [428, 926, 3], // 12 Pro Max, 13 Pro Max, 14 Plus
  [420, 912, 3], // Air
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [390, 844, 3], // 12, 12 Pro, 13, 13 Pro, 14, 16e
  [375, 812, 3], // X, XS, 11 Pro, 12 mini, 13 mini
  [414, 736, 3], // 6s–8 Plus
  [375, 667, 2], // 6s–8, SE 2nd/3rd gen
  [320, 568, 2], // SE 1st gen
];
/** @param {[number, number, number]} device */
export const splashFile = ([w, h, r]) => `splash/iphone-${w * r}x${h * r}.png`;

// Launch screen in points, rendered at device pixels: the centred mark only (no wordmark), nothing that could read as live status.
function splashSvg([w, h, r]) {
  const markW = 96;
  return svg(w * r, h * r, markAt(w / 2, h / 2, markW), `0 0 ${w} ${h}`);
}

async function png(svgText, path) {
  // Flattened RGB: no alpha channel, so iOS never shows a black or transparent corner behind the icon.
  const buffer = await sharp(Buffer.from(svgText)).flatten({ background: BG }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(new URL(path, publicDir), buffer);
  return buffer.length;
}

const publicDir = new URL('../public/', import.meta.url);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const dir of ['icons', 'splash']) mkdirSync(new URL(dir, publicDir), { recursive: true });
  for (const icon of ICONS) console.log(icon.file, await png(svg(icon.size, icon.size, markAt(icon.size / 2, icon.size / 2, icon.size * icon.mark)), icon.file), 'bytes');
  for (const device of SPLASH) console.log(splashFile(device), await png(splashSvg(device), splashFile(device)), 'bytes');
}
