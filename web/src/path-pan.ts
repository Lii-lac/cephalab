// @ts-nocheck
// The Path's lanes pan sideways together: one offset moves every lane's track, so the columns stay lined up. Drag any
// track (or scroll sideways / shift+wheel); on release it coasts and settles on a column edge. The offset survives
// redraws of the same build and resets for another.
// Nothing is ever cut at an edge: each view has a rest window (whole columns, plus room for the first column's › on the
// left and a drink's ticket on the right). A cell (ring, label, ticket, ×N: its whole painted box) fades out by how far it
// has crossed that window's edge and is gone F px past it, where the hard clip sits. At rest only whole cells show.
// Per frame this is arithmetic on boxes measured once per draw / resize (fit), no layout reads.
// Under the last lane a slim track shows where you are: its thumb is as wide as the whole columns in view and follows the
// offset every frame; drag the thumb or press the track to pan (it settles on a column too). It fades out while all fits.
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const F = 40;                                                  // px of travel over which a crossing cell fades to nothing
const WL = -12;                                                // the rest window's left edge: the first column's › sits at -7
let off = 0, build = null, drag = null, wheelT = 0, anim = 0;
let rows = [], col = 0, stop = 0, zoom = 1;                    // fit(): per view {t, wr, cells:[{el, l, r, o}]}, column width, furthest clean stop
let bar = null;                                                // the track: {el, k (the rail), i (the thumb), w, tw, T (thumb travel), on, x}
// one column's width in CSS px (the grid's own --col, not the track's width: a ticket poking out of the last cell widens that)
function colW(t) { const w = parseFloat(getComputedStyle(t).gridTemplateColumns); return w > 0 ? w : 0; }
function fit(host) {
  rows = []; col = 0; let max = 0, frac = 1;
  for (const v of host.querySelectorAll(".lanes .tview")) {
    const t = v.firstElementChild, c = t && colW(t), vw = v.clientWidth; if (!c || !vw) continue;
    const n = +((t.style.gridTemplateColumns.match(/repeat\((\d+)/) || [])[1] || 0);
    const whole = Math.max(1, Math.min(n, Math.floor(vw / c + 1e-6))) * c, wr = whole + 20;   // right: room for the last whole column's ticket
    col = c; max = Math.max(max, n * c - whole); if (n) frac = Math.min(frac, whole / (n * c));
    v.style.clipPath = `inset(-80px ${vw - wr - F}px -80px ${WL - F}px)`;
    const tr = t.getBoundingClientRect(), z = t.currentCSSZoom || tr.width / t.offsetWidth || 1;
    zoom = z;
    const cells = [];
    for (const el of t.children) {                             // the cell's painted box in track px at offset 0
      const b = el.getBoundingClientRect();
      let l = b.left, r = b.right;
      for (const e of el.querySelectorAll("*")) { const d = e.getBoundingClientRect(); if (d.width || d.height) { l = Math.min(l, d.left); r = Math.max(r, d.right); } }
      l = (l - tr.left) / z; r = (r - tr.left) / z;
      if (!el.classList.contains("first")) l = Math.min(l, (b.left - tr.left) / z - 8);   // its › (::before at left -7px)
      cells.push({ el, l, r, o: -1 });
    }
    rows.push({ t, wr, cells });
  }
  stop = col ? Math.max(0, Math.ceil(max / col - 1e-6)) * col : 0;
  fitBar(host, frac);
}
// the track lives across redraws (one element, put back under the lanes each draw), so it only fades when overflow changes
function fitBar(host, frac) {
  const lanes = host.querySelector(".lanes"); if (!lanes) return;
  const b = bar || makeBar();
  if (b.el.parentNode !== lanes || b.el.nextSibling) lanes.append(b.el);
  b.w = b.k.clientWidth; b.tw = Math.min(b.w, Math.max(24, Math.round(b.w * frac))); b.T = Math.max(0, b.w - b.tw); b.x = NaN;
  b.i.style.width = b.tw + "px";
  const on = stop > 0 && b.T > 0;
  if (on !== b.on) { b.on = on; b.el.classList.toggle("on", on); }
}
function makeBar() {
  const el = document.createElement("div"); el.className = "pscroll"; el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<div class="psk"><i></i></div>`;
  const b = bar = { el, k: el.firstElementChild, i: el.firstElementChild.firstElementChild, w: 0, tw: 0, T: 0, on: false, x: NaN };
  const toCol = x => col ? Math.max(0, Math.min(stop, Math.round(x / col) * col)) : 0;
  let held = null;
  b.k.addEventListener("pointerdown", e => {
    if (e.button !== 0 || !b.on) return;
    e.preventDefault(); cancelAnimationFrame(anim); anim = 0;
    const r = b.k.getBoundingClientRect(), z = b.k.currentCSSZoom || r.width / b.k.offsetWidth || 1;   // measured once per press
    let from = off;
    if (e.target !== b.i) { from = toCol((((e.clientX - r.left) / z - b.tw / 2) / b.T) * stop); glide(from, Math.abs(from - off) < 1 ? 0 : 280); }   // the track: the thumb's middle goes there
    held = { id: e.pointerId, x: e.clientX, from, z, moved: false };
    b.k.setPointerCapture?.(e.pointerId); b.k.classList.add("held");
  });
  b.k.addEventListener("pointermove", e => {
    if (!held || e.pointerId !== held.id) return;
    const dx = e.clientX - held.x;
    if (!held.moved && Math.abs(dx) < 2) return;
    if (!held.moved) { held.moved = true; cancelAnimationFrame(anim); anim = 0; }
    put(Math.max(0, Math.min(stop, held.from + dx / held.z / b.T * stop)));   // thumb px -> lane px
  });
  const end = e => { if (!held || (e && e.pointerId !== held.id)) return; const m = held.moved; held = null; b.k.classList.remove("held"); if (m) settle(); };
  b.k.addEventListener("pointerup", end);
  b.k.addEventListener("pointercancel", end);
  return b;
}
function put(x) {
  off = x;
  for (const { t, wr, cells } of rows) {
    t.style.transform = x ? `translateX(${-x}px)` : "";
    for (const c of cells) {
      const cross = Math.max(WL - (c.l - x), c.r - x - wr);   // how far its box is past either edge
      const o = cross <= 0 ? 1 : cross >= F ? 0 : Math.round((1 - cross / F) * 100) / 100;
      if (o === c.o) continue;
      c.o = o; c.el.style.opacity = o === 1 ? "" : String(o); c.el.style.visibility = o ? "" : "hidden";
    }
  }
  if (bar && bar.T) {                                          // the thumb: where the offset is between 0 and the last stop
    const tx = stop ? Math.round(Math.max(0, Math.min(1, x / stop)) * bar.T * 10) / 10 : 0;
    if (tx !== bar.x) { bar.x = tx; bar.i.style.transform = tx ? `translateX(${tx}px)` : ""; }
  }
}
// to x over ms, easing out like a flick coasting to a stop (≈ cubic-bezier(.16,1,.3,1)), one put() per frame
function glide(to, ms) {
  cancelAnimationFrame(anim); anim = 0;
  if (!ms || reduced()) return put(to);
  const from = off, t0 = performance.now(), ease = p => (1 - 2 ** (-10 * p)) / (1 - 2 ** -10);
  const tick = now => { const p = Math.min(1, (now - t0) / ms); put(from + (to - from) * ease(p)); anim = p < 1 ? requestAnimationFrame(tick) : 0; };
  anim = requestAnimationFrame(tick);
}
// onto a column edge within range: with a flick's speed (track px/ms) it coasts on first, to the column nearest where it would stop
function settle(vel = 0) {
  if (!col) return glide(0, 0);
  const coast = Math.max(-1.2 * 1000, Math.min(1.2 * 1000, vel * 320));        // ~momentum: speed x a time constant, capped
  const to = Math.max(0, Math.min(stop, Math.round((off + coast) / col) * col));
  const dist = Math.abs(to - off);
  glide(to, dist < 1 ? 0 : Math.min(900, Math.max(240, Math.abs(vel) > .1 ? dist / Math.abs(vel) * 1.6 : 280)));
}
const clampSoft = x => x < 0 ? x / 3 : x > stop ? stop + (x - stop) / 3 : x;   // a little give past the ends
let bound = null;
function bind(host) {
  if (bound === host) return;
  bound = host;
  host.addEventListener("pointerdown", e => {
    const v = e.target.closest(".tview"); if (!v || e.button !== 0) return;
    const coasting = !!anim;
    cancelAnimationFrame(anim); anim = 0;                      // catch a coasting track where it is
    // the page is zoomed: pointer px -> track px, measured once per press
    const z = v.currentCSSZoom || v.getBoundingClientRect().width / v.offsetWidth || 1;
    drag = { x: e.clientX, from: off, id: e.pointerId, moved: false, coasting, z, trail: [[e.timeStamp, e.clientX]] };
    v.setPointerCapture?.(e.pointerId);
  });
  host.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true; host.classList.add("panning");
    drag.trail.push([e.timeStamp, e.clientX]); while (drag.trail.length > 2 && e.timeStamp - drag.trail[0][0] > 90) drag.trail.shift();
    put(clampSoft(drag.from - dx / drag.z));
  });
  const end = e => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { moved, coasting, trail, z } = drag; drag = null; host.classList.remove("panning");
    if (!moved) { if (coasting) settle(); return; }          // a tap that caught a coast: onto the nearest column, not left mid-cell
    const [t0, x0] = trail[0], [t1, x1] = trail[trail.length - 1];
    const fresh = e && e.timeStamp - t1 < 60;                  // a drag that stopped before letting go has no flick
    settle(fresh && t1 > t0 ? -(x1 - x0) / (t1 - t0) / z : 0);
  };
  host.addEventListener("pointerup", end);
  host.addEventListener("pointercancel", end);
  host.addEventListener("wheel", e => {
    if (!e.target.closest(".lanes .tview")) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (!d) return;
    e.preventDefault();
    cancelAnimationFrame(anim); anim = 0;
    put(clampSoft(off + d / zoom));
    clearTimeout(wheelT); wheelT = setTimeout(() => settle(), 140);
  }, { passive: false });
  // the screen drawn while hidden has no sizes yet: fit when it gets one (shown, the window resized, the page zoomed)
  new ResizeObserver(() => { fit(host); off ? settle() : put(0); }).observe(host);
  host.addEventListener("dragstart", e => { if (e.target.closest?.(".tview")) e.preventDefault(); });   // images in cells: no native drag
}
export const pan = {
  drawn(host, id) {                                            // after a redraw: same build keeps its place (clamped), another starts at 0
    bind(host);
    if (id !== build) { build = id; off = 0; cancelAnimationFrame(anim); anim = 0; }
    fit(host);
    put(off);
    if (off) settle();
  },
};
