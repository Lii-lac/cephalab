// Your builds as a JSON file: export them all, import a file (add to yours, merged by id, or replace them). Uses only store.ts.
import { store, KEYS } from "../store";

export type SavedBuild = { id: number; title?: string; modes?: string[]; set: unknown[]; [k: string]: unknown };
export const myBuilds = (): SavedBuild[] => { const b = store.get(KEYS.builds); return Array.isArray(b) ? b : []; };

export function exportBuilds(): string {
  return JSON.stringify({ app: "cephalab-builds", version: 1, at: new Date().toISOString(), builds: myBuilds() }, null, 2);
}
/** The builds in a file (our export, or a bare array). Throws a sentence for the user. */
export function parseBuilds(text: string): SavedBuild[] {
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error("Not a JSON file"); }
  const list = Array.isArray(j) ? j : j && Array.isArray(j.builds) ? j.builds : null;
  if (!list) throw new Error("No builds in the file");
  const ok = list.filter((b: any) => b && typeof b === "object" && typeof b.id === "number" && Array.isArray(b.set));
  if (!ok.length) throw new Error("No builds in the file");
  return ok;
}
/** Add (skip ids you already have) or replace. Returns how many came in and how many you have now. */
export function mergeBuilds(incoming: SavedBuild[], mode: "add" | "replace"): { added: number; total: number } {
  const have = mode === "replace" ? [] : myBuilds();
  const ids = new Set(have.map(b => b.id));
  const fresh = incoming.filter((b, i) => !ids.has(b.id) && incoming.findIndex(x => x.id === b.id) === i);
  const all = [...have, ...fresh];
  store.set(KEYS.builds, all);
  return { added: fresh.length, total: all.length };
}
