import { handleFleet } from '@/lib/drone-server';
import { unsupported } from '@/lib/http';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handleFleet(request);
export const POST = (request: Request) => handleFleet(request);
const no = unsupported('GET', 'POST');
export const PUT = no, DELETE = no, PATCH = no, OPTIONS = no;
