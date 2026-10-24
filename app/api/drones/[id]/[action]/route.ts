import { handleDrones } from '@/lib/drone-server';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; action: string }> };
export async function POST(request: Request, context: Context) { const { id, action } = await context.params; return handleDrones(request, id, action); }
