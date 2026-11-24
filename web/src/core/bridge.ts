// The core's entry point for the web app (core/API.md, fn "plan"). Until the wasm core lands this runs the
// mockup's pathLanes() + keyed() (mockups/v52.template.html ~1913 / ~1972), ported verbatim, as a stub; the real
// core drops in behind plan() (a Web Worker calling st_call) without the Path screen changing.
import { SUBS } from "../data";
import { hash32, rng } from "../identity";

export type Ability = string;                                  // the game's internal name; "" = empty slot
export type Slot = "head" | "clothes" | "shoes";

export interface PlanPiece {
  row: string;                                                 // Leanny row id, e.g. "Hed_AMB000"
  brand: string;                                               // "B00".."B99"
  seed: number;                                                // u32
  subs: [Ability, Ability, Ability];                           // what the piece has now
  goal: [Ability, Ability, Ability];                           // "" = anything is fine there
  maxChunks?: number;                                          // at most this many chunks on this piece (its Path slider); absent = any
  chunkLean?: 0 | 1 | 2;                                       // its lane's chunk lean (path.ts): 0 conservative, 2 aggressive; absent = 1, normal
  openSlots?: 1 | 2 | 3;                                       // sub slots its stars open (pieces.ts openSlots); absent = 3
}
export interface PlanIn {
  pieces: PlanPiece[];                                         // one to three
  chunks: Record<Ability, number>;                             // owned, shared by the whole plan
  drinks: Record<Ability, number>;                             // drink tickets owned
  fixedOrder: boolean;
  useChunks: boolean;
  chunkRate?: number;   // chunks one roll is worth (path.ts CHUNK_RATE); 0 = chunks freely
  chunkBudget?: number; // chunks the whole plan may spend in all (the Path's snail); absent = no budget
  useDrinks: boolean;
  horizon: number;
  /** Stub only (not in core/API.md): the mock route is seeded by the build id, as v52 did. */
  mock?: { buildId: number };
}
export type StepKind = "roll" | "drink" | "slap" | "scrub" | "unlock";
export interface PlanStep {
  k: StepKind;
  a?: Ability;                                                 // what lands (roll, drink, slap)
  d?: Ability;                                                 // drink: the drink active
  burn?: string;                                               // roll: group id when the result is thrown away
  slot?: 1 | 2 | 3;                                            // slap: the slot chunked; unlock: the slot a star upgrade opens
  cost?: number;                                               // slap: chunks spent
  sameColumn?: boolean;                                        // slap: lands on the slot this column's roll just filled
  roll?: number | null;                                        // roll / drink: roll count so far
  key: number;                                                 // the column; equal keys in different lanes = one battle
  /** Stub only: the mockup's hand-drawn jitter (step tilt, ticket tilt), drawn from the same seeded rng. */
  r?: number;
  tr?: number;
}
export type Mark = "" | "wrong" | "met";
export interface PlanLane {
  row: string;
  have: [Ability, "" | "wrong"][];
  goal: [Ability, "" | "met"][];
  steps: PlanStep[];                                           // [] for an unreachable lane
}
export interface PlanTotals { rolls: number; battles: number; tickets: number; chunks: number; scrubs: number; snails: number }   // snails: Super Sea Snails for unlocks
export type PlanOut =
  | { ok: true; lanes: PlanLane[]; totals: PlanTotals; unreachable: number[] }
  | { ok: false; error: string };

export const BATTLES_PER_ROLL = 2.3;

/* ---------- the worker client: every call goes to ./worker.ts (the wasm core), one at a time ---------- */

type Fail = { ok: false; error: string };
export interface SeedOut { ok: true; seed: number }
export interface RollOut { n: number; ability: Ability; drink_hit: boolean; seed: number }
export interface Observed { a: Ability | null; drink: Ability | null }
export interface Candidate { skippedSteps: number; seed: number }
export interface RecoverOut { ok: true; candidates: Candidate[]; count: number; locked: boolean }

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();

