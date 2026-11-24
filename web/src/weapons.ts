// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "weapons"); behaviour must match v52.
import { ui } from "./state";
import { late } from "./late";
import { beadSquid } from "./beadsquid";
import { BANDS, bandFor, buildKey, hash32, inkFor, looksFor, rng } from "./identity";
import { BUILDS, L, MOCK, MODE, MODES, WEAPONS, ab, bkey, gear, spImg, subImg, wimg } from "./data";
import { sendouFor, slugFor, wantSendou } from "./sendou";
import { warm } from "./preload";

/* ================= WEAPONS (v15): arc + strip header from Alex's sketch ================= */
const CLASSICON = { Shooter: "00", Spinner: "01", Maneuver: "02", Blaster: "03", Charger: "04", Roller: "05", Brush: "06", Slosher: "07", Shelter: "08", Stringer: "09", Saber: "10" };
const classImg = c => `${L}/weapon_type/IconTypeWpn_${CLASSICON[c]}.png`;
export const CLASSNAME = { Shooter: "Shooters", Roller: "Rollers", Charger: "Chargers", Slosher: "Sloshers", Spinner: "Splatlings", Maneuver: "Dualies", Shelter: "Brellas", Blaster: "Blasters", Brush: "Brushes", Stringer: "Stringers", Saber: "Splatanas" };
export const SORTS = ["Main", "Sub", "Special"];

const CHEV = '<svg viewBox="0 0 40 56"><path d="M6 4l28 24L6 52" fill="none" stroke="#000" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 4l28 24L6 52" fill="none" stroke="#e6f53f" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// the screen opens on a random weapon each time (a fixed one with #w=<row>, which the visual tests use)
{ const want = new URLSearchParams(location.hash.slice(1)).get("w"), pool = WEAPONS.filter(w => CLASSNAME[w.cls]);
  const w0 = pool.find(w => w.row === want) || pool[Math.floor(Math.random() * pool.length)] || { cls: "Slosher", row: "Slosher_Diffusion_00" };
  ui.sortMode = "Main", ui.filt = w0.cls, ui.pick = w0.row; }
