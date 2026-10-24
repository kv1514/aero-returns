import type { Metadata } from 'next';
import FleetConsole from '@/components/fleet-console';
export const metadata: Metadata = { title: 'AERO Fleet — live drone console' };
export default function Fleet() { return <FleetConsole />; }
