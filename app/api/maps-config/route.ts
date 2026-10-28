import {env} from 'cloudflare:workers';
import {unsupported} from '@/lib/http';
export const dynamic='force-dynamic';
// This is intentionally a browser-restricted Maps key, never a server API credential.
export function GET(){return Response.json({key:env.GOOGLE_MAPS_BROWSER_KEY||'',mapId:env.GOOGLE_MAPS_MAP_ID||'DEMO_MAP_ID'},{headers:{'Cache-Control':'no-store'}});}
const no=unsupported('GET');
export const POST=no,PUT=no,DELETE=no,PATCH=no,OPTIONS=no;
