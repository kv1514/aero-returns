'use client';
import { useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { ArrowUpRight, Check, Clock3, ExternalLink, Plane, Search, Smartphone, Store, TriangleAlert } from 'lucide-react';
import {useMapConfig} from './map-config';
import {useAccessibility} from './accessibility';
import research from '@/data/hackathon-tracks.json';
import { evidenceChip, shareChip, type Evidence, type EvidenceChip } from '@/lib/evidence';

const GH='https://github.com/kv1514/aero-returns';
type TrackId='visa'|'anthropic'|'microsoft'|'hardware';
type Where={label:string;href:string};
type Track={id:TrackId;n:string;sponsor:string;title:string;cards:string[];beat:string;rubric:string;shows:[string,Where][];path:string[];gaps:string[];chips:(e:Evidence)=>EvidenceChip[];flags?:(e:Evidence)=>string[]};
const app={label:'/ · customer app',href:'/'},check={label:'Booking · Claude return check',href:'/?new=1'},merchant={label:'/merchant',href:'/merchant'},fleet={label:'/fleet',href:'/fleet'};
// The shared wording for a needs_person verdict: the booking check says the first, the merchant desk the second.
const PERSON_CUSTOMER='A person will review this return before the drone flies.',PERSON_MERCHANT='Waiting for a person before it flies — inspect on arrival.';
// A drone or mission count can't tell a physical flight from a smoke test or a simulated vehicle, so it never gets the green "recorded" dot.
const unproven=(chip:EvidenceChip):EvidenceChip=>({...chip,recorded:false});
// Copy rules: every claim is something the code does today; outcomes nobody has measured are listed as gaps, never as results.
const TRACKS:Track[]=[
  {id:'visa',n:'01',sponsor:'Visa',title:'Reimagining Shopping',cards:['Visa — Reimagining Shopping'],beat:'Shopping isn’t over until the return is.',rubric:'Innovation 25 · UX 25 · Technical execution 20 · Commerce impact 15 · Trust & responsibility 15 (Visa’s starter pack: UX 20 · Commerce impact 20). Return management tools are one of its example ideas.',
    shows:[['A return booked from home in a ride-hailing style flow: the return QR is read on the device, then a pickup spot, a drone-capacity check, a price estimate, simulated tracking (live telemetry on the drone link) and a receipt.',app],['Claude checks condition and match from a photo and suggests the merchant’s next step: restock, inspect, refurbish or return to vendor.',check],['The merchant desk, a demo view of this browser’s returns, shows each incoming return with Claude’s grade and suggested disposition before the parcel arrives, not as a surprise at the counter.',merchant],['Trust by design: simulation is labelled, no refund, payment or retailer approval is claimed, and photos are never stored.',{label:'AGENTS.md · behavior contracts',href:`${GH}/blob/main/AGENTS.md#behavior-contracts`}]],
    path:['On /, tap Try a sample return code.','Run the Claude return check on one item photo and read its disposition.','Book, switch the simulator to 5× and confirm package loading.','Open /merchant and show the return arriving with its disposition.'],
    gaps:['No payment, Visa API or refund integration. The retrieved rubric doesn’t require one; say so instead of implying it.','Faster restock and fewer store trips are the design goal, not a measured result. No merchant has used AirCart yet.','Hubs, prices and hand-offs are demo configurations, not participating retailers.'],
    chips:e=>[evidenceChip(e.returnsBooked,'return booked','returns booked'),evidenceChip(e.returnsCompleted,'return completed · simulator or drone link','returns completed · simulator or drone link'),evidenceChip(e.returnsWithClaudeCheck,'return booked with a Claude check','returns booked with a Claude check')]},
  {id:'anthropic',n:'02',sponsor:'Anthropic',title:'Claude for Public Benefit',cards:['Anthropic'],beat:'Who it’s for, and what Claude decides.',rubric:'A named, narrow community · a lived or interviewed problem · a working, useful flow · a meaningful Claude role with understood failures',
    shows:[['A tool-use loop: Claude calls check_drone_eligibility (AirCart’s real payload rules) and, when Apify is set up, lookup_product_specs, then answers in a fixed schema with checks, questions and a visible tool log.',check],[`Understood failures: the verdict can never contradict the drone limits, and confidence under 0.85, a mismatch, or damaged or unclear condition always goes to a person: “${PERSON_CUSTOMER}”`,{label:'lib/return-agent-shared.ts',href:`${GH}/blob/main/lib/return-agent-shared.ts`}],['Human in the loop: a return Claude sends to a person stays on the ground, simulated or live, until someone approves it on /merchant; live dispatch from Fleet is blocked until then. The person’s own measurements and AirCart’s rules decide what can fly. Refusals, timeouts and hourly limits show a plain message, and booking with manual details stays open.',{label:'lib/simulation.ts · heldForPerson',href:`${GH}/blob/main/lib/simulation.ts`}],['Built for Berkeley residents with limited mobility, older adults and car-free students: text size, Atkinson Hyperlegible, higher contrast, reduced motion, read-aloud, and a drone that waits as long as loading takes.',app]],
    path:['Say who it’s for and the problem you heard, in one sentence.','Run a clear photo: Ready to fly, with the tool log open.','Run a blurry or mismatched photo: it goes to a person, with its questions.','Book it anyway: the drone stays on the ground until you approve it on /merchant.'],
    gaps:['The community story has to come from the team. Name a person or conversation only if it happened; nothing here records interviews.','A live check needs ANTHROPIC_API_KEY on the Worker. Without it the check shows a setup message and nothing counts as a Claude call.','Claude is advisory: it doesn’t decide refunds, identity, retailer approval or flight safety.'],
    chips:e=>[evidenceChip(e.claudeChecks,'live Claude return check','live Claude return checks'),shareChip(e.claudeNeedsPerson,e.claudeChecks,'Claude checks','sent to a person'),evidenceChip(e.claudePhotoChecks,'live Claude photo check','live Claude photo checks')],
    flags:e=>[e.integrations.anthropic?'Claude API key configured · not proof of a call':'Claude API key not set on this deployment',e.integrations.apify?'Apify product lookup configured':'Apify product lookup not configured']},
  {id:'microsoft',n:'03',sponsor:'Microsoft',title:'Built for the Real World + Customer Impact',cards:['Microsoft — Built for the Real World','Microsoft — Customer Impact Award'],beat:'An agent you could run on Monday.',rubric:'Customer understanding · measurable usefulness · path from prototype to production · responsible design · end-to-end functionality',
    shows:[['End to end: description and photo → Claude’s gated verdict → booking with the verified review attached → simulated or drone-link flight → receipt → merchant desk.',merchant],['Audit trail: every Claude return check is a D1 row that moves from started to complete or failed, with verdict, model and the tools used. Photo checks get a row too, without model or tools. A booking re-checks that the review belongs to the same owner.',{label:'lib/server.ts',href:`${GH}/blob/main/lib/server.ts`}],['Responsible limits: per-owner and shared hourly caps, origin checks, prompts that treat photos and pages as untrusted data, no stored photos, and secrets only on the server.',{label:'lib/integration-server.ts',href:`${GH}/blob/main/lib/integration-server.ts`}],['Production path: a Cloudflare Worker and D1 with owner-scoped, versioned records, CI typecheck, tests and build, and this page’s aggregate-only /api/evidence.',{label:'docs/DEPLOY.md',href:`${GH}/blob/main/docs/DEPLOY.md`}]],
    path:['Run a check and open its tool log and checks.','Show an escalated case and the reason it went to a person.',`Book it with the review attached, then open /merchant: “${PERSON_MERCHANT}” Approve it and the drone takes off.`,'Come back here and point at the live counts.'],
    gaps:['Measurable usefulness needs numbers from real people, such as time or steps saved per return. None have been collected; only the counts on this page are measured.','Customer Impact needs a specific customer story told by the team.','No Microsoft or Azure service is used, and the retrieved rubric names none. Confirm with Microsoft mentors.'],
    chips:e=>[evidenceChip(e.claudeChecks,'live Claude return check','live Claude return checks'),shareChip(e.claudeNeedsPerson,e.claudeChecks,'Claude checks','escalated to a person'),evidenceChip(e.returnsWithClaudeCheck,'booking with a verified review','bookings with a verified review'),evidenceChip(e.returnsCompleted,'return completed · simulator or drone link','returns completed · simulator or drone link')]},
  {id:'hardware',n:'04',sponsor:'Best Hardware Hack',title:'+ Most Technically Complex',cards:['Best Hardware Hack','Most Technically Complex Hack'],beat:'Built for a real drone, pilot in command.',rubric:'No published track criteria. Devpost’s general criteria apply: a working demo (functionality) and engineering depth and sound architecture (technical complexity).',
    shows:[['Operator console: register a drone, set home, pickup and drop pads, arm with the pre-flight checklist, dispatch a booked return, launch every takeoff, abort at any time.',fleet],['Signed link: HMAC-signed, expiring, replay-protected text commands over 4G HTTPS polling or Twilio SMS, with fresh-telemetry, GPS, battery and geofence gates at dispatch.',{label:'docs/DRONE_LINK.md',href:`${GH}/blob/main/docs/DRONE_LINK.md`}],['Python bridge on the companion computer: MAVLink to PX4 or ArduPilot, geofence and 120 m cap checked again on the drone, link-loss failsafe, and a fake vehicle for dry runs.',{label:'bridge/',href:`${GH}/tree/main/bridge`}],['The customer app tracks the live drone from its telemetry. The simulator never becomes a real flight on its own, and no customer action launches the drone.',app]],
    path:['Open /fleet: the drone is connected with fresh telemetry, GPS and battery.','Complete the pre-flight checklist and dispatch the return booked earlier.','Launch the takeoff; the customer confirms loading; launch the next leg.','Show a signed command line and the always-available abort.'],
    gaps:['Judges need to see hardware: a real flight (legal, outdoors, pilot in command) or at least a PX4/ArduPilot SITL run on stage. At the last handoff no physical drone had flown.','Dispatch requires a 3D GPS fix, so an indoor demo needs SITL or a recording of an outdoor flight.','The drone and mission counts can’t tell a physical flight from a scripted smoke test with no vehicle, SITL or the bridge’s simulated vehicle, and the smoke and bridge test scripts add to them too. Say which one you flew.'],
    chips:e=>[evidenceChip(e.dronesRegistered,'drone registered in Fleet','drones registered in Fleet'),evidenceChip(e.liveFlightsCompleted,'drone-link mission completed','drone-link missions completed')].map(unproven),
    flags:()=>['Counts include scripted smoke tests with no vehicle, SITL and the bridge’s simulated vehicle. None of these is a physical flight.']},
];
const SCRIPT:[string,string,string[],string][]=[
  ['0:00–0:35','The person',['Anthropic','Microsoft'],'Name the community: Berkeley residents with limited mobility, older adults and car-free students. Describe what a return costs them today in their words: the trip, the ride, waiting for help. Use a story the team actually heard; if nobody was interviewed, call it the problem you’re designing for.'],
  ['0:35–1:15','The Claude check',['Anthropic','Microsoft','Visa'],'In booking, describe the item and add a photo. Run the Claude return check and open its tool log: Claude calls AirCart’s drone-limit tool before it decides. Then show one case it hands to a person, and that the person can still book with their own details.'],
  ['1:15–2:05','Book and fly',['Hardware','Visa'],'Book, and say whether this flight is the simulator or the drone link. Simulator: 5×, follow the drone, confirm loading, because it waits for you. Hardware: dispatch from /fleet, the operator launches each takeoff, and abort is always one tap away.'],
  ['2:05–2:35','The merchant receives',['Visa','Microsoft'],`Open /merchant: the return arrives with Claude’s condition and suggested disposition, so the merchant can plan to restock or inspect before the parcel lands. One sent to a person reads “${PERSON_MERCHANT}” Approve it, and only then does its drone take off. Don’t quote restock-time savings you haven’t measured.`],
  ['2:35–3:00','Built to be trusted',['Microsoft','Hardware'],'Close on architecture and safety: Worker and D1, owner-scoped records, an audit row for every Claude call, hourly caps, and signed, expiring 4G/SMS commands with the geofence and 120 m cap checked twice. End on what is live and what is simulated, using this page’s counts.'],
];
const ITEMS=['Rehearse the community story the team actually heard (no invented interviews)','Run one live Claude return check, and one that goes to a person','Book with the check attached and show it in /merchant','Fly the return through /fleet: SITL or the real drone, pilot in command','Run the custom Apify Actor on a public product page (optional)','Show phone layout and one accessibility preference','Record a three-minute demo video','Confirm sponsor entry checkboxes and any separate submission forms'];
const prize=(name:string)=>research.tracks.find(t=>t.name===name);
// Readable names for the research file's source keys, never raw camelCase such as "linkedSponsorBrief".
const SOURCE_LABEL:Record<string,string>={hive:'Hive',devpost:'Devpost',sponsor:'Sponsor',hiveAndDevpost:'Hive and Devpost',linkedSponsorBrief:'Linked sponsor brief',oldSite:'Old site',currentSite:'Current site'};
const sourceLabel=(key:string)=>SOURCE_LABEL[key]??key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
// The hardware track is an outdoor GPS drone (dispatch needs a 3D fix) or SITL indoors; an older research note said "indoor drone".
const HARDWARE_NOTE='Strong only if the drone link is shown flying a real outdoor drone (pilot in command) or a PX4/ArduPilot SITL run; map simulation alone does not demonstrate hardware.';
const trackNote=(t:{name:string;notes:string})=>t.name==='Best Hardware Hack'&&/\bindoor\b/i.test(t.notes)?HARDWARE_NOTE:t.notes;

// Small external stores, so reading the URL hash and saved checklist never calls setState inside an effect.
const KEY='aero:demo-checklist',hashListeners=new Set<()=>void>(),listListeners=new Set<()=>void>();let memoryList='[]';
const subscribe=(set:Set<()=>void>,event:string)=>(cb:()=>void)=>{set.add(cb);window.addEventListener(event,cb);return()=>{set.delete(cb);window.removeEventListener(event,cb);};};
const subscribeHash=subscribe(hashListeners,'hashchange'),subscribeList=subscribe(listListeners,'storage');
const readList=()=>{try{return localStorage.getItem(KEY)??memoryList;}catch{return memoryList;}};
function writeList(next:string[]){memoryList=JSON.stringify(next);try{localStorage.setItem(KEY,memoryList);}catch{}listListeners.forEach(l=>l());}
function selectTrack(id:TrackId){try{history.replaceState(history.state,'',`#${id}`);}catch{}hashListeners.forEach(l=>l());}

const CSS=`
.jr{--ux-bg:#fff;--ux-ink:#000;--ux-muted:#5e5e5e;--ux-line:#e8e8e8;--ux-soft:#f3f3f3;--ux-green:#06c167;--ux-red:#e11900;--ux-amber:#ffc043;--ux-blue:#276ef1;--jr-good-bg:#e3f8ec;--jr-good-ink:#03582b;--jr-warn-bg:#fff4d6;--jr-warn-ink:#6b4e00;--jr-font:'Inter',var(--font);--jr-head:'Inter Tight','Inter',var(--font);font-family:var(--jr-font)}
/* The saved appearance settings, as on /merchant and /fleet (useAccessibility sets these body attributes). */
body[data-theme=dark] .jr{--ux-bg:#141414;--ux-ink:#f6f6f6;--ux-muted:#a6a6a6;--ux-line:#2c2c2c;--ux-soft:#222;--jr-good-bg:#0e3220;--jr-good-ink:#86e3b2;--jr-warn-bg:#3a2c08;--jr-warn-ink:#ffd680}
body[data-contrast=true] .jr{--ux-muted:#2f2f2f;--ux-line:#8a8a8a}
body[data-theme=dark][data-contrast=true] .jr{--ux-muted:#d9d9d9}
body[data-font=true] .jr{--jr-font:var(--font);--jr-head:var(--font)}
.jr h1,.jr h2,.jr h3{font-family:var(--jr-head)}
/* Outranks the legacy dark heading colour in globals.css. */
.jr :is(h1,h2,h3),body[data-theme] .jr :is(h1,h2,h3){color:var(--ux-ink)}
body[data-theme] .jr h4{color:var(--ux-muted)}
.jr a:focus-visible,.jr button:focus-visible{outline:3px solid var(--ux-blue);outline-offset:2px}
.jr .demo-room-nav>.brand{color:var(--ux-ink);font:800 calc(20px * var(--font-scale,1))/1 var(--jr-head);letter-spacing:.12em}
.jr-nav{margin-left:auto;display:flex;gap:6px}
.jr-nav a{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 12px;border-radius:18px;font-size:calc(13px * var(--font-scale,1));font-weight:600;color:var(--ux-ink);text-decoration:none;border:1px solid var(--ux-line);background:var(--ux-bg)}
.jr-nav a:hover,.jr-btn:hover{opacity:.85}
.jr .demo-room-hero h1,.jr h2{color:var(--ux-ink)}
.jr .demo-script time{min-width:72px}
.jr-cta{display:flex;flex-wrap:wrap;gap:10px}
.jr-btn{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 18px;border-radius:12px;font-weight:600;font-size:calc(14px * var(--font-scale,1));text-decoration:none;background:var(--ux-bg);color:var(--ux-ink);border:1px solid var(--ux-line)}
.jr-btn.dark{background:var(--ux-ink);color:var(--ux-bg);border-color:var(--ux-ink)}
.jr-intro{font-size:calc(14px * var(--font-scale,1));line-height:1.65;color:var(--ux-muted);max-width:760px;margin:-8px 0 22px}
.jr-intro code,.jr-note code{font-size:.92em;background:var(--ux-soft);padding:1px 5px;border-radius:5px;color:var(--ux-ink)}
.jr-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:14px}
.jr-tab{position:relative;text-align:left;background:var(--ux-bg);border:1px solid var(--ux-line);border-radius:16px;padding:16px;cursor:pointer;display:flex;flex-direction:column;gap:7px;color:var(--ux-ink);font:inherit}
.jr-tab:not(:last-child)::after{content:'';position:absolute;right:-11px;top:50%;width:6px;height:6px;border-top:2px solid var(--ux-muted);border-right:2px solid var(--ux-muted);transform:translateY(-50%) rotate(45deg)}
.jr-tab[aria-selected=true]{border-color:var(--ux-ink);box-shadow:0 0 0 1px var(--ux-ink)}
.jr-tab small{font-size:calc(12px * var(--font-scale,1));font-weight:700;letter-spacing:.08em;color:var(--ux-muted)}
.jr-tab strong{font:700 calc(17px * var(--font-scale,1))/1.2 var(--jr-head);letter-spacing:-.01em}
.jr-tab>span{font-size:calc(13px * var(--font-scale,1));line-height:1.45;color:var(--ux-muted)}
.jr-tab .jr-chip{align-self:flex-start;margin-top:auto}
.jr-panel{background:var(--ux-bg);border:1px solid var(--ux-line);border-radius:16px;padding:28px}
.jr-panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:24px}
.jr-panel-head h3{font:700 calc(26px * var(--font-scale,1))/1.15 var(--jr-head);letter-spacing:-.02em;margin:6px 0 10px;color:var(--ux-ink)}
.jr-eyebrow{font-size:calc(12px * var(--font-scale,1));font-weight:700;letter-spacing:.1em;color:var(--ux-muted);text-transform:uppercase}
.jr-rubric{font-size:calc(14px * var(--font-scale,1));line-height:1.55;color:var(--ux-ink)}
.jr-rubric b{font-weight:600;color:var(--ux-muted);margin-right:6px}
.jr-prizes{display:flex;flex-direction:column;gap:6px;min-width:220px;max-width:280px}
.jr-prizes a{font-size:calc(12px * var(--font-scale,1));line-height:1.45;color:var(--ux-muted);text-decoration:none;display:flex;gap:5px;align-items:flex-start}
.jr-prizes a b{color:var(--ux-ink);font-weight:600}
.jr-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:32px}
.jr h4{font-size:calc(12px * var(--font-scale,1));font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ux-muted);margin:0 0 14px}

.jr-shows,.jr-path,.jr-gaps{list-style:none;padding:0;margin:0;display:grid;gap:14px}
.jr-shows li{display:grid;gap:6px;font-size:calc(14px * var(--font-scale,1));line-height:1.55;color:var(--ux-ink)}
.jr-where{justify-self:start;font-size:calc(12px * var(--font-scale,1));font-weight:600;color:var(--ux-ink);background:var(--ux-soft);border-radius:6px;padding:3px 8px;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.jr-path{counter-reset:step;gap:12px}
.jr-path li{counter-increment:step;display:flex;gap:12px;font-size:calc(14px * var(--font-scale,1));line-height:1.55;color:var(--ux-ink)}
.jr-path li::before{content:counter(step);flex:0 0 24px;height:24px;border-radius:50%;background:var(--ux-ink);color:var(--ux-bg);font-size:calc(12px * var(--font-scale,1));font-weight:700;line-height:24px;text-align:center;margin-top:-1px}
.jr-foot{display:grid;grid-template-columns:1.3fr 1fr;gap:32px;margin-top:26px;padding-top:22px;border-top:1px solid var(--ux-line)}
.jr-chips{display:flex;flex-wrap:wrap;gap:8px}
.jr-chip{display:inline-flex;align-items:center;gap:7px;min-height:30px;padding:4px 12px;border-radius:15px;font-size:calc(13px * var(--font-scale,1));font-weight:600;line-height:1.3;background:var(--ux-soft);color:var(--ux-muted)}
.jr-chip.on{background:var(--jr-good-bg);color:var(--jr-good-ink)}
.jr-chip.on::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--ux-green);flex-shrink:0}
.jr-chip.flag{background:none;border:1px dashed var(--ux-muted);font-weight:500}
.jr-gaps{gap:10px}
.jr-gaps li{border-left:3px solid var(--ux-amber);padding-left:12px;font-size:calc(14px * var(--font-scale,1));line-height:1.55;color:var(--ux-ink)}
.jr-note{font-size:calc(12px * var(--font-scale,1));line-height:1.6;color:var(--ux-muted);margin-top:14px}
.jr-note a{color:var(--ux-ink)}
.jr-tags{display:flex;flex-wrap:wrap;gap:6px;margin:-2px 0 8px}
.jr-tags span{font-size:calc(12px * var(--font-scale,1));font-weight:600;padding:3px 8px;border-radius:10px;background:var(--ux-soft);color:var(--ux-ink)}
/* The page below the track panel still uses the older .demo-room rules in globals.css (8–11 px, ~2.5:1). Restyled here with the same tokens: at least 12 px, scaled by the text-size setting, and 4.5:1 or better in both themes. */
.jr.demo-room{background:var(--ux-soft);color:var(--ux-ink)}
.jr .demo-room-nav{background:var(--ux-bg);border-bottom-color:var(--ux-line)}
.jr .demo-room-nav>span{font-size:calc(12px * var(--font-scale,1));font-weight:700;letter-spacing:.14em;color:var(--ux-muted);border-left-color:var(--ux-line)}
.jr .eyebrow,.jr .demo-section-heading .eyebrow{font-size:calc(12px * var(--font-scale,1));font-weight:700;letter-spacing:.12em;color:var(--ux-muted)}
.jr .demo-room-hero p{font-size:calc(15px * var(--font-scale,1));line-height:1.65;color:var(--ux-muted)}
.jr .demo-room-hero aside{background:var(--ux-bg);border-color:var(--ux-line);color:var(--ux-ink)}
.jr .demo-room-hero aside>span{font-size:calc(12px * var(--font-scale,1));font-weight:700;letter-spacing:.12em;color:var(--ux-muted)}
.jr .demo-room-hero aside>strong{font-family:var(--jr-head);color:var(--ux-ink)}
.jr .demo-room-hero aside>p{font-size:calc(13px * var(--font-scale,1));line-height:1.6;color:var(--ux-muted)}
.jr .demo-room-hero aside>a,.jr .demo-table-intro a,.jr footer a{color:var(--ux-ink);font-size:calc(13px * var(--font-scale,1));font-weight:600}
.jr .demo-section{border-top-color:var(--ux-line)}
.jr .demo-section-heading>span{font-size:calc(13px * var(--font-scale,1));color:var(--ux-muted)}
.jr .readiness-grid>article,.jr .conflict-grid>article{background:var(--ux-bg);border-color:var(--ux-line)}
.jr .readiness-grid p,.jr .conflict-grid p{font-size:calc(14px * var(--font-scale,1));line-height:1.6;color:var(--ux-muted)}
.jr .readiness-grid article>a{color:var(--ux-ink);font-weight:600}
.jr .ready-label,.jr .setup-label,.jr .fit-badge{font-size:calc(12px * var(--font-scale,1));font-weight:600;line-height:1.3;padding:4px 10px;border-radius:12px}
.jr .ready-label,.jr .fit-badge.strong{background:var(--jr-good-bg);color:var(--jr-good-ink)}
.jr .setup-label,.jr .fit-badge.stretch{background:var(--jr-warn-bg);color:var(--jr-warn-ink)}
.jr .fit-badge{background:var(--ux-soft);color:var(--ux-muted)}
.jr .demo-script>div>p,.jr .demo-script li p{font-size:calc(14px * var(--font-scale,1));line-height:1.6;color:var(--ux-muted)}
.jr .demo-script time{font-size:calc(12px * var(--font-scale,1));font-weight:600;color:var(--ux-muted)}
.jr .demo-script li h3{font-size:calc(16px * var(--font-scale,1))}
.jr .demo-checklist button{font-size:calc(14px * var(--font-scale,1));line-height:1.45;color:var(--ux-ink);background:var(--ux-bg);border-color:var(--ux-line);min-height:48px}
.jr .demo-checklist button>span{border-color:var(--ux-muted)}
.jr .demo-checklist button.checked{color:var(--ux-ink)}.jr .demo-checklist button.checked>span{background:var(--ux-ink);border-color:var(--ux-ink);color:var(--ux-bg)}
.jr .demo-table-intro,.jr .demo-footnote,.jr .empty-tracks{font-size:calc(14px * var(--font-scale,1));color:var(--ux-muted)}
.jr .track-filters>div,.jr .track-filters select{background:var(--ux-bg);border-color:var(--ux-line);color:var(--ux-muted)}
.jr .track-filters input,.jr .track-filters select{font-size:calc(14px * var(--font-scale,1));color:var(--ux-ink);min-height:44px}
.jr .track-filters input::placeholder{color:var(--ux-muted)}
.jr .track-table{background:var(--ux-bg);border-color:var(--ux-line)}
.jr .track-table th{font-size:calc(12px * var(--font-scale,1));font-weight:600;color:var(--ux-muted);background:var(--ux-soft)}
.jr .track-table td{border-top-color:var(--ux-line);font-size:calc(14px * var(--font-scale,1));color:var(--ux-ink)}
.jr .track-table td>a{font-size:calc(14px * var(--font-scale,1));color:var(--ux-ink)}
.jr .track-table td>span:not(.fit-badge),.jr .track-table td>small,.jr .track-table td p{font-size:calc(13px * var(--font-scale,1));color:var(--ux-muted)}
.jr .track-table td>small{font-size:calc(12px * var(--font-scale,1));font-weight:600;letter-spacing:.08em}
.jr .track-table td:last-child{width:100px}
.jr .conflict-grid h3{font-size:calc(16px * var(--font-scale,1))}
.jr .conflict-grid strong{font-size:calc(14px * var(--font-scale,1));font-weight:600;color:var(--ux-ink)}
.jr footer{border-top-color:var(--ux-line);color:var(--ux-muted);font-size:calc(13px * var(--font-scale,1))}
.jr :is(summary,input,select):focus-visible{outline:3px solid var(--ux-blue);outline-offset:2px}
.jr-team{margin:8px 0 32px}
.jr-team>summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;background:var(--ux-bg);border:1px dashed var(--ux-muted);border-radius:16px}
.jr-team>summary::-webkit-details-marker{display:none}
.jr-team>summary>span{display:grid;gap:4px}
.jr-team>summary strong{font:700 calc(18px * var(--font-scale,1))/1.25 var(--jr-head);color:var(--ux-ink)}
.jr-team>summary>span>span{font-size:calc(14px * var(--font-scale,1));line-height:1.5;color:var(--ux-muted)}
.jr-team>summary::after{content:'Show';flex:none;font-size:calc(13px * var(--font-scale,1));font-weight:600;color:var(--ux-ink);border:1px solid var(--ux-line);border-radius:16px;padding:6px 12px}
.jr-team[open]>summary::after{content:'Hide'}
.jr-team>.demo-section:first-of-type{border-top:0}
@media(max-width:1000px){.jr-tabs{grid-template-columns:repeat(2,1fr)}.jr-tab::after{display:none}.jr-grid,.jr-foot{grid-template-columns:1fr;gap:26px}}
@media(max-width:760px){.jr-nav a{font-size:0;gap:0;width:36px;padding:0;justify-content:center}.jr-nav a svg{width:17px;height:17px}.jr-tabs{gap:10px}.jr-tab{padding:14px}.jr-panel{padding:20px}.jr-panel-head{flex-direction:column;gap:14px}.jr-prizes{max-width:none}.jr-panel-head h3{font-size:calc(22px * var(--font-scale,1))}.jr-cta .jr-btn{flex:1 1 100%;justify-content:center}.jr .demo-script li{flex-direction:column;gap:6px}}
@media(max-width:420px){.jr .demo-room-nav>span{display:none}}
`;

function WhereLink({where}:{where:Where}){return where.href.startsWith('/')?<a className="jr-where" href={where.href}>{where.label}</a>:<a className="jr-where" href={where.href} target="_blank" rel="noreferrer">{where.label}<ArrowUpRight size={12}/></a>;}
function Chip({chip}:{chip:EvidenceChip}){return <span className={`jr-chip${chip.recorded?' on':''}`}>{chip.text}</span>;}

export default function DemoRoom(){
  useAccessibility();
  const maps=useMapConfig();
  const [group,setGroup]=useState('All'),[fit,setFit]=useState('All'),[search,setSearch]=useState(''),[integration,setIntegration]=useState<{anthropic:boolean;apify:boolean;googleMaps?:boolean;amazon?:boolean;verified?:{anthropic:number;apify:number}}|null>(null);
  const [evidence,setEvidence]=useState<Evidence|null>(null),[evidenceFailed,setEvidenceFailed]=useState(false);
  const hash=useSyncExternalStore(subscribeHash,()=>window.location.hash,()=>''),rawList=useSyncExternalStore(subscribeList,readList,()=>'[]');
  const checklist=useMemo(()=>{try{const saved=JSON.parse(rawList);return Array.isArray(saved)?saved.filter((v:unknown):v is string=>typeof v==='string'):[];}catch{return [];}},[rawList]);
  const active=TRACKS.find(t=>`#${t.id}`===hash)??TRACKS[0];
  useEffect(()=>{fetch('/api/integrations').then(r=>{if(!r.ok&&r.status!==401)throw new Error('Integration status unavailable.');return r.json() as Promise<{anthropic:boolean;apify:boolean;googleMaps?:boolean;amazon?:boolean;verified?:{anthropic:number;apify:number}}>;}).then(setIntegration).catch(()=>{});
    // A shared link such as /demo#hardware opens on that track.
    if(TRACKS.some(t=>`#${t.id}`===window.location.hash))document.getElementById('tracks')?.scrollIntoView();},[]);
  useEffect(()=>{let live=true;const load=()=>{if(document.visibilityState==='hidden')return;fetch('/api/evidence').then(r=>{if(!r.ok)throw new Error('Evidence unavailable.');return r.json() as Promise<Evidence>;}).then(e=>{if(live){setEvidence(e);setEvidenceFailed(false);}}).catch(()=>{if(live)setEvidenceFailed(true);});};
    load();const timer=window.setInterval(load,30_000);document.addEventListener('visibilitychange',load);return()=>{live=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',load);};},[]);
  const tracks=research.tracks.filter(t=>(group==='All'||t.group===group.toLowerCase())&&(fit==='All'||t.fit===fit.toLowerCase())&&`${t.name} ${t.requirement}`.toLowerCase().includes(search.toLowerCase()));
  function toggle(item:string){writeList(checklist.includes(item)?checklist.filter(i=>i!==item):[...checklist,item]);}
  function tabKey(e:KeyboardEvent<HTMLDivElement>){const i=TRACKS.indexOf(active),n=TRACKS.length,next=e.key==='ArrowRight'?(i+1)%n:e.key==='ArrowLeft'?(i+n-1)%n:e.key==='Home'?0:e.key==='End'?n-1:-1;if(next<0)return;e.preventDefault();selectTrack(TRACKS[next].id);document.getElementById(`jr-tab-${TRACKS[next].id}`)?.focus();}
  const pending:EvidenceChip={text:evidenceFailed?'Live counts unavailable right now':'Loading live counts…',recorded:false};
  const chipsFor=(t:Track)=>evidence?t.chips(evidence):[pending];
  // /api/integrations counts this session's own completed Claude calls; /api/evidence counts every completed return and photo check on the deployment.
  const mine=integration?.verified?.anthropic||0,claudeCalls=evidence?(evidence.claudeChecks??0)+(evidence.claudePhotoChecks??0):0,claudeLive=mine>0||claudeCalls>0;
  const claudeNote=[claudeCalls>0&&`${claudeCalls.toLocaleString('en-US')} completed Claude call${claudeCalls===1?'':'s'} on this deployment: return and photo checks from every account, team testing included.`,mine>0&&`${mine} live Claude call${mine===1?'':'s'} recorded for this session.`].filter(Boolean).join(' ');
  return <main className="demo-room jr"><style>{CSS}</style><header className="demo-room-nav"><a href="/" className="brand">AirCart</a><span>THE JUDGE ROOM</span><nav className="jr-nav" aria-label="Open the app"><a href="/" title="Customer app"><Smartphone size={15}/>Customer app</a><a href="/merchant" title="Merchant desk"><Store size={15}/>Merchant desk</a><a href="/fleet" title="Fleet console"><Plane size={15}/>Fleet console</a></nav></header><div className="demo-room-inner"><div className="demo-room-hero"><div><span className="eyebrow">CAL HACKS 13.0 · OCTOBER 23–25, 2026</span><h1>Four tracks,<br/>one story.</h1><p>AirCart is for Berkeley residents who find getting to a return drop-off hard: people with limited mobility, older adults and car-free students. One return carries the whole demo. Claude checks it, a drone collects it, and the merchant sees what’s coming back. Everything here is labelled simulated, configured or live, and no interview, metric or sponsor eligibility is claimed.</p><div className="jr-cta"><a href="/" className="jr-btn dark"><Smartphone size={16}/>Open the customer app</a><a href="/merchant" className="jr-btn"><Store size={16}/>Merchant desk</a><a href="/fleet" className="jr-btn"><Plane size={16}/>Fleet console</a></div></div><aside><Clock3 size={23}/><span>SUBMISSION DEADLINE</span><strong>Sunday, October 25<br/>9:00 a.m. Pacific</strong><p>Official listing asks hackers to arrive by 8 a.m. Three-minute presentation, then two minutes of questions.</p><a href={research.officialDevpost} target="_blank" rel="noreferrer">Official event rules<ArrowUpRight size={14}/></a></aside></div>
    <section className="demo-section jr-tracks" id="tracks" aria-labelledby="jr-tracks-title"><div className="demo-section-heading"><div><span className="eyebrow">FOUR TRACKS, ONE STORY</span><h2 id="jr-tracks-title">Pick your track. It’s the same return.</h2></div><span>Live counts from /api/evidence</span></div>
      <p className="jr-intro">Each track picks up where the last one ends: the shopping problem (Visa), who it’s for and what Claude decides (Anthropic), the agent in production (Microsoft), and the drone link built to fly it (hardware). Send a judge straight to theirs with <code>/demo#visa</code>, <code>#anthropic</code>, <code>#microsoft</code> or <code>#hardware</code>.</p>
      <div className="jr-tabs" role="tablist" aria-label="Prize tracks" onKeyDown={tabKey}>{TRACKS.map(t=>{const selected=t.id===active.id;return <button key={t.id} id={`jr-tab-${t.id}`} role="tab" type="button" className="jr-tab" aria-selected={selected} aria-controls="jr-panel" tabIndex={selected?0:-1} onClick={()=>selectTrack(t.id)}><small>{t.n} · {t.sponsor.toUpperCase()}</small><strong>{t.beat}</strong><span>{t.title}</span><Chip chip={chipsFor(t)[0]}/></button>;})}</div>
      <div className="jr-panel" role="tabpanel" id="jr-panel" aria-labelledby={`jr-tab-${active.id}`}>
        <div className="jr-panel-head"><div><span className="jr-eyebrow">{active.n} · {active.sponsor} · {active.title}</span><h3>{active.beat}</h3><p className="jr-rubric"><b>{active.id==='visa'?'Rubric':'Asks for'}</b>{active.rubric}</p></div><div className="jr-prizes">{active.cards.map(name=>{const card=prize(name);return card&&<a key={name} href={card.source} target="_blank" rel="noreferrer"><span><b>{name}</b> · {card.prize}</span><ArrowUpRight size={12}/></a>;})}</div></div>
        <div className="jr-grid"><div><h4>What the demo shows</h4><ul className="jr-shows">{active.shows.map(([text,where])=><li key={text}><WhereLink where={where}/>{text}</li>)}</ul></div><div><h4>60-second demo path</h4><ol className="jr-path">{active.path.map(step=><li key={step}>{step}</li>)}</ol></div></div>
        <div className="jr-foot"><div><h4>Live evidence</h4><div className="jr-chips" aria-live="polite">{chipsFor(active).map(chip=><Chip key={chip.text} chip={chip}/>)}{evidence&&active.flags?.(evidence).map(flag=><span key={flag} className="jr-chip flag">{flag}</span>)}</div><p className="jr-note">Every record in this deployment’s database counts, including team testing, smoke tests and demo-account practice. These are not customers, users or merchants. {evidence?.storage===false&&'Storage is unavailable here, so counts can’t be read. '}{evidence&&<>Updated {new Date(evidence.generatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})} · </>}<a href="/api/evidence" target="_blank" rel="noreferrer">Raw counts</a></p></div><div><h4>Honest gaps</h4><ul className="jr-gaps">{active.gaps.map(gap=><li key={gap}>{gap}</li>)}</ul></div></div>
      </div></section>
    <section className="demo-section"><div className="demo-section-heading"><h2>Keep the demo honest.</h2><span>Actual build status</span></div><div className="readiness-grid"><article><span className="ready-label">Working simulation</span><h3>Flight & returns</h3><p>QR reading, package compatibility, booking, continuous tracking, explicit pickup confirmation, history, and simulated handoff.</p></article><article><span className="setup-label">Ready · verify on hardware</span><h3>Live drone link</h3><p>Fleet console plus a signed 4G/SMS link and a PX4/ArduPilot bridge. A full mission has run end to end with the bridge’s simulated vehicle; fly SITL before real hardware, with a pilot in command.</p><a href="/fleet">Open Fleet <ArrowUpRight size={14}/></a></article><article><span className={claudeLive?'ready-label':'setup-label'}>{claudeLive?'Live call recorded':(integration?.anthropic??evidence?.integrations.anthropic)?'Configured · verify live':'Needs credentials'}</span><h3>Anthropic</h3><p>The Claude return check, photo review and uncertainty gates are implemented. {claudeLive?claudeNote:'The sample output is explicitly labeled and does not establish sponsor eligibility.'}</p></article><article><span className={integration?.verified?.apify?'ready-label':'setup-label'}>{integration?.verified?.apify?'Live call recorded':integration?.apify?'Configured · verify live':'Needs Actor + token'}</span><h3>Apify</h3><p>Custom product-spec Actor and app integration are implemented. Missing weights or dimensions stay unknown. {integration?.verified?.apify?`${integration.verified.apify} live lookup(s) recorded.`:'Deploy the Actor and show a real successful run.'}</p></article><article><span className={maps.key?'ready-label':'setup-label'}>{maps.key?'Key configured · verify live':'OpenStreetMap map · Google optional'}</span><h3>Google Maps & places</h3><p>Address lookup, pickup pins, UPS drop-offs and warehouse discovery are implemented. Add a restricted browser key through Maps in the tracking screen. Listings do not verify return acceptance.</p></article><article><span className={integration?.amazon?'ready-label':'setup-label'}>{integration?.amazon?'Configured · verify sign-in':'Manual import ready'}</span><h3>Amazon returns</h3><p>Profile linking needs registered Amazon app credentials. The manual Orders → QR / label → booking flow works now. Linking does not grant order history or refund access.</p></article><article><span className="ready-label">Source published</span><h3>Continue building</h3><p>The source, the Cloudflare Worker deploy guide and the drone-link protocol are in GitHub.</p><a href={`${GH}/tree/main/lib`} target="_blank" rel="noreferrer">Browse the source <ArrowUpRight size={14}/></a><a href={`${GH}/blob/main/docs/DEPLOY.md`} target="_blank" rel="noreferrer">How it’s deployed <ArrowUpRight size={14}/></a><a href={`${GH}/blob/main/docs/DRONE_LINK.md`} target="_blank" rel="noreferrer">Drone link protocol <ArrowUpRight size={14}/></a></article></div></section>
    {/* Judge-facing content ends above. Coaching, the rehearsal checklist and the sponsor research are for the team, so they stay collapsed. */}
    <details className="jr-team" id="team" open={hash==='#team'}><summary><span><strong>For the AirCart team</strong><span>Pitch script, rehearsal checklist, prize research and open questions. Not part of the judging.</span></span></summary>
    <section className="demo-section demo-script"><div><span className="eyebrow">YOUR THREE-MINUTE STORY</span><h2>Less running around.<br/>More independence.</h2><p>One return, told once, in track order: the person, Claude’s check, the flight, the merchant, and the safety close. Lead with the person; make the drone’s journey the visual payoff.</p></div><ol>{SCRIPT.map(([time,title,tags,text])=><li key={time}><time>{time}</time><div><h3>{title}</h3><div className="jr-tags">{tags.map(tag=><span key={tag}>{tag}</span>)}</div><p>{text}</p></div></li>)}</ol></section>
    <section className="demo-section"><div className="demo-section-heading"><h2>Before you pitch</h2><span>Saved on this device</span></div><div className="demo-checklist">{ITEMS.map(item=><button key={item} onClick={()=>toggle(item)} aria-pressed={checklist.includes(item)} className={checklist.includes(item)?'checked':''}><span>{checklist.includes(item)&&<Check size={14}/>}</span>{item}</button>)}</div></section>
    <section className="demo-section"><div className="demo-section-heading"><div><span className="eyebrow">EVERY TRACK, CHECKED</span><h2>The full opportunity map.</h2></div><span>{research.cardCounts.total} prize cards · verified Oct 23</span></div><p className="demo-table-intro">These are opportunities, not eligibility claims. Several cards group multiple awards. Strong fit is our assessment; sponsor requirements still have to be met. <a href={research.officialPrizePage} target="_blank" rel="noreferrer">Current official prize portal <ExternalLink size={12}/></a></p><div className="track-filters"><div><Search size={16}/><input aria-label="Search tracks" placeholder="Search sponsor or requirement" value={search} onChange={e=>setSearch(e.target.value)}/></div><select aria-label="Track group" value={group} onChange={e=>setGroup(e.target.value)}>{['All','Organizer','Sponsor','MLH'].map(v=><option key={v}>{v}</option>)}</select><select aria-label="AirCart fit" value={fit} onChange={e=>setFit(e.target.value)}>{['All','Strong','Stretch','Poor'].map(v=><option key={v} value={v}>{v==='All'?'Every fit':v==='Poor'?'Lower fit':v+' fit'}</option>)}</select></div><div className="track-table"><table><thead><tr><th>Track / prize</th><th>What it actually requires</th><th>AirCart fit</th></tr></thead><tbody>{tracks.map(t=><tr key={t.name}><td><a href={t.source} target="_blank" rel="noreferrer">{t.name}<ArrowUpRight size={13}/></a><span>{t.prize}</span><small>{t.group.toUpperCase()}</small></td><td>{t.requirement}<p>{trackNote(t)}</p></td><td><span className={`fit-badge ${t.fit}`}>{t.fit==='poor'?'Lower':t.fit==='strong'?'Strong':'Stretch'}</span></td></tr>)}</tbody></table>{!tracks.length&&<p className="empty-tracks">No tracks match these filters.</p>}</div></section>
    <section className="demo-section"><div className="demo-section-heading"><h2>Resolve these before submission.</h2><TriangleAlert size={21}/></div><div className="conflict-grid">{research.discrepancies.map(d=><article key={d.subject}><h3>{d.subject}</h3><p>{Object.entries(d).filter(([k])=>!['subject','resolution'].includes(k)).map(([k,v])=>`${sourceLabel(k)}: ${v}`).join(' · ')}</p><strong>{d.resolution}</strong></article>)}</div><p className="demo-footnote">No general sponsor-entry limit or prize-stacking rule was verified. Confirm with organizers. Additional official resources exist for Canva, Context.dev, and Greptile, but no separate prize card was found.</p></section>
    </details>
    <footer><span>AirCart · Built for a clearer, kinder return.</span><a href={research.officialResources} target="_blank" rel="noreferrer">Official sponsor resources<ArrowUpRight size={13}/></a></footer></div></main>;
}
