import { integrationRequest } from '@/lib/integration-server';
export const POST=(request:Request)=>integrationRequest(request,'review');
