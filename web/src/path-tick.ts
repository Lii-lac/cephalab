// The Path screen's live loop: a roll that happened in the game reads as progress. When a new snapshot shows a lane's piece
// moved on by exactly the plan's first step, that step inks over (its ability fills in with a short squash), then the lane's
// steps slide one column left into the new plan and Up next shows the next step. Anything else that changed a lane fades it
// into the new plan. Reduced motion: fades only. No DOM at import time, so tests/web can import classify() in Node.
import type { Chosen } from "./pieces";

export type Kind = "same" | "changed" | "done" | "count";
/** What the screen remembers of a lane's piece to tell what happened to it later. */
export interface Seen { slot: string; gearId: number; seed: number | null; subs: string[]; open?: number | null; main?: string | null }

export const seen = (c: Chosen | null): Seen | null => c && { slot: c.piece.slot, gearId: c.piece.gearId,
  seed: typeof c.piece.seed === "number" ? c.piece.seed : null, subs: [0, 1, 2].map(i => c.piece.subs[i] || ""), open: openOf(c.piece), main: c.piece.main || null };
// open sub slots from the stars, as pieces.ts openSlots (null when the stars aren't known)
const openOf = (p: any): number | null => p && typeof p.rarity === "number" && p.rarity >= 0 && p.rarity <= 5 ? Math.min(3, p.rarity + 1) : null;

export const xorstep = (s: number) => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };   // one seed step

/** Did the piece go from `o` to `n` by rolling exactly `st`, the old plan's first step of its lane? A botbase seed must be the
 *  seed after that step (a drink roll takes 1 or 2 seed steps); an s3s / file piece must have gained the slot that step fills. */
export function happened(o: Seen, n: Seen, st: any): boolean {
  if (!st || (st.k !== "roll" && st.k !== "drink") || (st.times || 1) > 1) return false;
  if (o.seed !== null && n.seed !== null) { const a = xorstep(o.seed); return n.seed === a || (st.k === "drink" && n.seed === xorstep(a)); }
  const k = o.subs.filter(Boolean).length;
  return k < 3 && n.subs.filter(Boolean).length === k + 1 && o.subs.slice(0, k).every((x, i) => x === n.subs[i]) && n.subs[k] === st.a;
}

/** What the new snapshot did to a lane's first planned step: "done" (it happened: it goes, the lane moves on a column),
 *  "count" (part of it happened: one roll of a burn group, one snail of a run of unlocks; the cell stays), null (neither).
 *  Murch's steps (unlock, chunk, scrub) don't touch the seed: a botbase seed that moved means something else happened. */
export function progress(o: Seen, n: Seen, steps: any[]): "done" | "count" | null {
  const st = steps?.[0]; if (!st) return null;
  const still = o.seed === null || n.seed === null || o.seed === n.seed;
  if (st.k === "unlock") {
    if (o.open == null || n.open == null || n.open <= o.open || !still) return null;
    let run = 1; while (steps[run]?.k === "unlock") run++;
    return n.open - o.open >= run ? "done" : "count";
  }
  if (st.k === "main") return still && !!n.main && n.main === st.a && o.main !== st.a ? "done" : null;   // Murch swapped the main (the seed stays)
  if (st.k === "slap") return still && n.subs[st.slot - 1] === st.a && o.subs[st.slot - 1] !== st.a ? "done" : null;
  if (st.k === "scrub") return still && o.subs.some(Boolean) && !n.subs.some(Boolean) ? "done" : null;
  if ((st.k === "roll" || st.k === "drink") && (st.times || 1) > 1) {
    if (o.seed === null || n.seed === null) return null;
    const a = xorstep(o.seed);
    return n.seed === a || (st.k === "drink" && n.seed === xorstep(a)) ? "count" : null;
  }
  return happened(o, n, st) ? "done" : null;
}

/* Live steps from the Switch (not the planner): a worn piece close to its next sub slot that the plan doesn't want rolled
   now says "Take off"; a roll that needs a drink the game doesn't have active says "Drink". Gear XP resets per slot: a slot
   unlocks at XP_CAP[subs filled] (3 filled: no more). */
export const XP_CAP = [2000, 8000, 14000];
export const XP_WARN = 5500;                                     // warn this close to the cap, or closer than 1.25 x the largest gain seen
export const warnAt = (gainMax?: number | null) => Math.max(XP_WARN, 1.25 * (+(gainMax ?? 0) || 0));
export type LiveStep = { k: "off" } | { k: "drink"; d: string } | null;
/** Per lane: lanes[i].gearId / slot = its piece, roll = its next step if that is a roll in the coming battle ({d: the drink it
 *  needs, or null}), null when the plan doesn't roll it then, undefined when there's no plan to go by (a note, done).
 *  pieces: the snapshot's {slot, gearId, exp, subs}; worn {head, clothes, shoes} or null; drink {ability} active, null with
 *  none, undefined when not read; T = warnAt(xpGainMax). */
export function liveSteps(lanes: { slot?: string; gearId?: number; roll?: { d: string | null } | null }[], pieces: any[],
                          worn: Record<string, number> | null | undefined, drink: { ability: string } | null | undefined, T: number): LiveStep[] {
  return lanes.map(l => {
    if (!worn || !l || l.roll === undefined || l.gearId == null || !l.slot || worn[l.slot] !== l.gearId) return null;
    const p = pieces.find(x => x && x.slot === l.slot && x.gearId === l.gearId);
    const cap = p ? XP_CAP[(p.subs || []).filter(Boolean).length] : undefined;
    if (cap === undefined) return null;                              // a full piece never rolls from XP
    const near = typeof p.exp === "number" && cap - p.exp <= T;
    if (l.roll && l.roll.d) return drink !== undefined && (!drink || drink.ability !== l.roll.d) ? { k: "drink", d: l.roll.d } : null;
    if (l.roll) return near && drink && drink.ability ? { k: "off" } : null;   // a plain roll wanted, but a drink is on (it can't come off)
    return near ? { k: "off" } : null;
  });
}

