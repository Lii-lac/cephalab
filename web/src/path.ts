// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "path"); behaviour must match v52.
import { store } from "./store";
import A_staple_left from "../../assets/staple-left.png";
import A_ticket from "../../assets/ticket.png";
import A_chunk from "../../assets/chunk.png";
import A_snail from "../../assets/super-sea-snail.png";
import { ui } from "./state";
import { plan, planNow, startSeed, recover, refine, call, BATTLES_PER_ROLL } from "./core/bridge";
import { live, subscribe } from "./live";
import { SeedResolver, choosePieces, buildPlanInput, hasPieces, readOverrides, openSlots, type Keep } from "./pieces";
import { late } from "./late";
import { typedStock, sumOf, reattach, initStock } from "./path-stock";
import { buildKey, hash32, rng } from "./identity";
import { BUILDS, GEAR, L, MAINONLY, NAMES, SUBS, WEAPONS, ab, gear, wimg } from "./data";
import { MAIN_RECIPES } from "./main-recipes";
import { rivalInk } from "./weapons";
import { classify, playTick, seen, liveSteps, warnAt } from "./path-tick";
import { pan } from "./path-pan";
import { planCache } from "./plan-cache";
import { tipAsks, bestTip, rollsOf, complete, showTip, tipAttach } from "./path-tip";

