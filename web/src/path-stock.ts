// Typed chunk and drink-ticket counts for players whose Switch reports no stock (path.ts stockOf is null).
// The Chunks / Drinks toggles' pictures (the chunk, the ticket: .stktap) are tappable then and open a popover of the 14 sub abilities, each with a
// count (0-999). Saved in localStorage "seedtracker.stock.v1" as { chunks: {}, drinks: {} }; zero counts are left out.
import { L, NAMES, SUBS } from "./data";
const N: Record<string, string> = NAMES;
import { late } from "./late";

export const STOCK_KEY = "seedtracker.stock.v1";
type Kind = "chunks" | "drinks";
type Counts = Record<string, number>;
const clamp = (v: unknown): number => { const n = Math.floor(+(v as any)); return Number.isFinite(n) ? Math.max(0, Math.min(999, n)) : 0; };
const clean = (m: any): Counts => { const o: Counts = {}; if (m && typeof m === "object") for (const k of SUBS) { const n = clamp(m[k]); if (n) o[k] = n; } return o; };
let mem: { chunks: Counts; drinks: Counts } | null = null;
function load() {
  if (mem) return mem;
  let raw: any = null;
  try { raw = JSON.parse(localStorage.getItem(STOCK_KEY) || "null"); } catch {}
  return (mem = { chunks: clean(raw?.chunks), drinks: clean(raw?.drinks) });
}
/** the typed counts, zeros omitted: the plan input whenever the Switch reports no stock */
export const typedStock = (): { chunks: Counts; drinks: Counts } => { const s = load(); return { chunks: { ...s.chunks }, drinks: { ...s.drinks } }; };
export const sumOf = (m: Counts | null | undefined): number => Object.values(m || {}).reduce((t, n) => t + (+n || 0), 0);
function setCount(kind: Kind, id: string, n: number) {
  const s = load(), v = clamp(n);
  if (v) s[kind][id] = v; else delete s[kind][id];
  try { localStorage.setItem(STOCK_KEY, JSON.stringify(s)); } catch {}
}

/* ---------- the popover ---------- */
let pop: HTMLElement | null = null, openKind: Kind | null = null, lastId: string | null = null, lastAt: number | null = null;   // lastId: the field in use, to refocus after a redraw
const TOG = { chunks: "c", drinks: "d" } as const;
const cell = (kind: Kind, id: string) => `<label class="sk-c" data-tip="${N[id]}"><img src="${L}/skill/${id}.png" alt="${N[id]}"><input type="number" min="0" max="999" step="1" inputmode="numeric" data-id="${id}" aria-label="${N[id]}" value="${load()[kind][id] || ""}" placeholder="0"></label>`;
function fill(kind: Kind) {
  const tog = document.querySelector(`#path .tog[data-t="${TOG[kind]}"]`);
  const art = tog?.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
  pop!.innerHTML = `<div class="tog sk-t"></div><div class="sk-g">${SUBS.map(id => cell(kind, id)).join("")}</div>`;
  const t = pop!.querySelector(".sk-t")!;
  if (art) { art.classList.remove("stktap"); for (const a of ["data-stock", "role", "aria-label", "title", "data-tip", "aria-haspopup", "aria-expanded"]) art.removeAttribute(a); t.append(art); }
  t.append(document.createTextNode(kind === "chunks" ? "Chunks" : "Drinks"));
}
function open(kind: Kind) {
  const wrap = document.querySelector("#path .tgwrap"); if (!wrap) return;
  if (!pop) {
    pop = document.createElement("div"); pop.className = "stockpop"; pop.setAttribute("role", "dialog");
    pop.addEventListener("focusin", e => { const i = e.target as HTMLInputElement; if (i.dataset?.id) lastId = i.dataset.id; });
    pop.addEventListener("input", e => { const i = e.target as HTMLInputElement; if (!i.dataset.id) return; lastId = i.dataset.id; lastAt = i.selectionStart; const v = clamp(i.value); if (i.value !== "" && String(v) !== i.value.trim()) i.value = String(v); setCount(openKind!, i.dataset.id, v); late.renderPath?.(); });
    pop.addEventListener("keydown", e => { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(); } });
    pop.addEventListener("wheel", e => { const i = e.target as HTMLInputElement; if (i.dataset?.id && document.activeElement === i) { e.preventDefault(); i.value = String(clamp(clamp(i.value) + (e.deltaY < 0 ? 1 : -1))); i.dispatchEvent(new Event("input", { bubbles: true })); } }, { passive: false });
    pop.addEventListener("focusout", e => { const i = e.target as HTMLInputElement; if (i.dataset?.id && i.value !== "") i.value = String(clamp(i.value)); });
  }
  const again = openKind === kind && pop.classList.contains("on");
  if (again) return close();
  openKind = kind; fill(kind);
  if (pop.parentElement !== wrap) { pop.classList.remove("on"); wrap.append(pop); }
  pop.removeAttribute("inert"); void pop.offsetWidth; pop.classList.add("on");
  document.querySelectorAll("#path .stktap").forEach(s => s.setAttribute("aria-expanded", String((s as HTMLElement).dataset.stock === kind)));
  (pop.querySelector("input") as HTMLInputElement | null)?.focus({ preventScroll: true });
}
export function close() {
  if (!pop) return;
  openKind = lastId = lastAt = null; pop.classList.remove("on"); pop.setAttribute("inert", "");
  (pop.contains(document.activeElement) ? document.activeElement as HTMLElement : null)?.blur();
  document.querySelectorAll("#path .stktap").forEach(s => s.setAttribute("aria-expanded", "false"));
}
/** path.ts draw() calls this after each redraw: the open popover moves into the new markup and keeps its field focused */
export function reattach(host: HTMLElement, tappable: boolean) {
  if (!pop || !openKind) return;
  if (!tappable) return close();
  const wrap = host.querySelector(".tgwrap"); if (!wrap || pop.parentElement === wrap) return;
  const id = lastId, at = lastAt;
  wrap.append(pop);
  host.querySelectorAll(".stktap").forEach(s => s.setAttribute("aria-expanded", String((s as HTMLElement).dataset.stock === openKind)));
  const f = id ? pop.querySelector(`input[data-id="${id}"]`) as HTMLInputElement | null : null;
  if (f) { f.focus({ preventScroll: true }); try { if (at != null) f.setSelectionRange(at, at); } catch {} }
}
export function initStock() {
  const host = document.getElementById("path")!;
  host.addEventListener("click", e => {                        // capture: the toggle under the picture must not turn on/off
    const s = (e.target as HTMLElement).closest?.(".stktap") as HTMLElement | null; if (!s) return;
    e.stopPropagation(); open(s.dataset.stock as Kind);
  }, true);
  document.addEventListener("pointerdown", e => { if (openKind && !(e.target as HTMLElement).closest?.(".stockpop, .stktap")) close(); });
  document.addEventListener("keydown", e => { if (openKind && e.key === "Escape") close(); });
}
