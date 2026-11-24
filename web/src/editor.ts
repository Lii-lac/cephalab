// Build editor (ported from mockups/gear14.html into #editor).
import "./styles/editor.css";
import A_staple_left from "../../assets/staple-left.png";
import A_staple_right from "../../assets/staple-right.png";
import A_circles from "../../assets/circles-transparent.png";
import CATALOG from "./data/gear-catalog.json";
import WEAPON_STATS_JSON from "./data/weapon-stats.json";
import { SECS, apTotal, computeStats, nfmt, type ActsStatRow, type NumStatRow, type SecId, type StatRow, type StatSection, type WeaponStatsData } from "./editor-stats";
import { ui } from "./state";
import { late } from "./late";
import { store } from "./store";
import { live, subscribe } from "./live";
import { orderedSnapshots } from "./pieces";
import { copyOutfit, paintCopy, resetCopyFailure } from "./wearing";
import { linkFor } from "./sendou-link";
import { BUILDS, L, MODE, MODES, NAMES, SUBS, WEAPONS as APP_WEAPONS, blankBuild } from "./data";

type SlotKey = "head" | "clothes" | "shoes";
interface GearMeta { row: string; name: string; brand: string; main: string; stars: number; slot: SlotKey; bid: string; fav: string; unfav: string; }
interface WeaponMeta { row: string; name: string; cls: string; sub: string; sp: string; }

const SLOTS: SlotKey[] = ["head", "clothes", "shoes"];
const SLOTNAME = ["Head", "Clothes", "Shoes"];
const MAINONLY: string[][] = [
  ["StartAllUp", "EndAllUp", "MinorityUp", "ComeBack"],
  ["SquidMoveSpatter_Reduction", "DeathMarking", "ThermalInk", "Exorcist", "ExSkillDouble"],
  ["SuperJumpSign_Hide", "ObjectEffect_Up", "SomersaultLanding"],
];
const ALLMAIN = MAINONLY.flat();
const ABORDER = SUBS.concat(ALLMAIN);
const MODE_LIST: [string, string][] = (["TW", "SZ", "TC", "RM", "CB"] as const).map(k => [k, (MODES as Record<string, string>)[k]]);
const SUBN: Record<string, string> = {
  Beacon: "Squid Beakon", Bomb_Curling: "Curling Bomb", Bomb_Fizzy: "Fizzy Bomb", Bomb_Quick: "Burst Bomb",
  Bomb_Robot: "Autobomb", Bomb_Splash: "Splat Bomb", Bomb_Suction: "Suction Bomb", Bomb_Torpedo: "Torpedo",
  LineMarker: "Angle Shooter", PointSensor: "Point Sensor", PoisonMist: "Toxic Mist", Shield: "Splash Wall",
  Sprinkler: "Sprinkler", Trap: "Ink Mine",
};
const SPN: Record<string, string> = {
  SpBlower: "Ink Vac", SpCastle: "Kraken Royale", SpChariot: "Crab Tank", SpChimney: "Splattercolor Screen",
  SpEnergyStand: "Tacticooler", SpFirework: "Super Chump", SpGreatBarrier: "Big Bubbler", SpInkStorm: "Ink Storm",
  SpJetpack: "Inkjet", SpMicroLaser: "Killer Wail 5.1", SpMultiMissile: "Tenta Missiles", SpNiceBall: "Booyah Bomb",
  SpPogo: "Triple Splashdown", SpShockSonar: "Wave Breaker", SpSkewer: "Reefslider", SpSuperHook: "Zipcaster",
  SpTripleTornado: "Triple Inkstrike", SpUltraShot: "Trizooka", SpUltraStamp: "Ultra Stamp",
};
const WT: Record<string, number> = {
  Shooter: 0, Blaster: 1, Maneuver: 2, Spinner: 3, Charger: 4, Roller: 5, Brush: 6, Slosher: 7, Shelter: 8, Stringer: 9, Saber: 10,
};
const SORTS: [string, string][] = [["alpha", "Alphabetical"], ["brand", "Brand"], ["main", "Main ability"]];
const TEE = "Clt_HAP001", DBL = "ExSkillDouble";
const SEENKEY = "seedtracker.gearseen.v1", PFKEY = "seedtracker.pickfirst.v1";
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const NAMES_MAP = NAMES as Record<string, string>;

const GEAR = CATALOG.gear as unknown as Record<SlotKey, [string, string, string, string, number, string][]>;
const BRANDS = CATALOG.brands as unknown as Record<string, [string, string, string]>;
const CLASSES = CATALOG.classes as unknown as [string, string][];
const ARTBUSY = (CATALOG.artBusy || {}) as Record<string, string>;
const WEAPON_STATS = WEAPON_STATS_JSON as unknown as WeaponStatsData;

const appWName = new Map<string, string>((APP_WEAPONS as { row: string; name: string }[]).map(w => [w.row, w.name]));
const WEAPONS: WeaponMeta[] = (CATALOG.weapons as { row: string; cls: string; sub: string; sp: string }[]).map(w => ({
  ...w, name: appWName.get(w.row) || w.row,
}));
const weaponByRow = new Map<string, WeaponMeta>(WEAPONS.map(w => [w.row, w]));
const byRow: Record<string, GearMeta> = {};
for (const s of SLOTS) {
  for (const g of GEAR[s]) {
    const br = BRANDS[g[5]] || ["", "", ""];
    byRow[g[0]] = { row: g[0], name: g[1], brand: g[2], main: g[3], stars: g[4], slot: s, bid: g[5], fav: br[1] || "", unfav: br[2] || "" };
  }
}

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const gimg = (row: string) => `${L}/gear/${row}.png`;
const simg = (a: string) => `${L}/skill/${a || "Unknown"}.png`;
const wimg = (w: WeaponMeta) => `${L}/weapon_flat/Path_Wst_${w.row}.png`;
const subimg = (w: WeaponMeta) => `${L}/subspe/Wsb_${w.sub}00.png`;
const spimg = (w: WeaponMeta) => `${L}/subspe/Wsp_${w.sp}00.png`;
const timg = (c: string) => `${L}/weapon_type/IconTypeWpn_${String(WT[c] ?? 0).padStart(2, "0")}.png`;
const ab = (a: string, z = 36, cls = "") =>
  a ? `<span class="ab ${cls}" style="--abz:${z}px" data-tip="${esc(NAMES_MAP[a] || a)}"><img src="${simg(a)}" alt="${esc(NAMES_MAP[a] || a)}"></span>`
    : `<span class="ab empty ${cls}" style="--abz:${z}px"></span>`;
const slotAb = (a: string, z: number) => a ? ab(a, z) : `<span class="ab q" style="--abz:${z}px"></span>`;
const blogo = (g: GearMeta, z = 32) =>
  g.bid ? `<img class="blogo" src="${L}/brand/${g.bid}.png" alt="${esc(g.brand)}" data-tip="${esc(g.brand)}" style="--bz:${z}px">` : esc(g.brand);
const clsName = (c: string) => (CLASSES.find(x => x[0] === c) || [c, c])[1];
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("st-still");

/* new-piece yellow ink splat SVG */
const SPLAT = (() => {
  const cx = 12, cy = 12, R = 8.4, N = 96, p: string[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / N * 2 * Math.PI, r = R * (1 + .15 * Math.sin(5 * t + .6) + .05 * Math.sin(8 * t + 2.1));
    p.push((cx + r * Math.cos(t)).toFixed(2) + " " + (cy + r * Math.sin(t)).toFixed(2));
  }
  const blob = "M " + p.join(" L ") + " Z";
  const drip = "M 16.6 16.6 C 17.1 20.4 17.7 22.8 17.8 24.8 C 17.9 27.9 13.7 27.9 13.3 24.8 C 12.9 23 12.7 20.5 12.4 17 Z";
  const fleck = (x: number, y: number, r: number) => `M ${x - r} ${y} A ${r} ${r} 0 1 0 ${x + r} ${y} A ${r} ${r} 0 1 0 ${x - r} ${y} Z`;
  return `<svg viewBox="-1 -1 26 29" aria-hidden="true"><path d="${blob} ${drip} ${fleck(22.6, 4.2, 1.5)} ${fleck(2.2, 22, 1.1)}"/></svg>`;
})();