/* ================= PATH ================= */
// Worked example from Alex: hat wants s+;s+;qj (has qr x3), shirt wants s+;s+;qr (already holds an s+), shoes want s+;s+;qr (hold qr;s+, wrong order).
ui.useChunks = true, ui.useDrinks = true, ui.fixedOrder = true;
// Chunks: the pill is on/off. On, each lane's chunk cap (the chunk sticker + pips left of its goal) says how many chunks that
// piece may take: level 0 none, 1 at most 10, 2 at most 20 (the default), 3 thirty or more (no cap: only the stock limits it),
// sent as the piece's core maxChunks (CAPMAX; none sent for level 3). Within its cap the planner spends chunks only when they
// save a fair few rolls (CHUNK_RATE: chunks one roll is worth, core chunkRate), so it may spend less. Saved per build and
// lane; the default is not stored.
export const CAPMAX = [0, 10, 20, null];
const CAPSTORE = "seedtracker.chunkcap", CAPS = ["none", "at most 10", "at most 20", "30 or more"];
const capMap = () => { try { const v = store.get(CAPSTORE); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
export const capsOf = b => [0, 1, 2].map(i => { const v = b ? capMap()[`${b.id}:${i}`] : undefined; return v === 0 || v === 1 || v === 3 ? v : 2; });
export function setCap(b, lane, v) { const m = { ...capMap() }, k = `${b.id}:${lane}`; if (v === 0 || v === 1 || v === 3) m[k] = v; else delete m[k]; try { store.set(CAPSTORE, m); } catch {} }
const CHUNK_RATE = 5, CSTORE = "seedtracker.chunks", OLDBUDGET = "seedtracker.chunkbudget";   // the old budget: > 0 or none = on
export const chunksOn = () => { try { const v = store.get(CSTORE); if (typeof v === "boolean") return v; const old = store.get(OLDBUDGET); return old == null || !(+old <= 0); } catch { return true; } };
export function setChunks(on) { ui.useChunks = !!on; try { store.set(CSTORE, !!on); } catch {} }
ui.useChunks = chunksOn();
const rnd = () => SUBS[Math.floor(Math.random() * SUBS.length)];
const TOGDRINK = rnd(), TOGCHUNK = rnd(), TOGTRIO = [rnd(), rnd(), rnd()];  // fresh on every load  // a different drink on the toggle each time the screen opens
const T = A_ticket, STAPLE = A_staple_left, CHUNKIMG = A_chunk;
const BRUSH = '<svg viewBox="0 0 24 24"><path d="M14 4l6 6-7 7-6-6z"/><path d="M7 11l-3 9 9-3"/></svg>';
const ticket = (d, tr, used = false) => `<span class="ticket${used ? " used" : ""}" style="--tr:${tr}deg" data-tip="${NAMES[d]} drink"><img class="base" src="${T}" alt=""><img class="tic" src="${L}/skill/${d}.png" alt="${NAMES[d]} drink"><img class="st" src="${STAPLE}" alt=""></span>`;
// a Super Sea Snail (assets/super-sea-snail.png, the game's crystal snail)
const SNAIL = `<img class="snail" src="${A_snail}" alt="">`;
// an unlock cell's hexagon: flat-top, corners rounded, drawn wider than its square box (live.css .ab.snl svg.hex)
const HEX = `<svg class="hex" viewBox="0 0 115.47 100" preserveAspectRatio="none" aria-hidden="true"><path d="M23.37 9.53Q28.87 0 39.87 0L75.6 0Q86.6 0 92.1 9.53L109.97 40.47Q115.47 50 109.97 59.53L92.1 90.47Q86.6 100 75.6 100L39.87 100Q28.87 100 23.37 90.47L5.5 59.53Q0 50 5.5 40.47Z"/></svg>`;
const unlockTitle = s => `Slot ${s.slot}`;
const chunkCorner = `<span class="corner" data-tip="Set with chunks"><img src="${CHUNKIMG}" alt=""></span>`;

// keyed() and the mock pathLanes() live in core/bridge.ts now (plan()).
const isRollAct = s => s.k === "roll" || s.k === "drink";
let real = false;                                              // drawing the core's plan (not the mock route): the first-step tag never sits on a burn group's label
// The grid lines the three pieces up in time. A roll sits in its battle's column (equal keys = one battle). Murch work
// (scrub, chunks: no battle of its own) goes as early as it can: right after the piece's previous roll (or at the very
// start), in columns of its own counted from the left in every lane, so the pieces' first scrubs and chunks share column 1.
// A dot is a battle the piece sits out (not worn), which is what lets its Murch work come early.
const isMurch = s => !isRollAct(s);
// where a step sits in time: [t, o] = a roll's key (o 0), or Murch work's gap (previous roll's last battle + .5) and its place in that gap
function timeOf(steps) {
  const at = new Map(), seen = {};
  let last = 0, prev = null;                                     // the lane's previous roll's (last) battle
  for (const s of steps) {
    const p = prev; prev = s;
    if (!isMurch(s)) { at.set(s, [s.key, 0]); last = s.key + (s.times || 1) - 1; continue; }
    if (s.k === "unlock" && p && p.k === "unlock") { at.set(s, at.get(p)); continue; }   // unlocks in a row share one cell (laneSteps draws "Unlock N")
    const g = last + .5;
    seen[g] = (seen[g] || 0) + 1;
    at.set(s, [g, seen[g] - 1]);
  }
  return at;
}
const colKey = ([t, o]) => t + ":" + o;
export function pathCols(lanes) {                             // every lane's [t, o], once, in time order
  const all = new Map();
  for (const l of lanes) for (const p of timeOf(l.steps).values()) all.set(colKey(p), p);
  return [...all.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
const chunkCell = (s, tip) => `<span class="chunkonly"${tip ? ` data-tip="${esc(typeof tip === "string" ? tip : NAMES[s.a])}"` : ""}><span class="edge"></span><span class="fill"></span><img src="${L}/skill/${s.a}.png" alt="${NAMES[s.a]}"></span>`;
// a main-only main's swap: its three recipe chunks as one small cluster (a chunk cell each, smaller)
const TRIO = [[0, 0], [31, 0], [15, 31]];
const chunkTrio = (parts, tip) => `<span class="chunktrio" data-tip="${esc(tip)}">${parts.map(([a], k) => `<span class="chunkonly" style="position:absolute;left:${TRIO[k][0]}px;top:${TRIO[k][1]}px;scale:.56;transform-origin:0 0;--cr:0deg"><span class="edge"></span><span class="fill"></span><img src="${L}/skill/${a}.png" alt="${NAMES[a]}"></span>`).join("")}</span>`;
// the main swap step's tooltip: ability name, plus any short chunks
const mainTip = s => {
  const parts = s.parts || [[s.a, MAINCHUNKS]], lack = s.lack || [];
  const need = a => parts.find(p => p[0] === a)?.[1] ?? MAINCHUNKS;
  if (!lack.length) return NAMES[s.a];
  return `${NAMES[s.a]} · ${parts.length > 1 ? lack.map(([a, n]) => `${need(a) - n} ${NAMES[a]}`).join(", ") : need(lack[0][0]) - lack[0][1]} short`;
};
// a core burn group step with "times": N is N rolls in battles key .. key+N-1, drawn once in the last column it reaches
// (`a` = what the last roll lands); the columns before it in that run get dots like any other. span(s) = [first, last] column.
function spanOf(steps, cols) {
  const at = timeOf(steps), idx = new Map(cols.map((p, i) => [colKey(p), i + 1]));
  const col = s => idx.get(colKey(at.get(s)));
  return s => { const c = col(s); if (!s.times) return [c, c]; let e = c; while (e < cols.length && cols[e][0] <= s.key + s.times - 1) e++; return [c, e]; };
}
const nowCol = cols => Math.max(cols.findIndex(p => Number.isInteger(p[0])) + 1 || cols.length, 1);   // the yellow next step: one done before or in the next battle
function laneSteps(steps, cols) {
  const span = spanOf(steps, cols), now = nowCol(cols);
  let html = "";
  const here = s => !!s.here && span(s)[1] <= now;
  const taken = new Set();                                       // a dot in every column this piece draws nothing in, so each column has its › in every row
  steps.forEach((s, i) => {
    if (s.k === "unlock" && steps[i - 1]?.k === "unlock") return;   // drawn with the first unlock of its run
    let run = 1; while (s.k === "unlock" && steps[i + run]?.k === "unlock") run++;
    const c1 = span(s)[1];
    taken.add(c1);
    const murch = isMurch(s);
    const kind = s.k === "scrub" || s.k === "unlock" ? "tool" : s.burn ? "past" : s.k === "slap" || s.k === "main" ? "slapped" : "keep";   // past: a roll a later scrub throws away, dimmed
    const c = ["step", kind, s.k === "unlock" && "unlock", here(s) && "here", s.k === "drink" && "drink", c1 === 1 && "first", murch && "murch"].filter(Boolean).join(" ");
    let body, label;
    if (s.k === "scrub") { body = `<div class="ab z52" data-tip="Scrub at Murch"><img src="${L}/skill/Unknown.png" alt=""></div>`; label = "Scrub"; }
    else if (s.k === "unlock" && run > 1) {
      const slots = steps.slice(i, i + run).map(x => x.slot);
      body = `<div class="ab z52 snl" data-tip="Slots ${slots.join(", ")}">${HEX}${SNAIL}</div><span class="cnum" style="--ct:${hash32(`unlock:${slots.join()}`) % 31 - 15}deg">×${run}</span>`;
      label = `Unlock ${run}`;
    }
    else if (s.k === "unlock") { body = `<div class="ab z52 snl" data-tip="${unlockTitle(s)}">${HEX}${SNAIL}</div>`; label = "Unlock"; }
    else if (s.k === "main") {
      const parts = s.parts || [[s.a, MAINCHUNKS]], lack = !!(s.lack && s.lack.length), tip = mainTip(s);
      body = (parts.length > 1 ? chunkTrio(parts, tip) : chunkCell(s, tip)) + `<span class="cnum${lack ? " lack" : ""}" style="--ct:${hash32(`main:${s.slot}:${s.a}`) % 31 - 15}deg" data-tip="${esc(tip)}">×${parts[0][1]}</span>`; label = "Main";
    }
    else if (s.k === "slap") {
      const tip = s.cost ? `${s.cost} chunks` : NAMES[s.a];
      body = chunkCell(s, tip) + (s.cost ? `<span class="cnum" style="--ct:${hash32(`${s.slot}:${s.a}:${s.cost}:${s.key}`) % 31 - 15}deg" data-tip="${s.cost} chunks">×${s.cost}</span>` : ""); label = `Slot ${s.slot}`;
    }
    else { body = ab(s.a, 52) + (s.k === "drink" ? ticket(s.d, s.tr) : ""); label = s.times > 1 ? `Roll ${fmt(s.times)} times` : `Roll ${s.roll}`; }
    html += `<div class="${c}" style="grid-column:${c1};--r:${s.r || 0}deg"${s.burn ? ' data-tip="Scrubbed later"' : ""}><div class="vis">${body}</div><span class="n">${label}</span></div>`;
  });
  for (let c = 1; c <= cols.length; c++) if (!taken.has(c)) html += `<div class="step ph${c === 1 ? " first" : ""}" style="grid-column:${c}"><div class="vis"><span class="phdot"></span></div></div>`;
  return html;
}
// a finished lane (its piece has the goal: no rolls left) shows a lime "done" tape where its track would be, one of these
// words, picked by a hash of the gear and the build's contents so the same finished piece always says the same thing
export const DONE_WORDS = ["Stay Fresh!", "Booyah!", "So Fresh!", "Woomy!", "Veemo!", "Ink-credible!", "Splat-tastic!", "Fresh Fit!", "Ready to Splat!", "Fully Inked!", "Off the Hook!"];
const laneDone = l => !l.note && !l.searching && !l.far && !l.steps.some(isRollAct);
const doneKey = (b, l, li) => `${l.row}|${buildKey(b)}|${li}`;
const doneTape = (b, l, li) => { const k = doneKey(b, l, li); return `<div class="ldone"><span class="dtape s1" data-dk="${esc(k)}">${esc(DONE_WORDS[hash32(k) % DONE_WORDS.length])}</span></div>`; };
// the tape pops in (scale + fade, 180 ms) the first time this page shows it, not on every redraw (a redraw re-inserts it)
const donePopped = new Set<string>();
function donePop(host) {
  const rm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const t of host.querySelectorAll<HTMLElement>(".lanes > .lane .dtape")) {
    const k = t.dataset.dk; if (donePopped.has(k)) continue; donePopped.add(k);
    t.animate(rm ? { opacity: [0, 1] } : { opacity: [0, 1], scale: [".9", "1"] }, { duration: 180, easing: "cubic-bezier(.2,.9,.3,1.2)" });
  }
}
export function laneCost(steps, done = false) {
  const rolls = steps.filter(isRollAct).reduce((t, s) => t + (s.times || 1), 0);
  // a drink burn group of N rolls is at least ceil(N / 8) tickets (DRINK_COLUMNS, core/API.md)
  const tickets = steps.filter(s => s.k === "drink").reduce((t, s) => t + (s.times ? Math.ceil(s.times / 8) : 1), 0), chunks = steps.reduce((t, s) => t + (s.cost || 0), 0);
  const snails = steps.filter(s => s.k === "unlock").length;
  return `<div class="lcost${done ? " nr" : ""}">
    ${done ? "" : `<span class="lc" data-tip="Rolls left"><b>${fmt(rolls)}</b> ${rolls === 1 ? "roll" : "rolls"}</span>`}
    ${tickets ? `<span class="lc" data-tip="Drink tickets"><span class="tkt" style="width:40px"><img class="base" src="${T}" alt=""><img class="tic" src="${L}/skill/${steps.find(s => s.k === "drink").d}.png" alt=""></span><b>${tickets}</b></span>` : ""}
    ${chunks ? `<span class="lc" data-tip="Ability chunks"><img class="chunkbare" src="${CHUNKIMG}" alt="" style="width:22px;height:22px"><b>${chunks}</b></span>` : ""}
    ${snails ? `<span class="lc" data-tip="Super Sea Snails">${SNAIL}<b>${snails}</b></span>` : ""}
  </div>`;
}
// a lane's cost row stays one line (Alex 2026-11-22: a wrapped second line went under the lane): when its chips are wider
// than the lane's end it steps down (.tight: smaller type and gaps), then the least important chips (snails, then tickets)
// go into the rolls chip's tooltip
const COSTDROP = ["Super Sea Snails", "Drink tickets"];
export function fitCosts(host) {
  for (const k of host.querySelectorAll(".lanes > .lane .lend > .lcost:not(.nr)")) {   // .nr: a finished lane, no rolls chip to fold into
    const w = k.parentElement.clientWidth, chips = [...k.children], rolls = chips[0];
    if (!w || !rolls) continue;
    k.classList.remove("tight"); for (const c of chips) c.hidden = false; rolls.dataset.tip = "Rolls left";
    const need = () => { const on = chips.filter(c => !c.hidden); return on.reduce((t, c) => t + c.offsetWidth, 0) + (on.length - 1) * (parseFloat(getComputedStyle(k).columnGap) || 0); };
    if (need() <= w) continue;
    k.classList.add("tight");
    const gone = [];
    for (const name of COSTDROP) {
      if (need() <= w) break;
      const c = chips.find(x => x.dataset.tip === name); if (!c) continue;
      c.hidden = true; gone.push(`${c.textContent.trim()} ${name === "Drink tickets" ? "tickets" : "snails"}`);
    }
    if (gone.length) rolls.dataset.tip = `Rolls left · +${gone.join(", ")}`;
  }
}
const slot = ([a, st], z) => ab(a, z, st === "wrong" ? "wrong" : st === "met" ? "met" : "");
// a lane's chunk cap, left of its goal: the chunk sticker over three pips (lit = 10 / 20 / 30+ chunks on this piece; none
// lit: grey, no chunks; all three: red, no cap; the sticker grows with the level); click steps round, a press dragged onto
// the strip it pops picks a level (capDown), arrow keys step. With Chunks off it is there but faded out and inert. data-v
// carries the level so a step can restyle it in place (stepCap).
const capFace = v => `<span class="cic"><img src="${CHUNKIMG}" alt=""><span class="ctint" style="-webkit-mask-image:url(${CHUNKIMG});mask-image:url(${CHUNKIMG})"></span></span><span class="pips">${[1, 2, 3].map(k => `<i${k <= v ? ' class="lit"' : ""}></i>`).join("")}</span>`;
const capBox = (li, v, on) => `<button class="ccap${on ? "" : " off"}" data-cap="${li}" data-v="${v}" role="slider" aria-label="Chunks on this piece" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${v}" aria-valuetext="${CAPS[v]}" data-tip="Chunks: ${CAPS[v]}"${on ? "" : ' tabindex="-1" inert'}>${capFace(v)}</button>`;
const fmt = n => n.toLocaleString("en-US");                    // 2400 -> "2,400"
const qmark = `<img src="${L}/skill/Unknown.png" alt="">`;
// a lane head's slot: what it has, else "?" (open, not rolled yet), else a grey no-entry sign past the piece's open slots
// (open = min(3, stars + 1); null when the stars aren't known: then every empty slot is "?")
const LOCK = `<svg viewBox="0 0 26 26" aria-hidden="true"><path d="M6.4 6.4 19.6 19.6"/></svg>`;
const haveSlot = (h, i, open) => h[0] ? slot(h, 26)
  : open != null && i >= open ? `<div class="ab z26 lock" data-tip="Locked slot">${LOCK}</div>`
  : `<div class="ab z26 q${h[1] === "wrong" ? " wrong" : ""}" data-tip="Not rolled yet">${qmark}</div>`;
// the main ability's ring, left of the subs (a bit bigger than they are): the piece's own in the lane head, the goal's in the
// pill ("any" = an empty ring when the build leaves the main open and the piece's main is known). wrong: a main-only goal the piece lacks
const mainRing = (a, z, st, tip) => a ? `<div class="ab z${z} main ${st}" data-tip="${esc(tip)}"><img src="${L}/skill/${a}.png" alt="${NAMES[a]}"></div>` : `<div class="ab z${z} main empty" data-tip="${esc(tip)}"></div>`;
const jobOf = (l, b, i) => (l && l.main) || { have: null, goal: (b.set[i] && b.set[i][1]) || "", swap: false, wrong: false };
const headMain = j => j.have ? mainRing(j.have, 34, "", j.wrong ? `Needs ${NAMES[j.goal]} main` : `Main: ${NAMES[j.have]}`) : "";
const goalMain = j => j.goal ? mainRing(j.goal, 44, j.wrong ? "wrong" : j.have === j.goal ? "met" : "", j.wrong ? `Needs ${NAMES[j.goal]} main` : `Main: ${NAMES[j.goal]}`)
  : j.have ? mainRing("", 44, "", "Any main") : "";
/* ================= PATH (v52): the path for one of your builds ================= */
const PSTORE = "seedtracker.pathbuild";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export function pathBuild() {                                         // the build picked last, else your newest, else none
  const mine = BUILDS.filter(b => b.mine);
  let want = NaN; try { want = +store.get(PSTORE); } catch {}
  return mine.find(b => b.id === want) || mine[mine.length - 1] || null;
}
export function setPathBuild(id) { try { store.set(PSTORE, String(id)); } catch {} }
// CHUNKCOST and the mock route: core/bridge.ts.
// The Up next card wears the build cards' look: yellow splats on its edges, the rival team's ink behind the badges
// (where the cards ink their buttons), seeded by the build's contents (buildKey).
function nextInk(b) {
  const r = rng(hash32(buildKey(b) + ":next"));
  const deep = "oklch(.9 .19 103)", light = "oklch(.98 .08 108)";   // a warmer lemon and a cream; darkening this yellow turns it olive
  const rival = rivalInk({ h: 110 }).css;
  const spots = [[2 + r() * 8, 88 + r() * 14, 330 + r() * 120, deep], [30 + r() * 16, -6 + r() * 10, 280 + r() * 90, light]];
  if (r() < .6) spots.push([58 + r() * 12, 96 + r() * 10, 220 + r() * 80, r() < .5 ? deep : light]);
  const edge = spots.map(([x, y, s, k]) => `<span class="ink" style="--k:${k};left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;--s:${Math.round(s)}px;--rot:${Math.round(r() * 360)}deg;--fx:${r() < .5 ? -1 : 1}"></span>`);
  const hits = [0, 1, 2].map(i => `<span class="ink riv" style="--k:${rival};left:${(91 + r() * 7).toFixed(1)}%;top:${(18 + i * 30 + r() * 10).toFixed(1)}%;--s:${Math.round(150 + r() * 70)}px;--rot:${Math.round(r() * 360)}deg;--fx:${r() < .5 ? -1 : 1}"></span>`);
  return edge.join("") + hits.join("");
}
// The three pieces roll at the same time, so Up next has a page per piece with a step this turn (upNextLanes): its next step (gear > what,
// the title, its own step count). The card flips through them (dots on its left edge say which); the battles bar,
// tickets and chunks are the whole build's and stay put.
// One step = a roll (a burn group of rolls counts as one) and the Murch work right after it (scrub, chunks over it);
// work before the first roll is a step of its own.
function stepGroups(steps) {
  const out = [];
  let cur = [];
  steps.forEach((s, i) => {
    const prev = steps[i - 1];
    if (isRollAct(s) && !(s.burn && prev && prev.burn === s.burn) && cur.length) { out.push(cur); cur = []; }   // a roll starts a step
    cur.push(s);
  });
  if (cur.length) out.push(cur);
  return out;
}
// Only pieces with something to do this turn get a page: a lane whose first step is the lane's yellow "here" (laneSteps).
// If none has, the lane(s) whose first step comes soonest.
function upNextLanes(raw, cols) {
  const left = raw.filter(l => l.steps.length && !l.note && !l.searching);
  if (!left.length || !cols.length) return left;
  const end = new Map(left.map(l => [l, spanOf(l.steps, cols)(l.steps[0])[1]])), now = nowCol(cols);
  const doing = left.filter(l => end.get(l) <= now);
  if (doing.length) return doing;
  const soon = Math.min(...end.values());
  return left.filter(l => end.get(l) === soon);
}
// the step's own cell, as its lane draws it: a ring with the ability (? for a scrub or a roll a scrub throws away), the
// chunk sticker for chunks, and a drink's ticket stapled onto its ring
const ring = a => `<div class="ab z56" style="box-shadow:0 0 0 3px #fff"${a ? ` data-tip="${NAMES[a]}"` : ""}>${a ? `<img src="${L}/skill/${a}.png" alt="${NAMES[a]}">` : qmark}</div>`;
const upCell = (s, drunk = false) => `<span class="ucell${s.k === "drink" ? " udrink" : ""}">${s.k === "main" && s.parts && s.parts.length > 1 ? chunkTrio(s.parts, mainTip(s)) : s.k === "main" ? chunkCell(s, mainTip(s)) : s.k === "slap" ? chunkCell(s, s.cost ? `${s.cost} chunks` : NAMES[s.a]) : s.k === "unlock" ? `<div class="ab z56 snl" data-tip="${unlockTitle(s)}">${HEX}${SNAIL}</div>` : ring(s.k === "scrub" || s.burn ? "" : s.a)}${s.k === "drink" ? ticket(s.d, s.tr ?? -6, drunk) : ""}</span>`;
// lv (liveOf): what the Switch says right now. A worn piece the plan doesn't want rolled yet, close to its next slot, gets a
// "Take off" page (first, so it is the one shown); a planned drink that is already active reads as done (the ticket used).
export function upNextCard(b, raw, totals, cols = pathCols(raw.filter(l => !l.note && !l.searching)), lv = null) {   // totals: the core's (live plans), else counted here as v52 did
  const all = raw.flatMap(l => l.steps), off = l => lv?.steps?.[raw.indexOf(l)]?.k === "off";
  const lanesLeft = [...raw.filter(off), ...upNextLanes(raw, cols).filter(l => !off(l))];
  const drunk = s => s.k === "drink" && !!lv?.drink?.ability && lv.drink.ability === s.d;
  const rolls = Math.max(0, ...raw.map(l => l.steps.filter(isRollAct).length));
  const battles = totals ? totals.battles : Math.ceil(rolls * 2.3), tickets = all.filter(x => x.k === "drink"), chunks = all.reduce((t, x) => t + (x.cost || 0), 0);
  const snails = totals && typeof totals.snails === "number" ? totals.snails : all.filter(x => x.k === "unlock").length;
  const pages = lanesLeft.map(l => {
    const name = (GEAR[l.row] || [""])[0];
    if (off(l)) return { name, flow: `${gear(l.row)}<span class="arrow">›</span>${gear("")}`, n: 0, title: `Take off your ${name}` };
    const groups = stepGroups(l.steps), g = groups[0];
    const shown = g.filter((s, i) => !(i && s.burn && s.burn === g[i - 1].burn));
    const s = shown[0], n = s.burn ? g.filter(x => x.burn === s.burn).reduce((t, x) => t + (x.times || 1), 0) : 1;
    const title = s.k === "scrub" ? "Scrub" : s.k === "unlock" ? `Unlock slot ${s.slot}` : s.k === "slap" ? "Chunk it on"
      : s.k === "main" ? "Swap main" : s.burn ? "Roll " + (["once", "twice"][n - 1] || fmt(n) + " times")
      : s.k === "drink" && !drunk(s) ? "Drink" : `Wear your ${name}`;
    return { name, flow: `${gear(l.row)}<span class="arrow">›</span>${upCell(s, drunk(s))}`, n: groups.length, title };
  });
  if (!pages.length) pages.push({ name: "", flow: `<div class="ab z56">${ab("", 56)}</div>`, title: "Done", n: 0 });
  const stack = (cls, f) => `<div class="ustack ${cls}">${pages.map((p, i) => `<div class="upg${i ? "" : " on"}">${f(p)}</div>`).join("")}</div>`;
  // each page carries its own bar line (all alike), so a page's title and bar are centred together in the banner whatever the other pages' titles take
  const bar = `<div class="unbattles"><div class="ubar"><i style="width:${all.length ? 6 : 100}%"></i></div>${raw.some(l => l.searching) ? `<span class="ulook"><b>Still looking</b> for the full build</span>`
    : `<span${raw.some(l => l.fresh) ? ' class="ufound"' : ""}><b>${fmt(battles)}</b> ${battles === 1 ? "battle" : "battles"} to the full build</span>`}</div>`;
  const liveKey = esc(JSON.stringify([lanesLeft.filter(off).map(l => raw.indexOf(l)), all.filter(drunk).length]));
  return `<div class="tag next tilt-l2" data-cur="0" data-live="${liveKey}">
      ${nextInk(b)}
      <span class="sticker ribbon">Up next</span>
      ${pages.length > 1 ? `<div class="udots">${pages.map((p, i) => `<button class="udot${i ? "" : " on"}" data-up="${i}" aria-label="${p.name}"></button>`).join("")}</div>` : ""}
      ${stack("flow", p => p.flow)}
      <div>${stack("utitle", p => `<h2><span>${p.title}</span></h2>${bar}`)}</div>
      <div class="badges">
        ${all.length ? stack("ustep", p => `<span class="badge stepb"${p.n ? "" : ' style="visibility:hidden"'}>Step&nbsp;<b>1/${p.n || 1}</b></span>`) : ""}
        ${tickets.length ? `<span class="badge"><span class="tkt" style="width:52px;transform:rotate(-8deg);margin:-6px 0"><img class="base" src="${T}" alt=""><img class="tic" src="${L}/skill/${tickets[0].d}.png" alt=""></span><b>${totals ? totals.tickets : tickets.length}</b> ${(totals ? totals.tickets : tickets.length) === 1 ? "ticket" : "tickets"}</span>` : ""}
        ${chunks ? `<span class="badge"><img class="chunkbare" src="${CHUNKIMG}" alt="" style="width:24px;height:24px"><b>${chunks}</b> chunks</span>` : ""}
        ${snails ? `<span class="badge" data-tip="1 per slot unlocked">${SNAIL}<b>${snails}</b> ${snails === 1 ? "snail" : "snails"}</span>` : ""}
      </div>
    </div>`;
}
const wblob = row => `<div class="blob wb"><span class="wsp sk${hash32(row + ":splash") % 16}"></span><img src="${wimg(row)}" alt=""></div>`;
// what the core needs for a build: its three pieces and goals, the toggles (seeds, stock: from the companion later)
function planInput(b) {
  return { pieces: b.set.map(([row, , subs]) => ({ row, brand: "", seed: 0, subs: ["", "", ""], goal: [0, 1, 2].map(i => subs[i] || "") })),
           chunks: {}, drinks: {}, fixedOrder: ui.fixedOrder, useChunks: ui.useChunks, useDrinks: ui.useDrinks, horizon: 60,
           mock: { buildId: b.id } };
}
/* ---------- planning from your real gear (pieces.ts: which piece, which seed; the core: the route) ---------- */
const resolver = new SeedResolver({ startSeed, recover: (s, b, o) => recover(s, b, o), refine });
let gen = 0;                                                   // a newer renderPath makes older plan results drop
let shown = null;                                              // { id, lanes } what the last live plan drew, kept on screen until the next arrives
let lastHtml = "";
let liveIds = null;                                            // { id, seen } the pieces of the last live plan (liveOf)
let ticking = null;                                            // { key } while a completed step plays out: the same snapshot again leaves it alone
const liveSnaps = () => (hasPieces(live.snapshots) ? live.snapshots : null);
// what the Switch holds (botbase snapshot.stock: chunks / drinks per ability), or null while it has not been read
const stockOf = snaps => { const st = snaps && snaps.botbase && snaps.botbase.stock; return st && typeof st === "object" ? { chunks: st.chunks || null, drinks: st.drinks || null } : null; };
// the plan input's counts: the Switch's when it reports any, else the ones typed behind the toggles (path-stock.ts)
const stockInput = snaps => { const s = stockOf(snaps); return s ? { chunks: s.chunks || {}, drinks: s.drinks || {} } : typedStock(); };
const noteLane = n => ({ row: n.row, have: n.subs.map(a => [a, ""]), goal: n.goal.map(a => [a, ""]), steps: [], note: n.note });
// the piece each lane showed last (pieces.ts Keep): in memory, and in the store (written when the piece changes, or every
// 30 s while it's seen) so a reload while the Switch reconnects keeps it too
const KEEPSTORE = "seedtracker.lastpieces";
const keepMem = new Map(Object.entries(store.get(KEEPSTORE) || {}));
const keep: Keep = {
  get: k => keepMem.get(k),
  set: (k, v) => {
    const was = keepMem.get(k); keepMem.set(k, v);
    if (!was || was.chosen.piece.gearId !== v.chosen.piece.gearId || v.at - was.at > 30000 || JSON.stringify(was.chosen.piece) !== JSON.stringify(v.chosen.piece)) {
      try { store.set(KEEPSTORE, Object.fromEntries(keepMem)); } catch {}
    } else keepMem.set(k, { ...v, at: was.at });                       // unchanged and recently saved: keep the saved time
  },
};
// the companion reads just these pieces off the Switch between whole reads (botbase_source.py); told when they change
let watched = "";
function watchPieces(chosen) {
  const ps = chosen.filter(c => c && c.source === "botbase").map(c => ({ slot: c.piece.slot, gearId: c.piece.gearId }));
  const k = JSON.stringify(ps);
  if (k === watched) return;
  watched = k;
  fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pieces: ps }) }).catch(() => { if (watched === k) watched = ""; });
}
/* The main ability. At Murch a piece's main is replaced by MAINCHUNKS chunks of the new ability. Only the 14 standard abilities
   have chunks; a main-only goal (on its own slot) is made from 15 chunks each of its three recipe abilities (main-recipes.ts), and
   one with no recipe known yet is out of reach (wrong); a main-only main on the piece can still be swapped away. The swap is a Murch step of its own (k "main", first in the lane) the core never sees: its chunks come
   off the stock before the plan and don't count against the lane's cap. have: null while the piece's main isn't known. */
