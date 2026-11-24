// Your builds also live with the companion (state/builds.json, every save kept in state/builds-history.jsonl), because the
// browser's copy can vanish: on 2026-11-21 the browser's whole site storage for 127.0.0.1:8765 was found recreated empty
// and Alex's build was gone. At start-up any build the companion has that this browser lacks (same title, abilities, gear
// and weapon) is added back; every save sends the whole list. Nothing here on the static site (no companion).
import { store, KEYS } from "./store";
import { STATIC } from "./local/flag";

const same = (a: any) => JSON.stringify([a.title, a.set, a.weapon || ""]);

/** Before the screens start: bring back builds the companion has and this browser doesn't. Gives up after ~1.5 s. */
export async function restoreBuilds(): Promise<number> {
  if (STATIC) return 0;
  let theirs: any[] | null = null;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch("/api/builds", { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) { const d = await r.json(); if (Array.isArray(d.builds)) theirs = d.builds; }
  } catch {}
  const mine: any[] = Array.isArray(store.get(KEYS.builds)) ? store.get(KEYS.builds) : [];
  if (!theirs) return 0;
  const have = new Set(mine.map(same)), ids = new Set(mine.map(b => b.id));
  let next = Math.max(100000, ...mine.map(b => +b.id || 0), ...theirs.map(b => +b.id || 0)) + 1, added = 0;
  for (const b of theirs) {
    if (!b || !Array.isArray(b.set) || have.has(same(b))) continue;
    mine.push({ ...b, id: ids.has(b.id) ? next++ : b.id }); ids.add(b.id); have.add(same(b)); added++;
  }
  if (added) store.set(KEYS.builds, mine);
  backupBuilds(mine);
  return added;
}

/** Every save of your builds: the whole list to the companion (fire and forget). */
export function backupBuilds(list: any[]): void {
  if (STATIC) return;
  fetch("/api/builds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ builds: list }) }).catch(() => {});
}
