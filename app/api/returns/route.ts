import { handle } from '@/lib/server';
import { brokenDemo, unsupported } from '@/lib/http';
export const dynamic = 'force-dynamic';
// A broken demo cookie gets the same 401 and cookie clear as every other route before lib/server.ts resolves the session.
export const GET = (request: Request) => brokenDemo(request) ?? handle(request);
export const POST = (request: Request) => brokenDemo(request) ?? handle(request);
const no = unsupported('GET', 'POST');
export const PUT = no, DELETE = no, PATCH = no, OPTIONS = no;
