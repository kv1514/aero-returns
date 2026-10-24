import { handleDrones } from '@/lib/drone-server';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handleDrones(request);
export const POST = (request: Request) => handleDrones(request);