/* initial shared editor state (kept compatible with wiring.ts / gear.ts / path-picker.ts) */
ui.ed = JSON.parse(JSON.stringify(BUILDS[0] || blankBuild()));
ui.sel = [0, 0];
ui.edIdx = BUILDS[0] ? 0 : -1;
ui.edKey = null;
ui.edFrom = "weapons";

/* owned & new from live snapshots (orderedSnapshots); seen persisted in store under seedtracker.gearseen.v1 */
const storedSeen = store.get(SEENKEY);
const seen = new Set<string>(Array.isArray(storedSeen) ? storedSeen : []);
let hasSnap = false;
let ownedSet = new Set<string>();
let fresh = new Set<string>();
function syncOwned(): boolean {
  const snaps = orderedSnapshots(live.snapshots);
  const newest = snaps.find(s => s.pieces.length > 0) || null;
  const nextHas = !!newest;
  const nextOwned = new Set<string>(newest ? newest.pieces.map(p => p.row) : []);
  const changed = nextHas !== hasSnap || nextOwned.size !== ownedSet.size || [...nextOwned].some(r => !ownedSet.has(r));
  hasSnap = nextHas;
  ownedSet = nextOwned;
  return changed;
}
const isOwned = (row: string) => hasSnap && ownedSet.has(row);
const dot = (row: string) => hasSnap && ownedSet.has(row) && !seen.has(row);
const regroup = () => { fresh = new Set([...ownedSet].filter(r => hasSnap && !seen.has(r))); };

/* motion helpers */
let swapN = 0;
const bump = (el: HTMLElement) => el.style.setProperty("--sw", String(++swapN));
function swap(el: any, html: string, dy = 6, done?: () => void) {
  if (!el) return;
  if (el.__html === html) { done && done(); return; }
  el.__html = html;
  if (still() || !isShown()) {
    if (el.__out) { el.__out.cancel(); el.__out = null; }
    el.innerHTML = html; done && done(); return;
  }
  el.__done = done;
  if (el.__out) return;
  bump(el);
  el.__out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: "linear", fill: "forwards" });
  el.__out.onfinish = () => {
    el.innerHTML = el.__html; el.__out.cancel(); el.__out = null;
    const d = el.__done; el.__done = null; d && d();
    el.animate([{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: "none" }], { duration: 200, easing: EASE }).onfinish = () => bump(el);
  };
}
function pop(el: Element | null) {
  if (el && !still() && isShown()) el.animate([{ transform: "scale(.82)", opacity: .2 }, { transform: "none", opacity: 1 }], { duration: 220, easing: EASE });
}

/* editor runtime state */
let mounted = false;
let lastEd: any = null;
let q = "", sortBy = "alpha", cat = 0, runMains = false;
let pickFirst = store.get(PFKEY) === true, armed: string | null = null;
let popCls: string | null = null, wq = "";
let wheelEl: HTMLDivElement | null = null;
let wheelOpen = false, hot = -1, press: { t: number | null; held?: number } | null = null, skipClick = false;
let wcx = 0, wcy = 0, wz = 1;
let holdT = 0;
let statW = "";
let secOpen: Partial<Record<SecId, boolean>> = {};
let secCh: Partial<Record<SecId, boolean>> = {};

const root = () => document.getElementById("editor")!;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => root().querySelector<T>("#" + id)!;
const isShown = () => !!document.getElementById("editor")?.classList.contains("on");

/* adapters between gear14 logic and app's ui.ed shape */
function normEd() {
  if (!ui.ed) ui.ed = blankBuild();
  if (!Array.isArray(ui.ed.set) || ui.ed.set.length !== 3) ui.ed.set = blankBuild().set;
  for (let i = 0; i < 3; i++) {
    const row = ui.ed.set[i];
    if (!Array.isArray(row)) ui.ed.set[i] = ["", "", ["", "", ""]];
    else {
      row[0] = row[0] || "";
      row[1] = row[1] || "";
      const subs = Array.isArray(row[2]) ? row[2] : [];
      row[2] = [subs[0] || "", subs[1] || "", subs[2] || ""];
    }
  }
  ui.ed.modes = MODE_LIST.map(([k]) => k).filter(k => Array.isArray(ui.ed.modes) && ui.ed.modes.includes(k));
  if (typeof ui.ed.title !== "string") ui.ed.title = "";
  if (typeof ui.ed.notes !== "string") ui.ed.notes = "";
  if (!Array.isArray(ui.sel) || ui.sel.length !== 2) ui.sel = [0, 0];
  if (ui.sel[1] < -1) ui.sel = [Math.max(0, Math.min(2, ui.sel[0] | 0)), 0];
}
const gearRow = (i: number): string => ui.ed.set[i][0] || "";
const mainAb = (i: number): string => ui.ed.set[i][1] || "";
const subAb = (i: number, k: number): string => ui.ed.set[i][2][k] || "";
const curWeapon = (): WeaponMeta => weaponByRow.get(ui.ed.weapon) || weaponByRow.get(ui.pick) || WEAPONS[0];
const teeMain = (p: number, k: number) => p === 1 && k < 0 && gearRow(1) === TEE;
const fits = (a: string, p: number, k: number) =>
  a === DBL ? teeMain(p, k) : !teeMain(p, k) && (SUBS.includes(a) || (k < 0 && MAINONLY[p].includes(a)));

function apOf(): Record<string, number> {
  const ap: Record<string, number> = {};
  for (let i = 0; i < 3; i++) {
    const m = mainAb(i);
    if (m && SUBS.includes(m)) ap[m] = (ap[m] || 0) + 10;
    for (let k = 0; k < 3; k++) {
      const s = subAb(i, k);
      if (s) ap[s] = (ap[s] || 0) + 3;
    }
  }
  return ap;
}
function mainsOn(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const m = mainAb(i);
    if (m && !SUBS.includes(m)) out.push(m);
  }
  return out;
}

