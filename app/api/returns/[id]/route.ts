import { handle } from '@/lib/server';
import { brokenDemo, unsupported } from '@/lib/http';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return brokenDemo(request) ?? handle(request, (await context.params).id); }
export async function PATCH(request: Request, context: Context) { return brokenDemo(request) ?? handle(request, (await context.params).id); }
const no = unsupported('GET', 'PATCH');
export const POST = no, PUT = no, DELETE = no, OPTIONS = no;
