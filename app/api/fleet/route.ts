import { handleFleet } from '@/lib/drone-server';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handleFleet(request);
export const POST = (request: Request) => handleFleet(request);