/* ---------- shelf (left rail) ---------- */
function brandsOf(s: SlotKey): GearMeta[] {
  const m = new Map<string, GearMeta>();
  for (const g of GEAR[s]) if (!m.has(g[2] || "")) m.set(g[2] || "", byRow[g[0]]);
  return [...m.values()];
}
function cmpFor(key: string): (x: GearMeta, y: GearMeta) => number {
  const by = (x: GearMeta, y: GearMeta) => x.name.localeCompare(y.name);
  if (key === "main") return (x, y) => ABORDER.indexOf(x.main) - ABORDER.indexOf(y.main) || by(x, y);
  return by;
}
function drawList(animSwap = true) {
  const s = SLOTS[cat];
  const html = GEAR[s].map(g =>
    `<button class="grow${hasSnap && !isOwned(g[0]) ? " nown" : ""}" aria-label="${esc(g[1])}" data-row="${g[0]}" data-q="${esc((g[1] + " " + g[2] + " " + (NAMES_MAP[g[3]] || "")).toLowerCase())}">` +
      `<span class="blob"><img src="${gimg(g[0])}" alt="" loading="lazy"></span>` +
      `${ab(g[3], 28)}${dot(g[0]) ? `<span class="nw" data-tip="New">${SPLAT}</span>` : ""}</button>`).join("") +
    brandsOf(s).map(g => `<div class="gdiv" data-brand="${esc(g.brand || "")}" hidden>${blogo(g, 32)}<b>${esc(g.brand || "")}</b><i class="rule"></i>${NAMES_MAP[g.fav] ? ab(g.fav, 28) : ""}</div>`).join("") +
    `<div class="empty" hidden>Nothing</div>`;
  const listEl = $("list") as any;
  if (!animSwap) {
    if (listEl.__out) { listEl.__out.cancel(); listEl.__out = null; }
    listEl.__html = html;
    listEl.innerHTML = html;
    filter(false);
  } else {
    swap(listEl, html, 4, () => filter(false));
  }
}
function endLeave(el: any) {
  if (!el.classList.contains("leaving")) return;
  if (el.__fl) { el.__fl.cancel(); el.__fl = null; }
  el.classList.remove("leaving"); el.hidden = true;
  for (const p of ["position", "left", "top", "width", "height", "margin"]) el.style.removeProperty(p);
}
function relayout(list: HTMLElement, items: [HTMLElement, boolean, number][], anim: boolean) {
  list.querySelectorAll(".leaving").forEach(endLeave);
  if (!anim) {
    for (const [el, show, o] of items) {
      const a = (el as any).__fl; if (a) { a.cancel(); (el as any).__fl = null; }
      el.style.order = String(o); el.hidden = !show;
    }
    return;
  }
  const lr = list.getBoundingClientRect(), was = new Map<HTMLElement, DOMRect>();
  for (const [el] of items) if (!el.hidden) was.set(el, el.getBoundingClientRect());
  const near = (r: DOMRect) => r.bottom > lr.top - 60 && r.top < lr.bottom + 60;
  for (const [el, show, o] of items) {
    const prevA = (el as any).__fl; if (prevA) { prevA.cancel(); (el as any).__fl = null; }
    el.style.order = String(o);
    const w = was.get(el);
    if (!show && w && near(w)) {
      el.classList.add("leaving");
      Object.assign(el.style, {
        position: "absolute", margin: "0",
        left: (w.left - lr.left - list.clientLeft + list.scrollLeft) + "px",
        top: (w.top - lr.top - list.clientTop + list.scrollTop) + "px",
        width: w.width + "px", height: w.height + "px",
      });
      const fl = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.88)" }], { duration: 160, easing: EASE });
      (el as any).__fl = fl;
      fl.onfinish = () => endLeave(el);
    } else el.hidden = !show;
  }
  for (const [el, show] of items) {
    if (!show) continue;
    const now = el.getBoundingClientRect(), w = was.get(el);
    if (!w) {
      if (near(now)) (el as any).__fl = el.animate([{ opacity: 0, transform: "scale(.85)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: EASE });
      continue;
    }
    const dx = w.left - now.left, dy = w.top - now.top;
    if ((Math.abs(dx) > .5 || Math.abs(dy) > .5) && (near(now) || near(w)))
      (el as any).__fl = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 320, easing: EASE });
  }
}
function filter(anim = true) {
  const list = $("list") as any, cmp = cmpFor(sortBy), brand = sortBy === "brand";
  const grp = (g: GearMeta) => !hasSnap ? 1 : fresh.has(g.row) ? 0 : isOwned(g.row) ? 1 : 2;
  const bk = (g: GearMeta) => brand ? g.brand || "~" : "";
  const rows: [HTMLElement, GearMeta][] = [...list.querySelectorAll(".grow")].map((r: HTMLElement) => [r, byRow[r.dataset.row!]] as [HTMLElement, GearMeta])
    .sort((x, y) => bk(x[1]).localeCompare(bk(y[1])) || grp(x[1]) - grp(y[1]) || cmp(x[1], y[1]));
  const divs = new Map<string, HTMLElement>([...list.querySelectorAll(".gdiv")].map((d: HTMLElement) => [d.dataset.brand || "", d]));
  const items: [HTMLElement, boolean, number][] = [], shown = new Set<string>();
  let n = 0, k = 0, last: string | null = null;
  for (const [r, g] of rows) {
    const show = !q || (r.dataset.q || "").includes(q);
    if (brand && g.brand !== last) { last = g.brand; const d = divs.get(g.brand || ""); if (d) items.push([d, false, k++]); }
    if (show) { n++; shown.add(g.brand || ""); }
    items.push([r, show, k++]);
    r.classList.toggle("on", r.dataset.row === gearRow(cat));
  }
  for (const it of items) if (it[0].classList.contains("gdiv")) it[1] = shown.has(it[0].dataset.brand || "");
  for (const d of divs.values()) if (!items.some(it => it[0] === d)) items.push([d, false, k++]);
  const e = list.querySelector(".empty") as HTMLElement | null;
  if (e) items.push([e, n === 0, k++]);
  relayout(list, items, anim && !still() && !list.__out && isShown());
  list.dataset.sort = sortBy;
  const total = SLOTS.reduce((sum, slot) => sum + GEAR[slot].length, 0);
  swap($("count"), `${n}/${total}`, 2);
  ($("q").parentNode as HTMLElement).classList.toggle("none", n === 0);
  paintSort();
}
function paintSort() {
  $("sortcur").textContent = (SORTS.find(s => s[0] === sortBy) || SORTS[0])[1];
  const html = SORTS.map(([k, n], i) => `<button class="tape sopt${k === sortBy ? " on" : ""}" data-sort="${k}" style="--tr:${[-1, .8, -.5][i]}deg">${n}</button>`).join("");
  const m = $("sortmenu") as any;
  if (m.__html !== html) { m.__html = html; m.innerHTML = html; }
}
function openSort(open: boolean) {
  const m = $("sortmenu"), b = $("sortbtn");
  m.classList.toggle("open", open); m.inert = !open;
  b.classList.toggle("on", open); b.setAttribute("aria-expanded", String(open));
}
function paintCat() {
  for (const t of [...$("slots").children] as HTMLElement[]) t.classList.toggle("on", +(t.dataset.cat || 0) === cat);
}
function setCat(i: number, animSwap = true) {
  if (i === cat && ($("list") as any).__html) return paintCat();
  cat = i; regroup(); paintCat(); drawList(animSwap);
}
function paintLabel(row?: string) {
  const g = byRow[row || gearRow(cat)], l = $("label");
  const status = !g || !hasSnap ? "" : dot(g.row) ? "new" : isOwned(g.row) ? "" : "not owned";
  swap(l, g ? `<b>${esc(g.name)}</b><small>${blogo(g, 34)}${status}</small>` : "<b></b><small></small>", 3);
}

/* ---------- center locker: pieces, weapon, modes, AP strip, Save ---------- */
function paintPieces(changed = false) {
  $("pieces").classList.toggle("all", pickFirst);
  root().querySelectorAll<HTMLElement>(".piece").forEach((el, i) => {
    const r = gearRow(i), g = r ? byRow[r] : null;
    const img = el.querySelector<HTMLImageElement>(".blob img")!, blob = el.querySelector<HTMLElement>(".blob")!;
    if (img.dataset.row !== r) {
      img.dataset.row = r;
      if (g) img.src = gimg(g.row); else img.removeAttribute("src");
      if (changed) pop(img);
    }
    blob.classList.toggle("none", !g);
    blob.classList.toggle("nown", !!g && hasSnap && !isOwned(g.row));
    el.classList.toggle("empty", !g);
    el.classList.toggle("cur", pickFirst || ui.sel[0] === i);
    swap(el.querySelector(".stars"), g ? "★".repeat(g.stars) : "", 4);
    swap(el.querySelector(".nm"), g ? (g.bid ? `<span class="lg" style="--bz:30px">${blogo(g, 30)}</span>` : "") + esc(g.name) : SLOTNAME[i], 4);
    el.querySelectorAll<HTMLElement>(".slot").forEach(sl => {
      const k = +(sl.dataset.s || 0), a = k < 0 ? mainAb(i) : subAb(i, k), html = slotAb(a, k < 0 ? 54 : 40);
      const name = a ? (NAMES_MAP[a] || a) : "Empty: pick an ability";
      const sAny = sl as any;
      if (sAny.__a !== a) {
        sl.setAttribute("aria-label", name);
        sl.innerHTML = html;
        sl.querySelectorAll("[data-tip]").forEach(n => n.removeAttribute("data-tip"));
        if (changed && sAny.__a !== undefined) pop(sl.firstElementChild);
        sAny.__a = a;
      }
      sl.classList.toggle("sel", !armed && ui.sel[0] === i && ui.sel[1] === k);
      sl.classList.toggle("ok", !!armed && fits(armed, i, k));
      sl.classList.toggle("no", !!armed && !fits(armed, i, k));
    });
  });
}