function rejectAll(why: string) {
  const all = [...pending.values()];
  pending.clear();
  for (const p of all) p.reject(new Error(why));
}
function start(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent) => {
    const p = pending.get(e.data.id);
    if (p) { pending.delete(e.data.id); p.resolve(e.data.reply); }
  };
  w.onerror = (e: ErrorEvent) => {                              // the worker script failed to load or crashed
    e.preventDefault();
    if (worker === w) { worker = null; w.terminate(); }
    rejectAll(`core worker failed: ${e.message || "could not load"}`);
  };
  w.onmessageerror = () => { if (worker === w) { worker = null; w.terminate(); } rejectAll("core worker: unreadable message"); };
  return worker = w;
}
/** One core call (core/API.md), as the raw reply. Rejects if the worker dies or is cancelled. */
export function call<T = any>(req: { fn: string; [k: string]: unknown }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try { start().postMessage({ id, req }); } catch (e) { pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
  });
}
/** Stops the worker (the only way to cancel a long recover); pending calls reject, the next call starts a fresh worker. */
export function cancel(): void {
  const w = worker;
  worker = null;
  w?.terminate();
  rejectAll("cancelled");
}

export const startSeed = (playerKey: string, slot: Slot, gearId: number) =>
  call<SeedOut | Fail>({ fn: "startSeed", playerKey, slot, gearId });
export const rolls = (seed: number, brand: string, drink: Ability | null, n: number) =>
  call<{ ok: true; rolls: RollOut[] } | Fail>({ fn: "rolls", seed, brand, drink, n });
export const recover = (start: number, brand: string, observed: Observed[], maxSteps?: number) =>
  call<RecoverOut | Fail>({ fn: "recover", start, brand, observed, ...(maxSteps === undefined ? {} : { maxSteps }) });
export const refine = (candidates: (number | Candidate)[], brand: string, observed: Observed[]) =>
  call<RecoverOut | Fail>({ fn: "refine", candidates, brand, observed });

/** The path for 1-3 pieces (core/API.md "plan"). The core's answer; if it says ok:false (not written yet) or the worker
 *  can't load, the stub's, so the Path screen never breaks. */
export async function plan(input: PlanIn): Promise<PlanOut> {
  try {
    const { mock, ...req } = input;                             // `mock` is stub-only
    const r = await call<PlanOut>({ fn: "plan", ...req });
    if (r && r.ok === true) return r;
  } catch (e) { if (e instanceof Error && e.message === "cancelled") throw e; }
  try { return planNow(input); } catch (e) { return { ok: false, error: String(e) }; }
}

/** The stub, synchronously: the v52 Path screen draws in the same frame as a toggle or a pick (see path.ts). */
export function planNow(input: PlanIn): PlanOut & { ok: true } {
  const b = { id: input.mock?.buildId ?? 0, set: input.pieces.map(p => [p.row, "", p.goal]) };
  const lanes = pathLanes(b, input).map(l => ({ ...l, steps: keyed(l.steps) })) as PlanLane[];
  const all = lanes.flatMap(l => l.steps);
  const rolls = new Set(all.filter(isRoll).map(s => s.key)).size;
  return {
    ok: true, lanes, unreachable: [],
    totals: { rolls, battles: Math.ceil(rolls * BATTLES_PER_ROLL), tickets: all.filter(s => s.k === "drink").length,
              chunks: all.reduce((t, s) => t + (s.cost || 0), 0), scrubs: all.filter(s => s.k === "scrub").length, snails: 0 },
  };
}

const isRoll = (s: { k: string }) => s.k === "roll" || s.k === "drink";   // chunks over a roll are Murch work after it, as in the core

/* ---------- from v52, verbatim but for: the toggles come from the input, and a slap's `roll: true` is `sameColumn` ---------- */

