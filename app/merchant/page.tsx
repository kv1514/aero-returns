import type { Metadata } from 'next';
import MerchantConsole from '@/components/merchant-console';
import './merchant.css';
export const metadata: Metadata = { title: 'AERO Merchant — returns desk' };
export default function Merchant() { return <MerchantConsole />; }