const MAINCHUNKS = 45;
function mainJobs(b, chosen) {
  return b.set.map(([, goal], i) => {
    const c = chosen[i], have = (c && c.piece && c.piece.main) || null, g = goal || "", differs = !!g && !!have && g !== have;
    const rec = MAIN_RECIPES[g], parts = !differs ? [] : SUBS.includes(g) ? [[g, MAINCHUNKS]] : rec && (MAINONLY[i] || []).includes(g) ? rec.map(a => [a, MAINCHUNKS / 3]) : [];
    return { have, goal: g, swap: parts.length > 0, wrong: differs && !parts.length, parts, lack: [] };
  });
}
async function planLive(b, snaps) {
  const chosen = choosePieces(b, snaps, { fixedOrder: ui.fixedOrder, overrides: readOverrides(store), keep });
  const resolved = await Promise.all(chosen.map(c => c ? resolver.resolve(c) : null));
  if (resolved.some(r => r && r.state === "stale")) return null;
  const built = buildPlanInput(b, chosen, resolved, { fixedOrder: ui.fixedOrder, useChunks: ui.useChunks, chunkRate: CHUNK_RATE, maxChunks: ui.useChunks ? capsOf(b).map(v => CAPMAX[v]) : undefined, useDrinks: ui.useDrinks, ...stockInput(snaps), horizon: FIRST });
  const { planned, notes } = built;
  const jobs = mainJobs(b, chosen), stk = stockInput(snaps), known = !!stockOf(snaps) || sumOf(stk.chunks) > 0, left = { ...stk.chunks };
  jobs.forEach((j, i) => {                                     // a main swap's 45 chunks come off the stock before the core plans, so no slap spends them
    if (!j.swap || planned[i] < 0) return;
    for (const [a, n] of j.parts) {
      const have = +left[a] || 0;
      if (known && have < n) j.lack.push([a, have]);
      left[a] = Math.max(0, have - n);
    }
  });
  let input = jobs.some((j, i) => j.swap && planned[i] >= 0) ? { ...built.input, chunks: left } : built.input, out = null;
  if (input.pieces.length) { ({ input, out } = await chunkPlan(input)); if (!out.ok) return null; }
  watchPieces(chosen);
  return { input, planned, notes, out, jobs, seen: chosen.map(seen), open: chosen.map(c => openSlots(c && c.piece)) };
}
// One plan call: no build-wide chunk budget, each piece's maxChunks (its lane's cap) does the limiting. The answer is kept
// per input (live "state" events replan the same input every ~1 s), so the same input never asks the core again.
let picked = null;                                             // { key, p } the last input's plan
export function chunkPlan(input, planFn = plan) {
  const key = JSON.stringify(input);
  if (picked && picked.key === key) return picked.p;
  const hit = planFn === plan ? planCache.get(input) : null;   // saved across restarts (plan-cache.ts); an injected planFn (tests) bypasses it
  const p = hit ? Promise.resolve({ input, out: hit.first }) : (planFn === plan ? corePlan(input) : planFn(input)).then(out => ({ input, out }));
  picked = { key, p };
  p.catch(() => { if (picked && picked.p === p) picked = null; });   // cancelled: ask again next time
  return p;
}
// the core's own answer, saved when it says ok (never the stub's: plan() falls back to it when the core can't answer)
async function corePlan(input) {
  try {
    const { mock, ...req } = input;
    const r = await call({ fn: "plan", ...req });
    if (r && r.ok === true) { planCache.putFirst(input, r); return r; }
  } catch (e) { if (e instanceof Error && e.message === "cancelled") throw e; }
  return plan(input);
}
// the lanes the screen draws for a plan: a lane the core couldn't reach yet ("searchedTo") is still being searched
// (each carries `open`: how many sub slots its piece can ever fill, null when its stars aren't known)
function toLanes({ planned, notes, out, open, jobs }) {
  return planned.map((pi, i) => {
    const o = open ? open[i] ?? null : null, j = jobs ? jobs[i] : null;
    const withMain = l => !j ? l : { ...l, main: j, steps: j.swap && !l.note && !l.searching ? [{ k: "main", a: j.goal, slot: i + 1, cost: MAINCHUNKS, parts: j.parts, ...(j.lack.length ? { lack: j.lack } : {}) }, ...l.steps] : l.steps };
    if (pi < 0) return withMain({ ...noteLane(notes[i]), open: o });
    const lane = out.lanes[pi];
    if (!out.unreachable.includes(pi)) return withMain(o === null ? lane : { ...lane, open: o });
    return withMain(typeof lane.searchedTo === "number" ? { ...lane, searching: true, open: o } : { ...lane, note: "This goal can't be reached with these settings", open: o });
  });
}

