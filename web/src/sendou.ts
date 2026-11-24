// sendou.ink's builds for a weapon, through the companion (GET /api/sendou/<slug>, cached there a day), kept here per
// weapon for the session. They go into BUILDS (not mine, origin = sendou's {sendou, owner, top500}), ahead of your own
// builds so the indices the cards carry don't move when you delete one of yours.
import { BUILDS, WEAPONS, syncSaved } from "./data";
import { STATIC } from "./local/flag";
import { ui } from "./state";

// the replicas are kits of a weapon sendou lists under the original
const SAME: Record<string, string> = { Shooter_Normal_H: "Shooter_Normal_00", Shooter_Normal_S: "Shooter_Normal_00", Shooter_Normal_Oct: "Shooter_Normal_01" };
// sendou's slug from the weapon's name: lower case, spaces to hyphens, everything but letters, digits and hyphens dropped
export function slugFor(row: string) {
  const w = (WEAPONS as any[]).find(x => x.row === (SAME[row] || row));
  return w ? w.name.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-") : "";
}

export type Entry = { state: "loading" | "ok" | "failed"; ids: number[]; count?: number; stale?: boolean; at: number };
const cache = new Map<string, Entry>();     // by slug, so a replica shares its original's builds
export const sendouFor = (row: string) => cache.get(slugFor(row));

function addBuilds(list: any[]) {
  const fresh = list.filter(b => b && Array.isArray(b.set) && !BUILDS.some((x: any) => !x.mine && x.id === b.id)).map(b => ({
    id: b.id, title: b.title || (b.src?.owner ? `Build by ${b.src.owner}` : "Untitled build"), modes: b.modes || [], notes: b.notes || "",
    set: b.set.map(([row, main, subs]: any) => [row || "", main || "", [0, 1, 2].map(k => (subs || [])[k] || "")]),
    weapon: b.weapon, origin: b.src || null, sendou: true,
  }));
  if (!fresh.length) return;
  let at = BUILDS.findIndex((x: any) => x.mine); if (at < 0) at = BUILDS.length;
  BUILDS.splice(at, 0, ...fresh);
  if (ui.edIdx >= at) ui.edIdx += fresh.length;     // the build open in the editor keeps its place
  syncSaved();
}

// fetch row's builds unless they're here or on their way; done(row) once they're in (or it failed)
export function wantSendou(row: string, done: (row: string) => void) {
  const slug = slugFor(row); if (!slug || STATIC) return;       // the static site has no companion to ask
  const e = cache.get(slug);
  if (e && (e.state !== "failed" || Date.now() - e.at < 20000)) return;   // a failure is tried again after 20 s
  const entry: Entry = { state: "loading", ids: [], at: Date.now() };
  cache.set(slug, entry);
  fetch(`/api/sendou/${encodeURIComponent(slug)}`).then(async r => {
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !Array.isArray(d.builds)) throw new Error(d?.error || String(r.status));
    addBuilds(d.builds);
    Object.assign(entry, { state: "ok", ids: d.builds.map((b: any) => b.id), count: d.count, stale: !!d.stale, at: Date.now() });
  }).catch(() => Object.assign(entry, { state: "failed", at: Date.now() })).finally(() => done(row));
}
