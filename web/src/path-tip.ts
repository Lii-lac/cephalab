// @ts-nocheck
// "More chunks would save rolls" (W12): once the Path's plan has settled with Chunks on, path.ts asks the core again with one
// goal ability's chunk stock raised to its next slap tier (at most 3 what-ifs, one after another), and the one that saves the
// most rolls shows as a small card in the gap between the Up next banner and the lanes, right-aligned, over nothing you can
// press. It is one element, out of the flow (absolute in .lanes), moved into each redraw's .lanes by tipAttach (a fade under
// way goes on there); it fades in and out, and a dismissed suggestion stays dismissed (store: seedtracker.chunktip) until its
// ability, chunks or rolls change.
import { store } from "./store";

// a slap costs 10, 20, 30 chunks for a piece's 1st, 2nd, 3rd (core plan_final.cpp: cumulative 5(n+1)(n+2))
export const TIERS = [10, 30, 60];
export const nextTier = n => TIERS.find(t => t > n) ?? n + 10;
// the rolls the lanes' cost rows show, summed over the lanes
export const rollsOf = lanes => lanes.reduce((t, l) => t + (l.steps || []).filter(s => s.k === "roll" || s.k === "drink").reduce((u, s) => u + (s.times || 1), 0), 0);

// the what-ifs for a plan input: each standard ability its goals still lack (most-lacked first, at most `max`), its stock
// raised to the next tier. `whatIf` names the ability in the request (the core ignores it; tests tell the requests apart by it).
export function tipAsks(input, subs, max = 3) {
  const lack = new Map();
  for (const p of input.pieces) {
    if (p.maxChunks === 0) continue;                            // this piece takes no chunks
    const left = input.fixedOrder ? null : [...p.subs];
    p.goal.forEach((g, k) => {
      if (!g || !subs.includes(g)) return;
      if (left) { const i = left.indexOf(g); if (i >= 0) { left[i] = null; return; } }
      else if (p.subs[k] === g) return;
      lack.set(g, (lack.get(g) || 0) + 1);
    });
  }
  return [...lack.entries()].sort((x, y) => y[1] - x[1]).slice(0, max).map(([a]) => {
    const have = +(input.chunks || {})[a] || 0, to = nextTier(have);
    return { a, extra: to - have, input: { ...input, chunks: { ...input.chunks, [a]: to }, whatIf: a } };
  });
}
// a what-if's lanes count only when every lane has its route: none missing, searching, unreachable or a note
export const complete = (lanes, n) => lanes.length === n && lanes.every(l => l && !l.note && !l.searching && Array.isArray(l.steps));
// the what-if that saves the most rolls (ties: fewer extra chunks), or null when none saves one
export function bestTip(base, res) {
  const ok = res.filter(r => base - r.rolls >= 1).sort((x, y) => x.rolls - y.rolls || x.extra - y.extra);
  return ok.length ? { a: ok[0].a, extra: ok[0].extra, saved: base - ok[0].rolls } : null;
}

const DSTORE = "seedtracker.chunktip", FADE = 240;
const sig = t => `${t.a}:${t.extra}:${t.saved}`;
let card = null, cur = null, swapT = 0, fadeAt = -1e9, fadeIn = false;
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
function el() {
  if (card) return card;
  card = document.createElement("div");
  card.className = "psug"; card.id = "psug"; card.setAttribute("role", "status");
  card.innerHTML = `<span class="psart"></span><span class="pstx"></span><button class="psx" type="button" aria-label="Dismiss"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
  card.querySelector(".psx").addEventListener("click", () => { if (cur) { try { store.set(DSTORE, sig(cur)); } catch {} } showTip(null); });
  tipAttach(document.getElementById("path"));
  return card;
}
// after each #path redraw: the card goes into the new .lanes; a fade still under way plays its rest there (a re-inserted
// node starts from its end style, which would cut the fade)
export function tipAttach(host) {
  const lanes = host && host.querySelector(".pl > .lanes");
  if (!card || !lanes || card.parentNode === lanes) return;
  lanes.prepend(card);
  const t = performance.now() - fadeAt;
  if (t < FADE) { const a = card.animate({ opacity: fadeIn ? [0, 1] : [1, 0], visibility: ["visible", "visible"] }, { duration: FADE, easing: EASE }); a.currentTime = t; }
}
const flip = (c, on) => { fadeAt = performance.now(); fadeIn = on; c.classList.toggle("show", on); };
function fill(c, t) {
  const n = t.saved, x = t.extra;
  c.querySelector(".psart").innerHTML = `<span>${t.art}</span>`;
  c.querySelector(".pstx").innerHTML = `<b>+${x}</b> ${t.name} ${x === 1 ? "chunk" : "chunks"}: <b>${n}</b> fewer ${n === 1 ? "roll" : "rolls"}`;
  c.dataset.a = t.a;
}
// t: { a, extra, saved, name, art } or null (hide). The same suggestion again changes nothing; another one fades the old
// out before the new fades in.
export function showTip(t) {
  if (t) { let d = null; try { d = store.get(DSTORE); } catch {} if (d === sig(t)) t = null; }
  const c = t || card ? el() : null;
  if (!c) return;
  if (t && cur && sig(t) === sig(cur)) return;
  clearTimeout(swapT); swapT = 0;
  const was = cur; cur = t;
  if (!t) { if (c.classList.contains("show")) flip(c, false); return; }
  if (was && c.classList.contains("show")) { flip(c, false); swapT = setTimeout(() => { swapT = 0; if (cur === t) { fill(c, t); void c.offsetWidth; flip(c, true); } }, FADE); return; }
  fill(c, t); void c.offsetWidth; flip(c, true);
}
