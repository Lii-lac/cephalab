// web/src/pieces.ts in Node (no browser): which piece a lane plans for, the override, source preference, the seed cache,
// refine on a later snapshot, and stale results dropped.   node tests/web/pieces.mjs  (from the repo root)
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = await import(pathToFileURL(path.join(repo, "web/src/pieces.ts")).href);

let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`); if (!ok) failures++; };

const S = "SquidMove_Up", M = "MainInk_Save", R = "RespawnTime_Save", Q = "InkRecovery_Up";
const pc = (slot, gearId, row, subs, extra = {}) => ({ slot, gearId, row, brand: "B03", main: "", subs: [...subs, "", "", ""].slice(0, 3), ...extra });
const snap = (source, pieces, playerKey = "u-aaaaaaaaaaaaaaaaaaaa") => ({ source, playerKey, pieces, at: 1 });
const build = { id: 7, set: [["Hed_CAP002", "ComeBack", [S, S, M]], ["Clt_TES001", "", [S, R, ""]], ["Shs_BOT003", "", [S, "", ""]]] };
const pick = (snaps, o = {}) => P.choosePieces(build, snaps, { fixedOrder: true, ...o }).map(c => c && c.piece.gearId);

// ---- the choice rules
{
  const snaps = { botbase: snap("botbase", [
    pc("head", 50, "Hed_CAP002", [M]), pc("head", 20, "Hed_CAP002", []), pc("head", 10, "Hed_FST000", [S, S, M]),   // own row owned (twice): lowest id of the own rows
    pc("clothes", 60, "Clt_TLY004", [S]), pc("clothes", 61, "Clt_TLY004", [S, R]), pc("clothes", 62, "Clt_TLY004", [S, R]),   // none own: fewest unmet, then lowest id
    pc("shoes", 70, "Shs_SHI006", [M]) ]) };                                                                       // none own, one piece only
  const got = pick(snaps);
  check("own gear row wins (lowest gearId among your copies)", got[0] === 20, `got ${got[0]}`);
  check("no own row: fewest goal slots unmet, tie by lowest gearId", got[1] === 61, `got ${got[1]}`);
  check("no own row: a lone piece of the slot is taken", got[2] === 70);
  check("nothing owned for a slot -> null", pick({ botbase: snap("botbase", [pc("head", 1, "Hed_CAP002", [])]) })[1] === null);
  check("empty snapshots -> all null", pick({}).every(x => x === null));
  check("unmet: fixed order counts slot by slot", P.unmet([R, S, M], [S, S, M], true) === 1 && P.unmet([S, S, M], [S, S, M], true) === 0 && P.unmet([], ["", "", ""], true) === 0);
  check("unmet: free order counts the multiset", P.unmet([R, S, M], [S, S, M], false) === 1 && P.unmet([M, S, S], [S, S, M], false) === 0);
  const free = P.choosePieces(build, { botbase: snap("botbase", [pc("clothes", 1, "Clt_TLY004", [R, S]), pc("clothes", 2, "Clt_TLY004", [S, M])]) }, { fixedOrder: false }).map(c => c && c.piece.gearId);
  check("free order picks by multiset", free[1] === 1, `got ${free[1]}`);
}

// ---- a sendou build with no gear rows ("" = any gear): the lane's index gives the slot
{
  const blank = { id: 9, set: [["", "", [S, "", ""]], ["", "", [S, R, ""]], ["", "", ["", "", ""]]] };
  const snaps = { botbase: snap("botbase", [pc("head", 30, "Hed_CAP002", []), pc("head", 31, "Hed_FST000", [S]),
    pc("clothes", 40, "Clt_TLY004", [S, R]), pc("shoes", 50, "Shs_SHI006", [M])]) };
  const got = P.choosePieces(blank, snaps, { fixedOrder: true }).map(c => c && c.piece.gearId);
  check('"" rows: each lane gets its slot\'s fewest-unmet piece', got[0] === 31 && got[1] === 40 && got[2] === 50, `got ${got}`);
  const ov = P.choosePieces(blank, snaps, { fixedOrder: true, overrides: { [P.overrideKey(9, "head")]: 30 } })[0];
  check('"" rows: the override still wins', ov && ov.piece.gearId === 30);
  const none = P.choosePieces(blank, { botbase: snap("botbase", [pc("head", 30, "Hed_CAP002", [])]) }, { fixedOrder: true });
  check('"" rows: no piece of the slot -> null, note names the slot', none[1] === null && P.buildPlanInput(blank, none, [null, null, null], { fixedOrder: true, useChunks: false, useDrinks: false }).notes[1].note.includes("clothes"));
}

// ---- the override
{
  const snaps = { botbase: snap("botbase", [pc("head", 20, "Hed_CAP002", []), pc("head", 21, "Hed_FST000", [S])]) };
  const ov = { [P.overrideKey(7, "head")]: 21 };
  check("override wins when still owned", pick(snaps, { overrides: ov })[0] === 21);
  check("override of a piece no longer owned is ignored", pick(snaps, { overrides: { [P.overrideKey(7, "head")]: 999 } })[0] === 20);
  check("override is per build", pick(snaps, { overrides: { [P.overrideKey(8, "head")]: 21 } })[0] === 20);
  const mem = new Map(); const kv = { get: k => (mem.has(k) ? JSON.parse(JSON.stringify(mem.get(k))) : null), set: (k, v) => mem.set(k, v) };
  P.setOverride(kv, 7, "head", 21); P.setOverride(kv, 7, "shoes", 5);
  check("override saved in the store by build id + slot", JSON.stringify(P.readOverrides(kv)) === JSON.stringify({ "7:head": 21, "7:shoes": 5 }));
  P.setOverride(kv, 7, "shoes", null);
  check("override cleared", JSON.stringify(P.readOverrides(kv)) === JSON.stringify({ "7:head": 21 }));
}

// ---- source preference: botbase > s3s > file
{
  const a = [pc("head", 1, "Hed_CAP002", [S])], b = [pc("head", 2, "Hed_CAP002", [M])], c = [pc("head", 3, "Hed_CAP002", [R])];
  const all = { file: snap("file", c), s3s: snap("s3s", b), botbase: snap("botbase", a) };
  check("botbase over s3s over file", pick(all)[0] === 1 && pick({ file: all.file, s3s: all.s3s })[0] === 2 && pick({ file: all.file })[0] === 3);
  check("a source with nothing for the slot is skipped", pick({ botbase: snap("botbase", [pc("shoes", 9, "Shs_BOT003", [])]), s3s: snap("s3s", b) })[0] === 2);
  const ch = P.choosePieces(build, all, { fixedOrder: true })[0];
  check("the choice remembers its source and player key", ch.source === "botbase" && ch.playerKey === "u-aaaaaaaaaaaaaaaaaaaa");
}

// ---- seeds: a fake core that counts calls and can be held back
function fakeCore() {
  const calls = { startSeed: 0, recover: 0, refine: 0 }, log = [];
  const gate = { recover: null };                                // set to a promise to hold recover
  const core = {
    calls, log, gate, ambiguous: 3, lockOn: 2,
    async startSeed(pk, slot, id) { calls.startSeed++; return { ok: true, seed: 1000 + id }; },
    async recover(start, brand, observed) {
      calls.recover++; log.push({ fn: "recover", start, brand, observed });
      if (gate.recover) await gate.recover;
      const n = observed.length;
      const candidates = Array.from({ length: n >= core.lockOn ? 1 : core.ambiguous }, (_, i) => ({ skippedSteps: i, seed: 5000 + n * 10 + i }));
      return { ok: true, candidates, count: candidates.length, locked: candidates.length === 1 };
    },
    async refine(cands, brand, observed) {
      calls.refine++; log.push({ fn: "refine", cands, brand, observed });
      return { ok: true, candidates: [{ skippedSteps: 0, seed: 9999 }], count: 1, locked: true };
    },
  };
  return core;
}
const chosen = (piece, o = {}) => ({ piece, source: "s3s", playerKey: "u-aaaaaaaaaaaaaaaaaaaa", ...o });

{
  const core = fakeCore(), r = new P.SeedResolver(core);
  const bb = await r.resolve(chosen(pc("head", 1, "Hed_CAP002", [S], { seed: 4242 }), { source: "botbase" }));
  check("botbase piece: its own seed, no core call", bb.state === "seed" && bb.seed === 4242 && core.calls.startSeed + core.calls.recover === 0);
  const none = await r.resolve(chosen(pc("head", 2, "Hed_CAP002", [])));
  check("piece with no subs: the start seed (not rolled)", none.state === "seed" && none.seed === 1002 && core.calls.recover === 0);
  const noKey = await r.resolve(chosen(pc("head", 3, "Hed_CAP002", [S]), { playerKey: "" }));
  check("no player key -> error, not a guess", noKey.state === "error");
}
{
  const core = fakeCore(), r = new P.SeedResolver(core);
  const p1 = pc("head", 5, "Hed_CAP002", [S]);
  const a = await r.resolve(chosen(p1));
  check("s3s piece, one sub, ambiguous", a.state === "ambiguous" && a.count === 3 && core.calls.recover === 1);
  const obs = core.log[0].observed;
  check("recover: start seed, brand, the filled subs as {a, drink:null}", core.log[0].start === 1005 && core.log[0].brand === "B03" && JSON.stringify(obs) === JSON.stringify([{ a: S, drink: null }]));
  // the cache: same (playerKey, gearId, subs) again costs nothing
  const again = await r.resolve(chosen(p1));
  check("cache: same piece and subs again makes no core call", again.state === "ambiguous" && core.calls.recover === 1 && core.calls.startSeed === 1);
  // another snapshot, one more roll: refine with only the new roll
  const a2 = await r.resolve(chosen(pc("head", 5, "Hed_CAP002", [S, R])));
  const last = core.log.at(-1);
  check("next snapshot with more subs refines with only the new roll", a2.state === "seed" && a2.seed === 9999 && last.fn === "refine" && core.calls.recover === 1
    && JSON.stringify(last.observed) === JSON.stringify([{ a: R, drink: null }]) && last.cands.length === 3, `${core.calls.recover} recover, ${core.calls.refine} refine`);
  const cached = await r.resolve(chosen(pc("head", 5, "Hed_CAP002", [S, R])));
  check("locked seed is cached too", cached.state === "seed" && core.calls.refine === 1 && core.calls.recover === 1);
  // another piece never shares a track or cache
  const o = await r.resolve(chosen(pc("head", 6, "Hed_CAP002", [S])));
  check("a different piece recovers on its own", o.state === "ambiguous" && core.calls.recover === 2);
  // subs that don't continue the old run (scrubbed and rerolled) start over with recover
  const core2 = fakeCore(), r2 = new P.SeedResolver(core2);
  await r2.resolve(chosen(pc("shoes", 8, "Shs_BOT003", [S])));
  await r2.resolve(chosen(pc("shoes", 8, "Shs_BOT003", [M, R])));
  check("a changed run (not an extension) recovers again", core2.calls.recover === 2 && core2.calls.refine === 0);
  // identical requests in flight share one call
  const core3 = fakeCore(), r3 = new P.SeedResolver(core3);
  const pp = pc("clothes", 3, "Clt_TES001", [S]);
  const [x, y] = await Promise.all([r3.resolve(chosen(pp)), r3.resolve(chosen(pp))]);
  check("identical requests in flight share one recover", core3.calls.recover === 1 && x.state === "ambiguous" && y.state === "ambiguous");
}

// ---- stale: a recover that comes back after a newer snapshot is dropped
{
  const core = fakeCore(), r = new P.SeedResolver(core);
  let release; core.gate.recover = new Promise(res => { release = res; });
  const slow = r.resolve(chosen(pc("head", 11, "Hed_CAP002", [S])));
  await new Promise(res => setTimeout(res, 20));
  core.gate.recover = null;                                      // the newer snapshot's recover answers at once
  const fresh = await r.resolve(chosen(pc("head", 11, "Hed_CAP002", [S, R])));
  release();
  const old = await slow;
  check("the newer snapshot's answer is used", fresh.state === "seed" && fresh.seed === 5020, JSON.stringify(fresh));
  check("the older recover's late answer is dropped", old.state === "stale", JSON.stringify(old));
  const back = await r.resolve(chosen(pc("head", 11, "Hed_CAP002", [S])));
  check("a dropped answer is never cached (asking again recomputes)", back.state === "ambiguous" && core.calls.recover === 3, `${core.calls.recover} recovers`);
}

// ---- the plan input
{
  const core = fakeCore(), r = new P.SeedResolver(core);
  const snaps = { s3s: snap("s3s", [pc("head", 1, "Hed_CAP002", [S]), pc("clothes", 2, "Clt_TES001", []), pc("shoes", 3, "Shs_BOT003", [S], { seed: 77 })]) };
  const ch = P.choosePieces(build, snaps, { fixedOrder: true });
  const res = await Promise.all(ch.map(c => c && r.resolve(c)));
  const { input, planned, notes } = P.buildPlanInput(build, ch, res, { fixedOrder: true, useChunks: false, useDrinks: true });
  check("ambiguous lane is a one-line note, not planned", planned[0] === -1 && notes[0].note === "3 possible seeds, one more roll");
  check("the other lanes are planned with their seeds", planned[1] === 0 && planned[2] === 1 && input.pieces.length === 2 && input.pieces[0].seed === 1002 && input.pieces[1].seed === 77);
  check("the plan input carries real rows, brand, goal and the toggles", input.pieces[0].row === "Clt_TES001" && input.pieces[0].brand === "B03"
    && JSON.stringify(input.pieces[0].goal) === JSON.stringify([S, R, ""]) && input.useChunks === false && input.useDrinks === true && input.fixedOrder === true);
}

// ---- a read missing the piece shown last keeps it for KEEP_MS (2026-11-21: the Switch reconnecting swapped the tee for a jacket)
{
  const mem = new Map(), keep = { get: k => mem.get(k), set: (k, v) => mem.set(k, v) };
  const tee = pc("clothes", 5, "Clt_TES001", [S]), jacket = pc("clothes", 9, "Clt_JKT001", [S, R]);
  const full = { botbase: snap("botbase", [tee, jacket]) }, gap = { botbase: snap("botbase", [jacket]) };
  const k = (snaps, now, o = {}) => P.choosePieces(build, snaps, { fixedOrder: true, keep, now, ...o })[1]?.piece.gearId;
  const a = k(full, 1000), b = k(gap, 5000), c = k(gap, 1000 + P.KEEP_MS + 1);
  check("keep: the tee is shown, then a read without it keeps the tee", a === 5 && b === 5, JSON.stringify({ a, b }));
  check("keep: missing for longer than KEEP_MS -> the next best piece", c === 9, String(c));
  const mem2 = new Map(), keep2 = { get: k => mem2.get(k), set: (k, v) => mem2.set(k, v) };
  P.choosePieces(build, full, { fixedOrder: true, keep: keep2, now: 1 });
  const ov = P.choosePieces(build, gap, { fixedOrder: true, keep: keep2, now: 2, overrides: { [P.overrideKey(7, "clothes")]: 9 } })[1]?.piece.gearId;
  check("keep: a piece you picked yourself wins over the kept one", ov === 9, String(ov));
  const back = k({ botbase: snap("botbase", [{ ...tee, subs: [S, R, ""] }, jacket]) }, 6000);
  const mem3 = new Map(), keep3 = { get: k => mem3.get(k), set: (k, v) => mem3.set(k, v) };
  P.choosePieces(build, full, { fixedOrder: true, keep: keep3, now: 1 });
  const other = P.choosePieces(build, { s3s: snap("s3s", [{ ...jacket, gearId: 40 }]) }, { fixedOrder: true, keep: keep3, now: 2 })[1]?.piece.gearId;
  check("keep: another source taking over goes by the normal rules", other === 40, String(other));
  check("keep: once the tee is read again its new state is used", back === 5 && mem.get("7:clothes").chosen.piece.subs[1] === R);
}

console.log(failures ? `FAILED: ${failures} check(s)` : "ALL PASS");
process.exit(failures ? 1 : 0);
