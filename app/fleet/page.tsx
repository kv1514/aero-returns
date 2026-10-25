import type { Metadata } from 'next';
import FleetConsole from '@/components/fleet-console';
import './fleet.css';
export const metadata: Metadata = { title: 'AirCart Fleet — live drone console' };
export default function Fleet() { return <FleetConsole />; }
