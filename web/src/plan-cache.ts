// Planned routes kept across restarts (web/src/store.ts, IndexedDB): the core is deterministic, so the same plan input
// always gives the same answer. One entry per input under seedtracker.plan.<hash> (the full key string is kept inside and
// compared on read), an index of [hash, lastUsedMs] keeps the 40 most recently used. The key starts with the core's tag
// (__CORE_HASH__, vite.config.ts), so a rebuilt core never shows an old route.
import { store } from "./store";
import { hash32 } from "./identity";

declare const __CORE_HASH__: string;

export interface SearchState { out: any; from: number; looked: number; ended: boolean; done: boolean }
export interface PlanEntry { k: string; at: number; first: any; search?: SearchState }

const P = "seedtracker.plan.", INDEX = P + "index", KEEP = 40;
const tag = () => { try { return typeof __CORE_HASH__ === "string" ? __CORE_HASH__ : "nocore"; } catch { return "nocore"; } };
export function planKey(input: any): string {
  const { from, ...rest } = input || {};                         // a slice's own from is not part of the question
  return tag() + ":" + JSON.stringify(rest);
}
const slot = (k: string) => P + hash32("a" + k).toString(16).padStart(8, "0") + hash32("b" + k).toString(16).padStart(8, "0");
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isOut = (v: any) => !!v && typeof v === "object" && Array.isArray(v.lanes) && Array.isArray(v.unreachable);
function sound(e: any, k: string): e is PlanEntry {
  if (!e || typeof e !== "object" || e.k !== k || !isNum(e.at) || !isOut(e.first) || e.first.ok !== true) return false;
  const s = e.search;
  return s === undefined || (!!s && typeof s === "object" && isOut(s.out) && isNum(s.from) && isNum(s.looked) && typeof s.ended === "boolean" && typeof s.done === "boolean");
}
const index = (): [string, number][] => {
  const v = store.get(INDEX);
  return Array.isArray(v) ? v.filter(x => Array.isArray(x) && typeof x[0] === "string" && isNum(x[1])) : [];
};
function touch(h: string) {
  const list = index().filter(x => x[0] !== h);
  list.push([h, Date.now()]);
  list.sort((a, b) => b[1] - a[1]);
  for (const [old] of list.slice(KEEP)) store.set(old, undefined);
  store.set(INDEX, list.slice(0, KEEP));
}
function drop(h: string) { store.set(h, undefined); store.set(INDEX, index().filter(x => x[0] !== h)); }

export const planCache = {
  /** The saved entry for this plan input, or null (a broken or other-core entry counts as a miss and is deleted). */
  get(input: any): PlanEntry | null {
    try {
      if ((globalThis as any).__noPlanCache) return null;        // a test that counts plan calls
      const k = planKey(input), h = slot(k), e = store.get(h);
      if (e == null) return null;
      if (!sound(e, k)) { if (e.k === k || typeof e.k !== "string") drop(h); return null; }
      touch(h);
      return e;
    } catch { return null; }
  },
  /** Save the core's first reply (ok:true only). Keeps a search state already saved for the same reply. */
  putFirst(input: any, first: any): void {
    try {
      if (!isOut(first) || first.ok !== true) return;
      const k = planKey(input), h = slot(k), old = store.get(h);
      store.set(h, { k, at: Date.now(), first, ...(sound(old, k) && old.search ? { search: old.search } : {}) });
      touch(h);
    } catch {}
  },
  /** Save the progressive search's state under an input that already has its first reply. */
  putSearch(input: any, search: SearchState): void {
    try {
      const k = planKey(input), h = slot(k), e = store.get(h);
      if (!sound(e, k)) return;
      store.set(h, { ...e, search: { out: search.out, from: search.from, looked: search.looked, ended: search.ended, done: search.done } });
      touch(h);
    } catch {}
  },
};
