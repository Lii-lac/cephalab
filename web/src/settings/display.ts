// Settings / Display: Motion (follow system / reduced / full), Zoom, High contrast. Saved in localStorage "st.display" and applied
// at start-up (mountSettings runs with the app), not only when the screen is open. Also sizes the board to its content.
import { $, seg } from "./dom";

export const DISPLAY_KEY = "st.display";
type D = { motion: "system" | "reduced" | "full"; zoom: number; contrast: boolean };
const root = document.documentElement;
let d: D = { motion: "system", zoom: 1, contrast: false };
try { d = { ...d, ...JSON.parse(localStorage.getItem(DISPLAY_KEY) || "{}") }; } catch { /* keep the defaults */ }
const save = () => { try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(d)); } catch { /* private mode */ } };

/** The board is as tall as its tallest page (the pages share one cell, so every category gives the same height), capped at the
 *  space under the header (bottom margin = side margin, in unzoomed page pixels); only when capped do the rows shrink (--k). */
export function fitBoard() {
  const menu = document.querySelector<HTMLElement>("#settings .st-menu"), head = document.querySelector("header");
  if (!menu || !head || !menu.getClientRects().length) return;
  const cs = getComputedStyle(root), side = parseFloat(cs.getPropertyValue("--side")) || 48, z = (parseFloat(cs.getPropertyValue("--zpl")) || 1) * d.zoom;
  const cap = Math.max(420, (innerHeight - (head.getBoundingClientRect().bottom + 16) - side) / z);
  const at = (k: number) => { menu.style.setProperty("--k", k.toFixed(3)); return menu.offsetHeight; };
  root.style.removeProperty("--boardh");
  menu.classList.add("st-measure");                  // every page counts while the row scale is found
  let k = 1;
  if (at(1) > cap) {
    let lo = 0.5, hi = 1;
    for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (at(m) > cap) hi = m; else lo = m; }
    k = lo; if (at(k) > cap) root.style.setProperty("--boardh", cap.toFixed(1) + "px");
  }
  menu.style.setProperty("--k", k.toFixed(3));
  menu.classList.remove("st-measure");               // then the board takes the shown page's height
}
let q = 0;
export const fitSoon = () => { cancelAnimationFrame(q); q = requestAnimationFrame(() => { q = requestAnimationFrame(fitBoard); }); };

function apply() {
  root.classList.toggle("st-still", d.motion === "reduced");   // stops every transition; motion.ts reads it too
  root.classList.toggle("st-hc", d.contrast);
  root.style.setProperty("--stuz", String(d.zoom));
  fitSoon();
}

