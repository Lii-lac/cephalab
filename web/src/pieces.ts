// Which of your real pieces the Path screen plans for, and where each one's seed comes from (no DOM, no bridge import:
// the core calls are handed in, so Node can test this file directly: tests/web/pieces.mjs).
import type { PlanIn, Observed, Candidate, RecoverOut, SeedOut, Slot } from "./core/bridge";

type Fail = { ok: false; error: string };
export interface Piece { slot: Slot; gearId: number; row: string; brand: string; main?: string; subs: string[]; seed?: number | null; rarity?: number }
export interface Snapshot { source: string; gameVersion?: string; playerKey?: string; pieces: Piece[]; at?: unknown }
export type Snapshots = Record<string, Snapshot | undefined>;
export interface BuildLike { id: number; set: [string, string, string[]][] | any[] }
export interface Chosen { piece: Piece; source: string; playerKey: string }

/** Best source first: the Switch's RAM beats SplatNet (s3s) beats a gear file. Unknown sources come last. */
export const SOURCE_ORDER = ["botbase", "s3s", "file"];
export function orderedSnapshots(snaps: Snapshots): Snapshot[] {
  const rank = (s: string) => { const i = SOURCE_ORDER.indexOf(s); return i < 0 ? SOURCE_ORDER.length : i; };
  return Object.keys(snaps).filter(k => snaps[k] && Array.isArray(snaps[k]!.pieces)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
    .map(k => ({ ...snaps[k]!, source: snaps[k]!.source || k }));
}
export const hasPieces = (snaps: Snapshots) => orderedSnapshots(snaps).some(s => s.pieces.length > 0);

/** How many sub slots a piece can ever fill: min(3, stars + 1) (botbase's `rarity`, s3seed/gear.py), or null when its stars
 *  aren't known (SplatNet, s3s, a gear file): then no slot is taken for locked. */
export const openSlots = (p: Piece | null | undefined): number | null =>
  p && typeof p.rarity === "number" && p.rarity >= 0 && p.rarity <= 5 ? Math.min(3, p.rarity + 1) : null;

export const slotOfRow =(row: string): Slot | null => row.startsWith("Hed_") ? "head" : row.startsWith("Clt_") ? "clothes" : row.startsWith("Shs_") ? "shoes" : null;

const LANE_SLOTS: Slot[] = ["head", "clothes", "shoes"];          // a build's lanes are head, clothes, shoes

/** Goal slots (non-empty ones) the piece doesn't meet yet: slot by slot when the order is fixed, else as a multiset. */
export function unmet(subs: string[], goal: string[], fixedOrder: boolean): number {
  const want = [0, 1, 2].map(i => goal[i] || "");
  if (fixedOrder) return want.filter((g, i) => g && subs[i] !== g).length;
  const have = [0, 1, 2].map(i => subs[i] || "");
  let n = 0;
  for (const g of want) {
    if (!g) continue;
    const j = have.indexOf(g);
    if (j >= 0) have[j] = "\0"; else n++;
  }
  return n;
}

/* ---------- a per-build override: the piece you picked for a slot, saved as { "<build id>:<slot>": gearId } ---------- */
export const OVERRIDE_KEY = "seedtracker.pathpieces";
type KV = { get(k: string): any; set(k: string, v: unknown): void };
export const overrideKey = (buildId: number, slot: Slot) => `${buildId}:${slot}`;
export function readOverrides(store: KV): Record<string, number> { const v = store.get(OVERRIDE_KEY); return v && typeof v === "object" ? v : {}; }
export function setOverride(store: KV, buildId: number, slot: Slot, gearId: number | null) {
  const all = { ...readOverrides(store) }, k = overrideKey(buildId, slot);
  if (gearId == null) delete all[k]; else all[k] = gearId;
  store.set(OVERRIDE_KEY, all);
}

/** One piece per lane of the build (null: you own nothing for that slot, or the build has no row there).
 *  Order of preference: your override while you still own that piece, then the first source (botbase > s3s > file) that has
 *  a piece of the slot: the build's own gear row if you own it there, else the piece with the fewest goal slots unmet
 *  (tie: lowest gearId). */
/** The piece each build lane showed last, by "<build id>:<slot>", with when it was last in a read (path.ts keeps it in memory
 *  and in the store). */
export type Keep = { get(k: string): { chosen: Chosen; at: number } | undefined; set(k: string, v: { chosen: Chosen; at: number }): void };
export const KEEP_MS = 120000;
export function choosePieces(build: BuildLike, snaps: Snapshots, opt: { fixedOrder: boolean; overrides?: Record<string, number>; keep?: Keep; now?: number }): (Chosen | null)[] {
  const ordered = orderedSnapshots(snaps), now = opt.now ?? Date.now();
  return build.set.map(([row, , subs]: any, i: number) => {
    const slot = slotOfRow(row || "") || LANE_SLOTS[i];
    if (!slot) return null;
    const k = overrideKey(build.id, slot), want = opt.overrides?.[k];
    const pick = pickFor(row, slot, subs, want);
    // a read that's missing the piece shown last (the Switch reconnecting, a partial read) keeps it for KEEP_MS instead of
    // quietly swapping to another piece; a piece you picked yourself, one that's really gone for longer, or a different
    // source taking over (botbase -> s3s: other ids) goes by the normal rules
    const last = opt.keep?.get(k), lg = last?.chosen?.piece?.gearId;
    if (last && now - last.at < KEEP_MS && lg != null && (want == null || want === lg) && (!pick || pick.piece.gearId !== lg)
        && ordered.some(s => s.source === last.chosen.source) && !ordered.some(s => s.pieces.some(p => p.slot === slot && p.gearId === lg))) return last.chosen;   // same source still reading, piece absent
    if (pick && opt.keep) opt.keep.set(k, { chosen: pick, at: now });
    return pick;
  });
  function pickFor(row: string, slot: Slot, subs: any, want: number | undefined): Chosen | null {
    const goal = [0, 1, 2].map(i => (subs && subs[i]) || "");
    const of = (s: Snapshot) => s.pieces.filter(p => p.slot === slot);
    const wrap = (s: Snapshot, piece: Piece): Chosen => ({ piece, source: s.source, playerKey: s.playerKey || "" });
    if (want != null) for (const s of ordered) { const p = of(s).find(x => x.gearId === want); if (p) return wrap(s, p); }
    for (const s of ordered) {
      const mine = of(s);
      if (!mine.length) continue;
      const lowest = (a: Piece, b: Piece) => (a.gearId <= b.gearId ? a : b);
      const own = row ? mine.filter(p => p.row === row) : [];
      if (own.length) return wrap(s, own.reduce(lowest));
      const score = (p: Piece) => unmet(p.subs, goal, opt.fixedOrder);
      return wrap(s, mine.reduce((a, b) => { const x = score(a), y = score(b); return y < x || (y === x && b.gearId < a.gearId) ? b : a; }));
    }
    return null;
  }
}

/* ---------- the seed of a piece ---------- */
export interface Core {
  startSeed(playerKey: string, slot: Slot, gearId: number): Promise<SeedOut | Fail>;
  recover(start: number, brand: string, observed: Observed[]): Promise<RecoverOut | Fail>;
  refine(candidates: (number | Candidate)[], brand: string, observed: Observed[]): Promise<RecoverOut | Fail>;
}
export type Resolved =
  | { state: "seed"; seed: number }
  | { state: "ambiguous"; count: number }
  | { state: "error"; error: string }
  | { state: "stale" };                                          // a newer snapshot of the same piece took over: drop this

interface Track { filled: string[]; cands: Candidate[] }        // the still-ambiguous run of one piece, to refine later
const filledSubs = (subs: string[]) => [0, 1, 2].map(i => subs[i] || "").filter(Boolean);

export class SeedResolver {
  private cache = new Map<string, Resolved>();                   // (playerKey, gearId, subs) -> answer; never a stale one
  private inflight = new Map<string, Promise<Resolved>>();
  private gen = new Map<string, number>();                       // per piece: the newest request
  private track = new Map<string, Track>();
  private core: Core;
  constructor(core: Core) { this.core = core; }                  // (no parameter properties: Node strips types only)

  /** The piece's seed now. Botbase pieces carry theirs; others are found from their sub run (recover, then refine). */
  resolve(c: Chosen): Promise<Resolved> {
    const { piece, playerKey } = c;
    if (typeof piece.seed === "number") return Promise.resolve({ state: "seed", seed: piece.seed });
    if (!playerKey) return Promise.resolve({ state: "error", error: "no player key for this piece" });
    const pk = `${playerKey}|${piece.slot}|${piece.gearId}`, filled = filledSubs(piece.subs), ck = `${pk}|${filled.join(",")}`;
    const hit = this.cache.get(ck);
    if (hit) return Promise.resolve(hit);
    const flying = this.inflight.get(ck);
    if (flying) return flying;
    const my = (this.gen.get(pk) ?? 0) + 1;
    this.gen.set(pk, my);
    const p = this.work(c, pk, filled, my).then(r => {
      if (this.inflight.get(ck) === p) this.inflight.delete(ck);
      if (this.gen.get(pk) !== my) return { state: "stale" } as Resolved;
      if (r.state !== "error") this.cache.set(ck, r);
      return r;
    }, e => {
      if (this.inflight.get(ck) === p) this.inflight.delete(ck);
      return { state: "error", error: e instanceof Error ? e.message : String(e) } as Resolved;
    });
    this.inflight.set(ck, p);
    return p;
  }

  private async work(c: Chosen, pk: string, filled: string[], my: number): Promise<Resolved> {
    const { piece, playerKey } = c;
    const start = await this.core.startSeed(playerKey, piece.slot, piece.gearId);
    if (!start.ok) return { state: "error", error: start.error };
    if (!filled.length) return { state: "seed", seed: start.seed };       // nothing rolled yet: the start seed
    const obs = (subs: string[]): Observed[] => subs.map(a => ({ a, drink: null }));
    const t = this.track.get(pk);
    let r: RecoverOut | Fail;
    if (t && t.filled.length < filled.length && t.filled.every((a, i) => a === filled[i])) r = await this.core.refine(t.cands, piece.brand, obs(filled.slice(t.filled.length)));
    else r = await this.core.recover(start.seed, piece.brand, obs(filled));
    if (this.gen.get(pk) !== my) return { state: "stale" };
    if (!r.ok) return { state: "error", error: r.error };
    if (r.count === 0) { this.track.delete(pk); return { state: "error", error: "no seed matches this piece's rolls" }; }
    if (r.locked) { this.track.delete(pk); return { state: "seed", seed: r.candidates[0].seed }; }
    this.track.set(pk, { filled, cands: r.candidates });
    return { state: "ambiguous", count: r.count };
  }
}

/* ---------- the plan input from the chosen pieces ---------- */
export interface LaneNote { row: string; subs: string[]; goal: string[]; note: string }
/** `planned[i]` = the PlanIn piece index of the build's lane i, or -1 with `notes[i]` saying why it has no steps. */
export function buildPlanInput(build: BuildLike, chosen: (Chosen | null)[], resolved: (Resolved | null)[],
  tog: { fixedOrder: boolean; useChunks: boolean; chunkRate?: number; chunkBudget?: number; maxChunks?: (number | null)[]; lean?: (number | null)[]; useDrinks: boolean; chunks?: Record<string, number>; drinks?: Record<string, number>; horizon?: number }):
  { input: PlanIn; planned: number[]; notes: (LaneNote | null)[] } {
  const pieces: PlanIn["pieces"] = [], planned: number[] = [], notes: (LaneNote | null)[] = [];
  build.set.forEach(([row, , subs]: any, i: number) => {
    const goal = [0, 1, 2].map(k => (subs && subs[k]) || "");
    const c = chosen[i], r = resolved[i];
    const note = (msg: string, p?: Piece): void => { planned.push(-1); notes.push({ row: p?.row || row, subs: p ? [0, 1, 2].map(k => p.subs[k] || "") : ["", "", ""], goal, note: msg }); };
    if (!c) return note(`You don't have a ${slotOfRow(row || "") || LANE_SLOTS[i] || "gear"} piece yet`);
    if (!r || r.state === "stale") return note("Looking for this piece's seed...", c.piece);
    if (r.state === "ambiguous") return note(`${r.count} possible seeds, one more roll`, c.piece);
    if (r.state === "error") return note(`Couldn't find this piece's seed: ${r.error}`, c.piece);
    planned.push(pieces.length); notes.push(null);
    const cap = tog.maxChunks?.[i];                            // this lane's chunk slider (null / absent = any)
    const lean = tog.lean?.[i];                                // this lane's chunk lean (0 / 2; 1, null, absent = normal: not sent)
    const open = openSlots(c.piece);                           // slots its stars open (3 or unknown: not sent); the core plans the unlocks
    pieces.push({ row: c.piece.row, brand: c.piece.brand, seed: r.seed, subs: [0, 1, 2].map(k => c.piece.subs[k] || "") as any, goal: goal as any, ...(cap != null ? { maxChunks: cap } : {}), ...(lean === 0 || lean === 2 ? { chunkLean: lean as 0 | 2 } : {}), ...(open != null && open < 3 ? { openSlots: open as 1 | 2 } : {}) });
  });
  return { input: { pieces, chunks: tog.chunks || {}, drinks: tog.drinks || {}, fixedOrder: tog.fixedOrder, useChunks: tog.useChunks, chunkRate: tog.chunkRate || 0, ...(tog.chunkBudget != null ? { chunkBudget: tog.chunkBudget } : {}), useDrinks: tog.useDrinks, horizon: tog.horizon ?? 60 },
           planned, notes };
}
