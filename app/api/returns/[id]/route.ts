import { handle } from '@/lib/server';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return handle(request, (await context.params).id); }
export async function PATCH(request: Request, context: Context) { return handle(request, (await context.params).id); }
