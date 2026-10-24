import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'AERO — Returns, without the trip.',
  description: 'Your return, a little more effortless. An interactive drone pickup and delivery simulation in Berkeley.',
  icons: { icon: '/favicon.svg' },
};
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