function arrowX(row: string): number {
  const h = ARTBUSY[row]; if (!h) return 75;
  const busy = (x: number) => x < 0 || x > 149 ? 0 : (parseInt(h[x >> 2], 16) >> (3 - (x & 3))) & 1, R = 16;
  let best = 75, bd = 1e9;
  for (let x = -20; x <= 175; x++) {
    let ok = true;
    for (let d = -R; d <= R && ok; d++) if (busy(x + d)) ok = false;
    if (ok && Math.abs(x - 75) < bd) { bd = Math.abs(x - 75); best = x; }
  }
  return best;
}
function openPop(cls: string) {
  const p = $("wpop"), lk = p.parentElement!, wp = $("wpick");
  const curW = curWeapon();
  popCls = cls; wq = ""; $<HTMLInputElement>("wq").value = "";
  const list = WEAPONS.filter(w => w.cls === cls);
  const fams = new Map<string, WeaponMeta[]>();
  for (const w of list) {
    const k = w.row.replace(/_[^_]+$/, "");
    if (!fams.has(k)) fams.set(k, []);
    fams.get(k)!.push(w);
  }
  const half = Math.max(...[...fams.values()].map(f => f.length).filter(n => n <= 3), 1);
  $("wgrid").innerHTML = [...fams.values()].map(f =>
    `<div class="wfam${f.length > half ? " wide" : ""}" style="min-width:${f.length > half ? 0 : half * 60 + 2}px">` +
    f.map(w => `<button class="wcell${w.row === curW.row ? " on" : ""}" data-w="${w.row}" data-q="${esc(w.name.toLowerCase())}" data-tip="${esc(w.name)}" aria-label="${esc(w.name)}"><img src="${wimg(w)}" alt=""></button>`).join("") +
    `</div>`).join("") +
    `<div class="none" hidden>No ${esc(clsName(cls).toLowerCase())} by that name</div>`;
  $<HTMLImageElement>("wti").src = timg(cls);
  $("wpt").textContent = clsName(cls);
  $("wpn").textContent = String(list.length);
  const Lr = lk.getBoundingClientRect(), A = wp.getBoundingClientRect(), P = $("pieces").getBoundingClientRect(), z = Lr.width / lk.offsetWidth || 1;
  p.style.left = (P.left - Lr.left) / z + "px";
  p.style.width = "";
  p.style.maxWidth = P.width / z + "px";
  p.style.top = (A.bottom - Lr.top) / z + 14 + "px";
  p.style.setProperty("--ax", (A.left - P.left) / z + arrowX(curW.row) - 9 + "px");
  p.style.setProperty("--wmax", Math.max(200, lk.clientHeight - p.offsetTop - 24) + "px");
  p.classList.add("open"); p.inert = false; wp.setAttribute("aria-expanded", "true");
  $<HTMLInputElement>("wq").focus({ preventScroll: true });
}
function closePop() {
  if (!mounted) return;
  const p = $("wpop"); if (!p.classList.contains("open")) return;
  p.classList.remove("open"); p.inert = true; popCls = null;
  $("wpick").setAttribute("aria-expanded", "false");
}
function paintWpop() {
  let n = 0;
  for (const c of $("wgrid").querySelectorAll<HTMLElement>(".wcell")) {
    const show = !wq || (c.dataset.q || "").includes(wq);
    c.hidden = !show; if (show) n++;
  }
  for (const f of $("wgrid").querySelectorAll<HTMLElement>(".wfam"))
    f.hidden = ![...f.children].some(c => !(c as HTMLElement).hidden);
  const none = $("wgrid").querySelector<HTMLElement>(".none");
  if (none) none.hidden = n > 0;
  $("wpn").textContent = String(n);
  ($("wq").parentNode as HTMLElement).classList.toggle("none", n === 0);
}
function paintWeapon() {
  const w = curWeapon();
  swap($("wpick"), `<span class="blob"><img src="${wimg(w)}" alt="${esc(w.name)}"></span>`, 4);
  swap($("wkit"), `<i data-tip="${esc(SUBN[w.sub] || "")}"><img src="${subimg(w)}" alt="${esc(SUBN[w.sub] || "")}"></i><i data-tip="${esc(SPN[w.sp] || "")}"><img src="${spimg(w)}" alt="${esc(SPN[w.sp] || "")}"></i>`, 4);
  swap($("wname"), esc(w.name), 4);
}

/* ---------- class wheel (mounted on document.body outside #editor zoom) ---------- */
const WR = 164, Wr = 100, WC = 180, WN = CLASSES.length;
const WDEAD = 32, WHYST = 6, WLINGER = 600;
function ensureWheel(): HTMLDivElement {
  if (wheelEl) return wheelEl;
  wheelEl = document.createElement("div");
  wheelEl.className = "ed-wheel"; wheelEl.id = "ed-wheel"; wheelEl.inert = true;
  const P = (rad: number, t: number): [number, number] => [WC + rad * Math.cos(t), WC + rad * Math.sin(t)];
  const f = (p: [number, number]) => p[0].toFixed(2) + " " + p[1].toFixed(2);
  const toward = (p: [number, number], qPt: [number, number], d: number): [number, number] => {
    const l = Math.hypot(qPt[0] - p[0], qPt[1] - p[1]);
    return [p[0] + (qPt[0] - p[0]) * d / l, p[1] + (qPt[1] - p[1]) * d / l];
  };
  const span = 2 * Math.PI / WN, g = 3, cr = 8;
  const segs = CLASSES.map(([c, n], i) => {
    const m = -Math.PI / 2 + i * span, t0 = m - span / 2, t1 = m + span / 2;
    const o0 = t0 + Math.asin(g / WR), o1 = t1 - Math.asin(g / WR), i0 = t0 + Math.asin(g / Wr), i1 = t1 - Math.asin(g / Wr);
    const A = P(WR, o0), B = P(WR, o1), C = P(Wr, i1), D = P(Wr, i0);
    const d = `M ${f(toward(A, D, cr))} Q ${f(A)} ${f(P(WR, o0 + cr / WR))} A ${WR} ${WR} 0 0 1 ${f(P(WR, o1 - cr / WR))} Q ${f(B)} ${f(toward(B, C, cr))}`
      + ` L ${f(toward(C, B, cr))} Q ${f(C)} ${f(P(Wr, i1 - cr / Wr))} A ${Wr} ${Wr} 0 0 0 ${f(P(Wr, i0 + cr / Wr))} Q ${f(D)} ${f(toward(D, A, cr))} Z`;
    const er = Wr + 4.5, e = `M ${f(P(er, i1 - (cr + 3) / er))} A ${er} ${er} 0 0 0 ${f(P(er, i0 + (cr + 3) / er))}`;
    const ic = P((WR + Wr) / 2, m);
    return `<g class="seg" data-i="${i}" data-wc="${c}" role="button" aria-label="${esc(n)}" style="--i:${i};--dx:${(9 * Math.cos(m)).toFixed(2)}px;--dy:${(9 * Math.sin(m)).toFixed(2)}px"><title>${esc(n)}</title>`
      + `<path class="bg" d="${d}"/><path class="tx" d="${d}"/><path class="rim" d="${d}"/><path class="edge" d="${e}"/>`
      + `<image href="${timg(c)}" x="${(ic[0] - 23).toFixed(1)}" y="${(ic[1] - 23).toFixed(1)}" width="46" height="46"/></g>`;
  }).join("");
  wheelEl.innerHTML = `<svg width="${2 * WC}" height="${2 * WC}" viewBox="0 0 ${2 * WC} ${2 * WC}" role="group" aria-label="Weapon classes"><defs><pattern id="wtex" patternUnits="userSpaceOnUse" width="700" height="441" x="-170" y="-40"><image href="${A_circles}" width="700" height="441"/></pattern></defs>${segs}</svg>`;
  document.body.appendChild(wheelEl);
  return wheelEl;
}
function setHot(i: number) {
  hot = i;
  wheelEl?.querySelectorAll<SVGElement>(".seg").forEach(s => s.classList.toggle("hot", +(s.dataset.i || -1) === i));
}
function openWheel() {
  const wheel = ensureWheel();
  closePop();
  const r = $("wpick").getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  wz = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--zed")) || 1;
  const m = (WR + 12) * wz;
  wcx = Math.max(m, Math.min(innerWidth - m, x));
  wcy = Math.max(m, Math.min(innerHeight - m, y));
  wheel.style.left = (wcx - WC) + "px";
  wheel.style.top = (wcy - WC) + "px";
  wheel.style.transform = `scale(${wz})`;
  const cur = curWeapon().cls;
  wheel.querySelectorAll<SVGElement>(".seg").forEach(s => s.classList.toggle("cur", s.dataset.wc === cur));
  wheelOpen = true; wheel.inert = false; wheel.classList.add("open"); setHot(-1);
}
function closeWheel() {
  if (!wheelOpen || !wheelEl) return;
  wheelOpen = false; wheelEl.inert = true; wheelEl.classList.remove("open"); setHot(-1);
}
function wheelHit(x: number, y: number): number {
  const dx = x - wcx, dy = y - wcy, d = Math.hypot(dx, dy) / wz;
  if (d < Wr - 4 || d > WR + 14) return -1;
  const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360 + 180 / WN) % 360;
  return Math.floor(deg / (360 / WN));
}
function wheelPick(x: number, y: number): number {
  const over = wheelHit(x, y); if (over >= 0) return over;
  const dx = x - wcx, dy = y - wcy; if (Math.hypot(dx, dy) / wz <= WDEAD) return -1;
  const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360, span = 360 / WN;
  if (hot >= 0) { const off = Math.abs(((deg - hot * span) % 360 + 540) % 360 - 180); if (off <= span / 2 + WHYST) return hot; }
  return Math.floor(((deg + span / 2) % 360) / span);
}