export function mountDisplay() {
  seg($("[data-key=motion]"), v => { d.motion = v as D["motion"]; save(); apply(); })(d.motion);
  const oo = $("#contrast"), zoom = $("#zoom"), stops = [...zoom.children] as HTMLButtonElement[];
  oo.classList.toggle("on", d.contrast); oo.setAttribute("aria-checked", String(d.contrast));
  oo.addEventListener("click", () => {
    d.contrast = !d.contrast; oo.classList.toggle("on", d.contrast); oo.setAttribute("aria-checked", String(d.contrast)); save(); apply();
  });
  // Zoom: every tick is a step. The numbers are jump points: 90 % lights the first tick, the others light their own six;
  // between two numbers the ticks share the gap evenly. Keys step number to number; press and drag along the ticks zooms live.
  for (const b of stops) { const t = b.textContent; b.type = "button"; b.innerHTML = `<span class="st-tn">${t}</span><span class="st-tt">${"<i></i>".repeat(6)}</span>`; }
  const ticks = [...zoom.querySelectorAll<HTMLElement>(".st-tt i")], per = ticks.length / stops.length;
  const V = stops.map(b => parseFloat(b.dataset.v!)), K = stops.map((_, i) => i ? (i + 1) * per - 1 : 0), lo = V[0], hi = V[V.length - 1];
  const val = (k: number) => {                       // tick -> zoom
    let i = 1; while (i < K.length - 1 && k > K[i]) i++;
    return Math.round((V[i - 1] + (V[i] - V[i - 1]) * (k - K[i - 1]) / (K[i] - K[i - 1])) * 1e4) / 1e4;
  };
  const nearest = (xs: number[], x: number) => { let b = 0; xs.forEach((c, k) => { if (Math.abs(c - x) < Math.abs(xs[b] - x)) b = k; }); return b; };
  d.zoom = Number(d.zoom); if (!(d.zoom >= lo && d.zoom <= hi)) d.zoom = Number.isFinite(d.zoom) ? Math.max(lo, Math.min(hi, d.zoom)) : 1;   // any value in range loads
  zoom.setAttribute("aria-valuemin", String(Math.round(lo * 100))); zoom.setAttribute("aria-valuemax", String(Math.round(hi * 100)));
  let at = 0;
  const set = (k: number, user: boolean, keep = false) => {   // keep: mid-drag, applied but not saved yet
    at = k;
    const v = user ? val(k) : d.zoom, n = V.findIndex(x => Math.abs(x - v) < 1e-6);
    ticks.forEach((t, j) => t.classList.toggle("lit", j <= k));
    stops.forEach((b, j) => b.classList.toggle("at", j === n));
    zoom.setAttribute("aria-valuenow", String(Math.round(v * 100))); zoom.setAttribute("aria-valuetext", `${Math.round(v * 100)} %`);
    if (user) { if (d.zoom !== v) { d.zoom = v; apply(); } if (!keep) save(); }
  };
  stops.forEach((b, i) => b.addEventListener("click", e => { if (!e.detail) set(K[i], true); }));   // a click with no pointer (assistive tech)
  zoom.addEventListener("keydown", e => {
    const s = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[e.key];
    if (!s) return;
    e.preventDefault();
    const v = val(at), up = V.findIndex(x => x > v + 1e-6), down = V.map(x => x < v - 1e-6).lastIndexOf(true), i = s > 0 ? up : down;
    if (i >= 0) set(K[i], true);
  });
  // a drag reads the pointer against the ticks as they were at the press (viewport px): the zoom it applies rescales and
  // moves the strip under the pointer, so measuring it again mid-drag would chase itself. Measured again on the next press.
  let g: { id: number; xs: number[]; x: number; num: number; moved: boolean } | null = null;
  zoom.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement, b = t.closest("button") as HTMLButtonElement | null, onTicks = !!t.closest(".st-tt") || !b;
    g = { id: e.pointerId, xs: ticks.map(i => { const r = i.getBoundingClientRect(); return (r.left + r.right) / 2; }), x: e.clientX, num: onTicks ? -1 : stops.indexOf(b!), moved: false };
    zoom.setPointerCapture?.(e.pointerId);
    if (g.num < 0) set(nearest(g.xs, e.clientX), true, true);   // a press on the ticks takes that tick at once; on a number it waits
  });
  zoom.addEventListener("pointermove", e => {
    if (!g || e.pointerId !== g.id) return;
    if (!g.moved && g.num >= 0 && Math.abs(e.clientX - g.x) < 4) return;
    g.moved = true; set(nearest(g.xs, e.clientX), true, true);
  });
  const end = (e: PointerEvent) => {                 // saved on release; a number pressed and let go is a jump to it
    if (!g || e.pointerId !== g.id) return;
    const { num, moved } = g; g = null;
    if (num >= 0 && !moved) set(K[num], true); else save();
  };
  zoom.addEventListener("pointerup", end);
  zoom.addEventListener("pointercancel", end);
  set(nearest(ticks.map((_, k) => val(k)), d.zoom), false);
  addEventListener("resize", fitSoon);
  document.fonts?.ready.then(fitSoon);
  apply();
}
