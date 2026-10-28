/**
 * Browser-only photo preparation for Claude checks: decode, scale to fit, and re-encode as JPEG.
 * Re-encoding through a canvas also drops EXIF metadata such as GPS location. Nothing here uploads or stores anything.
 */
export type PreparedImage = { mediaType: 'image/jpeg'; data: string; preview: string; width: number; height: number; bytes: number };
export const MAX_SIDE = 1600, MAX_BASE64 = 1_500_000, MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** Largest first; later steps trade detail for size so a busy photo still fits the server's per-image limit. */
const PLAN = [{ side: 1600, quality: .85 }, { side: 1600, quality: .72 }, { side: 1280, quality: .72 }, { side: 1024, quality: .65 }, { side: 800, quality: .6 }];
export function encodePlan(maxSide = MAX_SIDE) { const cap = Math.max(64, Math.round(maxSide)); const plan = PLAN.map(p => ({ ...p, side: Math.min(p.side, cap) })); return plan.filter((p, i) => !plan.slice(0, i).some(q => q.side === p.side && q.quality === p.quality)); }
/** Scales down (never up) so the longer side is at most maxSide, keeping the aspect ratio. */
export function fitWithin(width: number, height: number, maxSide: number) {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
/** Decoded size of a base64 payload (no data: prefix). */
export const base64Bytes = (b64: string) => Math.max(0, Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };
async function decode(file: Blob): Promise<Decoded> {
  // createImageBitmap applies EXIF orientation by default; <img> is the fallback for formats it rejects (e.g. HEIC on Safari).
  if (typeof createImageBitmap === 'function') { try { const bitmap = await createImageBitmap(file); return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }; } catch { /* try <img> */ } }
  const url = URL.createObjectURL(file), img = new Image();
  try { img.src = url; await img.decode(); return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }; }
  catch { URL.revokeObjectURL(url); throw new Error('Could not read that photo. Use a JPG, PNG or WebP image.'); }
}
const NO_CANVAS = 'This browser cannot prepare photos. You can still book without them.';
function draw(source: CanvasImageSource, { width, height }: { width: number; height: number }) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error(NO_CANVAS);
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); // transparent PNGs would otherwise turn black as JPEG
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}
const release = (canvas: HTMLCanvasElement) => { canvas.width = canvas.height = 0; };
/**
 * Returns a JPEG no larger than maxSide on its longer edge and under maxBase64 characters, or throws a user-facing message.
 * The full-size decode is the memory peak (about 4 bytes per pixel). It is drawn once and released straight away; smaller
 * fallbacks are drawn from that first copy. Decoding straight to a smaller size (createImageBitmap's resize options) is not
 * used: it needs the rotated size up front, and a wrong guess about how a browser orders EXIF rotation and resizing
 * squashes rotated phone photos. Sources are capped at 20 MB and at most 3 photos are prepared, one at a time.
 */
export async function resizeImage(file: Blob, { maxSide = MAX_SIDE, maxBase64 = MAX_BASE64 } = {}): Promise<PreparedImage> {
  if (file.type && !file.type.startsWith('image/')) throw new Error('That file is not a photo. Use a JPG, PNG or WebP image.');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose a photo under 20 MB.');
  const plan = encodePlan(maxSide), image = await decode(file);
  let base: HTMLCanvasElement;
  try {
    if (!(image.width > 0 && image.height > 0)) throw new Error('Could not read that photo. Use a JPG, PNG or WebP image.');
    base = draw(image.source, fitWithin(image.width, image.height, plan[0].side));
  } finally { image.close(); }
  try {
    for (const step of plan) {
      const { width, height } = fitWithin(base.width, base.height, step.side);
      const canvas = width === base.width && height === base.height ? base : draw(base, { width, height });
      const preview = canvas.toDataURL('image/jpeg', step.quality);
      if (canvas !== base) release(canvas);
      if (!preview.startsWith('data:image/jpeg;base64,')) throw new Error(NO_CANVAS);
      const data = preview.slice(preview.indexOf(',') + 1);
      if (data.length <= maxBase64) return { mediaType: 'image/jpeg', data, preview, width, height, bytes: base64Bytes(data) };
    }
    throw new Error('That photo is too detailed to send, even after shrinking it. Try another photo.');
  } finally { release(base); }
}
