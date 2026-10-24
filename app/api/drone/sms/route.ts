import { handleSms } from '@/lib/drone-server';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleSms(request);
