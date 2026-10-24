import type { Metadata } from 'next';
import DroneControl from '@/components/drone-control';
export const metadata: Metadata = { title: 'AERO Fly — Live drone control', description: 'Connect a drone over 4G and fly it from A to B.' };
export default function Fly() { return <DroneControl />; }
