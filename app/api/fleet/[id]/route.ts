import { handleFleet } from '@/lib/drone-server';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return handleFleet(request, (await context.params).id); }
export async function PATCH(request: Request, context: Context) { return handleFleet(request, (await context.params).id); }
export async function DELETE(request: Request, context: Context) { return handleFleet(request, (await context.params).id); }
