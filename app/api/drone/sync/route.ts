import { handleDroneSync } from '@/lib/drone-server';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleDroneSync(request);