/* ---------- progressive search (core/API.md "plan", from / searchedTo): a lane not found within FIRST seed steps is looked
   for further, one slice at a time in the worker, until it is found. A new build, toggle or snapshot drops the search;
   leaving the screen parks it (it goes on when you come back). ---------- */
const FIRST = 200;                                             // the first request: the core's proven joint search for near goals
const FAR = 1000;                                              // battles: past this the lane says it's a long way off
const NUDGE = "Far off · try chunks or drinks";
let srch = null;                                               // { key, b, r, lanes, from, looked, nudge, timer, parked, over }
const keyOf = (b, snaps) => JSON.stringify([b && b.id, b && b.set, ui.fixedOrder, ui.useChunks, ui.useDrinks, capsOf(b), readOverrides(store), snaps, stockOf(snaps), stockOf(snaps) ? null : typedStock()]);
const onScreen = () => !!document.getElementById("path")?.classList.contains("on");
const lookedOf = steps => Math.round(steps * BATTLES_PER_ROLL);
function stopSearch() { if (srch) clearTimeout(srch.timer); srch = null; }
function sliceOf(from, input) {                                // seed steps for the next slice: doubling up to the core's 20000 cap
  if (from > 1000000) return 0;
  const tickets = Object.values(input.drinks || {}).reduce((t, n) => t + (+n || 0), 0);
  return Math.min(20000, Math.max(FIRST, from), Math.floor(8388608 / (tickets + 1)) - 1 - from);
}
// the lanes a search's answer draws: a lane that was searching and now has its steps is "far" (fresh only when found live)
const foundLanes = (r, prev, fresh) => toLanes(r).map((l, i) => l.searching || !l.steps.length ? l
  : prev[i]?.searching ? { ...l, far: true, ...(fresh ? { fresh: true } : {}) } : prev[i]?.far ? { ...l, far: true } : l);
// the search's state is saved (plan-cache.ts) at most once per 2 s, and always when it is found or ends
function saveSearch(s, force) {
  const now = Date.now();
  if (!force && now - (s.savedAt || 0) < 2000) return;
  s.savedAt = now;
  planCache.putSearch(s.r.input, { out: s.r.out, from: s.from, looked: s.looked, ended: !!s.ended, done: !s.lanes.some(l => l.searching) });
}
function startSearch(b, r, lanes, key, t0) {
  const s = srch = { key, b, r, lanes, from: Math.max(...lanes.filter(l => l.searching).map(l => l.searchedTo)), looked: 0, nudge: false, timer: 0, parked: false, over: false, savedAt: 0 };
  s.looked = lookedOf(s.from); s.nudge = s.looked > FAR;
  const hit = planCache.get(r.input), c = hit && hit.search;   // a search saved by an earlier run: done or ended draws at once, else it goes on from where it was
  if (c) {
    s.r = { ...r, out: c.out }; s.lanes = foundLanes(s.r, lanes, false); s.from = c.from; s.looked = c.looked;
    real = true; shown = { id: b.id, lanes: s.lanes, totals: c.out.totals };
    draw(b, s.lanes, c.out.totals);
    if (!s.lanes.some(l => l.searching) || c.ended) { s.over = true; if (c.ended && s.lanes.some(l => l.searching)) { s.ended = s.nudge = true; paintSearch(); } return; }
    s.nudge = s.looked > FAR;
  }
  s.timer = setTimeout(() => { if (srch === s && !s.over) { s.nudge = true; paintSearch(); } }, Math.max(0, 2000 - (Date.now() - t0)));
  paintSearch();
  runSearch(s);
}
async function runSearch(s) {
  const valid = () => srch === s && keyOf(pathBuild(), liveSnaps()) === s.key;
  for (;;) {
    await new Promise(res => setTimeout(res, 0));              // yield between slices
    if (!valid()) { if (srch === s) stopSearch(); return; }
    if (!onScreen()) { s.parked = true; return; }
    const h = sliceOf(s.from, s.r.input);
    if (h < 1) return endSearch(s);                            // as far as the core can look
    let out;
    try { out = await call({ fn: "plan", ...s.r.input, from: s.from, horizon: h }); } catch { if (srch === s) stopSearch(); return; }   // the worker died or was cancelled: the next renderPath starts over
    if (!valid()) return;                                      // a newer build / toggle / snapshot: this answer is dropped
    if (!out || out.ok !== true) return endSearch(s);         // the core's guard said no: as far as it can look
    while (document.querySelector('#path .pbuild[aria-expanded="true"]')) {   // a redraw would shut the open build list: wait
      await new Promise(res => setTimeout(res, 150));
      if (!valid()) return;
    }
    const prev = s.lanes;
    s.r = { ...s.r, out };
    s.lanes = foundLanes(s.r, prev, true);
    s.from += h; s.looked = lookedOf(s.from); if (s.looked > FAR) s.nudge = true;
    real = true; shown = { id: s.b.id, lanes: s.lanes, totals: out.totals };
    draw(s.b, s.lanes, out.totals); paintSearch();
    if (!s.lanes.some(l => l.searching)) { clearTimeout(s.timer); s.over = true; saveSearch(s, true); return; }
    saveSearch(s, false);
  }
}
// the widget's numbers are set in place (not in the html), so the bar grows and the line fades instead of being redrawn
function paintSearch() {
  const s = srch; if (!s) return;
  const pct = s.ended ? 100 : 100 * s.looked / (s.looked + 10000);   // keeps growing, never full, until the search ends
  for (const w of document.querySelectorAll("#path .lsearch")) {
    w.classList.toggle("end", !!s.ended);
    w.querySelector(".lsbar i").style.width = pct.toFixed(2) + "%";
    w.querySelector(".lslab").textContent = s.ended ? `Not within ${fmt(s.looked)} battles.` : `Looked ${fmt(s.looked)} battles ahead`;
    w.querySelector(".lnudge").classList.toggle("on", s.nudge);
  }
}
// the core can't look further (past 1,000,000 seed steps, or its ticket guard): the bar settles full and grey, one line says how far
function endSearch(s) { clearTimeout(s.timer); s.over = s.ended = s.nudge = true; paintSearch(); saveSearch(s, true); }
{ const host = document.getElementById("path");               // back on the screen: a parked search goes on
  if (host) new MutationObserver(() => { const s = srch; if (s && s.parked && onScreen()) { s.parked = false; runSearch(s); } }).observe(host, { attributes: true, attributeFilter: ["class"] }); }

