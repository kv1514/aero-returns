import {env} from 'cloudflare:workers';
export const dynamic='force-dynamic';
// This is intentionally a browser-restricted Maps key, never a server API credential.
export function GET(){return Response.json({key:env.GOOGLE_MAPS_BROWSER_KEY||'',mapId:env.GOOGLE_MAPS_MAP_ID||'DEMO_MAP_ID'},{headers:{'Cache-Control':'no-store'}});}