export function filters() {
  if (ui.sortMode === "Main") return Object.keys(CLASSNAME).filter(c => WEAPONS.some(w => w.cls === c)).map(c => ({ key: c, img: classImg(c), name: CLASSNAME[c] }));
  const f = ui.sortMode === "Sub" ? "sub" : "sp", seen = new Map();
  for (const w of WEAPONS) if (!seen.has(w[f])) seen.set(w[f], { key: w[f], img: f === "sub" ? subImg(w) : spImg(w), name: w[f] });
  return [...seen.values()];
}
const matches = w => ui.sortMode === "Main" ? w.cls === ui.filt : ui.sortMode === "Sub" ? w.sub === ui.filt : w.sp === ui.filt;
export const shown = () => WEAPONS.filter(matches);
const imgsOf = w => [wimg(w.row), subImg(w), spImg(w)];
// the weapons around strip index i, the ones ahead (dir) first: what the strip and the preview show next
function warmAround(i, dir = 1) {
  const n = S.list.length, out = [];
  if (!n) return;
  for (let k = 0; k <= S.side + 6; k++) {
    out.push(S.list[modn(i + (dir < 0 ? -k : k), n)]);
    if (k && k <= S.side + 2) out.push(S.list[modn(i - (dir < 0 ? -k : k), n)]);
  }
  warm([...new Set(out)].flatMap(imgsOf), true);
}
let warmedAll = false;
function warmEverything() {                         // once: every class's first weapon, then the rest when idle
  if (warmedAll) return;
  warmedAll = true;
  const firsts = Object.keys(CLASSNAME).map(c => WEAPONS.find(w => w.cls === c)).filter(Boolean);
  warm(firsts.flatMap(imgsOf));
  warm(WEAPONS.flatMap(imgsOf));
}
const prettyKit = s => s.replace(/^(Bomb_|Sp)/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
const SIDE = 3;          // cards drawn either side of the pick; the outer ones are cut off by the screen edge
/* ================= the weapon strip (v21): smooth and springy ================= */
// One DOM card per absolute index (…, -1, 0, 1, …): a card keeps its weapon for as long as it's on screen,
// so nothing swaps images mid-drag. Every frame only transforms change (translate3d, GPU).
// Motion: drag follows the finger 1:1; on release the recent velocity is projected forward and a critically
// damped spring settles on the nearest weapon. The yellow splat stays on the committed pick until it settles.
export const CW = 116, GAP = 8, STEP = CW + GAP;
export const S = { pos: 0, vel: 0, target: null, drag: false, raf: 0, side: 0, list: [], cards: new Map(), samples: [], committed: 0 };
export const modn = (i, n) => ((i % n) + n) % n;
/* ================= one scroll for the whole screen (v23) =================
   Scrolling down first slides the bead filter and the weapon strip up out of sight (the logo, tabs and
   Switch tag stay put), then scrolls the builds. Scrolling up does the reverse. One virtual position V:
   the first H pixels collapse the top, the rest is the builds' own scrollTop. Eased toward its target. */
const G = { V: 0, T: 0, H: 0, raf: 0, expect: 0 };
function collapseMax() {
  const w = document.getElementById("weapons"), b = document.getElementById("below");
  if (!w || !b) return 0;
  const c = G.V <= G.H ? G.V : G.H;   // undo the current collapse when measuring
  return Math.max(0, b.getBoundingClientRect().top + c - w.getBoundingClientRect().top - 50);
}
export function applyScroll() {
  const ps = document.querySelector(".pinscroll");
  const c = Math.min(G.V, G.H);
  document.documentElement.style.setProperty("--c", c.toFixed(1) + "px");
  document.documentElement.style.setProperty("--cf", (G.H ? c / G.H : 0).toFixed(4));
  document.documentElement.style.setProperty("--H", G.H.toFixed(1) + "px");
  document.documentElement.style.setProperty("--e", (G.H ? 1 - Math.exp(-G.V / (1.6 * G.H)) : 0).toFixed(4));
  const bs = document.getElementById("beadslot");
  if (bs) { bs.style.opacity = Math.max(0, 1 - c / 70).toFixed(3); bs.style.pointerEvents = c > 30 ? "none" : ""; }
  const hdr = document.querySelector("#weapons .hdr");
  if (hdr) { const k = Math.min(1, c / (G.H * .85)); hdr.style.opacity = (1 - k * k * (3 - 2 * k)).toFixed(3); }   // smoothstep out
  if (ps) { ps.scrollTop = Math.max(0, G.V - G.H); G.expect = ps.scrollTop; }
  const wsc = document.getElementById("weapons");   // v36: no top-fade mask once nearly collapsed, so the risen label isn't cut
  if (wsc) { if (G.H && c / G.H > .9) { wsc.style.setProperty("-webkit-mask", "none", "important"); wsc.style.setProperty("mask", "none", "important"); }
             else { wsc.style.removeProperty("-webkit-mask"); wsc.style.removeProperty("mask"); } }
}
function scrollLimit() {
  const ps = document.querySelector(".pinscroll"); if (!ps) return G.H;
  // once collapsed the builds box is H taller, so it can scroll H less
  return G.H + Math.max(0, ps.scrollHeight - (ps.clientHeight + (G.H - Math.min(G.V, G.H))));
}
function scrollTick() {
  G.T = Math.max(0, Math.min(scrollLimit(), G.T));
  const d = G.T - G.V;
  G.V = Math.abs(d) < .4 ? G.T : G.V + d * .2;
  applyScroll();
  G.raf = G.V === G.T ? 0 : requestAnimationFrame(scrollTick);
}
function initGlobalScroll() {
  G.H = collapseMax();
  const w = document.getElementById("weapons");
  if (w && !w.dataset.gs) {
    w.dataset.gs = 1;
    w.addEventListener("wheel", e => {
      if (e.defaultPrevented) return;               // the strip keeps its own wheel
      e.preventDefault();
      G.T += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      if (!G.raf) G.raf = requestAnimationFrame(scrollTick);
    }, { passive: false });
    let ty = null;                                   // touch: drag the page with the finger
    w.addEventListener("touchstart", e => { ty = e.touches[0].clientY; }, { passive: true });
    w.addEventListener("touchmove", e => {
      if (ty == null || e.target.closest("#vp")) return;
      e.preventDefault(); const y = e.touches[0].clientY; G.T += ty - y; ty = y;
      if (!G.raf) G.raf = requestAnimationFrame(scrollTick);
    }, { passive: false });
    window.addEventListener("keydown", e => {
      const k = { PageDown: 1, PageUp: -1, ArrowDown: .15, ArrowUp: -.15, " ": 1 }[e.key];
      if (k == null || e.target.closest("input, textarea, button")) return;
      e.preventDefault(); G.T += k * window.innerHeight * .8;
      if (!G.raf) G.raf = requestAnimationFrame(scrollTick);
    });
    window.addEventListener("resize", () => { G.H = collapseMax(); G.T = G.V = Math.min(G.V, scrollLimit()); applyScroll(); });
  }
  G.V = G.T = Math.min(G.V, G.H);   // a new weapon: builds start at the top, the strip stays as it was
  applyScroll();
}

function stripHtml() {
  const list = shown(), n = list.length;
  const avail = window.innerWidth - 2 * 96, maxSide = Math.floor((n - 1) / 2);
  const side = Math.max(0, Math.min(maxSide, Math.floor((Math.floor((avail + GAP) / STEP) - 1) / 2)));
  const vpw = (2 * side + 1) * STEP - GAP;
  S.side = side; S.list = list; S.pos = S.committed = Math.max(0, list.findIndex(x => x.row === ui.pick));
  S.vel = 0; S.target = null; S.hold = 0; S.cards = new Map(); S.anim = null; cancelAnimationFrame(S.raf); S.raf = 0;
  return { vpw, html: `
    <div class="strip3" id="strip3" style="--vpw:${vpw}px">
      <button class="cap3 l" data-step="-1" aria-label="Previous">${CHEV}</button>
      <div class="vp" id="vp"><div class="track" id="track"></div></div>
      <button class="cap3 r" data-step="1" aria-label="Next">${CHEV}</button>
    </div>` };
}
function cardFor(i) {
  let el = S.cards.get(i);
  if (el) return el;
  const w = S.list[modn(i, S.list.length)];
  el = document.createElement("div");
  el.className = "slot"; el.dataset.i = i;
  el.innerHTML = `<span class="shade"></span><div class="ecard"><span class="art"><img src="${wimg(w.row)}" alt="${w.name}" draggable="false"></span><span class="kitstrip"><span><img src="${subImg(w)}" alt="" draggable="false"></span><span><img src="${spImg(w)}" alt="" draggable="false"></span></span></div>`;
  document.getElementById("track").appendChild(el);
  S.cards.set(i, el);
  return el;
}
function paintStrip() {
  // v38: v36's flat arc again (no cylinder); the splat marks whichever card is under the middle right now
  const mid = Math.round(S.pos), ARC = S.side ? 3 / S.side : 1;
  const lo = Math.floor(S.pos) - S.side - 1, hi = Math.ceil(S.pos) + S.side + 1;
  for (const [i, el] of S.cards) if (i < lo || i > hi) { el.remove(); S.cards.delete(i); }
  for (let i = lo; i <= hi; i++) {
    const el = cardFor(i), u = i - S.pos, a = Math.abs(u);
    const fade = a <= S.side ? 1 : Math.max(0, 1 - (a - S.side) * 2);   // cards past the last full slot fade out, never get cut
    el.style.transform = `translate3d(calc(${(u * STEP).toFixed(2)}px - 50%), ${(u * u * 3.2 * ARC * ARC).toFixed(2)}px, 0) rotate(${(u * 3.4 * ARC).toFixed(2)}deg)`;
    el.style.opacity = fade.toFixed(3);
    el.style.pointerEvents = fade < .5 ? "none" : "";            // a fading edge card can't catch clicks meant for the chevrons
    el.style.zIndex = 100 - Math.round(a * 2);
    el.classList.toggle("on", i === mid);
  }
}
function settleStrip() {
  const i = S.anim ? S.anim.T : Math.round(S.pos); S.committed = i;
  const w = S.list[modn(i, S.list.length)];
  paintStrip();
  if (w.row !== ui.pick) { ui.pick = w.row; late.MO.pickWeapon(); }
}
/* Motion (v37): one critically damped glide x(t) = T + (A + B·t)·e^(-w·t), started from the card's current position
   AND velocity, so a flick carries on without a hitch and eases into its weapon with no wobble. A flick's landing
   spot is projected like iOS scrolling (deceleration 0.997/ms, so it travels v·330ms) and rounded to a weapon;
   w is then picked so the glide is that same smooth deceleration. */
export function animTo(T, v0, tau) {
  if (S.hold) return;
  const d = T - S.pos;
  warmAround(T, Math.sign(d) || 1);                                     // the landing spot is known now: load ahead of it
  if (tau == null) tau = (Math.abs(v0) > 1e-4 && Math.sign(v0) === Math.sign(d)) ? Math.max(90, Math.min(360, Math.abs(d / v0))) : 75;
  S.anim = { x0: S.pos, v0, T, w: 1 / tau, t0: performance.now() };
  cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(stripLoop);
}
export function animState(now) {
  const a = S.anim, t = now - a.t0, A = a.x0 - a.T, B = a.v0 + a.w * A, e = Math.exp(-a.w * t);
  return { x: a.T + (A + B * t) * e, v: (B - a.w * (A + B * t)) * e };
}
function stripLoop(now) {
  S.raf = 0; now = now || performance.now();
  if (S.drag || !S.anim || S.hold) return;
  const { x, v } = animState(now || performance.now());
  S.pos = x;
  if (!S.anim.snap && Math.abs(x - S.anim.T) < .45 && S.anim.w < 1 / 70) {   // aim assist: the last bit is a quick, firm pull
    S.anim = { x0: x, v0: v * .6, T: S.anim.T, w: 1 / 55, t0: now || performance.now(), snap: 1 };
  }
  if (Math.abs(x - S.anim.T) < .3 && S.committed !== S.anim.T) settleStrip();   // nearly there: the builds swap now, the glide finishes on its own
  if (Math.abs(x - S.anim.T) < .008 && Math.abs(v) < .001) { S.pos = S.anim.T; S.anim = null; settleStrip(); return; }
  paintStrip(); S.raf = requestAnimationFrame(stripLoop);
}
const kickStrip = () => animTo(S.target ?? Math.round(S.pos), S.anim ? animState(performance.now()).v : 0);
export function stepPick(k) {                                         // chevrons, mouse-wheel notches: one weapon, keeping momentum
  const now = performance.now(), v = S.anim ? animState(now).v : 0;
  if (S.anim) S.pos = animState(now).x;
  animTo((S.anim ? S.anim.T : Math.round(S.pos)) + k, v, 110);
}
function initStrip() {
  const vp = document.getElementById("vp"); if (!vp) return;
  paintStrip();
  let downX = 0, startPos = 0, moved = 0;
  vp.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    cancelAnimationFrame(S.raf); S.raf = 0;
    if (S.anim) S.pos = animState(performance.now()).x;           // catch it mid-glide, right where it is
    S.anim = null; S.drag = true; S.target = null; downX = e.clientX; startPos = S.pos; moved = 0; S.samples = [[performance.now(), e.clientX]];
    vp.setPointerCapture(e.pointerId); vp.classList.add("drag");
  });
  vp.addEventListener("pointermove", e => {
    if (!S.drag) return;
    const dx = e.clientX - downX; moved = Math.max(moved, Math.abs(dx));
    S.pos = startPos - dx / STEP;
    const now = performance.now();
    S.samples.push([now, e.clientX]); while (S.samples.length > 2 && now - S.samples[0][0] > 90) S.samples.shift();
    if (!S.paintQ) S.paintQ = requestAnimationFrame(() => { S.paintQ = 0; paintStrip(); });
  });
  const release = e => {
    if (!S.drag) return; S.drag = false; vp.classList.remove("drag");
    if (moved < 6) {                                            // a click: bring that card to the middle
      const s = document.elementFromPoint(e.clientX, e.clientY)?.closest(".slot");
      if (s) { animTo(+s.dataset.i, 0, 45); S.anim.snap = 1; settleStrip(); } else animTo(Math.round(S.pos), 0, 75); return;
    }
    const now = performance.now(), [t0, x0] = S.samples[0], [t1, x1] = S.samples[S.samples.length - 1];
    const vx = now - t1 > 70 ? 0 : (x1 - x0) / Math.max(8, t1 - t0);   // px/ms; a finger that stopped before letting go has no fling
    const v = -vx / STEP;                                       // weapons per ms
    const proj = Math.max(-24, Math.min(24, v * 330));
    animTo(Math.round(S.pos + proj), v);
  };
  vp.addEventListener("pointerup", release);
  vp.addEventListener("pointercancel", release);
  let wheelIdle = 0, wv = 0, wt = 0;
  vp.addEventListener("wheel", e => {
    e.preventDefault();
    if (S.hold) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (e.deltaMode === 0 && Math.abs(d) < 40) {               // trackpad: move with the fingers, then glide on and settle
      cancelAnimationFrame(S.raf); S.raf = 0; S.anim = null;
      const now = performance.now(); wv = now - wt < 80 ? (d / STEP) / Math.max(8, now - wt) : 0; wt = now;
      S.pos += d / STEP; paintStrip();
      clearTimeout(wheelIdle); wheelIdle = setTimeout(() => animTo(Math.round(S.pos + Math.max(-12, Math.min(12, wv * 300))), wv * .5), 60);
    } else stepPick(Math.sign(d));                              // mouse wheel: one weapon per notch
  }, { passive: false });
}