// A replan you asked for (a cap stepped, a toggle flipped): the lanes on screen stay until the new plan is drawn, their
// tracks and costs dimmed and the cap you touched rippling its pips. Shown only from RCWAIT ms in (a quick answer shows
// nothing) and then for at least RCMIN ms; lifting it fades back, the fresh lanes included. RCMAX: never stuck on.
const RCWAIT = 180, RCMIN = 420, RCMAX = 20000;
let rcWant = null, rcT = 0, rcAt = 0, rcOff = 0, rcCap = null;
export function busyOn(cap = null) { rcWant = { cap }; }           // the next renderPath that asks the core arms it
function busyArm() {
  const w = rcWant; rcWant = null;
  if (!w) return;
  clearTimeout(rcOff); rcOff = 0;
  if (w.cap != null) rcCap = w.cap;
  if (rcAt) return busyPaint();
  if (!rcT) rcT = setTimeout(() => { rcT = 0; rcAt = performance.now(); busyPaint(); rcOff = setTimeout(busyClear, RCMAX); }, RCWAIT);
}
function busyPaint() { const h = document.getElementById("path"); if (!h) return; h.classList.add("recalc"); if (rcCap != null) h.dataset.rc = rcCap; else delete h.dataset.rc; }
function busyClear() { rcOff = 0; rcAt = 0; rcCap = null; const h = document.getElementById("path"); if (h) { h.classList.remove("recalc"); delete h.dataset.rc; rcLift = performance.now(); busyFade(h); } }
// the fade back runs on whatever lanes are drawn: a redraw within RCFADE ms of the lift (a search slice, a live redraw) plays the rest on the new markup
const RCFADE = 260, RCSEL = ".lanes > .lane :is(.tview, .lsearch, .lfarnote, .lcost)";
let rcLift = -1e9;
function busyFade(host) {
  const t = performance.now() - rcLift;
  if (t >= RCFADE) return;
  for (const el of host.querySelectorAll(RCSEL)) { const a = el.animate({ opacity: [.35, 1] }, { duration: RCFADE, easing: "ease-out" }); a.currentTime = t; }
}
function busyOff() {
  rcWant = null; clearTimeout(rcT); rcT = 0;
  if (!rcAt) { rcCap = null; return; }
  clearTimeout(rcOff);
  rcOff = setTimeout(busyClear, Math.max(0, RCMIN - (performance.now() - rcAt)));
}
export function renderPath() {
  const b = pathBuild(), snaps = b && liveSnaps();
  if (ticking && snaps && ticking.key === keyOf(b, snaps)) { real = true; return; }
  ticking = null;
  real = false;
  if (srch && snaps && srch.key === keyOf(b, snaps)) {         // nothing changed: the search for exactly this goes on
    real = true; draw(b, shown.lanes, shown.totals); paintSearch(); busyOff();
    return;
  }
  stopSearch();
  tipStop(b, snaps);
  if (!b) { gen++; shown = null; draw(b, []); busyOff(); return; }
  if (!snaps) { gen++; shown = null; draw(b, planNow(planInput(b)).lanes); busyOff(); return; }   // no companion: the mockup's route
  real = true;
  draw(b, shown && shown.id === b.id ? shown.lanes : null, shown && shown.totals);   // the previous lanes stay until the new route arrives
  const my = ++gen, key = keyOf(b, snaps), t0 = Date.now();
  busyArm();
  planLive(b, snaps).then(r => {
    if (my !== gen) return;
    if (!r) return busyOff();
    const lanes = toLanes(r), prev = shown && shown.id === b.id && shown.seen ? shown : null;
    const kinds = prev ? classify(prev.lanes, lanes, prev.seen, r.seen) : null;   // what the snapshot did to each lane (path-tick.ts)
    shown = { id: b.id, lanes, totals: r.out && r.out.totals, seen: r.seen };
    liveIds = { id: b.id, seen: r.seen };
    const after = () => { if (lanes.some(l => l.searching)) { tipRun = null; showTip(null); startSearch(b, r, lanes, key, t0); } else runTips(b, r, lanes, key); };
    if (!kinds || kinds.every(k => k === "same")) { draw(b, lanes, shown.totals); busyOff(); return after(); }
    busyOff();
    const mine = ticking = { key };
    playTick(document.getElementById("path"), kinds, () => draw(b, lanes, shown.totals), () => my === gen)
      .then(() => { if (ticking === mine) ticking = null; if (my === gen) after(); }, e => { if (ticking === mine) ticking = null; console.error("path tick", e); if (my === gen) { draw(b, lanes, shown.totals); after(); } });
  }, e => { if (my === gen) busyOff(); console.error("path plan", e); });
}
subscribe(ev => { if ((ev === "snapshot" || ev === "state") && (shown || liveSnaps())) renderPath(); });

/* ---------- "more chunks would save rolls" (path-tip.ts): once a plan has settled (no lane searching) with Chunks on, the
   same input is asked again with one goal ability's stock at its next slap tier, at most 3 what-ifs, one after another,
   through the plan cache (a reload asks nothing again). A newer build, toggle or snapshot drops the run; the card stays
   only while its build is the one shown. ---------- */
let tipRun = null;                                             // { k0: keyOf when started, k: the plan input, bid }
let tipBid = null;                                             // the build the shown suggestion is for
function tipStop(b, snaps) {
  if (tipRun && (!snaps || tipRun.k0 !== keyOf(b, snaps))) tipRun = null;
  if (!b || !snaps || !ui.useChunks || tipBid !== b.id) { tipBid = null; showTip(null); }
}
async function whatIf(input) {                                 // as corePlan, but never the stub's answer
  const hit = planCache.get(input);
  if (hit) return hit.first;
  const { mock, ...req } = input;
  const r = await call({ fn: "plan", ...req });
  if (r && r.ok === true) { planCache.putFirst(input, r); return r; }
  return null;
}
function runTips(b, r, lanes, k0) {
  if (!ui.useChunks || !r.out || r.out.unreachable.length || !complete(lanes, lanes.length)) { tipRun = null; tipBid = null; showTip(null); return; }
  const k = JSON.stringify(r.input);
  if (tipRun && tipRun.k === k) { tipRun.k0 = k0; return; }    // the same question: running or answered
  const me = tipRun = { k0, k }, base = rollsOf(lanes), asks = tipAsks(r.input, SUBS);
  (async () => {
    const res = [];
    for (const q of asks) {
      if (tipRun !== me) return;
      let out = null;
      try { out = await whatIf(q.input); } catch {}
      if (tipRun !== me) return;
      const wl = out && out.ok && Array.isArray(out.lanes) && out.lanes.length === r.out.lanes.length && !out.unreachable.length ? toLanes({ ...r, out }) : null;
      if (wl && complete(wl, lanes.length)) res.push({ a: q.a, extra: q.extra, rolls: rollsOf(wl) });   // summed as the cost rows count
    }
    const t = bestTip(base, res);
    tipBid = t ? b.id : null;
    showTip(t && { ...t, name: NAMES[t.a], art: chunkCell({ a: t.a }) });
  })();
}

// The live steps' inputs (path-tick.ts liveSteps): which piece each lane plans (the last live plan's), whether the plan rolls
// it in the coming battle, and what the botbase snapshot says is worn, its XP and the active drink. Seeds don't move when
// gear is swapped, so none of this replans: it only changes the Up next card.
const rollNow = (l, cols) => {
  if (l.note || l.searching || !l.steps.length) return undefined;
  const r = l.steps.find(isRollAct);
  return r && spanOf(l.steps, cols)(r)[0] <= nowCol(cols) ? { d: r.k === "drink" ? r.d : null } : null;
};
function liveOf(b, lanes, cols) {
  const snap = liveSnaps()?.botbase;
  if (!real || !snap || !liveIds || liveIds.id !== b.id) return null;
  const drink = "drink" in snap ? snap.drink : undefined;
  const rows = lanes.map((l, i) => ({ slot: liveIds.seen[i]?.slot, gearId: liveIds.seen[i]?.gearId, roll: rollNow(l, cols) }));
  return { steps: liveSteps(rows, snap.pieces || [], snap.wearing, drink, warnAt(snap.xpGainMax)), drink };
}
// A live step coming or going swaps the card's shown page the way a flip does: the old one leaves upward, the new one rises
// in (each stack keeps its tallest page's size, so nothing around it moves); the side dots cross-fade.
const SOFT = "cubic-bezier(.2,.8,.2,1)", OUT = "cubic-bezier(.4,0,1,1)";
function upSave(host) {
  const card = host.querySelector(".pl > .tag.next:not(.pcnext)");
  if (!card) return null;
  const pages = {};
  for (const st of card.querySelectorAll(".ustack")) { const p = st.querySelector(":scope > .upg.on"); if (p) pages[st.className] = p; }
  return { live: card.dataset.live, pages, dots: card.querySelector(":scope > .udots") };
}
function upSwap(host, old) {
  const card = host.querySelector(".pl > .tag.next:not(.pcnext)");
  if (!card || !old || old.live === undefined || card.dataset.live === old.live) return;
  const rm = matchMedia("(prefers-reduced-motion: reduce)").matches, gone = el => () => el.remove();
  for (const st of card.querySelectorAll(".ustack")) {
    const was = old.pages[st.className], now = st.querySelector(":scope > .upg.on");
    if (was) {
      was.classList.remove("on"); was.style.visibility = "visible"; was.setAttribute("aria-hidden", "true"); st.append(was);
      was.animate(rm ? { opacity: [1, 0] } : { opacity: [1, 0], translate: ["0px 0px", "0px -16px"] }, { duration: 180, easing: OUT, fill: "forwards" }).finished.then(gone(was), gone(was));
    }
    now?.animate(rm ? { opacity: [0, 1] } : { opacity: [0, 1], translate: ["0px 16px", "0px 0px"] }, { duration: 300, delay: rm ? 0 : 70, easing: SOFT, fill: "backwards" });
  }
  const dots = card.querySelector(":scope > .udots");
  if (old.dots && (!dots || dots.innerHTML !== old.dots.innerHTML)) {
    old.dots.style.pointerEvents = "none"; card.append(old.dots);
    old.dots.animate({ opacity: [1, 0] }, { duration: 180, easing: OUT, fill: "forwards" }).finished.then(gone(old.dots), gone(old.dots));
  }
  if (dots && (!old.dots || dots.innerHTML !== old.dots.innerHTML)) dots.animate({ opacity: [0, 1] }, { duration: 220, delay: 70, easing: SOFT, fill: "backwards" });
}

// a lane's battles: its last roll's column (a burn group ends N-1 columns after its key) x BATTLES_PER_ROLL, as the core counts
const laneBattles = steps => Math.ceil(Math.max(0, ...steps.filter(isRollAct).map(s => s.key + (s.times || 1) - 1)) * BATTLES_PER_ROLL - 1e-9);
const searchBox = `<div class="lsearch"><div class="lsbar"><i></i></div><span class="lslab"></span><span class="lnudge">${NUDGE}</span></div>`;
function farBox(l, track) {                                    // a lane found by the search: its route, its battles, and the nudge if it's far
  const n = laneBattles(l.steps);
  return `<div class="lfar${l.fresh ? " lfound" : ""}">${track}<div class="lfarnote"><span class="lslab"><b>${fmt(n)}</b> ${n === 1 ? "battle" : "battles"}</span>${n > FAR ? `<span class="lnudge on">${NUDGE}</span>` : ""}</div></div>`;
}

