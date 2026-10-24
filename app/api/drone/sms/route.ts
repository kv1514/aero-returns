import { handleSms } from '@/lib/drone-server';
import { unsupported } from '@/lib/http';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleSms(request);
const no = unsupported('POST');
export const GET = no, HEAD = no, PUT = no, DELETE = no, PATCH = no, OPTIONS = no;