/* ---------- right column: abilities palette ---------- */
function paintPal() {
  const [p, s] = ui.sel, cur = s < 0 ? mainAb(p) : subAb(p, s);
  const k = $("pfk"); k.classList.toggle("on", pickFirst); k.setAttribute("aria-pressed", String(pickFirst));
  const mark = () => root().querySelectorAll<HTMLButtonElement>(".pal .popt").forEach(o => {
    const a = o.dataset.a || "", off = !pickFirst && (s >= 0 ? !SUBS.includes(a) : a === DBL ? !teeMain(p, s) : teeMain(p, s));
    o.classList.toggle("cur", !pickFirst && a === cur);
    o.classList.toggle("armed", pickFirst && a === armed);
    o.classList.toggle("off", off); o.disabled = off;
    o.setAttribute("aria-label", NAMES_MAP[a] || a);
    o.querySelector(".ab")?.removeAttribute("data-tip");
  });
  mark();
  const pm = $("pmains"), h0 = pm.offsetHeight;
  swap(pm, (pickFirst ? ALLMAIN : MAINONLY[p]).map(a => `<button class="popt" data-a="${a}">${ab(a, 40)}</button>`).join(""), 4, () => {
    mark();
    const h1 = pm.offsetHeight;
    if (!still() && isShown() && h0 > 0 && Math.abs(h1 - h0) > .5) pm.animate([{ height: h0 + "px" }, { height: h1 + "px" }], { duration: 240, easing: EASE });
  });
}

/* ---------- right column: stats panel ---------- */
function pipRow(label: string, b0: number, b1: number, per: number): string {
  const top = Math.max(b0, b1) / per, n = Math.ceil(top - 1e-9);
  let pips = "";
  for (let k = 0; k < n; k++) {
    const f = Math.max(0, Math.min(1, b0 / per - k)), g1 = Math.max(0, Math.min(1, b1 / per - k));
    const lo = Math.min(f, g1).toFixed(3), add = Math.max(0, g1 - f).toFixed(3);
    pips += `<span class="pip"><i style="--f:${lo}"></i><b style="--f:${lo};--g:${add}"></b></span>`;
  }
  const v = b0 === b1 ? nfmt(b1, 2) : `<s>${nfmt(b0, 2)}</s> → ${nfmt(b1, 2)}`;
  return `<div class="pl"><span>${esc(label)}</span><span class="pips">${pips}</span><span class="pv">${v}</span></div>`;
}

function buildStats(sections: StatSection[], wRow: string) {
  statW = wRow;
  $("srows").innerHTML = sections.map(sec =>
    `<section class="sec" data-sec="${sec.id}">` +
    `<button class="sh" data-sec="${sec.id}" aria-expanded="true"><i class="caret"></i><span>${esc(sec.title)}</span><small></small></button>` +
    `<div class="sb"><div>` +
    sec.rows.map(r => r.kind === "acts"
      ? `<div class="acts" data-rid="${r.id}"><div class="at">Actions per ink tank<small></small></div><div class="ab2"></div></div>`
      : `<div class="sr" data-rid="${r.id}">${r.kind === "num" && r.ability ? `<img class="ic" src="${simg(r.ability)}" alt="" data-tip="${esc(NAMES_MAP[r.ability] || r.ability)}">` : `<span class="ic"></span>`}<span class="nm" data-tip="${esc(r.name)}">${esc(r.name)}</span><span class="d"></span><span class="bar"><i></i><span class="dl"></span></span><span class="bv"><s></s><span class="ar">→</span><b></b></span></div>`
    ).join("") +
    `</div></div></section>`
  ).join("");
}

const liveRows = (body: Element): HTMLElement[] =>
  [...body.children].filter(r => !r.classList.contains("ghost")) as HTMLElement[];

interface RowSnap { top: number; h: number; q: boolean; clone: HTMLElement; }
interface SecSnap { shut: boolean; h: number; rows: Map<HTMLElement, RowSnap>; }

function statsBefore(): Map<HTMLElement, SecSnap> {
  const box = $("srows");
  return new Map(([...box.children] as HTMLElement[]).map(sec => {
    const body = sec.querySelector<HTMLElement>(".sb > div")!, br = body.getBoundingClientRect();
    const rows = new Map<HTMLElement, RowSnap>(liveRows(body).map(r => {
      const rr = r.getBoundingClientRect();
      return [r, { top: rr.top - br.top, h: rr.height, q: r.classList.contains("q"), clone: r.cloneNode(true) as HTMLElement }];
    }));
    return [sec, { shut: sec.classList.contains("shut"), h: br.height, rows }];
  }));
}

function statsAfter(before: Map<HTMLElement, SecSnap>) {
  for (const [sec, o] of before) {
    const body = sec.querySelector<HTMLElement>(".sb > div")! as any;
    if (body.__fl) { body.__fl.cancel(); body.__fl = null; }
    for (const r of body.children as HTMLCollectionOf<any>) if (r.__fl) { r.__fl.cancel(); r.__fl = null; }
    if (o.shut || sec.classList.contains("shut")) continue;
    const br = body.getBoundingClientRect();
    for (const r of liveRows(body)) {
      const was = o.rows.get(r); if (!was) continue;
      const rr = r.getBoundingClientRect(), top = rr.top - br.top;
      if (was.q !== r.classList.contains("q")) {
        const gh = was.clone; gh.classList.add("ghost"); gh.removeAttribute("data-rid");
        gh.style.top = was.top + "px"; gh.style.height = was.h + "px"; body.appendChild(gh);
        gh.animate([{ opacity: 1, height: was.h + "px" }, { opacity: 0, height: "0px" }], { duration: 220, easing: EASE, fill: "forwards" }).onfinish = () => gh.remove();
        (r as any).__fl = r.animate([{ opacity: 0, clipPath: `inset(0 0 ${rr.height}px 0)` }, { opacity: 1, clipPath: "inset(0 0 0 0)" }], { duration: 300, easing: EASE });
      } else if (Math.abs(top - was.top) > .5) {
        (r as any).__fl = r.animate([{ transform: `translateY(${was.top - top}px)` }, { transform: "none" }], { duration: 320, easing: EASE });
      }
    }
    if (Math.abs(br.height - o.h) > .5) body.__fl = body.animate([{ height: o.h + "px" }, { height: br.height + "px" }], { duration: 320, easing: EASE });
  }
}

