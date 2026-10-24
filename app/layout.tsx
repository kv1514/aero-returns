import type { Metadata, Viewport } from 'next';
import './globals.css';
import './ride.css';
import './pwa.css';
// Home-screen install: the manifest and PNGs live in public/ and come from `npm run pwa:assets` (scripts/generate-pwa-assets.mjs keeps the same splash list).
// No service worker: AERO never serves a cached page, so tracking and drone telemetry always come from the network.
// Portrait iPhones as [device-width, device-height, device-pixel-ratio]; iOS shows the startup image whose media query matches exactly.
const SPLASH: [number, number, number][] = [[440,956,3],[430,932,3],[428,926,3],[420,912,3],[414,896,3],[414,896,2],[402,874,3],[393,852,3],[390,844,3],[375,812,3],[414,736,3],[375,667,2],[320,568,2]];
export const metadata: Metadata = {
  title: 'AERO — Returns, without the trip.',
  description: 'Your return, a little more effortless. An interactive drone pickup and delivery simulation in Berkeley.',
  applicationName: 'AERO',
  manifest: '/manifest.webmanifest',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' }], apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] },
  // 'default' keeps dark status-bar text on the white app; the map starts below the status bar and pwa.css keeps everything clear of the notch and home indicator.
  appleWebApp: { capable: true, title: 'AERO', statusBarStyle: 'default', startupImage: SPLASH.map(([w, h, r]) => ({ url: `/splash/iphone-${w * r}x${h * r}.png`, media: `screen and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)` })) },
  // vinext emits only the unprefixed mobile-web-app-capable; iOS before 26 needs the apple- prefixed tag to open full screen and use the startup images.
  other: { 'apple-mobile-web-app-capable': 'yes' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // AERO opens light even when the phone is in dark mode (its dark theme is opt-in), so both entries stay white and the status bar or toolbar never shows a black band above the white page.
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#ffffff' }],
};
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
