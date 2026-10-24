import type { Metadata } from 'next';
import DemoRoom from '@/components/demo-room';
export const metadata: Metadata = { title: 'AERO Judge Room — Cal Hacks 13.0', description: 'Four prize tracks, one return: the demo path, live aggregate evidence and honest gaps for Visa, Anthropic, Microsoft and the hardware tracks.' };
export default function DemoPage() { return <DemoRoom />; }