function paintStats() {
  const w = curWeapon();
  const sections = computeStats(w, ui.ed.set, WEAPON_STATS);
  const rebuilt = statW !== w.row;
  if (rebuilt) buildStats(sections, w.row);
  const before = !rebuilt && !still() && isShown() ? statsBefore() : null;
  const box = $("srows");
  const secTop = new Map<HTMLElement, number>(before ? ([...box.children] as HTMLElement[]).map(s => [s, s.getBoundingClientRect().top]) : []);
  const secById = new Map<SecId, StatSection>(sections.map(s => [s.id, s]));

  for (const secEl of [...box.children] as HTMLElement[]) {
    const id = secEl.dataset.sec as SecId;
    const secData = secById.get(id);
    if (!secData) continue;
    const rowById = new Map<string, StatRow>(secData.rows.map(r => [r.id, r]));
    let nch = 0;
    const rows = liveRows(secEl.querySelector(".sb > div")!);
    rows.forEach((rEl, k) => {
      const r = rowById.get(rEl.dataset.rid || "");
      if (!r) return;
      if (r.kind === "acts") {
        const ar = r as ActsStatRow;
        const sm = rEl.querySelector<HTMLElement>(".at small")!;
        sm.textContent = ar.sharedPer != null ? (ar.sharedPer > 1 ? `1 pip = ${ar.sharedPer}` : "1 pip = 1") : "";
        const html = ar.kinds.map(kd =>
          `<div class="ak"><span>${esc(kd.label)}</span>${ar.sharedPer == null ? `<small>${kd.per > 1 ? `1 pip = ${kd.per}` : "1 pip = 1"}</small>` : ""}</div>` +
          pipRow("no sub", kd.noSub0, kd.noSub1, kd.per) +
          pipRow("1 " + ar.subName, kd.withSub0, kd.withSub1, kd.per)
        ).join("");
        const ab2 = rEl.querySelector<HTMLElement>(".ab2")! as any;
        if (ab2.__h !== html) { ab2.__h = html; ab2.innerHTML = html; }
      } else if (r.kind === "text") {
        rEl.querySelector(".bv s")!.textContent = r.text;
        rEl.querySelector(".bv b")!.textContent = r.text;
      } else {
        const nr = r as NumStatRow;
        rEl.querySelector(".bv s")!.textContent = nr.baseFmt;
        rEl.querySelector(".bv b")!.textContent = nr.valFmt;
        const p0 = nr.base / nr.max, p1 = nr.val / nr.max;
        const bar = rEl.querySelector<HTMLElement>(".bar")!, dl = bar.querySelector<HTMLElement>(".dl")!;
        bar.style.setProperty("--p", Math.min(p0, p1).toFixed(3));
        dl.style.setProperty("--a", Math.min(p0, p1).toFixed(3));
        dl.style.setProperty("--w", Math.abs(p1 - p0).toFixed(3));
        dl.classList.toggle("neg", p1 < p0);
        rEl.querySelector(".d")!.textContent = nr.deltaFmt;
      }
      rEl.classList.toggle("q", !r.changed);
      rEl.style.order = String((r.changed ? 0 : 100) + k);
      if (r.changed) nch++;
    });
    if (secCh[id] !== undefined && secCh[id] !== (nch > 0)) delete secOpen[id];
    secCh[id] = nch > 0;
    const open = secOpen[id] ?? (nch > 0);
    secEl.classList.toggle("shut", !open);
    secEl.querySelector(".sh")!.setAttribute("aria-expanded", String(open));
    const sm = secEl.querySelector<HTMLElement>(".sh small")!;
    swap(sm, nch ? `${nch} changed` : `${rows.length} stats`, 3, () => sm.classList.toggle("ch", nch > 0));
  }

  const order = SECS.map(s => s[0]).sort((x, y) => Number(!!secCh[y]) - Number(!!secCh[x]));
  const want = order.map(id => box.querySelector<HTMLElement>(`.sec[data-sec="${id}"]`)!).filter(Boolean);
  if (want.some((s, i) => box.children[i] !== s)) want.forEach(s => box.appendChild(s));
  if (before) statsAfter(before);
  for (const [s, t0] of secTop) {
    const sa = s as any;
    if (sa.__mv) { sa.__mv.cancel(); sa.__mv = null; }
    const dy = t0 - s.getBoundingClientRect().top;
    if (Math.abs(dy) > .5) sa.__mv = s.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 320, easing: EASE });
  }
  swap($("tot"), `${apTotal(ui.ed.set)} AP`, 4);
}

/* ---------- AP strip ---------- */
function fitStrip() {
  if (!mounted) return;
  const s = $("apstrip"), W = s.clientWidth, PAD = 8, GAP = 5;
  if (!W) return;
  for (const el of [...s.children] as HTMLElement[]) {
    if (el.classList.contains("exclusive")) continue;
    const v = +el.style.getPropertyValue("--units") || 0;
    const img = el.querySelector<HTMLElement>("img")!, n = el.querySelector<HTMLElement>("b")!;
    const need = PAD + img.offsetWidth + GAP + n.scrollWidth + PAD;
    el.classList.toggle("num", v > 0 && W * v / 57 >= need);
  }
}
function paintStrip() {
  const s = $("apstrip"), ap = apOf(), exclusive = mainsOn();
  if (!s.children.length) {
    s.innerHTML =
      SUBS.map(a => `<span data-a="${a}" data-tip="${esc(NAMES_MAP[a])}"><span class="ap-ink"><img src="${simg(a)}" alt=""><b></b></span></span>`).join("") +
      ALLMAIN.map(a => `<span class="exclusive" data-a="${a}" data-tip="${esc(NAMES_MAP[a])}"><span class="ap-ink"><img src="${simg(a)}" alt="${esc(NAMES_MAP[a])}"></span></span>`).join("");
  }
  const box = s.getBoundingClientRect(), children = [...s.children] as HTMLElement[];
  const leftEdges = children.map(el => el.getBoundingClientRect().left - box.left);
  let nextBefore = 0;
  for (const [i, el] of children.entries()) {
    const a = el.dataset.a || "", n = el.querySelector("b"), old = +el.style.getPropertyValue("--units") || 0;
    const v = n ? ap[a] || 0 : exclusive.includes(a) ? 10 : 0;
    if (!n && !old) el.style.setProperty("--enter-delay", v && box.width > 0 && leftEdges[i] - box.width * nextBefore / 57 > .5 ? "var(--strip-width-time)" : "0ms");
    nextBefore += v;
    el.style.setProperty("--units", String(v));
    el.setAttribute("aria-hidden", String(v === 0));
    if (n && v && n.textContent !== String(v)) n.textContent = String(v);
  }
  fitStrip();
}

/* ---------- modes & save button ---------- */
function paintModes() {
  for (const c of [...$("mods").children] as HTMLElement[]) {
    const on = ui.ed.modes.includes(c.dataset.m);
    c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on));
  }
}
function paintSave() {
  const s = $<HTMLButtonElement>("save");
  const gap = [0, 1, 2].some(i => !mainAb(i) || [0, 1, 2].some(k => !subAb(i, k)));
  const reason = !(ui.ed.title || "").trim() ? "Needs a name" : gap ? "Fill every slot" : "";
  s.disabled = !!reason;
  if (reason) s.dataset.tip = reason; else delete s.dataset.tip;
}
function paint(changed = false) {
  paintPieces(changed);
  paintStrip();
  paintPal();
  paintStats();
  paintSave();
  filter();
  paintLabel();
}

/* ---------- title & description sizing ---------- */
const titleMeasure = document.createElement("canvas").getContext("2d")!;
const cap = (value: string, field: HTMLTextAreaElement) => String(value ?? "").slice(0, field.maxLength).replace(/[\uD800-\uDBFF]$/, "");
const titleText = (value: string, field: HTMLTextAreaElement) => cap(String(value ?? "").replace(/\r\n?|\n/g, " "), field);
function fitTitle() {
  if (!mounted) return;
  const f = $<HTMLTextAreaElement>("title"), width = f.clientWidth;
  if (!width) return;
  titleMeasure.font = `44px ${getComputedStyle(f).fontFamily}`;
  const advance = titleMeasure.measureText(f.value || f.placeholder).width;
  let size = Math.max(30, Math.floor(44 * width / Math.max(width, advance + 2)));
  f.style.height = "0px";
  const available = f.parentElement!.clientHeight - 6;
  do { f.style.fontSize = `${size}px`; } while (f.scrollHeight > available && --size >= 12);
  f.style.height = `${Math.min(available, f.scrollHeight) + 6}px`;
}

/* ---------- hold-to-Delete (~700 ms) ---------- */
function stopHold() {
  if (!mounted) return;
  clearTimeout(holdT); holdT = 0;
  $("discard").classList.remove("holding");
}
function startHold() {
  const del = $("discard");
  if (holdT) return;
  del.classList.add("holding");
  holdT = window.setTimeout(() => {
    holdT = 0;
    del.classList.remove("holding");
    closeOverlays();
    late.deleteEditorBuild?.();
  }, 700);
}
function closeOverlays() {
  if (!mounted) return;
  openSort(false);
  closePop();
  closeWheel();
  stopHold();
}

/* ---------- keyboard slot stepping (Tab / Shift+Tab, and Enter/Space when not on a button/field) ---------- */
function edStep([g, s]: [number, number], d: number): [number, number] | null {
  const order: [number, number][] = [0, 1, 2].flatMap(r => [0, 1, 2].map(k => [r, k] as [number, number]));
  const at = s >= 0 ? order.findIndex(([r, k]) => r === g && k === s)
    : d > 0 ? order.findIndex(([r]) => r === g) - 1 : order.findIndex(([r]) => r === g);
  return order[at + d] || null;
}

