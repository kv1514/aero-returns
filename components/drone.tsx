import { useId } from 'react';
export function DroneIllustration({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const id = useId().replace(/:/g, '');
  return <svg className={className} viewBox="0 0 380 220" fill="none" role="img" aria-label="AERO quadcopter with a secure return package">
    <defs>
      <linearGradient id={`${id}-body`} x1="140" y1="78" x2="230" y2="140" gradientUnits="userSpaceOnUse"><stop stopColor="#fff"/><stop offset=".5" stopColor="#e8eef3"/><stop offset="1" stopColor="#99a7b9"/></linearGradient>
      <linearGradient id={`${id}-arm`} x1="90" y1="65" x2="280" y2="157"><stop stopColor="#d7dfe8"/><stop offset=".5" stopColor="#a6b4c5"/><stop offset="1" stopColor="#46576b"/></linearGradient>
      <linearGradient id={`${id}-box`} x1="176" y1="134" x2="214" y2="188"><stop stopColor="#dcc6a1"/><stop offset="1" stopColor="#9b805b"/></linearGradient>
      <radialGradient id={`${id}-shadow`}><stop stopColor="#253449" stopOpacity=".22"/><stop offset="1" stopColor="#253449" stopOpacity="0"/></radialGradient>
    </defs>
    {!compact && <ellipse cx="195" cy="196" rx="116" ry="16" fill={`url(#${id}-shadow)`}/>}
    <g className="drone-hover">
      <path d="m165 120-18 48 12 6 19-46m42-2 19 43-13 6-18-47" stroke="#5b6c80" strokeWidth="5" strokeLinejoin="round"/>
      <path d="m169 132 36-8 27 17-36 11-27-20Z" fill="#e1cba9"/>
      <path d="m169 132 27 20v34l-27-18v-36Z" fill="#b99a71"/>
      <path d="m196 152 36-11v34l-36 11v-34Z" fill={`url(#${id}-box)`}/>
      <path d="m184 129 29 18v17l-10 3v-18l-29-18" fill="#efddbd"/>
      <path d="m159 104-63-32m75 47-58 27m96-38 68-40m-58 52 61 27" stroke="#556576" strokeWidth="15" strokeLinecap="round"/>
      <path d="m159 100-63-32m75 47-58 27m96-38 68-40m-58 52 61 27" stroke={`url(#${id}-arm)`} strokeWidth="11" strokeLinecap="round"/>
      {[[94,67],[114,142],[281,64],[282,142]].map(([x,y], i) => <g key={i}>
        <ellipse cx={x} cy={y+7} rx="15" ry="7" fill="#26364a"/>
        <path d={`M${x-15} ${y}v7q15 13 30 0v-7`} fill="#36465a"/>
        <ellipse cx={x} cy={y} rx="15" ry="7" fill="#6c7b8c"/>
        <ellipse cx={x} cy={y-3} rx="49" ry="17" stroke="#8d9cae" strokeOpacity=".22" fill="#b6c5d5" fillOpacity=".09"/>
        <g className="rotor" style={{ transformOrigin: `${x}px ${y-4}px` }}>
          <path d={`M${x-3} ${y-5}q-28-16-46-9q-6 6 44 13m5-2q27 16 46 9q6-6-44-13`} fill="#1b2b40" fillOpacity=".85"/>
        </g>
        <ellipse cx={x} cy={y-4} rx="6" ry="4" fill="#dfe7f1"/>
      </g>)}
      <path d="m146 91 23-17 45 4 24 23-6 27-37 11-40-20-9-28Z" fill="#718297"/>
      <path d="m146 87 23-17 45 4 24 23-6 27-37 11-40-20-9-28Z" fill={`url(#${id}-body)`}/>
      <path d="m169 71 45 4 11 12-42 4-21-11 7-9Z" fill="#f7fafc"/>
      <path d="m159 91 26 13 37-8-8 19-28 7-20-12-7-19Z" fill="#1b2c43"/>
      <path d="m171 94 15 6 21-4" stroke="#486a96" strokeWidth="1.5"/>
      <path d="m185 128 17 6 9-3v10l-9 4-17-8v-9Z" fill="#17283f"/>
      <circle cx="200" cy="136" r="3" fill="#397efd"/>
      <path d="m151 105 6 3m68 13 5-2" stroke="#4be3a3" strokeWidth="3" strokeLinecap="round"/>
      <text x="179" y="85" fontSize="8" letterSpacing="2" fontWeight="800" fill="#33445c" transform="rotate(9 179 85)">AERO</text>
    </g>
  </svg>;
}
export const droneMarkerSvg = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="d" x1="0" x2="1" y2="1"><stop stop-color="white"/><stop offset="1" stop-color="#839ab7"/></linearGradient></defs><g stroke="#17273e" stroke-width="6" stroke-linecap="round"><path d="M35 35 22 22M65 35 78 22M35 65 22 78M65 65 78 78"/></g><g fill="#17273e" stroke="#c4d1e2" stroke-width="2"><circle cx="22" cy="22" r="15"/><circle cx="78" cy="22" r="15"/><circle cx="22" cy="78" r="15"/><circle cx="78" cy="78" r="15"/></g><g stroke="white" stroke-opacity=".5" stroke-width="3"><path d="m12 17 20 10m36-10 20 10M12 73l20 10m36-10 20 10"/></g><path d="m36 26 14-5 14 5 4 39-18 13-18-13Z" fill="url(#d)" stroke="#6b82a0"/><path d="m40 31 10-4 10 4-2 16H42Z" fill="#162a43"/><path d="M43 64h14" stroke="#347aff" stroke-width="4" stroke-linecap="round"/></svg>`;