// Give every step a time key: a roll is its roll number; anything else sits just before the next roll.
// Steps with the same key share a column across all three pieces, so every "roll 4" lines up.
function keyed(steps: any[]) {
  let roll = 0;
  const out = steps.map(s => {
    const isRoll = s.k === "roll" || s.k === "drink";
    if (isRoll) roll++;
    return { ...s, roll: isRoll ? roll : null, key: isRoll ? roll : null };
  });
  for (let i = out.length - 1, nextKey = roll + 1, sub = 0; i >= 0; i--) {
    if (out[i].key === null) { sub += .01; out[i].key = nextKey - .5 - sub; }
    else { nextKey = out[i].key; sub = 0; }
  }
  return out;
}
const CHUNKCOST = [10, 20, 30];                                // the 1st / 2nd / 3rd copy of that ability on the piece, as in the game
const copies = (subs: string[], a: string) => Math.max(1, Math.min(3, subs.filter(x => x === a).length));
// Mock route for a build: what each piece has now (seeded by the build id) and the steps to its goal subs.
// k: roll | drink | slap (chunks) | scrub, as in laneSteps(). Fixed order, Chunks and Drinks change the route.
function pathLanes(b: { id: number; set: any[] }, { fixedOrder, useChunks, useDrinks }: PlanIn): any[] {
  const sub = (r: () => number) => (not: string[]) => { let a; do a = SUBS[Math.floor(r() * SUBS.length)]; while (not.includes(a)); return a; };
  return b.set.map(([row, , subs]: any, k: number) => {
    const rh = rng(hash32(`${b.id}:have:${k}`)), r = rng(hash32(`${b.id}:steps:${k}`)), pickSub = sub(r);
    const G = [0, 1, 2].map(i => subs[i] || ""), n = 1 + Math.floor(rh() * 3);
    const H = G.map((g, i) => { const x = rh(), y = sub(rh)([g]); return i >= n ? "" : g && x < .45 ? g : y; });
    const used = new Set<number>(), met = [false, false, false];
    G.forEach((g, i) => { if (!g) return; const j = fixedOrder ? (H[i] === g ? i : -1) : H.findIndex((h, x) => h === g && !used.has(x)); if (j >= 0) { used.add(j); met[i] = true; } });
    G.forEach((g, i) => { if (g) return; const j = fixedOrder ? (H[i] ? i : -1) : H.findIndex((h, x) => h && !used.has(x)); if (j >= 0) { used.add(j); met[i] = true; } });
    const wrong = H.map((h, i) => !!h && !used.has(i)), nWrong = wrong.filter(Boolean).length;
    const steps: any[] = [];
    let need = [0, 1, 2].filter(i => !met[i]);
    if (nWrong >= 2 || (nWrong === 1 && !useChunks)) { steps.push({ k: "scrub" }); need = [0, 1, 2]; }   // back to ???
    else if (nWrong === 1) {                                     // one wrong sub: chunk the right one over it
      const i = wrong.indexOf(true), g = fixedOrder ? G[i] : G[need[0]];
      const a = g || pickSub([]), after = H.map((h, x) => (x === i ? a : h));
      steps.push({ k: "slap", a, slot: i + 1, cost: CHUNKCOST[copies(after, a) - 1], sameColumn: false });
      need = need.filter(x => x !== (fixedOrder ? i : need[0]));
    }
    let burns = 2;                                               // a few throwaway rolls, never more than 2 per piece
    for (const i of need) {
      const g = G[i];
      if (!g) { steps.push({ k: "roll", a: pickSub([]), r: Math.round(r() * 10 - 5) }); continue; }
      const d1 = r(), d2 = r(), dDrink = r(), dSlap = r();
      const nb = Math.min(burns, d1 < .5 ? 0 : 1 + (d2 < .4 ? 1 : 0)); burns -= nb;
      for (let x = 0; x < nb; x++) steps.push({ k: "roll", a: pickSub([g]), burn: `b${k}${i}` });
      if (useDrinks && dDrink < .35) steps.push({ k: "drink", d: g, a: g, r: Math.round(r() * 10 - 5), tr: Math.round(r() * 24 - 12) });
      else if (useChunks && i === need[need.length - 1] && dSlap < .3) steps.push({ k: "roll", a: pickSub([g]), burn: `c${k}${i}` }, { k: "slap", a: g, slot: i + 1, sameColumn: true, cost: CHUNKCOST[copies(G.slice(0, i + 1), g) - 1] });   // as the core: the roll, then chunks over what it landed
      else steps.push({ k: "roll", a: g, r: Math.round(r() * 10 - 5) });
    }
    return { row, have: H.map((h, i) => [h, wrong[i] ? "wrong" : ""]), goal: G.map((g, i) => [g, met[i] ? "met" : ""]), steps };
  });
}
