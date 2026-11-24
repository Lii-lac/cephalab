// Section 6 of run_tests.mjs: the planner (fn plan). 1 and 2 pieces vs the brute-force joint
// reference (tests/core/plan_ref.mjs), hand cases, every plan replayed, timing, bad input.
// planTests(t): t = {call, jsRoll, ABIL, traits, rnd, randInt, randU32, pick, section, fail}.
export async function planTests(t) {
  const { call, jsRoll, ABIL, traits, rnd, randInt, randU32, pick, section, fail } = t;
  const { make } = await import(new URL('./plan_ref.mjs', import.meta.url));
  const { replayPlan } = make(jsRoll, ABIL);
  const refs = {}, refFor = (rate) => (refs[rate] ??= make(jsRoll, ABIL, rate).refJoint);
  const brands = Object.keys(traits.Traits);
  const plans = [];  // [req, reply] of every plan made here, replayed below
  const plan = (req) => { const r = call({ fn: 'plan', ...req }); plans.push([req, r]); return r; };
  const coreCost = (r) => [r.totals.rolls, r.totals.battles, r.totals.tickets, r.totals.chunks, r.totals.scrubs];
  const refCost = (x) => x && [x[0], Math.ceil((x[1] * 23) / 10), x[2], x[3], x[4]];
  const plainRolls = (seed, brand, n) => { const out = []; for (let i = 0; i < n; i++) { const [s, a] = jsRoll(seed, brand, null); out.push(a); seed = s; } return out; };
  // a seed whose next plain rolls are want[] and that passes ok(seed)
  const seedFor = (brand, want, ok = () => true) => { for (;;) { const s = randU32(); if (plainRolls(s, brand, want.length).every((a, i) => a === want[i]) && ok(s)) return s; } };
  const randPiece = (i) => {
    const brand = pick(brands), seed = randU32();
    const near = plainRolls(seed, brand, 6);
    const ab = () => (rnd() < 0.6 ? pick(near) : pick(ABIL));
    const nSubs = randInt(0, 3), subs = [0, 1, 2].map((k) => (k < nSubs ? ab() : ''));
    const goal = [0, 1, 2].map(() => (rnd() < 0.2 ? '' : ab()));
    return { row: `Row_${i}`, brand, seed, subs, goal };
  };
  const randStock = (piece) => {
    const chunks = {}, drinks = {};
    for (let k = randInt(0, 2); k > 0; k--) chunks[rnd() < 0.7 ? pick(piece.goal.filter(Boolean).concat(ABIL[0])) : pick(ABIL)] = 10 * randInt(0, 4);
    for (let k = randInt(0, 2); k > 0; k--) drinks[rnd() < 0.7 ? pick(piece.goal.filter(Boolean).concat(ABIL[1])) : pick(ABIL)] = randInt(0, 2);
    return { chunks, drinks };
  };

  // (1) the core's cost vs the reference. Lanes the reference can't plan alone must come back
  // unreachable; if the rest can't be planned together, the core may drop more, and what it
  // keeps must still be the reference's optimum for those lanes.
  const vsRef = (req) => {
    const r = plan(req);
    if (!r.ok) return `not ok: ${r.error}`;
    const refJoint = refFor(req.useChunks ? req.chunkRate || 0 : 0);
    const o = { horizon: req.horizon, fixed: req.fixedOrder, chunks: req.useChunks, drinks: req.useDrinks };
    const st = { chunks: req.chunks, drinks: req.drinks, ...(req.chunkBudget != null ? { budget: req.chunkBudget } : {}) };
    const idx = req.pieces.map((_, i) => i);
    const soloUn = idx.filter((i) => refJoint([req.pieces[i]], o, st) === null);
    const live = idx.filter((i) => !soloUn.includes(i));
    const full = refJoint(live.map((i) => req.pieces[i]), o, st);
    if (full) {
      if (JSON.stringify(r.unreachable) !== JSON.stringify(soloUn)) return `unreachable ${JSON.stringify(r.unreachable)} want ${JSON.stringify(soloUn)}`;
      return JSON.stringify(coreCost(r)) === JSON.stringify(refCost(full)) ? null : `core ${JSON.stringify(coreCost(r))} ref ${JSON.stringify(refCost(full))}`;
    }
    if (!soloUn.every((i) => r.unreachable.includes(i))) return `unreachable ${JSON.stringify(r.unreachable)} misses ${JSON.stringify(soloUn)}`;
    const kept = refJoint(idx.filter((i) => !r.unreachable.includes(i)).map((i) => req.pieces[i]), o, st);
    if (!kept) return `kept lanes can't be planned together`;
    return JSON.stringify(coreCost(r)) === JSON.stringify(refCost(kept)) ? null : `core ${JSON.stringify(coreCost(r))} ref (kept) ${JSON.stringify(refCost(kept))}`;
  };
  // rated: the chunk slider (chunkRate), rolls * rate + chunks compared first
  // chunkLean per piece (0 / 1 / 2 / none; only a rate weighs it) from its own generator, so the shared rnd's cases stay as they were
  let leanSeed = 0x2545f491;
  const leanPick = () => { leanSeed = (Math.imul(leanSeed, 1103515245) + 12345) >>> 0; return [0, 1, 2, undefined][leanSeed >>> 30]; };
  // openSlots per piece (1 / 2 / 3 / none = 3; locked slots, opened by unlock steps) from a generator of its own too
  let openSeed = 0x6b43a9b5;
  const openPick = () => { openSeed = (Math.imul(openSeed, 1103515245) + 12345) >>> 0; return [1, 2, 3, undefined][openSeed >>> 30]; };
  for (const [n, cases, hmax, rated] of [[1, 300, 10, false], [2, 300, 6, false], [1, 200, 10, true], [2, 150, 6, true]]) {
    let pass = 0, total = 0, ms = 0, shared = 0, drunk = 0, leaned = 0, locked = 0, unlocked = 0;
    for (let c = 0; c < cases; c++) {
      total++;
      const pieces = [], chunks = {}, drinks = {};
      for (let i = 0; i < n; i++) {
        const p = randPiece(i), s = randStock(p);
        pieces.push(p); Object.assign(chunks, s.chunks); Object.assign(drinks, s.drinks);
        const g = p.goal.filter(Boolean);  // 2 pieces: often a drink one of them wants
        if (n === 2 && g.length && rnd() < 0.7) drinks[pick(g)] = randInt(1, 2);
      }
      const req = { pieces, chunks, drinks, fixedOrder: rnd() < 0.5, useChunks: rated || rnd() < 0.6, useDrinks: rnd() < (n === 1 ? 0.6 : 0.8), horizon: randInt(1, hmax) };
      if (rated) req.chunkRate = pick([1, 3, 10, 25]);
      if (req.useChunks && rnd() < 0.4) for (const p of pieces) if (rnd() < 0.6) p.maxChunks = pick([0, 10, 20, 30]);   // a per-piece cap
      if (req.useChunks && rnd() < 0.5) req.chunkBudget = pick([0, 10, 20, 30, 40, 60]);   // the Path's chunk budget for the whole plan
      for (const p of pieces) { const l = leanPick(); if (l !== undefined) p.chunkLean = l; }
      for (const p of pieces) { const o = openPick(); if (o !== undefined) p.openSlots = o; }
      if (pieces.some((p) => p.openSlots < 3)) locked++;
      if (rated && pieces.some((p) => p.chunkLean === 0 || p.chunkLean === 2)) leaned++;
      const t0 = performance.now();
      const err = vsRef(req);
      ms += performance.now() - t0;
      const r = plans.at(-1)[1];
      const dl = r.ok ? r.lanes.filter((l) => l.steps.some((s) => s.k === 'drink')).length : 0;
      if (dl > 0) drunk++;
      if (dl > 1) shared++;
      if (r.ok && r.lanes.some((l) => l.steps.some((s) => s.k === 'unlock'))) unlocked++;
      if (err === null) pass++; else fail(`plan vs reference (${n} pieces) case ${c}: ${err} req ${JSON.stringify(req)}`);
    }
    section(`plan: ${n} piece${n > 1 ? 's' : ''}${rated ? ', chunk rate' : ''} vs brute-force joint reference (${cases} cases)`, pass, total, `(${drunk} with drink steps, ${shared} of them in 2 lanes, ${locked} with locked slots, ${unlocked} with unlock steps, ${rated ? `${leaned} with a chunk lean, ` : ''}${ms.toFixed(0)} ms)`);
  }

  // (2) hand cases
  let pass = 0, total = 0;
  const check = (name, ok, r) => { total++; if (ok) pass++; else fail(`${name}: ${JSON.stringify(r).slice(0, 400)}`); };
  const S = 'SquidMove_Up', Q = 'InkRecovery_Up', B = 'B03', Z1 = 'MainInk_Save', Z2 = 'SubInk_Save';
  const base = { chunks: {}, drinks: {}, fixedOrder: true, useChunks: false, useDrinks: false, horizon: 10 };
  {
    // s+;s+;qr on a hat holding s+ in slot 1 needs only s+ then qr
    const seed = seedFor(B, [S, Q]);
    const r = plan({ ...base, pieces: [{ row: 'Hed_A', brand: B, seed, subs: [S, '', ''], goal: [S, S, Q] }] });
    check('s+ then qr', r.ok && r.lanes[0].steps.map((s) => s.k + ':' + s.a).join() === `roll:${S},roll:${Q}` && r.totals.rolls === 2 &&
      JSON.stringify(r.lanes[0].goal) === JSON.stringify([[S, 'met'], [S, ''], [Q, '']]), r);
  }
  {
    // wrong slot: qr;s+ on s+;s+;qr. Fixed on: chunk s+ over slot 1 (2nd copy, 20) when the stock allows ...
    const seed = seedFor(B, [Q]);
    const pc = { row: 'Hed_B', brand: B, seed, subs: [Q, S, ''], goal: [S, S, Q] };
    let r = plan({ ...base, pieces: [pc], useChunks: true, chunks: { [S]: 20 } });
    check('wrong slot, fixed, chunk over', r.ok && r.totals.rolls === 1 && r.totals.chunks === 20 && r.totals.scrubs === 0 &&
      r.lanes[0].steps.some((s) => s.k === 'slap' && s.slot === 1 && s.a === S && s.cost === 20) &&
      JSON.stringify(r.lanes[0].have) === JSON.stringify([[Q, 'wrong'], [S, ''], ['', '']]), r);
    // ... else scrub
    r = plan({ ...base, pieces: [pc], useChunks: true, chunks: { [S]: 10 }, horizon: 40 });
    check('wrong slot, fixed, little stock -> scrub', r.ok && (r.unreachable.length === 1 || (r.totals.scrubs >= 1 && !r.lanes[0].steps.some((s) => s.k === 'slap' && s.slot === 1 && s.cost === 20))), r);
    r = plan({ ...base, pieces: [pc], horizon: 40 });
    check('wrong slot, fixed, no chunks -> scrub', r.ok && (r.unreachable.length === 1 || (r.totals.scrubs >= 1 && r.lanes[0].steps[0].k === 'scrub')), r);
    // fixed order off: it fits, only s+ is needed
    const seed2 = seedFor(B, [S]);
    r = plan({ ...base, pieces: [{ ...pc, seed: seed2 }], fixedOrder: false });
    check('wrong slot, order off, fits', r.ok && r.lanes[0].steps.length === 1 && r.lanes[0].steps[0].a === S && r.totals.rolls === 1 &&
      JSON.stringify(r.lanes[0].have) === JSON.stringify([[Q, ''], [S, ''], ['', '']]), r);
  }
  {
    // no tickets (or drinks off) -> no drink steps
    let ok = true, last;
    for (let c = 0; c < 20; c++) {
      const pieces = [randPiece(0), randPiece(1)];
      last = plan({ ...base, pieces, useDrinks: true, useChunks: true, chunks: { [S]: 30 }, drinks: {}, horizon: 30 });
      ok &&= last.ok && last.lanes.every((l) => l.steps.every((s) => s.k !== 'drink')) && last.totals.tickets === 0;
      last = plan({ ...base, pieces, useDrinks: false, drinks: { [S]: 2, [Q]: 2 }, horizon: 30 });
      ok &&= last.ok && last.lanes.every((l) => l.steps.every((s) => s.k !== 'drink'));
    }
    check('no tickets / drinks off -> no drink steps', ok, last);
  }
  {
    // unreachable within the horizon -> listed, steps []; the other lane still planned; lane already done -> steps []
    const seed = seedFor(B, [S, Q]);
    const r = plan({ ...base, horizon: 2, pieces: [
      { row: 'Hed_U', brand: B, seed: 1, subs: ['', '', ''], goal: [Q, Q, Q] },
      { row: 'Clt_D', brand: B, seed: 2, subs: [S, Q, S], goal: [S, '', S] },
      { row: 'Shs_R', brand: B, seed, subs: [S, '', ''], goal: [S, S, Q] }] });
    check('unreachable lane', r.ok && JSON.stringify(r.unreachable) === '[0]' && r.lanes[0].steps.length === 0, r);
    check('lane already done', r.ok && r.lanes[1].steps.length === 0 && r.lanes[1].goal.every((g) => g[1] === 'met'), r);
    check('third lane planned', r.ok && r.lanes[2].steps.length === 2 && r.totals.rolls === 2, r);
  }
  {
    // A's next wanted roll needs drink S (a hit), B's next must be plain (Q): different columns, B
    // first (A's phase then runs past the plan's end instead of idling before B's roll).
    const hitS = (s) => jsRoll(s, B, S)[2];
    const sA = seedFor(B, [], (s) => plainRolls(s, B, 1)[0] !== S && hitS(s));
    const sB = seedFor(B, [Q], (s) => jsRoll(s, B, S)[1] !== Q);
    const drinkPhase = { ...base, useDrinks: true, drinks: { [S]: 1 } };
    let r = plan({ ...drinkPhase, pieces: [
      { row: 'Hed_A', brand: B, seed: sA, subs: [Z1, Z2, ''], goal: [Z1, Z2, S] },
      { row: 'Hed_B', brand: B, seed: sB, subs: [Z1, Z2, ''], goal: [Z1, Z2, Q] }] });
    const a = r.ok && r.lanes[0].steps, b = r.ok && r.lanes[1].steps;
    check('drink and plain in different columns', r.ok && a.length === 1 && b.length === 1 && a[0].k === 'drink' && a[0].d === S &&
      b[0].k === 'roll' && b[0].a === Q && b[0].key === 1 && a[0].key === 2 && r.totals.rolls === 2 && r.totals.battles === 5 && r.totals.tickets === 1, r);
    // both need S from a hit: one phase, one column, one ticket
    const sA2 = seedFor(B, [], (s) => plainRolls(s, B, 1)[0] !== S && hitS(s) && s !== sA);
    r = plan({ ...drinkPhase, pieces: [
      { row: 'Hed_A', brand: B, seed: sA, subs: [Z1, Z2, ''], goal: [Z1, Z2, S] },
      { row: 'Clt_A', brand: B, seed: sA2, subs: [Z2, Z1, ''], goal: [Z2, Z1, S] }] });
    check('one phase serves two pieces', r.ok && r.lanes.every((l) => l.steps.length === 1 && l.steps[0].k === 'drink' && l.steps[0].key === 1) &&
      r.totals.rolls === 1 && r.totals.tickets === 1 && r.totals.battles === 3, r);
  }
  {
    // locked slots (openSlots): fixed seeds, so the shared rnd's later cases stay as they were (the replay checks every plan)
    const one = (goal, openSlots, horizon = 60) => plan({ ...base, horizon, pieces: [{ row: 'Hed_L', brand: B, seed: 12345, subs: ['', '', ''], goal, openSlots }] });
    let r = one([S, '', ''], 1);
    const ks = (x) => x.ok ? x.lanes[0].steps.map((s) => s.k) : [];
    check('1 star, goal in slot 1 only: no unlock, a scrub before every burn roll', r.ok && !ks(r).includes('unlock') && r.totals.snails === 0 &&
      r.lanes[0].steps[0].times === r.totals.rolls - 1 && r.lanes[0].steps[0].scrubs === r.totals.rolls - 2, r);
    r = one(['', '', S], 1);
    check('1 star, goal in slot 3: unlock 2 and 3 first', r.ok && ks(r)[0] === 'unlock' && ks(r)[1] === 'unlock' && r.lanes[0].steps[0].slot === 2 &&
      r.lanes[0].steps[1].slot === 3 && r.lanes[0].steps[1].key < 1 && r.totals.snails === 2, r);
    r = one(['', '', S], 2, 20000);
    check('2 stars at horizon 20000: one unlock', r.ok && ks(r)[0] === 'unlock' && r.lanes[0].steps[0].slot === 3 && r.totals.snails === 1, r);
    r = plan({ ...base, horizon: 20000, pieces: [
      { row: 'Hed_L', brand: B, seed: 12345, subs: ['', '', ''], goal: [S, '', ''], openSlots: 1 },
      { row: 'Clt_L', brand: B, seed: 999, subs: [Q, '', ''], goal: [Q, Q, ''], openSlots: 1 },
      { row: 'Shs_L', brand: B, seed: 4242, subs: ['', '', ''], goal: ['', S, ''], openSlots: 2 }] });
    check('3 pieces with locked slots at horizon 20000', r.ok && !r.unreachable.length && r.totals.snails === 1 &&
      r.lanes[1].steps[0].k === 'unlock' && !r.lanes[0].steps.concat(r.lanes[2].steps).some((s) => s.k === 'unlock'), r);
  }
  section('plan: hand cases', pass, total);

  // 3-piece plans, horizon 60, chunks and drinks on (timed)
  let worst = 0, sum = 0;
  for (let c = 0; c < 20; c++) {
    const pieces = [randPiece(0), randPiece(1), randPiece(2)];
    const st = randStock(pieces[0]), st2 = randStock(pieces[1]);
    const req = { pieces, chunks: { ...st.chunks, ...st2.chunks }, drinks: { ...st.drinks, ...st2.drinks }, fixedOrder: c % 2 === 0, useChunks: true, useDrinks: true, horizon: 60 };
    const t0 = performance.now();
    plan(req);
    const ms = performance.now() - t0;
    worst = Math.max(worst, ms); sum += ms;
  }

  // one piece over long horizons (tests/core/plan_long.mjs): scan vs old search, probe, slices, timing
  const { longTests } = await import(new URL('./plan_long.mjs', import.meta.url));
  const longTiming = longTests({ ...t, plan, randPiece, randStock });

  // (3) replay every plan made above with the real roll math and the phase rule
  pass = 0; total = 0;
  for (const [req, r] of plans) {
    total++;
    const err = replayPlan(req, r);
    if (err === null) pass++; else fail(`replay: ${err} req ${JSON.stringify(req).slice(0, 300)}`);
  }
  section(`plan: replay of every plan (${plans.length})`, pass, total, `| 3 pieces, horizon 60, chunks+drinks: worst ${worst.toFixed(1)} ms, mean ${(sum / 20).toFixed(1)} ms ${longTiming}`);

  // (4) bad plan input -> ok:false
  pass = 0; total = 0;
  const P = { row: 'Hed_A', brand: 'B03', seed: 1, subs: ['', '', ''], goal: [S, '', ''] };
  const R = { fn: 'plan', pieces: [P], fixedOrder: true, useChunks: true, useDrinks: true, horizon: 10 };
  const bad = [
    { fn: 'plan' }, { ...R, pieces: [] }, { ...R, pieces: [P, P, P, P] }, { ...R, pieces: P }, { ...R, pieces: [1] },
    { ...R, pieces: [{ ...P, row: '' }] }, { ...R, pieces: [{ ...P, brand: 'X1' }] }, { ...R, pieces: [{ ...P, seed: -1 }] },
    { ...R, pieces: [{ ...P, seed: 2 ** 32 }] }, { ...R, pieces: [{ ...P, seed: 1.5 }] }, { ...R, pieces: [{ ...P, subs: ['', ''] }] },
    { ...R, pieces: [{ ...P, goal: ['Nope', '', ''] }] }, { ...R, pieces: [{ ...P, goal: [null, '', ''] }] },
    { ...R, pieces: [{ ...P, subs: ['', S, ''] }] }, { ...R, pieces: [{ ...P, goal: undefined }] },
    { ...R, chunks: { [S]: -10 } }, { ...R, chunks: { Nope: 10 } }, { ...R, chunks: [10] }, { ...R, drinks: { [S]: 1.5 } }, { ...R, drinks: 'x' },
    { ...R, fixedOrder: undefined }, { ...R, useChunks: 'yes' }, { ...R, useDrinks: 1 },
    { ...R, horizon: undefined }, { ...R, horizon: -1 }, { ...R, horizon: 20001 }, { ...R, horizon: '10' },
    { ...R, pieces: [P, P], horizon: 20001 }, { ...R, pieces: [P, P], from: 1000001 }, { ...R, from: -1 }, { ...R, from: 1.5 },
    { ...R, from: 1000001 }, { ...R, from: '0' }, { ...R, drinks: { [S]: 200, [Q]: 200 }, horizon: 20000, from: 100000 },
    { ...R, pieces: [P, P, P], drinks: { [S]: 200, [Q]: 200 }, horizon: 20000, from: 100000 },
  ];
  for (const b of bad) {
    total++;
    const r = call(b);
    if (r.ok === false && typeof r.error === 'string' && r.error) pass++; else fail('bad plan accepted: ' + JSON.stringify(b).slice(0, 200));
  }
  section('plan: bad input gives ok:false', pass, total);
}