ui.beadsRebuilt = false;
export function layoutGoo() {
  const row = document.querySelector("#beadslot .beads"); if (!row || !row.offsetWidth) return;
  let goo = row.querySelector(".goo");
  if (!goo) { goo = document.createElement("span"); goo.className = "goo"; goo.setAttribute("aria-hidden", "true"); row.append(goo); }
  const beads = [...row.querySelectorAll(".bead")];
  if (goo.children.length !== beads.length) goo.innerHTML = beads.map(() => "<i></i>").join("");
  const onIdx = beads.findIndex(b => b.classList.contains("on"));   // glide only when the pick moved; a resize snaps
  goo.classList.toggle("snap", goo.dataset.on === undefined || +goo.dataset.on === onIdx);
  goo.dataset.on = onIdx;
  beads.forEach((b, i) => {
    const by = parseFloat(b.style.getPropertyValue("--by")) || 0, k = 1;
    const w = b.offsetWidth * k, h = b.offsetHeight * k;
    Object.assign(goo.children[i].style, { left: b.offsetLeft - (w - b.offsetWidth) / 2 + "px", top: b.offsetTop + by - (h - b.offsetHeight) / 2 + "px", width: w + "px", height: h + "px" });
  });
}
export function paintBeads(fs, fi) {
  const slot = document.getElementById("beadslot"), cur = [...slot.querySelectorAll(".bead")];
  const z = i => i === fi ? 50 : fs.length - Math.abs(i - fi);
  if (cur.length === fs.length && cur.every((b, i) => b.dataset.f === fs[i].key)) {
    cur.forEach((b, i) => { b.dataset.z = z(i); b.classList.toggle("on", i === fi); if (!b.classList.contains("was")) b.style.zIndex = z(i); });
    layoutGoo();
    return;
  }
  ui.beadsRebuilt = true;
  slot.innerHTML = `<div class="beads">${fs.map((f, i) =>
    `<button class="bead ${i === fi ? "on" : ""}" style="--by:${i % 2 ? 9 : -9}px;z-index:${z(i)}" data-z="${z(i)}" data-f="${f.key}" aria-label="${f.name}"><img src="${f.img}" alt="${f.name}"></button>`).join("")}</div>`;
  layoutGoo();
}
export function renderWeapons() {
  const fs = filters(), list = shown();
  if (!list.some(x => x.row === ui.pick)) ui.pick = list[0].row;
  const fi = fs.findIndex(f => f.key === ui.filt), st = stripHtml();
  paintBeads(fs, fi);
  beadSquid(document.querySelector("#beadslot .bead.on"));
  document.getElementById("weapons").innerHTML = `
  <div class="hdr" style="--vpw:${st.vpw}px">
    <button class="sorttag2" data-sort data-tip="Sort by"><span class="lbtn">L</span><span class="lbl">${ui.sortMode}</span></button>
    ${st.html}
  </div>
  <div class="below" id="below"></div>`;
  initStrip();
  if (!renderWeapons.later) renderBelow();
  warmAround(S.pos);
  warmEverything();
}
export function renderBelow() {
  const w = WEAPONS.find(x => x.row === ui.pick);
  document.getElementById("below").innerHTML = `
    <div class="wpanel">
      <div class="stage"><div class="ntape">${nameWords(w)}</div><div class="wart"><span class="wink sk${hash32(w.row + ":splash") % 16}"></span><img class="gun" src="${wimg(w.row)}" alt="${w.name}"></div><div class="kits"><div class="kb ksub"><span class="disc"><img src="${subImg(w)}" alt=""></span><span class="klbl">${prettyKit(w.sub)}</span></div><div class="kb ksp"><span class="burst"><span><img src="${spImg(w)}" alt=""></span></span><span class="klbl">${prettyKit(w.sp)}</span></div></div></div><div class="wordname">${nameWords(w)}</div><div class="archname"><svg viewBox="0 0 330 92"><path id="arcp" d="M18 78 Q165 18 312 78" fill="none"/><text text-anchor="middle"><textPath href="#arcp" startOffset="50%">${w.name}</textPath></text></svg></div>
      <div class="artbox"><img src="${wimg(w.row)}" alt="${w.name}"></div>
      <div class="kitbar"><span class="k3"><span><img src="${subImg(w)}" alt=""></span>${prettyKit(w.sub)}</span><span class="k3"><span><img src="${spImg(w)}" alt=""></span>${prettyKit(w.sp)}</span></div>
    </div>
    <div class="wbuilds2"><div class="blabel"><h2>Top builds</h2><a class="sticker" href="${slugFor(w.row) ? `https://sendou.ink/builds/${encodeURIComponent(slugFor(w.row))}/popular` : "https://sendou.ink/builds"}" target="_blank" rel="noreferrer">from sendou.ink</a>${buildsNote(w.row)}</div>
      <div class="pinscroll"><div class="pins"${PINZ ? ` style="--z:${PINZ}"` : ""}>${pinsHtml(w.row)}</div></div></div>`;
  fitTape(); indentTape(); fitPins(); initGlobalScroll();
  if (!MOCK) wantSendou(w.row, buildsArrived);
}
const pinsHtml = row => buildOrder(row).map((bi, r) => buildCard(BUILDS[bi], bi, r)).join("");
// one quiet line beside the heading when sendou has nothing to show (or only an old copy); nothing while it loads
function buildsNote(row) {
  if (MOCK) return "";
  const e = sendouFor(row), say = !e || e.state === "loading" ? "" : e.state === "failed" ? "Couldn't reach sendou.ink"
    : !e.ids.length ? "No builds yet" : e.stale ? "An older copy; sendou.ink didn't answer" : "";
  return `<span class="bnote">${say}</span>`;
}
// sendou answered for row: if it's still the weapon shown, its cards and note fade in where the empty list was
function buildsArrived(row) {
  if (row !== ui.pick) return;
  const pins = document.querySelector("#below .pins"), note = document.querySelector("#below .blabel .bnote");
  if (!pins) return;
  pins.innerHTML = pinsHtml(row);
  if (note) note.outerHTML = buildsNote(row);
  fitPins(); G.H = collapseMax();
  [...pins.children].slice(0, 9).forEach((c, i) => c.animate({ opacity: [0, 1], translate: ["0px 16px", "0px 0px"] }, { duration: 260, delay: i * 30, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" }));
  const n = document.querySelector("#below .blabel .bnote"); if (n && n.textContent) n.animate({ opacity: [0, 1] }, { duration: 240 });
}
let PINZ = "";   // the cards' last zoom, written straight into the next render
function fitPins() {   // 3 columns that always fill section 2: each card is drawn at 280px and zoomed to its column
  const p = document.querySelector(".pins"); if (!p) return;
  const gap = parseFloat(getComputedStyle(p).columnGap) || 26;
  const z = ((p.clientWidth - 2 * gap) / 3 / 252).toFixed(4); PINZ = z;
  if (p.style.getPropertyValue("--z") !== z) p.style.setProperty("--z", z);
}
window.addEventListener("resize", () => fitPins());
function nameWords(w) {
  const r = rng(hash32(w.row + ":name"));
  return w.name.split(" ").map(t => `<span style="--a:${((r() < .5 ? -1 : 1) * (2 + r() * 4)).toFixed(1)}deg;--y:${Math.round(r() * 6 - 3)}px">${t}</span>`).join("");
}
function fitTape() {   // shrink the name until its tape fits the panel
  const t = document.querySelector(".ntape"); if (!t) return;
  const panel = t.closest(".wpanel"); let size = 44;
  const set = () => t.querySelectorAll("span").forEach(s => s.style.fontSize = size + "px"); set();
  while (size > 20 && (t.offsetHeight > panel.clientHeight * .28 || [...t.querySelectorAll("span")].some(s => s.offsetWidth > panel.clientWidth * .8))) { size -= 2; set(); }
}
function indentTape() {
  const t = document.querySelector(".ntape"); if (!t) return;
  const sp = [...t.querySelectorAll("span")]; sp.forEach(s => s.classList.remove("ind1"));
  let top = sp[0] ? sp[0].offsetTop : 0;
  for (let i = 1; i < sp.length; i++) if (sp[i].offsetTop > top + 8) { sp[i].classList.add("ind1"); top = sp[i].offsetTop; }
}
function fitWordName() {   // shrink until every word fits on its line
  const box = document.querySelector(".wordname"); if (!box) return;
  let size = 40; const set = () => box.querySelectorAll("span").forEach(s => s.style.fontSize = size + "px"); set();
  while (size > 18 && [...box.querySelectorAll("span")].some(s => s.offsetWidth > box.clientWidth - 40)) { size -= 2; set(); }
}
function fitArchName() {   // shrink long names so they stay on the arch
  const t = document.querySelector(".archname text"); if (!t) return;
  let size = 34; t.style.fontSize = size + "px";
  while (t.getComputedTextLength() > 300 && size > 18) { size -= 2; t.style.fontSize = size + "px"; }
}

document.addEventListener("keydown", e => { if (!document.getElementById("weapons").classList.contains("on") || e.target.closest?.("input, textarea")) return; if (e.key === "ArrowRight") stepPick(1); if (e.key === "ArrowLeft") stepPick(-1); });

/* ---- a build card that's unique to its id; nothing lands on text ---- */
/* Charms are real locker stickers from the game (Leanny's zakka images): graffiti tags, logos, characters, doodles.
   Picked from the build id, so a build always wears the same one; about one in five wears none. */
const STICKERS = [
  ...[0, 1, 2, 3, 4, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39].map(n => `Grf_Sti_Graffiti_${String(n).padStart(2, "0")}`),
  ...[14, 15, 16, 17, 21, 25, 26, 27].map(n => `Grf_Sti_Decoration_${n}`),
  ...[0, 1, 2, 3, 6, 7, 9, 10].map(n => `Stc_Sti_Character_${String(n).padStart(2, "0")}`),
  ...[3, 10].map(n => `Stc_Sti_Decoration_${String(n).padStart(2, "0")}`),
  "Stc_Sti_Logo_10",
];
function stickerHtml(key) {   // key: buildKey(b)
  const r = rng(hash32(key + ":sticker"));
  if (r() < .2) return "";
  const name = STICKERS[Math.floor(r() * STICKERS.length)], rot = Math.round(r() * 24 - 12);
  return `<span class="stk" style="--sr:${rot}deg"><img src="${L}/zakka/${name}.png" alt="" loading="lazy" onerror="this.parentNode.remove()"></span>`;
}

function buildOrder(row) {
  if (!MOCK) {                                                      // sendou's order, for this weapon
    const e = sendouFor(row);
    return e ? e.ids.map(id => BUILDS.findIndex(b => !b.mine && b.id === id)).filter(i => i >= 0) : [];
  }
  return BUILDS.map((b, i) => [hash32(row + ":" + b.id), i]).filter(([, i]) => !BUILDS[i].mine).sort((x, y) => x[0] - y[0]).map(x => x[1]);
}
// the other team's ink: opposite hue, pulled into the nearest band of the card palette (lemon stands in for the amber gap)
export function rivalInk(ink) {
  const h = (ink.h + 180) % 360, band = bandFor(h) || BANDS.find(b => b.name === "lemon");
  const hh = bandFor(h) ? h : 112, L = (band.L[0] + band.L[1]) / 2, C = (band.C[0] + band.C[1]) / 2;
  return { css: `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${hh})`, text: L < .67 ? "#fff" : "#111" };
}
// for each splat: the biggest HIT-shaped solid patch inside it, as fractions (x, y, w, h) of the image (parts/gen_splats.py)
const SPLATFIT = [[0.2429, 0.25, 0.5048, 0.5857], [0.3619, 0.3107, 0.3405, 0.3964], [0.3405, 0.3357, 0.3714, 0.4321], [0.2905, 0.225, 0.4262, 0.4964], [0.3357, 0.2714, 0.431, 0.5], [0.3857, 0.2607, 0.4238, 0.4929], [0.3595, 0.1929, 0.4238, 0.4929], [0.281, 0.2607, 0.3881, 0.45], [0.2905, 0.2643, 0.4548, 0.5286], [0.2405, 0.2643, 0.4238, 0.4929], [0.3667, 0.2679, 0.3952, 0.4607], [0.2738, 0.225, 0.3952, 0.4607]];
const INKBOX = { w: 179, h: 58, right: -16, top: -6 };          // the button area that must be fully inked, footer px
const HIT = { w: 40, h: 31 };                                    // the solid-patch shape gen_splats.py measured (BOX_W/H)
const EL = { right: -16, top: -60, w: 262, h: 116 };             // the ::before element, footer px
// the hits for a build: [splat, x, y, w, h] in element px (from its top-left), seeded by the build's contents (buildKey)
function inkHits(key) {
  const r = rng(hash32(key + ":ink"));
  const order = [...SPLATFIT.keys()].map(k => [r(), k]).sort((p, q) => p[0] - q[0]).map(p => p[1]);   // a different splat per hit
  const boxX = EL.w + EL.right - INKBOX.right - INKBOX.w, boxY = INKBOX.top - EL.top;   // the box's top-left in the element
  const place = (k, px, py, pw) => {                             // splat k sized so its solid patch is pw wide with its top-left at (px, py)
    const [x, y, w, h] = SPLATFIT[k], cw = pw / w, ch = pw * HIT.h / HIT.w / h;
    return [k, px - x * cw, py - y * ch, cw, ch];
  };
  const hits = [], ph = INKBOX.h, pw = ph * HIT.w / HIT.h;       // three big hits: each patch is the box's full height (~75 x 58)
  const step = (INKBOX.w - pw) / 2;
  let n = 0;
  for (let c = 0; c < 3; c++) hits.push(place(order[n++], boxX + Math.max(0, Math.min(INKBOX.w - pw, c * step + (r() - .5) * 10)), boxY, pw));
  for (let k = 0; k < 2 + (r() < .6); k++) {                     // strays: smaller hits off to the left, below or up under the panel
    const sw = 22 + r() * 18, sx = boxX - 70 + r() * 150, sy = r() < .5 ? boxY + 4 + r() * 26 : boxY + INKBOX.h - 16 + r() * 10;
    hits.push(place(order[n++], sx, sy, sw));
  }
  return hits;
}
// splat images, loaded once from the CSS variables build.py filled with data URIs
let SPLATIMGS = null;
function splatImages() {
  if (!SPLATIMGS) {
    const cs = getComputedStyle(document.documentElement);
    SPLATIMGS = Promise.all(SPLATFIT.map((_, k) => {
      const im = new Image();
      im.src = cs.getPropertyValue("--s" + k).trim().replace(/^url\(["']?/, "").replace(/["']?\)$/, "");
      return im.decode().then(() => im);
    }));
  }
  return SPLATIMGS;
}
// one mask bitmap per build, drawn once and kept: cards are rebuilt on every weapon pick, so later renders reuse it
const INKMASKS = new Map();
function cornerInk(key, colour) {   // key: buildKey(b), so builds with the same contents share one bitmap
  const ready = INKMASKS.get(key);
  if (typeof ready === "string") return { cls: " inked", style: `--inkimg:url(${ready});` };
  if (!ready) INKMASKS.set(key, splatImages().then(imgs => {
    const s = Math.min(2, Math.max(1, window.devicePixelRatio || 1)), cv = document.createElement("canvas");   // screen resolution, no more
    cv.width = Math.round(EL.w * s); cv.height = Math.round(EL.h * s);
    const g = cv.getContext("2d", { willReadFrequently: true });   // CPU canvas: toBlob needs no GPU readback
    for (const [k, x, y, w, h] of inkHits(key)) g.drawImage(imgs[k], x * s, y * s, w * s, h * s);
    g.globalCompositeOperation = "source-in"; g.fillStyle = colour; g.fillRect(0, 0, cv.width, cv.height);   // tint the hits
    return new Promise(res => cv.toBlob(res, "image/png"));
  }).then(blob => {
    const url = URL.createObjectURL(blob);
    INKMASKS.set(key, url);
    document.querySelectorAll(`.bcard2[data-key="${key}"]`).forEach(c => { c.style.setProperty("--inkimg", `url(${url})`); c.classList.add("inked"); });
  }).catch(() => INKMASKS.delete(key)));
  return { cls: "", style: "" };
}
export function buildCard(b, i, rank = i) {
  const key = buildKey(b), ink = inkFor(key), look = looksFor(key), r = rng(look.seed ^ 0x9e3779b9), rival = rivalInk(ink), corner = cornerInk(key, rival.css);
  const splats = look.splats.map(s => `<span class="ink" style="--k:${s.deep ? ink.deep : ink.light};left:${s.x}%;top:${s.y}%;--s:${s.s}px;--rot:${s.rot}deg;--fx:${s.flip ? -1 : 1}"></span>`).join("");
  return `<article class="tag bcard bcard2${corner.cls}" data-id="${b.id}" data-key="${key}" style="${corner.style}background-color:${ink.css};--ink:${ink.css};--rival:${rival.css};--rivaltx:${rival.text};--fg:${ink.text};--tilt:${look.tilt}deg;--dx:${look.dx}px;--dy:${look.dy}px">
    ${splats}
    <span class="sticker rank">#${rank + 1}</span>
    <div class="title"><h3>${b.title}</h3><div class="modes">${Object.keys(MODES).map(m => `<img class="mode ${b.modes.includes(m) ? "" : "off"}" src="${MODE(m)}" alt="${MODES[m]}" data-tip="${MODES[m]}">`).join("")}</div></div>
    <div class="inner">${b.set.map(([row, main, subs]) => `
      <div class="prow">${gear(row)}${ab(main, 34)}<span class="sep"></span><div class="subs">${subs.map(s => ab(s, 30)).join("")}</div></div>`).join("")}</div>
    <div class="bfoot"><button class="btn ${b.saved ? "on" : ""}" data-save="${bkey(b)}">${b.saved ? "Saved" : "Save"}</button><button class="btn y" data-edit="${bkey(b)}">Edit</button></div>
  </article>`;
}