// the cap widgets fade with the Chunks pill: a draw within LFADE ms of it flipping plays the rest of the fade on the new markup
const LFADE = 220;
let capOn = null, capFlip = -1e9;
function fadeCaps(host) {
  const t = performance.now() - capFlip;
  if (t >= LFADE) return;
  for (const w of host.querySelectorAll(".ccap")) { const a = w.animate({ opacity: ui.useChunks ? [0, 1] : [1, 0], visibility: ["visible", "visible"] }, { duration: LFADE, easing: "ease-out" }); a.currentTime = t; }
}
function stepCap(w, v) {                                       // in place first (pips and tint fade by CSS), the drawn html patched to match, then the replan
  const b = pathBuild(), li = +w.dataset.cap, was = +w.getAttribute("aria-valuenow");
  if (!b || v === was) return;
  setCap(b, li, v);
  w.dataset.v = v; w.setAttribute("aria-valuenow", v); w.setAttribute("aria-valuetext", CAPS[v]); w.dataset.tip = `Chunks: ${CAPS[v]}`;
  w.querySelectorAll(".pips i").forEach((p, k) => p.classList.toggle("lit", k < v));
  lastHtml = lastHtml.replace(capBox(li, was, true), capBox(li, v, true));
  busyOn(li);
  renderPath();                                                // the lanes on screen stay until the plan for the new cap arrives
}
// Press a cap and a strip of its four levels pops out above it (below when there is no room), the current one underlined;
// the current level sits right above the widget. Hold and slide left/right (only x counts) and let go to pick the level
// nearest the pointer. A press that never slides steps round as a click; Esc while held changes nothing. The strip lives on <body> (a ~1 s live redraw of #path would wipe it) and is
// zoomed like the lanes; the pointer is captured by the widget and followed on window, so a redraw mid-press loses nothing.
let hold = null;
const capWidget = li => document.querySelector(`#path .ccap[data-cap="${li}"]`);
function capOptAt(x) {                                         // once the press has slid sideways: the option nearest the pointer's x (y doesn't matter)
  if (!hold?.moved) return -1;
  let best = -1, d = 1e9;
  hold.mids.forEach((m, i) => { if (Math.abs(x - m) < d) { d = Math.abs(x - m); best = i; } });
  return best;
}
function capClose() {
  const el = hold?.el; hold = null;
  if (!el) return;
  el.classList.remove("on");
  setTimeout(() => el.remove(), 200);                          // after its 120 ms fade
}
function capDown(e) {
  const w = e.target.closest?.("#path .ccap");
  if (!w || e.button !== 0 || hold || w.classList.contains("off")) return;
  const cur = +w.getAttribute("aria-valuenow"), r = w.getBoundingClientRect(), z = w.currentCSSZoom || 1;
  const el = document.createElement("div");
  el.className = "ccpick"; el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<div class="ccin" style="zoom:${z}">${[0, 1, 2, 3].map(v => `<span class="cco${v === cur ? " cur" : ""}" data-v="${v}">${capFace(v)}</span>`).join("")}</div>`;
  document.body.append(el);
  const box = el.firstElementChild, s = el.getBoundingClientRect(), gap = 8 * z;
  let top = r.top - s.height - gap;
  const below = top < 4;
  if (below) top = r.bottom + gap;
  el.style.left = `${Math.max(4, Math.min(innerWidth - s.width - 4, (r.left + r.right - s.width) / 2))}px`;
  el.style.top = `${Math.min(innerHeight - s.height - 4, top)}px`;
  el.classList.toggle("below", below);
  box.style.transition = "none"; box.style.transform = "none";                    // measured at rest, not mid pop
  const opts = [...box.children];
  let mids = opts.map(o => { const q = o.getBoundingClientRect(); return (q.left + q.right) / 2; });
  // the current level sits right above the widget, so sliding left/right from the press walks the levels
  const want = (r.left + r.right) / 2 - mids[cur], l0 = parseFloat(el.style.left), l1 = Math.max(4, Math.min(innerWidth - s.width - 4, l0 + want));
  el.style.left = `${l1}px`; mids = mids.map(m => m + l1 - l0);
  box.style.transition = box.style.transform = "";
  el.getBoundingClientRect();                                  // the closed look is the start of the pop
  el.classList.add("on");
  hold = { id: e.pointerId, li: +w.dataset.cap, cur, x0: e.clientX, el, opts, mids, moved: false, hot: -1 };
  w.setPointerCapture?.(e.pointerId);
}
function capMove(e) {
  if (!hold || e.pointerId !== hold.id) return;
  if (Math.abs(e.clientX - hold.x0) > 6) hold.moved = true;
  const i = capOptAt(e.clientX);
  if (i !== hold.hot) { hold.hot = i; hold.opts.forEach((o, k) => o.classList.toggle("hot", k === i)); }
}
function capUp(e) {
  if (!hold || e.pointerId !== hold.id) return;
  capMove(e);
  const { li, hot, moved, cur } = hold, w = capWidget(li);
  capClose();
  if (!w) return;
  if (moved) { if (hot >= 0 && hot !== cur) stepCap(w, hot); }
  else stepCap(w, (cur + 1) % 4);
}
addEventListener("pointermove", capMove, true);
addEventListener("pointerup", capUp, true);
addEventListener("pointercancel", e => { if (hold && e.pointerId === hold.id) capClose(); }, true);
addEventListener("keydown", e => { if (hold && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); capClose(); } }, true);
{ const host = document.getElementById("path");
  host?.addEventListener("pointerdown", capDown);
  for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) host?.addEventListener(ev, () => { held = null; }, { passive: true });   // you scrolled: no lane to put back
  host?.addEventListener("click", e => { if (e.target.closest?.(".tog[data-t]")) busyOn(); }, true);   // before wiring.ts flips it and replans
  // a pointer's click was dealt with on pointerup (capUp); a click with no pointer (Enter, Space) steps round
  host?.addEventListener("click", e => { const w = e.target.closest?.(".ccap"); if (w && e.detail === 0) stepCap(w, (+w.getAttribute("aria-valuenow") + 1) % 4); });
  host?.addEventListener("keydown", e => {
    const w = e.target.closest?.(".ccap"), d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!w || !d) return;
    e.preventDefault();
    stepCap(w, Math.max(0, Math.min(3, +w.getAttribute("aria-valuenow") + d)));
  }); }

// While a build's first plan is worked out (no lanes yet): the three lanes as they will stand, the build's gear on the left
// and its goal on the right, and between them a row of cells in the real lanes' own markup (laneSteps): solid rings for
// rolls, dashed ones for rolls a later scrub throws away, at most one "?" scrub a lane, blank dots, dimmed labels under
// them, column 1 the yellow next step. A main that must change needs no planner (mainJobs): that lane starts with the real
// Main cell and the other lanes with a dot, as the real lanes will. A yellow ring sweeps along each row and every ring it
// passes flicks through a few abilities and lands on one, like a roll (a Main's chunks flick and land on the goal); a
// while later they go back to "?" in the same order, and it loops (opacity and transform only, every ring on one PCP
// cycle, its place in it set by its delay). Seeded by the build, so the ~1 s live redraws leave it alone. Reduced motion:
// still "?" rings, same layout. pcFit shows only the whole columns in view (as path-pan does at rest). When the plan
// lands, calcLand moves its cells onto the real lanes' cells and lands them one by one.
const PCN = 16, PCSTEP = .32, PCLANE = .2, PCP = 3.2, PCFLICK = .07;   // columns a row, s between columns / rows, the cycle, one flick
// a rolling face: `rest` (a ring's "?"), four flicks, the landed one (`land`, else a random sub); t = its place in the PCP
// cycle (a negative delay), r = the build's rng
function pcFaces(r, t, rest = "Unknown", land = "") {
  const a = [...SUBS]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  const img = (id, c, at) => `<img class="${c}" src="${L}/skill/${id}.png" alt="" style="animation-delay:${(t + at).toFixed(2)}s">`;
  return img(rest, "q", 0) + a.slice(0, 4).map((id, m) => img(id, "f", m * PCFLICK)).join("") + img(land || a[4], "l", 4 * PCFLICK);
}
const pcRing = (r, t, z, cls = "") => `<div class="pcc${cls}" style="--t:${t}s"><div class="ab z${z}">${pcFaces(r, t)}</div></div>`;
// a chunk whose ability flicks and lands on `a` (the Main cell's)
const pcChunk = (r, t, a, style = "") => `<span class="chunkonly"${style}><span class="edge"></span><span class="fill"></span>${pcFaces(r, t, a, a)}</span>`;
// one calculating lane's track: real step classes and columns, so each cell lies where a real lane's cell will
function pcTrack(r, i, j, anyMain) {
  const t = c => +((c - 1) * PCSTEP + i * PCLANE - PCP).toFixed(2), out = [];
  const cell = (c, cls, body, label = "") => `<div class="step pcs ${cls}${c === 1 ? " first" : ""}" style="grid-column:${c};--t:${t(c)}s"><div class="vis">${body}</div>${label ? `<span class="n">${label}</span>` : ""}</div>`;
  const dot = c => `<div class="step pcs ph${c === 1 ? " first" : ""}" style="grid-column:${c}"><div class="vis"><span class="phdot"></span></div></div>`;
  let roll = 0, c = 1;
  const ring = (c, cls) => cell(c, cls, `<div class="ab z52">${pcFaces(r, t(c))}</div>`, `Roll ${++roll}`);
  if (anyMain) {                                               // the Main is Murch work before the first battle: column 1, the other lanes a dot there
    if (j.swap) {
      const parts = j.parts, body = parts.length > 1 ? `<span class="chunktrio">${parts.map(([a], k) => pcChunk(r, t(1), a, ` style="position:absolute;left:${TRIO[k][0]}px;top:${TRIO[k][1]}px;scale:.56;transform-origin:0 0;--cr:0deg"`)).join("")}</span>` : pcChunk(r, t(1), parts[0][0]);
      out.push(cell(1, "slapped here murch", body + `<span class="cnum" style="--ct:${hash32(`main:${i + 1}:${j.goal}`) % 31 - 15}deg">×${parts[0][1]}</span>`, "Main"));
    } else out.push(dot(1));
    c = 2;
  }
  out.push(ring(c, j.swap ? "keep" : "keep here")); c++;       // the next step: the first roll, unless the Main is
  const scrub = r() < .45 ? c + 1 + Math.floor(r() * 4) : 0, burn = scrub ? 1 + Math.floor(r() * Math.min(3, scrub - c)) : 0;   // one scrub a lane at most, 1-3 thrown-away rolls before it
  for (; c <= PCN; c++) out.push(c === scrub ? cell(c, "tool", `<div class="ab z52">${qmark}</div>`, "Scrub") : scrub && c >= scrub - burn && c < scrub ? ring(c, "past") : r() < .4 ? dot(c) : ring(c, "keep"));
  return `<div class="pctview" aria-hidden="true"><div class="track grid" style="grid-template-columns:repeat(${PCN}, var(--col))">${out.join("")}</div></div>`;
}
// only the whole columns in view show (path-pan's rest window), so a cell never sits cut at the right edge
function pcFit(host) {
  for (const v of host.querySelectorAll(".pcalc:not(.out) .pctview")) {
    const t = v.firstElementChild, col = parseFloat(getComputedStyle(t).gridTemplateColumns), vw = v.clientWidth;
    if (!(col > 0) || !vw) continue;
    const n = Math.max(1, Math.floor(vw / col + 1e-6));
    for (const el of t.children) el.style.visibility = parseInt(el.style.gridColumn) > n ? "hidden" : "";
  }
}
// what the calculating screen can already show for real: the pieces the plan will use (choosePieces, synchronous) and
// their slots, so the lane heads, caps and goals are the ones the plan lands with
function calcPieces(b) {
  const snaps = liveSnaps();
  const ch = snaps ? choosePieces(b, snaps, { fixedOrder: ui.fixedOrder, overrides: readOverrides(store), keep }) : [];
  return [0, 1, 2].map(i => {
    const [row, , subs] = b.set[i] || ["", "", []], c = ch[i], p = c && c.piece;
    return { main: mainJobs(b, ch)[i], row: (p && p.row) || row || "", have: [0, 1, 2].map(k => [(p && p.subs && p.subs[k]) || "", ""]), goal: [0, 1, 2].map(k => (subs && subs[k]) || ""), open: c ? openSlots(p) : null, piece: !!p };
  });
}
// the yellow Up next banner while the first plan is worked out: the same banner (its ink seeded by the build), the three
// pieces' gear flicking in turn and a rolling ring where the next step goes, an empty bar under where the title goes.
// When the plan lands the real banner takes its place: calcLand keeps this one's flow on it until its ring lands.
function calcNext(b, pcs) {
  const r = rng(hash32(`${buildKey(b)}:calcnext`)), rows = [...new Set(pcs.map(p => p.row))];
  const gears = rows.map((row, i) => `<div class="pcg" style="animation-delay:${(i * .4 - 1.2).toFixed(1)}s">${gear(row)}</div>`).join("");
  return `<div class="tag next tilt-l2 pcnext" aria-hidden="true">
      ${nextInk(b)}
      <span class="sticker ribbon">Up next</span>
      <div class="flow"><div class="pcgears${rows.length > 1 ? "" : " one"}">${gears}</div><span class="arrow">›</span>${pcRing(r, -PCP + .4, 56, " first")}</div>
      <div><div class="ustack utitle"><div class="upg on"><h2 style="visibility:hidden"><span>&nbsp;</span></h2></div></div><div class="unbattles"><div class="ubar"><i style="width:0%"></i></div><span style="visibility:hidden"><b>0</b></span></div></div>
      <div class="badges"></div>
    </div>`;
}
// The banner's title is a box of two lines (live.css); a title that needs three steps its font size down until it fits two.
function fitTitles(host) {
  for (const h of host.querySelectorAll(".next .utitle h2")) {
    const t = h.firstElementChild;
    if (!t || !h.clientHeight) continue;                       // drawn while hidden: the ResizeObserver below fits it when it gets a size
    t.style.fontSize = "";
    for (let px = parseFloat(getComputedStyle(t).fontSize); t.offsetHeight > h.clientHeight + 1 && px > 18;) t.style.fontSize = (px -= 2) + "px";
  }
}
{ const host = document.getElementById("path"); if (host) new ResizeObserver(() => { fitTitles(host); fitCosts(host); pcFit(host); }).observe(host); }
function calcBox(b, pcs, caps) {
  const r = rng(hash32(`${buildKey(b)}:calc`)), anyMain = pcs.some(p => p.main.swap);
  const rows = pcs.map((p, i) => {
    const cap = capBox(i, caps[i], ui.useChunks).replace('<button class="ccap', '<button inert tabindex="-1" aria-hidden="true" class="ccap pcskel').replace(/ data-cap="\d"/, "");
    return `<div class="pclane t${i + 1}"><span class="cap"><b>${(GEAR[p.row] || [""])[0]}</b></span><div class="lnow">${gear(p.row)}<div class="have">${headMain(p.main)}${p.have.map((h, k) => haveSlot(h, k, p.open)).join("")}</div></div>${pcTrack(r, i, p.main, anyMain)}<div class="lend">${p.piece ? cap : ""}<div class="goal">${goalMain(p.main)}${p.goal.map(g => slot([g, ""], 36)).join("")}</div>${p.piece ? '<div class="lcost pcghost" aria-hidden="true"><span class="lc"><b>0</b> rolls</span></div>' : ""}</div></div>`;
  });
  return `<div class="pcalc" role="status" aria-label="Calculating a path">${rows.join("")}</div>`;
}
function calcSaved(host, calc) {                               // where the calculating strips were and how far their loops had got
  const rc = calc.getBoundingClientRect();
  return { top: rc.top, h: rc.height, t: calc.getAnimations({ subtree: true }).map(a => [a.effect?.target, a.animationName, a.currentTime]) };
}
// The plan lands cell by cell, left to right (W16): the real lanes are drawn at once, every cell hidden, and the calculating
// cell of its column (the same node, its loop where it was) sits on it in the same grid cell, still rolling. In turn (the
// banner's ring first, then each lane from the top, LANDCELL ms a column, a lane under ~1.1 s) a ring flicks, stops, and the
// real cell pops in under it with the roll's own settle, its label fading in; a column past the plan's end becomes a blank
// dot the same way, and those dots fade off once the lane is done. Opacity and transform only; nothing cross-fades as a
// whole. A redraw meanwhile puts the same calculating nodes back on the new cells and goes on from the same clock (landApply).
const LANDCELL = 100, LANDLANE = 120, LANDFIRST = 140, LANDNEXT = 60, LANDPOP = 288, LANDEASE = "cubic-bezier(.2,.8,.2,1)";
let land = null;                                               // { id, t0, V, step, phs: [lane][calc cells], wrap, end, clips, timers }
const landAnims = new WeakMap();                               // a calculating node: the hide animations landApply gave it
const landT = (i, c) => LANDFIRST + i * LANDLANE + (Math.max(1, Math.min(c, land.V)) - 1) * land.step;
const landRestore = (el, times) => { for (const a of el.getAnimations({ subtree: true })) { if (!a.animationName) continue; const s = times.find(x => x[0] === a.effect?.target && x[1] === a.animationName); if (s && s[2] != null) a.currentTime = s[2]; } };
const landSave = () => land ? [...land.phs.flat(), land.wrap].filter(el => el?.isConnected).flatMap(el => el.getAnimations({ subtree: true }).filter(a => a.animationName).map(a => [a.effect?.target, a.animationName, a.currentTime])) : [];
// a calculating ring's loop put at the moment its flicks start, so it lands (stops) at T; t: its place in the PCP cycle
function landFlick(L, el, T) {
  if (land !== L || !el.isConnected) return;
  const ph = Math.max(0, Math.min(4 * PCFLICK, 4 * PCFLICK - (T - (performance.now() - L.t0)) / 1000)), t = parseFloat(el.style.getPropertyValue("--t")) || 0;
  for (const a of el.getAnimations({ subtree: true })) if (a.animationName) a.currentTime = (t + ph + 3 * PCP) * 1000;
}
function landEnd() {
  if (!land) return;
  for (const id of land.timers) clearTimeout(id);
  for (const el of [...land.phs.flat(), land.wrap]) el?.remove();
  for (const [v, was, mine] of land.clips) if (v.style.clipPath === mine) v.style.clipPath = was;
  land = null;
}
function calcLand(host, b, calc, at, oldNext, nextAt) {
  landEnd();
  const nx = host.querySelector(".pl > .tag.next");
  if (nx && oldNext && nx.classList.contains("pcnext")) { nx.replaceWith(oldNext); landRestore(oldNext, nextAt.t); }   // still searching: the calculating banner goes on as it was
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("st-still")) return;   // an instant swap
  const phs = [...calc.querySelectorAll(".pclane")].map(l => [...l.querySelectorAll(".track > .step")].filter(el => el.style.visibility !== "hidden"));
  const V = Math.max(1, ...phs.map(p => p.length)), step = Math.min(LANDCELL, 1100 / V);
  const L = land = { id: b.id, t0: performance.now(), V, step, phs, wrap: null, end: LANDFIRST + 2 * LANDLANE + (V - 1) * step + LANDPOP, clips: [], timers: [] };
  const f = nx && oldNext && !nx.classList.contains("pcnext") && oldNext.querySelector(":scope > .flow");
  if (f) { const w = L.wrap = document.createElement("div"); w.className = "pcnext"; w.setAttribute("aria-hidden", "true"); w.style.cssText = "position:absolute;left:0;top:0;margin:0;z-index:2;pointer-events:none"; w.append(f); }
  landApply(host, at.t.concat(nextAt?.t || []));
  const later = (fn, ms) => L.timers.push(setTimeout(fn, Math.max(0, ms - (performance.now() - L.t0))));
  const pcc = L.wrap?.querySelector(".pcc"); if (pcc) later(() => landFlick(L, pcc, LANDNEXT), LANDNEXT - 4 * PCFLICK * 1000);
  phs.forEach((cells, i) => cells.forEach(el => {
    const T = landT(i, parseInt(el.style.gridColumn));
    later(() => landFlick(L, el, T), T - 4 * PCFLICK * 1000);
    later(() => {                                              // past the plan's end: it lands on a blank dot
      if (land !== L || !el.isConnected || !el.classList.contains("pcx")) return;
      el.className = `step ph pcs pcx${el.classList.contains("first") ? " first" : ""}`;
      el.innerHTML = `<div class="vis"><span class="phdot"></span></div>`;
      el.firstElementChild.animate({ scale: ["1.14", "1"] }, { duration: LANDPOP, easing: LANDEASE });
    }, T);
  }));
  later(() => {                                                // the lanes are done: the dots past a plan's end fade off, then the calculating nodes go
    if (land !== L) return;
    const xs = phs.flat().filter(el => el.isConnected && el.classList.contains("pcx"));
    for (const el of xs) el.animate({ opacity: [1, 0] }, { duration: 260, easing: "ease-out", fill: "forwards" });
    L.timers.push(setTimeout(() => { if (land === L) landEnd(); }, xs.length ? 280 : 0));
  }, L.end);
}
function landApply(host, times) {
  const e = performance.now() - land.t0;
  const anim = (el, kf, T, dur, o = {}) => el && T + dur - e > 0 ? el.animate(kf, { delay: T - e, duration: dur, ...o }) : null;
  const hide = (el, T) => anim(el, [{ opacity: 0 }, { opacity: 0 }], 0, T);   // hidden until T, then whatever it is
  const fadeIn = (el, T, dur = 260) => anim(el, { opacity: [0, +getComputedStyle(el).opacity] }, T, dur, { easing: "ease-out", fill: "backwards" });
  host.querySelectorAll(".lanes > .lane").forEach((ln, i) => {
    const tr = ln.querySelector(".track.grid"), end = landT(i, land.V);
    if (!tr) { for (const x of ln.querySelectorAll(".lnote, .lsearch")) fadeIn(x, LANDFIRST + i * LANDLANE); return; }
    const real = new Map();
    for (const el of [...tr.children]) {
      const c = parseInt(el.style.gridColumn), T = landT(i, c), n = el.querySelector(":scope > .n");
      real.set(c, el);
      if (n) fadeIn(n, T, 220);
      hide(el, T);
      anim(el.querySelector(":scope > .vis"), { scale: ["1.14", "1"] }, T, LANDPOP, { easing: LANDEASE });
    }
    let extra = false;
    for (const ph of land.phs[i] || []) {
      const c = parseInt(ph.style.gridColumn), T = landT(i, c), x = !real.has(c);
      ph.classList.toggle("pcx", x);
      for (const a of landAnims.get(ph) || []) a.cancel();
      if (!x && T <= e) { ph.remove(); continue; }
      tr.append(ph); landRestore(ph, times); extra = extra || x;
      if (x) continue;
      const gone = { delay: T - e, duration: 1, fill: "forwards" };
      landAnims.set(ph, [ph.querySelector(":scope > .vis")?.animate({ opacity: [0, 0] }, gone), ph.animate({ opacity: [0, 0] }, { ...gone, pseudoElement: "::before" }),
        ph.querySelector(":scope > .n")?.animate({ opacity: [+getComputedStyle(ph.querySelector(":scope > .n")).opacity, 0] }, { delay: T - e, duration: 200, easing: "ease-out", fill: "forwards" })].filter(Boolean));
    }
    const v = tr.parentElement, cp = v?.style.clipPath || "";
    if (extra && cp.startsWith("inset(")) { const mine = cp.replace(/^inset\(\s*(\S+)\s+\S+/, "inset($1 0px"); land.clips.push([v, cp, mine]); v.style.clipPath = mine; }   // the columns past the plan stay in view while they land
    for (const x of ln.querySelectorAll(".lcost, .lfarnote")) fadeIn(x, end);
  });
  const nx = host.querySelector(".pl > .tag.next:not(.pcnext)"), w = land.wrap, pg = nx?.querySelector(":scope > .ustack.flow > .upg.on");
  if (!nx || !w || !pg) return;
  if (LANDNEXT > e) {                                          // the calculating flow over the real one, left edges and middles together
    nx.append(w); landRestore(w, times);
    const f = w.firstElementChild, r1 = pg.getBoundingClientRect(), r0 = f.getBoundingClientRect(), z = w.currentCSSZoom || 1;
    w.style.left = `${((r1.left - r0.left) / z).toFixed(1)}px`; w.style.top = `${((r1.top + r1.height / 2 - r0.top - r0.height / 2) / z).toFixed(1)}px`;
    for (const a of landAnims.get(w) || []) a.cancel();
    landAnims.set(w, [w.animate({ opacity: [0, 0] }, { delay: LANDNEXT - e, duration: 1, fill: "forwards" })]);
  } else w.remove();
  hide(pg.parentElement, LANDNEXT);
  anim(pg.lastElementChild, { scale: ["1.14", "1"] }, LANDNEXT, LANDPOP, { easing: LANDEASE });
  for (const x of nx.querySelectorAll(":scope > div:not([class]), :scope > .badges, :scope > .udots")) fadeIn(x, LANDNEXT + 120);
}
// A redraw keeps the lane you were looking at where it was on screen (#path scrolls inside itself, and the new markup can
// be taller or shorter above it: Up next coming or going, a lane turning into the searching strip). When the new page is
// too short to put it back, the next redraw tries again from the same place, unless you scrolled in between.
let held = null;                                               // { i, y, left }: lane index, its top in #path, the scrollTop left
const rowsOf = host => host.querySelectorAll(".lanes > .lane, .lanes > .pcalc:not(.out) > .pclane");
function holdScroll(host) {
  const top = () => host.getBoundingClientRect().top;
  let i, y;
  if (held && host.scrollTop === held.left) ({ i, y } = held);
  else {
    held = null;
    if (!host.scrollTop) return () => {};
    const t = top(), rs = [...rowsOf(host)];
    i = rs.findIndex(r => r.getBoundingClientRect().bottom > t);
    if (i < 0) return () => {};
    y = rs[i].getBoundingClientRect().top - t;
  }
  return () => {
    const at = () => { const r = rowsOf(host)[i]; return r ? r.getBoundingClientRect().top - top() : null; };
    const d = at(); if (d == null) { held = null; return; }
    if (Math.abs(d - y) >= .5) host.scrollTop += d - y;
    held = Math.abs(at() - y) >= 1 ? { i, y, left: host.scrollTop } : null;
  };
}
function draw(b, raw, totals) {                                // raw: lanes with their steps already keyed; null = none yet. totals: the core's (live plans)
  const host = document.getElementById("path"), mine = BUILDS.filter(x => x.mine).reverse();
  if (!b) {                                                    // nothing of yours yet: start one here
    host.innerHTML = lastHtml = `<div class="pl"><div class="pempty"><button class="newb" data-pnew aria-label="New build"><span class="plus">+</span><span>New build</span></button></div></div>`;
    return;
  }
  if (capOn !== null && capOn !== ui.useChunks) capFlip = performance.now();
  capOn = ui.useChunks;
  const caps = capsOf(b), searching = !!raw && raw.some(l => l.searching) && !raw.some(l => l.steps.length), pcs = !raw || searching ? calcPieces(b) : null;
  const L3 = raw || [], snapsNow = liveSnaps(), stk = stockOf(snapsNow), typed = stk ? null : typedStock(), hasTyped = !!typed && (sumOf(typed.chunks) + sumOf(typed.drinks) > 0);
  const nostock = !!snapsNow && !stk && !hasTyped && (ui.useChunks || ui.useDrinks);
  // with live snapshots but no Switch stock, a toggle's picture opens the typed counts (path-stock.ts); no numbers on the toggles
  const tap = k => !stk && snapsNow ? ` stktap" data-stock="${k}" role="button" aria-label="${k === "chunks" ? "Chunk" : "Drink"} counts" data-tip="${k === "chunks" ? "Chunk" : "Drink"} counts" aria-haspopup="dialog" aria-expanded="false` : "";
  const cols = pathCols(L3.filter(l => !l.note && !l.searching));
  const html = `
  <div class="pl">
    <div class="ptop">
      <button class="pbuild press" aria-haspopup="listbox" aria-expanded="false">
        ${wblob(b.weapon || ui.pick)}<h1>${esc(b.title)}</h1><span class="chev" aria-hidden="true"></span>
      </button>
      <div class="tgwrap"><div class="toggles">
        <button class="tog press ${ui.fixedOrder ? "on" : ""}" data-t="o"><span class="trio">${[1, 2, 3].map(n => `<span class="ab z26 num">${n}</span>`).join("")}</span>Fixed order<span class="knob"></span></button>
        <button class="tog press ${ui.useChunks ? "on" : ""}" data-t="c"><span class="chunklit${tap("chunks")}"><span class="edge"></span><span class="fill"></span>${qmark}</span>Chunks<span class="knob"></span></button>
        <button class="tog press ${ui.useDrinks ? "on" : ""}" data-t="d"><span class="tkt${tap("drinks")}"><img class="base" src="${T}" alt=""><img class="tic" src="${L}/skill/Unknown.png" alt=""></span>Drinks<span class="knob"></span></button>
      </div>${nostock ? `<span class="stknote">Chunk and ticket counts come from the Switch; none read yet.</span>` : ""}</div>
      <div class="ppick" hidden>
        <label class="pseek"><input class="pq" aria-label="Find a build" autocomplete="off" spellcheck="false"></label>
        <div class="prows" role="listbox" aria-label="Your builds">${mine.map(m => `
        <button class="pbrow ${m.id === b.id ? "on" : ""}" role="option" aria-selected="${m.id === b.id}" data-pb="${m.id}" data-q="${esc((m.title + " " + ((WEAPONS.find(w => w.row === (m.weapon || ui.pick)) || {}).name || "")).toLowerCase())}">
          <img class="pw" src="${wimg(m.weapon || ui.pick)}" alt=""><span class="pt">${esc(m.title)}</span>
          <span class="pg">${m.set.map(([row]) => row ? `<img src="${L}/gear/${row}.png" alt="">` : `<span class="blob empty" style="width:30px;height:30px" data-tip="Any gear"></span>`).join("")}</span>
        </button>`).join("")}
        </div>
      </div>
    </div>
    ${!raw || searching ? calcNext(b, pcs) : L3.some(l => l.note || l.searching) && !L3.some(l => l.steps.length) ? "" : upNextCard(b, L3, real ? totals : null, cols, liveOf(b, L3, cols))}
    <div class="lanes">${!raw ? calcBox(b, pcs, caps) : L3.map((l, li) => `
      <div class="lane t${li + 1}">
        <span class="cap"><b>${(GEAR[l.row] || [""])[0]}</b></span>
        <div class="lnow">${gear(l.row)}<div class="have">${headMain(jobOf(l, b, li))}${l.have.map((h, i) => haveSlot(h, i, l.open)).join("")}</div></div>
        ${l.note ? `<div class="lnote">${esc(l.note)}</div>`
          : l.searching ? searchBox
          : laneDone(l) ? doneTape(b, l, li)
          : (t => l.far ? farBox(l, t) : t)(`<div class="tview"><div class="track grid" style="grid-template-columns:repeat(${cols.length}, var(--col))">${laneSteps(l.steps.map((s, i) => ({ ...s, here: i === 0 })), cols)}</div></div>`)}
        <div class="lend">${l.note ? "" : capBox(li, caps[li], ui.useChunks)}<div class="goal">${goalMain(jobOf(l, b, li))}${l.goal.map(g => slot(g, 36)).join("")}</div>${l.note || l.searching ? "" : laneCost(l.steps, laneDone(l))}</div>
      </div>`).join("")}
    </div>
  </div>`;
  if (html !== lastHtml) {
    const f = document.activeElement?.closest?.("#path .ccap")?.dataset.cap;   // a cap in use keeps the focus through the redraw
    const calc = host.querySelector(".lanes > .pcalc"), calcAt = calc && calcSaved(host, calc), oldNext = host.querySelector(".pl > .pcnext"), nextAt = oldNext && calcSaved(host, oldNext);
    const put = holdScroll(host), up = upSave(host), lt = landSave();
    host.innerHTML = lastHtml = html; tipAttach(host); fitTitles(host); fitCosts(host); pcFit(host); pan.drawn(host, b.id); put(); fadeCaps(host); busyFade(host); donePop(host);   // put after the pan bar is back under the lanes: it's part of the height
    upSwap(host, up);
    if (calcAt && !host.querySelector(".lanes > .pcalc")) calcLand(host, b, calc, calcAt, oldNext, nextAt);
    else {
      if (oldNext && !calc) host.querySelector(".pl > .tag.next:not(.pcnext)")?.animate({ opacity: [0, 1] }, { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 160 : 380, easing: "ease-out" });   // a banner that took the calculating one's place (a search found its first step) fades in
      if (land) { if (land.id === b.id && !calc && host.querySelector(".lanes > .lane") && performance.now() - land.t0 < land.end) landApply(host, lt); else landEnd(); }   // a redraw mid-landing goes on with it
    }
    if (f != null) host.querySelector(`.ccap[data-cap="${f}"]`)?.focus({ preventScroll: true });
  }   // an unchanged plan leaves the page (and an open picker) alone; the lanes keep their place sideways
  reattach(host, !stk && !!snapsNow);                                        // an open count popover moves into the new markup
}

// forward references from earlier modules (they were one shared script scope in v52)
Object.assign(late, { renderPath, wblob });
initStock();
