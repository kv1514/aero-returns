export const MAP_CONFIG_KEY='aero:google-maps:v1';
export function normalizeMapConfig(value:unknown):{key:string;mapId:string}{
  if(!value||typeof value!=='object')return {key:'',mapId:'DEMO_MAP_ID'};
  const v=value as Record<string,unknown>;
  return {key:typeof v.key==='string'?v.key.trim():'',mapId:typeof v.mapId==='string'&&v.mapId.trim()?v.mapId.trim():'DEMO_MAP_ID'};
}