/* ---------- mount once & wire events ---------- */
function mount() {
  if (mounted) return;
  mounted = true;
  const host = root();
  host.innerHTML = `<div class="lk">
    <aside class="rail">
      <div class="slots" id="slots"></div>
      <label class="seek"><input id="q" placeholder="Search" autocomplete="off" spellcheck="false" aria-label="Search gear"></label>
      <div class="sortbar"><button class="tape sortbtn" id="sortbtn" aria-haspopup="true" aria-expanded="false"><small>Sort</small><span id="sortcur"></span><i class="caret"></i></button><span class="n" id="count"></span>
        <div class="sortmenu" id="sortmenu" inert></div></div>
      <div class="list scroll" id="list"></div>
      <div class="label"><div class="lin" id="label"><b></b><small></small></div></div>
    </aside>
    <section class="locker paper">
      <img class="staple l" src="${A_staple_left}" alt=""><img class="staple r" src="${A_staple_right}" alt="">
      <div class="ltop">
        <button class="wpick" id="wpick" aria-expanded="false" aria-label="Change weapon" data-tip="Hold for classes" data-tip-delay="1500"></button>
        <div class="buildcopy"><div class="titlebox"><textarea class="tin" id="title" rows="1" required maxlength="50" aria-label="Build name" placeholder="Build name" spellcheck="false"></textarea></div><textarea class="bdesc" id="description" rows="2" maxlength="280" aria-label="Build description" placeholder="Build description"></textarea><div class="drow"><span class="wkit" id="wkit"></span><div class="wname" id="wname"></div></div></div>
        <div class="side"><button class="save" id="save"><span>Save build</span><span>Saved</span></button><button class="disc" id="discard" data-tip="Hold to delete" aria-label="Delete build (hold)"><span class="dl"><span>Delete</span></span><span class="dl fill" aria-hidden="true"><span>Delete</span></span></button><div class="mods" id="mods"></div></div>
      </div>
      <div class="pieces" id="pieces"></div>
      <div class="ledger"><div class="lrow"><span class="cfw"><button class="qt cf" id="copyfit"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.2 3.2 L3 5.9 L4.8 9.1 L6.4 8.3 V16.8 H13.6 V8.3 L15.2 9.1 L17 5.9 L12.8 3.2 Q10 5.6 7.2 3.2 Z"/></svg>Copy outfit<span class="dots"><span>...</span><span id="cfdots"></span></span></button><i class="why" role="status"></i></span><button class="qt" id="sendou"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.5 3.5 H16.5 V8.5 M16.5 3.5 L9.5 10.5 M14.5 12 V16.5 H3.5 V5.5 H8"/></svg>Sendou</button></div></div>
      <div class="apstrip" id="apstrip"></div>
    </section>
    <aside class="plan">
      <div class="pal">
        <div class="head"><span>Abilities</span><span class="hr"><button class="pfk" id="pfk" aria-pressed="false" aria-label="Pick an ability, then click slots" data-tip="Pick an ability first"><b><svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true"><circle class="sl" cx="10" cy="10" r="6.5" pathLength="24"/></svg><svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true"><g transform="translate(0 -.7)"><path class="shk" d="M6.6 9.2 V6.6 A3.4 3.4 0 0 1 13.4 6.6 V9.2"/><rect class="bd" x="4" y="9.2" width="12" height="8.6" rx="1.8"/><circle cx="10" cy="12.8" r="1.25" fill="currentColor"/><path d="M10 13.4 V15.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></g></svg></b></button></span></div>
        <div class="pgrid" id="psubs"></div>
        <div class="pgrid pmains" id="pmains"></div>
      </div>
      <div class="stats">
        <div class="h"><span>Stats</span><span class="tot" id="tot"></span></div>
        <div class="srows scroll" id="srows"></div>
      </div>
    </aside>
    <div class="wpop" id="wpop" inert aria-label="Pick a weapon">
      <div class="wph"><img class="wti" id="wti" alt=""><b class="wpt" id="wpt"></b><label class="seek"><input id="wq" placeholder="Filter" autocomplete="off" spellcheck="false" aria-label="Filter weapons"></label><span class="wpn" id="wpn"></span></div>
      <div class="wgrid" id="wgrid"></div>
    </div>
  </div>`;

  $("slots").innerHTML = SLOTNAME.map((n, i) => `<button class="tape" data-cat="${i}" style="--tr:${[-1.5, .8, -.6][i]}deg">${n}</button>`).join("");
  $("pieces").innerHTML = SLOTS.map((_, i) => `<div class="piece" data-p="${i}">
    <button class="gp" data-p="${i}" aria-label="${SLOTNAME[i]}"><span class="blob"><img alt=""></span></button>
    <div class="stars"></div><div class="nm"></div>
    <div class="ab-row"><button class="slot" data-p="${i}" data-s="-1"></button><span class="vsep"></span>
      ${[0, 1, 2].map(k => `<button class="slot" data-p="${i}" data-s="${k}"></button>`).join("")}</div></div>`).join("");
  $("psubs").innerHTML = SUBS.map(a => `<button class="popt" data-a="${a}">${ab(a, 40)}</button>`).join("");
  $("mods").innerHTML = MODE_LIST.map(([m, n]) => `<button class="chip" data-m="${m}" data-tip="${esc(n)}" aria-label="${esc(n)}"><img class="mi" src="${MODE(m)}" alt=""></button>`).join("");

  ensureWheel();

  /* clicks inside #editor */
  host.addEventListener("click", e => {
    const t = e.target as HTMLElement;
    const c = t.closest<HTMLElement>("[data-cat]");
    if (c) { setCat(+(c.dataset.cat || 0)); return; }
    const g = t.closest<HTMLElement>(".grow");
    if (g) {
      const r = byRow[g.dataset.row || ""], prev = gearRow(cat);
      if (!r) return;
      if (prev && prev !== r.row && dot(prev)) {
        seen.add(prev); store.set(SEENKEY, [...seen]);
        const pr = $("list").querySelector<HTMLElement>(`.grow[data-row="${prev}"]`), nw = pr?.querySelector<HTMLElement>(".nw");
        if (pr && nw) {
          const cs = getComputedStyle(nw), from = { opacity: cs.opacity, scale: cs.scale === "none" ? "1" : cs.scale };
          nw.getAnimations().forEach(a => a.cancel()); pr.classList.add("seen");
          if (!still()) nw.animate([from, { opacity: 0, scale: .3 }], { duration: 220, easing: EASE });
        }
      }
      ui.ed.set[cat][0] = r.row;
      ui.ed.set[cat][1] = r.main;
      ui.sel = [cat, 0]; runMains = false;
      paint(true); return;
    }
    const gp = t.closest<HTMLElement>(".gp");
    if (gp) { const p = +(gp.dataset.p || 0); ui.sel = [p, ui.sel[1]]; runMains = ui.sel[1] === -1; setCat(p); paint(); return; }
    const sl = t.closest<HTMLElement>(".slot");
    if (sl) {
      const p = +(sl.dataset.p || 0), k = +(sl.dataset.s || 0);
      if (armed) {
        if (!fits(armed, p, k)) return;
        const cur = k < 0 ? mainAb(p) : subAb(p, k), v = cur === armed ? "" : armed;
        if (teeMain(p, k) && !v) return;
        if (k < 0) ui.ed.set[p][1] = v; else ui.ed.set[p][2][k] = v;
        paint(true); return;
      }
      ui.sel = [p, k]; runMains = k === -1; setCat(p); paint(); return;
    }
    const pc = t.closest<HTMLElement>(".piece");
    if (pc) { const p = +(pc.dataset.p || 0); ui.sel = [p, ui.sel[1]]; runMains = ui.sel[1] === -1; setCat(p); paint(); return; }
    if (t.closest("#pfk")) { pickFirst = !pickFirst; armed = null; store.set(PFKEY, pickFirst); paint(); return; }
    const so = t.closest<HTMLElement>(".sopt");
    if (so) { sortBy = so.dataset.sort || "alpha"; openSort(false); regroup(); filter(); return; }
    if (t.closest("#sortbtn")) { openSort(!$("sortmenu").classList.contains("open")); return; }
    if (!t.closest("#sortmenu")) openSort(false);
    const o = t.closest<HTMLElement>(".popt");
    if (o) {
      const a = o.dataset.a || "";
      if (pickFirst) { armed = armed === a ? null : a; paint(); return; }
      const [p, k] = ui.sel;
      if (k >= 0 && !SUBS.includes(a)) return;
      if (k < 0 && (a === DBL) !== teeMain(p, k)) return;
      const cur = k < 0 ? mainAb(p) : subAb(p, k);
      if (cur === a && teeMain(p, k)) return;
      if (cur === a) { if (k < 0) ui.ed.set[p][1] = ""; else ui.ed.set[p][2][k] = ""; paint(true); return; }
      if (k < 0) ui.ed.set[p][1] = a; else ui.ed.set[p][2][k] = a;
      ui.sel = k < 2 ? [p, k + 1] : p < 2 ? [p + 1, runMains ? -1 : 0] : [p, k];
      if (ui.sel[0] !== p) setCat(ui.sel[0]);
      paint(true); return;
    }
    const sh = t.closest<HTMLElement>(".sh");
    if (sh) {
      const sec = sh.parentElement!;
      const id = sh.dataset.sec as SecId;
      secOpen[id] = sec.classList.contains("shut");
      paintStats(); return;
    }
    const wc = t.closest<HTMLElement>(".wcell");
    if (wc) { ui.ed.weapon = wc.dataset.w || ui.ed.weapon; closePop(); paintWeapon(); paint(); return; }
    if (t.closest("#wpick")) return;
    const ch = t.closest<HTMLElement>(".chip");
    if (ch) {
      const m = ch.dataset.m || "", on = new Set<string>(ui.ed.modes);
      if (on.has(m)) on.delete(m); else on.add(m);
      ui.ed.modes = MODE_LIST.map(([k]) => k).filter(k => on.has(k));
      paintModes(); paintSave(); return;
    }
    if (t.closest("#copyfit")) { copyOutfit(renderEditor); return; }
    if (t.closest("#sendou")) { window.open(linkFor(ui.ed.weapon || ui.pick, ui.ed.set), "_blank", "noopener"); return; }
    if (t.closest("#save")) { if (!$<HTMLButtonElement>("save").disabled) late.leaveEditor(true); return; }
    if (!t.closest("#wpop")) closePop();
  });

  /* weapon picker: click opens popover, press-and-hold opens class wheel */
  const wpick = $("wpick");
  wpick.addEventListener("contextmenu", e => e.preventDefault());
  wpick.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    press = { t: window.setTimeout(() => { if (press) { press.t = null; press.held = performance.now(); openWheel(); } }, 250) };
  });
  document.addEventListener("pointermove", e => { if (wheelOpen) { const i = wheelPick(e.clientX, e.clientY); if (i !== hot) setHot(i); } });
  document.addEventListener("pointerup", e => {
    if (!press) return;
    const p = press; press = null; skipClick = true; setTimeout(() => { skipClick = false; }, 0);
    if (p.t !== null) { clearTimeout(p.t); if (popCls) closePop(); else { closeWheel(); openPop(curWeapon().cls); } return; }
    const i = wheelPick(e.clientX, e.clientY);
    if (i >= 0) { closeWheel(); openPop(CLASSES[i][0]); }
    else if (p.held && performance.now() - p.held > WLINGER) closeWheel();
  });
  document.addEventListener("pointercancel", () => { if (press && press.t !== null) clearTimeout(press.t); press = null; });
  document.addEventListener("click", e => {
    if (skipClick) { skipClick = false; e.stopImmediatePropagation(); return; }
    if (!wheelOpen) return;
    e.stopImmediatePropagation();
    const i = wheelPick(e.clientX, e.clientY);
    closeWheel(); if (i >= 0) openPop(CLASSES[i][0]);
  }, true);

  /* hold-to-Delete */
  const del = $("discard");
  del.addEventListener("pointerdown", e => { if (e.button === 0) startHold(); });
  for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"]) del.addEventListener(ev, stopHold);
  del.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!e.repeat) startHold(); } });
  del.addEventListener("keyup", e => { if (e.key === "Enter" || e.key === " ") stopHold(); });

  /* shelf hover label & search */
  $("list").addEventListener("mouseover", e => { const g = (e.target as HTMLElement).closest<HTMLElement>(".grow"); paintLabel(g?.dataset.row); });
  $("list").addEventListener("mouseleave", () => paintLabel());
  $<HTMLInputElement>("q").addEventListener("input", e => { q = (e.target as HTMLInputElement).value.trim().toLowerCase(); filter(); });
  $<HTMLInputElement>("wq").addEventListener("input", e => { wq = (e.target as HTMLInputElement).value.trim().toLowerCase(); paintWpop(); });

  /* title & description */
  const titleField = $<HTMLTextAreaElement>("title"), descField = $<HTMLTextAreaElement>("description");
  titleField.addEventListener("beforeinput", e => { if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") e.preventDefault(); });
  titleField.addEventListener("input", () => {
    const text = titleText(titleField.value, titleField);
    if (titleField.value !== text) {
      const caret = titleField.selectionStart;
      titleField.value = text;
      titleField.setSelectionRange(caret, caret);
    }
    ui.ed.title = text.trim(); fitTitle(); paintSave();
  });
  descField.addEventListener("input", () => {
    const text = cap(descField.value, descField);
    if (descField.value !== text) descField.value = text;
    ui.ed.notes = text; paintSave();
  });

  /* keyboard: Escape closes overlays; Tab/Shift+Tab (and Enter/Space off buttons/fields) step slots */
  document.addEventListener("keydown", e => {
    if (!isShown()) return;
    if (e.key === "Escape") { openSort(false); closePop(); closeWheel(); return; }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (popCls || wheelOpen || $("sortmenu").classList.contains("open")) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, [contenteditable]")) return;
    if (e.key === "Tab") {
      const to = edStep(ui.sel, e.shiftKey ? -1 : 1);
      e.preventDefault();
      if (to) { ui.sel = to; runMains = false; if (to[0] !== cat) setCat(to[0]); paint(); }
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && !target?.closest?.("button, a")) {
      const to = edStep(ui.sel, 1);
      e.preventDefault();
      if (to) { ui.sel = to; runMains = false; if (to[0] !== cat) setCat(to[0]); paint(); }
    }
  });

  /* close floating overlays if user clicks outside #editor (e.g. header) or switches screens */
  document.addEventListener("pointerdown", e => {
    if (!isShown()) return;
    const t = e.target as HTMLElement;
    if (!t.closest("#wpop, #wpick")) closePop();
    if (!t.closest("#sortmenu, #sortbtn")) openSort(false);
  });
  new ResizeObserver(fitTitle).observe(titleField.parentElement!);
  new ResizeObserver(fitStrip).observe($("apstrip"));
  addEventListener("resize", fitStrip);
  document.fonts?.ready.then(() => { fitTitle(); fitStrip(); });
  new MutationObserver(() => {
    if (isShown()) requestAnimationFrame(() => { fitTitle(); fitStrip(); paintCopy(); });
    else closeOverlays();
  }).observe(host, { attributes: true, attributeFilter: ["class"] });

  /* react to live snapshots arriving */
  subscribe(ev => {
    if (ev !== "state" && ev !== "snapshot") return;
    if (!syncOwned()) return;
    regroup();
    drawList(false);
    paintPieces(false);
    paintLabel();
  });
}

export function renderEditor() {
  mount();
  normEd();
  syncOwned();
  const opened = ui.ed !== lastEd;
  lastEd = ui.ed;
  if (opened) {
    closeOverlays();
    resetCopyFailure();
    armed = null;
    statW = "";
    secOpen = {};
    secCh = {};
    runMains = ui.sel[1] === -1;
    q = "";
    $<HTMLInputElement>("q").value = "";
    $("save").classList.remove("done");
    const titleField = $<HTMLTextAreaElement>("title"), descField = $<HTMLTextAreaElement>("description");
    titleField.value = titleText(ui.ed.title, titleField);
    ui.ed.title = titleField.value.trim();
    descField.value = cap(ui.ed.notes, descField);
    ui.ed.notes = descField.value;
    regroup();
    cat = Math.max(0, Math.min(2, ui.sel[0] | 0));
    paintCat();
    drawList(false);
    paintWeapon();
    paintModes();
    paintCopy();
    paint(false);
    fitTitle();
  } else {
    paintWeapon();
    paintModes();
    paintCopy();
    paint(false);
  }
}
