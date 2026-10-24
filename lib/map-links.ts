import type {Point} from './simulation';
function coordinates(point:Point){
  const [lng,lat]=point;if(!Number.isFinite(lng)||!Number.isFinite(lat)||Math.abs(lng)>180||Math.abs(lat)>90)throw new Error('Invalid map coordinates.');
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}
export function streetViewURL(point:Point){return `https://www.google.com/maps/@?${new URLSearchParams({api:'1',map_action:'pano',viewpoint:coordinates(point)})}`;}
export function earthURL(point:Point){return `https://earth.google.com/web/search/${encodeURIComponent(coordinates(point))}`;}
