// The companion's settings object (GET /api/settings), shared by the Connections and Data pages. A companion that isn't there
// (404, 502, no network) greys every row marked data-api and shows one quiet line.
import { $, $$, api } from "./dom";
import { STATIC } from "../local/flag";

export type Cfg = { switch: { host: string; port: number; every: number }; splatnet: { every: "battle" | "5min" | "off" }; updates?: { auto: boolean }; data: { folder: string; cacheBytes: number } };
export let cfg: Cfg | null = null;
export const offline = () => cfg === null;
const listeners = new Set<() => void>();
export const onCfg = (f: () => void) => { listeners.add(f); };

export function useCfg(c: Cfg | null) {
  cfg = c;
  $(".st-page").classList.toggle("offline", !c);
  $("#offLine").classList.toggle("on", !c && !STATIC);        // the static site has nothing to fix: the rows are just grey
  if (STATIC) $("#offLine").textContent = "";
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
