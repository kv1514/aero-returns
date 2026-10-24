import { integrationRequest } from '@/lib/integration-server';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => integrationRequest(request, 'agent');