const sig = (l: any) => JSON.stringify([l.have, l.goal, l.steps, l.note, !!l.searching]);
/** Per lane: "same" (nothing to show), "done" (the planned first step happened), "changed" (anything else). */
export function classify(oldLanes: any[], newLanes: any[], oldSeen: (Seen | null)[], newSeen: (Seen | null)[]): Kind[] {
  return newLanes.map((l, i) => {
    const old = oldLanes[i];
    if (!old || sig(old) === sig(l)) return "same";
    const o = oldSeen[i], n = newSeen[i];
    return (o && n && o.slot === n.slot && o.gearId === n.gearId && progress(o, n, old.steps)) || "changed";
  });
}

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)", INK = 300, FADE = 250, SLIDE = 420;
const settle = (a?: Animation | null) => (a ? a.finished.then(() => {}, () => {}) : Promise.resolve());

/** Plays the change from the old plan (still drawn) to the new one. `redraw` draws the new plan; `current` says whether this
 *  is still the newest plan (a newer snapshot has taken over when false: nothing more is drawn here).
 *  done: the step inks over, then the lane's whole track slides left one column, the finished step fading out past the
 *  edge; then the new plan is drawn (the step is gone from it, so the track can't be panned back to it) and, if its first
 *  step doesn't sit where the slide left the old second one, eased there. count: the cell inks and is redrawn in place. */
export async function playTick(host: HTMLElement, kinds: Kind[], redraw: () => void, current: () => boolean): Promise<void> {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lane = (i: number) => host.querySelectorAll<HTMLElement>(".lane")[i];
  const idx = (k: Kind) => kinds.flatMap((x, i) => (x === k ? [i] : []));
  const done = idx("done"), counted = idx("count");
  const slid: { i: number; ref: number | null; k: number }[] = [];
  if (!reduced && (done.length || counted.length)) {
    const steps = [...done, ...counted].map(i => lane(i)?.querySelector<HTMLElement>(".track .step:not(.ph)")).filter((s): s is HTMLElement => !!s);
    steps.forEach(s => s.classList.add("inked"));
    await Promise.all(steps.map(s => settle(s.querySelector(".vis > *")?.animate({ scale: [1, 0.82, 1.08, 1] }, { duration: INK, easing: EASE }))));
    if (!current()) return;
    const run: Promise<void>[] = [];
    for (const i of done) {
      const l = lane(i), track = l?.querySelector<HTMLElement>(".track"), all = track ? [...track.querySelectorAll<HTMLElement>(".step")] : [];
      const real = all.filter(s => !s.classList.contains("ph")), first = real[0];
      if (!track || !first) continue;
      const col = parseFloat(getComputedStyle(track).getPropertyValue("--col")) || 100;   // CSS px
      const k = first.getBoundingClientRect().width / (parseFloat(getComputedStyle(first).width) || first.getBoundingClientRect().width) || 1;   // client px per CSS px
      slid.push({ i, ref: real[1] ? real[1].getBoundingClientRect().left - col * k : null, k });
      const tv = l.querySelector<HTMLElement>(".tview"), c = tv && getComputedStyle(tv).clipPath.match(/^inset\((\S+) (\S+) (\S+) (\S+)\)$/);
      if (tv && c) tv.style.clipPath = `inset(${c[1]} ${c[2]} ${c[3]} 0px)`;   // path-pan lets cells show a little past the left edge; mid-slide that would put the leaving step over the lane head
      for (const s of all) run.push(settle(s.animate({ translate: ["0 0", `${-col}px 0`] }, { duration: SLIDE, easing: EASE, fill: "forwards" })));
      run.push(settle(first.animate({ opacity: [1, 0] }, { duration: SLIDE * .5, easing: "ease-out", fill: "forwards" })));   // gone before it reaches the lane head
    }
    await Promise.all(run);
    if (!current()) return;
  }
  redraw();
  const run: Promise<void>[] = [];
  const fade = (el: Element | null | undefined, ms = FADE) => { if (el) run.push(settle(el.animate({ opacity: [0, 1] }, { duration: ms, easing: EASE }))); };
  kinds.forEach((k, i) => {
    if (k === "same") return;
    const l = lane(i); if (!l) return;
    if (reduced || k === "changed") { l.querySelectorAll(".track, .lsearch, .lfar, .lnote").forEach(e => fade(e)); return; }
    if (k !== "done") return;
    const s = slid.find(x => x.i === i), first = l.querySelector<HTMLElement>(".track .step:not(.ph)");
    if (!s || s.ref == null || !first) return;
    const dx = (s.ref - first.getBoundingClientRect().left) / s.k;
    if (Math.abs(dx) > 1) l.querySelectorAll(".track .step").forEach(e => run.push(settle(e.animate({ translate: [`${dx.toFixed(1)}px 0`, "0 0"] }, { duration: FADE, easing: EASE }))));
  });
  if (done.length || counted.length) host.querySelectorAll(".next .ustack .upg.on").forEach(e => run.push(settle(e.animate(reduced ? { opacity: [0, 1] } : { opacity: [0, 1], translate: ["0 10px", "0 0"] }, { duration: INK, easing: EASE }))));
  await Promise.all(run);
}
