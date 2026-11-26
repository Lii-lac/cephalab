// The companion's settings object (GET /api/settings), shared by the Connections and Data pages. A companion that isn't there
// (404, 502, no network) greys every row marked data-api and shows one quiet line with a Start companion button (cephalab://start).
import { $, $$, api, fadeText } from "./dom";
import { STATIC } from "../local/flag";

export type Cfg = { switch: { host: string; port: number; every: number }; splatnet: { every: "battle" | "5min" | "off" }; updates?: { auto: boolean }; discord?: { level: "off" | "basic" | "full" }; data: { folder: string; cacheBytes: number } };
export let cfg: Cfg | null = null;
export const offline = () => cfg === null;
const listeners = new Set<() => void>();
export const onCfg = (f: () => void) => { listeners.add(f); };

let pollTimer = 0;
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } }

export function useCfg(c: Cfg | null) {
  cfg = c;
  const off = !c && !STATIC;
  $(".st-page").classList.toggle("offline", !c);
  const line = $("#offLine");
  line.classList.toggle("on", off);                           // the static site has nothing to fix: the rows are just grey
  line.toggleAttribute("inert", !off);
  if (STATIC) line.textContent = "";
  if (c) {
    stopPoll();
    const txt = document.querySelector<HTMLElement>("#settings #offText");
    const btn = document.querySelector<HTMLButtonElement>("#settings #startComp");
    if (txt) txt.textContent = "Companion not running";
    if (btn) { btn.disabled = false; const lbl = btn.firstElementChild as HTMLElement | null; if (lbl) lbl.textContent = "Start companion"; }
  }
  for (const row of $$("[data-api]")) { row.toggleAttribute("inert", !c); if (!c) row.setAttribute("aria-disabled", "true"); else row.removeAttribute("aria-disabled"); }
  listeners.forEach(f => f());
}
export async function loadCfg() {
  const r = await api("GET", "/api/settings");
  useCfg(r.ok && r.j && r.j.switch && r.j.splatnet && r.j.data ? r.j : null);
}
/** POST a subset of the settings; the reply is the whole object. Returns an error text, or "" when saved. */
export async function saveCfg(part: object): Promise<string> {
  const r = await api("POST", "/api/settings", part);
  if (!r.ok || !r.j.switch) { if (r.status === 0 || r.status === 404 || r.status >= 500) useCfg(null); return r.j.error || "Not saved"; }
  cfg = r.j;
  return "";
}

/** Wire the offline bar's Start companion button: triggers cephalab://start and polls until the companion answers. */
export function mountOffline(onOnline: () => void) {
  if (STATIC) return;
  const btn = document.querySelector<HTMLButtonElement>("#settings #startComp");
  const txt = document.querySelector<HTMLElement>("#settings #offText");
  if (!btn || !txt) return;
  const lbl = btn.firstElementChild as HTMLElement;
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    stopPoll();
    btn.disabled = true;
    fadeText(lbl, "Starting");
    fadeText(txt, "Starting companion");
    const a = document.createElement("a");
    a.href = "cephalab://start";
    a.style.display = "none";
    document.body.append(a);
    a.click();
    a.remove();
    const deadline = Date.now() + 10000;
    const check = async () => {
      await loadCfg();
      if (!offline()) {
        stopPoll();
        onOnline();
        return;
      }
      if (Date.now() >= deadline) {
        stopPoll();
        btn.disabled = false;
        fadeText(lbl, "Try again");
        fadeText(txt, "Run cephalab.exe to start");
      }
    };
    pollTimer = window.setInterval(check, 500);
    setTimeout(check, 700);
  });
}
