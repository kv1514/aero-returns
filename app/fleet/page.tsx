import type { Metadata } from 'next';
import FleetConsole from '@/components/fleet-console';
import LiveSyncPanel from '@/components/live-sync-panel';
import './fleet.css';
export const metadata: Metadata = { title: 'AirCart Fleet — live drone console' };
export default function Fleet() { return <><FleetConsole /><LiveSyncPanel /></>; }
