import { STATIC } from "../local/flag";
// Small helpers the Settings screen's parts share: lookups, the companion API, quiet lines, fades, reveals, chip groups.
export const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>("#settings " + s)!;
export const $$ = <T extends HTMLElement = HTMLElement>(s: string) => [...document.querySelectorAll<T>("#settings " + s)];
export const still = () => document.documentElement.classList.contains("st-still") || matchMedia("(prefers-reduced-motion: reduce)").matches;
export const later = (ms: number, f: () => void) => setTimeout(f, ms);

const clientEvents: string[] = [];
function noteClient(line: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  clientEvents.push(`${ts} [ui] ${line}`);
  if (clientEvents.length > 25) clientEvents.shift();
}
export function clientLog(): string { return clientEvents.join("\n"); }

export type Reply = { status: number; ok: boolean; j: any };
/** The companion API: JSON in, JSON out; never throws (an unreachable companion is status 0). */
export async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  if (STATIC) return { status: 0, ok: false, j: {} };          // the static site never asks
  try {
    const init: RequestInit = { method };
    if (method === "POST") { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body ?? {}); }
    const r = await fetch(path, init);
    let j: any = {};
    try { j = await r.json(); } catch { /* no body */ }
    if (!r.ok) noteClient(`${method} ${path} -> ${r.status}${j?.error ? " (" + String(j.error).slice(0, 120) + ")" : ""}`);
    return { status: r.status, ok: r.ok, j };
  } catch (e) {
    noteClient(`${method} ${path} -> network error (${e instanceof Error ? e.message : "failed"})`);
    return { status: 0, ok: false, j: { error: "Companion not running" } };
  }
}

/** A word changes: it fades out, the new one fades in. */
const fading = new WeakMap<HTMLElement, { to: string; t: number }>();
/** Swap a line's text with a short fade. A newer call wins: an older fade still in flight never lands its text after it. */
export function fadeText(el: HTMLElement, text: string) {
  const f = fading.get(el);
  if ((f ? f.to : el.textContent) === text) return;
  if (f) clearTimeout(f.t);
  if (still() || el.textContent === text) { fading.delete(el); el.textContent = text; el.classList.remove("out"); return; }
  el.classList.add("st-fade", "out");
  fading.set(el, { to: text, t: window.setTimeout(() => { fading.delete(el); el.textContent = text; el.classList.remove("out"); }, 120) });
}
/** One control gives way to another in the same place. */
export function swap(show: HTMLElement, hide: HTMLElement) {
  if (!show.hidden && hide.hidden) return;
  if (still()) { hide.hidden = true; show.hidden = false; return; }
  hide.classList.add("st-fade", "out");
  setTimeout(() => {
    hide.hidden = true; hide.classList.remove("out"); show.classList.add("st-fade", "out"); show.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => show.classList.remove("out")));
  }, 120);
}
export function reveal(el: HTMLElement, open: boolean) { el.classList.toggle("open", open); el.toggleAttribute("inert", !open); }

const timers = new WeakMap<HTMLElement, number>();
/** A quiet line (.si-msg): text fades in; `hold` ms later it fades out (0 = stays). The old text stays while it fades shut. */
export function say(el: HTMLElement, text: string, err = false, hold = err ? 0 : 1800) {
  clearTimeout(timers.get(el));
  const t = el.firstElementChild as HTMLElement;
  if (text) { t.textContent = text; el.classList.toggle("err", err); }
  el.classList.toggle("on", !!text);
  if (text && hold) timers.set(el, window.setTimeout(() => el.classList.remove("on"), hold));
}

/** A group of chips with one on. Returns set(value) (quiet, no callback); a click calls onUser(value). */
export function seg(el: HTMLElement, onUser: (v: string) => void) {
  const set = (v: string) => { for (const b of el.children as unknown as HTMLButtonElement[]) { const on = b.dataset.v === v; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); } };
  for (const b of el.children as unknown as HTMLButtonElement[]) { b.type = "button"; b.setAttribute("role", "radio"); b.addEventListener("click", () => { if (b.classList.contains("on")) return; set(b.dataset.v!); onUser(b.dataset.v!); }); }
  set((el.querySelector<HTMLElement>(".on") || (el.children[0] as HTMLElement)).dataset.v!);
  return set;
}
/** "38 MB" for a byte count. */
export function size(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"]; let i = -1, v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < 2);
  return `${v >= 10 ? Math.round(v) : String(Math.round(v * 10) / 10)} ${u[i]}`;
}
