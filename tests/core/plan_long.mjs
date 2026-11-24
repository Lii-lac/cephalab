// Planner checks for one piece over long horizons (core/src/plan_scan.cpp), run by plan_tests.mjs:
// the scan vs the old one-piece search, the far probe with its exact battle count, search in
// slices ("from") vs one big search, and the horizon-20000 timing; then 2-3 pieces over long
// horizons (core/src/plan_long.cpp): the probe on 3 pieces, slices, random far cases, timing, near goals at horizon
// 20000 vs 60. Every plan goes through
// plan() so plan_tests.mjs replays it.
// longTests(t) -> the timing text for the replay RESULT line.
export function longTests(t) {
  const { call, jsRoll, ABIL, traits, rnd, randInt, randU32, pick, section, fail, plan, randPiece, randStock } = t;
  const brands = Object.keys(traits.Traits);
  const cost = (r) => JSON.stringify([r.totals.rolls, r.totals.battles, r.totals.tickets, r.totals.chunks, r.totals.scrubs]);
  const done = { row: 'Dummy', brand: 'B00', seed: 1, subs: [ABIL[0], ABIL[0], ABIL[0]], goal: ['', '', ''] };

  // (a) the scan vs the old one-piece search (plan_search.cpp), reached through a 2-piece
  // request whose second lane is already done: same cost, horizons where burns use drinks.
  {
    let pass = 0, total = 0, burnDrinks = 0;
    for (let c = 0; c < 300; c++) {
      const p = randPiece(0), s = randStock(p);
      if (rnd() < 0.5) s.drinks[pick(ABIL)] = randInt(1, 3);
      const req = { pieces: [p], ...s, fixedOrder: rnd() < 0.5, useChunks: rnd() < 0.6, useDrinks: rnd() < 0.9, horizon: randInt(15, 45) };
      const r = plan(req);
      const o = call({ fn: 'plan', ...req, pieces: [p, done] });
      total++;
      const want = o.unreachable.includes(0) ? 'unreachable' : cost(o);
      const got = r.ok && (r.unreachable.length ? 'unreachable' : cost(r));
      if (got === want) pass++; else fail(`scan vs old search case ${c}: ${got} want ${want} req ${JSON.stringify(req)}`);
      if (r.ok && r.lanes[0].steps.some((x) => x.k === 'drink' && x.burn)) burnDrinks++;
    }
    section('plan: 1 piece scan vs the old one-piece search, horizon 15-45 (300 cases)', pass, total, `(${burnDrinks} burn with drinks)`);
  }

  let pass = 0, total = 0;
  const check = (name, ok, r) => { total++; if (ok) pass++; else fail(`${name}: ${JSON.stringify(r).slice(0, 400)}`); };
  // (b) the probe: unreachable at horizon 200, reachable at 20000 with exactly the battles of the
  // first window of 3 plain rolls that land the goal (no chunks, no drinks: burn t, roll 3).
  const G = ['InkRecovery_Up', 'HumanMove_Up', 'SquidMove_Up'];
  for (const fixedOrder of [true, false]) {
    const piece = { row: 'Hed_P', brand: 'B11', seed: 4097, subs: ['', '', ''], goal: G };
    const base = { pieces: [piece], chunks: {}, drinks: {}, fixedOrder, useChunks: false, useDrinks: false };
    let r = plan({ ...base, horizon: 200 });
    check(`probe fixed=${fixedOrder} unreachable at 200`, r.ok && r.unreachable.length === 1 && r.lanes[0].searchedTo === 200, r);
    const roll3 = [];
    let seed = 4097, t0 = -1;
    for (let k = 0; k < 20000 && t0 < 0; k++) {
      const [s2, a] = jsRoll(seed, 'B11', null);
      seed = s2;
      roll3.push(a);
      if (roll3.length < 3) continue;
      const w = roll3.slice(-3);
      if (fixedOrder ? w.every((x, i) => x === G[i]) : [...w].sort().join() === [...G].sort().join()) t0 = k - 2;
    }
    r = plan({ ...base, horizon: 20000 });
    const want = { rolls: t0 + 3, battles: Math.ceil(((t0 + 3) * 23) / 10), tickets: 0, chunks: 0, scrubs: t0 ? 1 + Math.ceil(Math.max(0, t0 - 3) / 3) : 0, snails: 0 };
    check(`probe fixed=${fixedOrder} at 20000: burn ${t0}, ${want.battles} battles`, t0 > 200 && r.ok && !r.unreachable.length &&
      JSON.stringify(r.totals) === JSON.stringify(want) && r.lanes[0].steps.length === 5 && r.lanes[0].steps[0].times === t0, r);
    t.probe = (t.probe ?? []).concat(`${fixedOrder ? 'fixed' : 'any order'} ${want.battles} battles (${t0} burn rolls)`);
  }
  // (c) slices of 500 seed steps (from = 0, 500, ...): the first that finds a route gives the
  // route of one search with horizon = its end; the slices before say unreachable, searchedTo.
  let found = 0, slices = 0, later = 0;
  for (let c = 0; c < 50; c++) {
    const brand = pick(brands), T = traits.Traits[brand];
    const rare = ABIL.filter((a) => a !== T.UsualGearSkill);
    const goal = [pick(rare), pick(rare), pick(rare)];
    const other = ABIL.filter((a) => !goal.includes(a));
    const drinks = rnd() < 0.5 ? { [pick(other)]: randInt(1, 2), [pick(other)]: randInt(0, 2) } : {};
    const req = { pieces: [{ row: 'Hed_S', brand, seed: randU32(), subs: [pick(ABIL), '', ''], goal }], chunks: { [pick(other)]: 30 },
      drinks, fixedOrder: rnd() < 0.7, useChunks: true, useDrinks: true, horizon: 500 };
    let ok = true, hit = null;
    const first = slices;
    for (let from = 0; from < 20000 && ok && !hit; from += 500) {
      const r = plan({ ...req, from });
      slices++;
      if (!r.ok) ok = false;
      else if (r.unreachable.length) ok = r.lanes[0].searchedTo === from + 500;
      else hit = [from, r];
    }
    if (hit) {
      found++;
      if (slices - first > 1) later++;
      const big = plan({ ...req, horizon: hit[0] + 500 });
      ok &&= JSON.stringify(big) === JSON.stringify(hit[1]);
    }
    check(`slices case ${c}`, ok, req);
  }
  section(`plan: 1 piece long horizons (probe, slices of 500 vs one search: ${found}/50 found, ${later} after the first slice, ${slices} slices)`, pass, total, `| probe ${t.probe.join(', ')}`);

  // (d) timing: horizon 20000, one piece, chunks + drinks on, far goals (the brand's rare ability
  // 3 times, chunks and tickets of other abilities), many of them unreachable: the whole scan.
  let worst = 0, sum = 0, un = 0;
  for (let c = 0; c < 20; c++) {
    const brand = pick(brands.filter((b) => ABIL.includes(traits.Traits[b].UnusualGearSkill)));
    const X = traits.Traits[brand].UnusualGearSkill, goal = [X, X, X];
    const other = ABIL.filter((a) => a !== X);
    const req = { pieces: [{ row: 'Hed_T', brand, seed: randU32(), subs: ['', '', ''], goal }], chunks: { [pick(other)]: 40, [X]: c % 2 ? 10 : 0 },
      drinks: { [other[0]]: 2, [other[1]]: 2, [other[2]]: 2 }, fixedOrder: c % 4 !== 0, useChunks: true, useDrinks: true, horizon: 20000 };
    const t0 = performance.now();
    const r = plan(req);
    const ms = performance.now() - t0;
    if (r.ok && r.unreachable.length) un++;
    worst = Math.max(worst, ms); sum += ms;
  }
  return `| 1 piece, horizon 20000, chunks+drinks (6 tickets): worst ${worst.toFixed(1)} ms, mean ${(sum / 20).toFixed(1)} ms, ${un}/20 unreachable ${jointLong(t)}`;
}

// 2-3 pieces past the joint search's reach (core/src/plan_long.cpp). Returns the timing text.
function jointLong(t) {
  const { call, ABIL, traits, rnd, randInt, randU32, pick, section, fail, plan, randPiece, randStock } = t;
  const brands = Object.keys(traits.Traits);
  let pass = 0, total = 0;
  const check = (name, ok, r) => { total++; if (ok) pass++; else fail(`${name}: ${JSON.stringify(r).slice(0, 400)}`); };
  const one = (p, req) => call({ fn: 'plan', ...req, pieces: [p] });
  // (e) the A5a probe goal on a hat, a shirt and shoes of three brands, seeds scanned so each is
  // unreachable alone at horizon 200 and reachable at 20000: with no stock the 3-piece plan is
  // reachable at 20000, not proven optimal, and takes no more battles than the three one-piece plans.
  const G = ['InkRecovery_Up', 'HumanMove_Up', 'SquidMove_Up'], probe = [];
  for (const fixedOrder of [true, false]) {
    const base = { chunks: {}, drinks: {}, fixedOrder, useChunks: false, useDrinks: false };
    const pieces = [['Hed_P', 'B11'], ['Clt_P', 'B05'], ['Shs_P', 'B17']].map(([row, brand]) => {
      for (let seed = 4097; ; seed++) {
        const p = { row, brand, seed, subs: ['', '', ''], goal: G };
        if (one(p, { ...base, horizon: 200 }).unreachable.length && !one(p, { ...base, horizon: 20000 }).unreachable.length) return p;
      }
    });
    const r = plan({ ...base, pieces, horizon: 200 });
    check(`3-piece probe fixed=${fixedOrder} unreachable at 200`, r.ok && r.unreachable.length === 3 && r.lanes.every((l) => l.searchedTo === 200), r);
    // then at 20000; again with tickets of other abilities (burns may drink, lanes share phases
    // and tickets, split between the lanes: no more battles than without tickets, nor than the
    // lanes alone one after another, each of which had every ticket)
    let plain = Infinity;
    for (const drinks of [{}, { MainInk_Save: 2, SubInk_Save: 2, RespawnTime_Save: 1 }]) {
      const b2 = { ...base, drinks, useDrinks: Object.keys(drinks).length > 0, horizon: 20000 };
      const solo = pieces.map((p) => one(p, b2).totals.battles), sum = solo.reduce((x, y) => x + y, 0);
      const r = plan({ ...b2, pieces });
      check(`3-piece probe fixed=${fixedOrder} drinks=${b2.useDrinks} at 20000`, r.ok && !r.unreachable.length && (b2.useDrinks ? r.totals.battles <= plain && r.totals.battles <= sum
        : r.optimal === false && r.totals.battles <= sum && r.lanes.every((l) => l.steps.some((s) => s.times > 1))), r);
      if (r.ok) plain = r.totals.battles;
      probe.push(`${fixedOrder ? 'fixed' : 'any order'}${b2.useDrinks ? ' + 5 tickets' : ''} ${r.totals?.battles} battles (alone ${solo.join('+')} = ${sum}, most ${Math.max(...solo)})`);
    }
  }
  // (f) slices of 1000: the first slice that finds a lane gives that lane's route of one search
  // ending there; a slice before it says unreachable with searchedTo = from + 1000.
  let lanesFound = 0, later = 0;
  for (let c = 0; c < 12; c++) {
    const n = randInt(2, 3), pieces = [], other = new Set(ABIL);
    for (let i = 0; i < n; i++) {
      const brand = pick(brands), rare = ABIL.filter((a) => a !== traits.Traits[brand].UsualGearSkill);
      const goal = [pick(rare), pick(rare), rnd() < 0.3 ? '' : pick(rare)];
      goal.forEach((g) => other.delete(g));
      pieces.push({ row: ['Hed_S', 'Clt_S', 'Shs_S'][i], brand, seed: randU32(), subs: ['', '', ''], goal });
    }
    const o = [...other];
    const req = { pieces, chunks: { [pick(o)]: 30 }, drinks: rnd() < 0.5 ? { [pick(o)]: randInt(1, 2) } : {},
      fixedOrder: rnd() < 0.7, useChunks: true, useDrinks: true, horizon: 1000 };
    const first = new Array(n).fill(null);
    let ok = true;
    for (let from = 0; from + 1000 <= 20000 && ok && first.includes(null); from += 1000) {
      const r = plan({ ...req, from });
      ok = r.ok;
      for (let i = 0; i < n && ok; i++) {
        if (first[i] !== null) continue;
        if (r.unreachable.includes(i)) ok = r.lanes[i].searchedTo === from + 1000;
        else first[i] = [from, r.lanes[i]];
      }
    }
    for (let i = 0; i < n && ok; i++) {
      if (!first[i]) continue;
      lanesFound++;
      if (first[i][0] > 0) later++;
      const big = plan({ ...req, horizon: first[i][0] + 1000 });
      ok = big.ok && JSON.stringify(big.lanes[i]) === JSON.stringify(first[i][1]);
    }
    check(`2-3 piece slices case ${c}`, ok, req);
  }
  // (g) random far 2-3 piece requests (horizon 201..20000, some sliced): replayed with the rest.
  let reach = 0, notOpt = 0, lanes = 0, sharedBurns = 0, drinkBurns = 0;
  // columns of a lane's burn steps (key .. key + times - 1)
  const burnCols = (l) => l.steps.filter((x) => x.burn && x.times).map((x) => [x.key, x.key + x.times - 1]);
  const overlap = (a, b) => a.some(([x, y]) => b.some(([u, v]) => x <= v && u <= y));
  for (let c = 0; c < 50; c++) {
    const n = randInt(2, 3), pieces = [];
    for (let i = 0; i < n; i++) {
      const brand = pick(brands), ab = () => (rnd() < 0.15 ? '' : pick(ABIL));
      const nSubs = randInt(0, 2);
      pieces.push({ row: `Row_${i}`, brand, seed: randU32(), subs: [0, 1, 2].map((k) => (k < nSubs ? pick(ABIL) : '')), goal: [ab(), ab(), ab()] });
    }
    const chunks = {}, drinks = {};
    for (let k = randInt(0, 3); k > 0; k--) chunks[pick(ABIL)] = 10 * randInt(1, 6);
    for (let k = randInt(0, 3); k > 0; k--) drinks[pick(ABIL)] = randInt(1, 3);
    const r = plan({ pieces, chunks, drinks, fixedOrder: rnd() < 0.6, useChunks: rnd() < 0.7, useDrinks: rnd() < 0.8,
      horizon: randInt(201, 20000), ...(rnd() < 0.3 ? { from: randInt(1, 5000) } : {}) });
    lanes += n;
    if (r.ok) reach += n - r.unreachable.length;
    if (r.optimal === false) notOpt++;
    if (r.ok) {
      const bc = r.lanes.map(burnCols);
      if (bc.some((a, i) => bc.some((b, j) => j > i && overlap(a, b)))) sharedBurns++;
      if (r.lanes.some((l) => l.steps.some((x) => x.k === 'drink' && x.times))) drinkBurns++;
    }
    check(`far 2-3 piece case ${c}`, r.ok, r);
  }
  section(`plan: 2-3 pieces long horizons (probe, slices of 1000 vs one search: ${lanesFound} lanes found, ${later} after the first slice; 50 far cases: ${reach}/${lanes} lanes reached, ${notOpt} not proven optimal, ${sharedBurns} with burn groups of 2 lanes in the same columns, ${drinkBurns} with drink burn groups)`,
    pass, total, `| probe on 3 pieces: ${probe.join(', ')}`);
  // (h) timing: 3 pieces, horizon 20000, chunks + drinks (6 tickets shared), far goals.
  let worst = 0, sum = 0, un = 0;
  const rare = brands.filter((b) => ABIL.includes(traits.Traits[b].UnusualGearSkill));
  for (let c = 0; c < 20; c++) {
    const pieces = ['Hed_T', 'Clt_T', 'Shs_T'].map((row) => {
      const brand = pick(rare), X = traits.Traits[brand].UnusualGearSkill;
      return { row, brand, seed: randU32(), subs: ['', '', ''], goal: [X, X, rnd() < 0.5 ? X : ''] };
    });
    const req = { pieces, chunks: { [pick(ABIL)]: 40, [pick(ABIL)]: 20 }, drinks: { [ABIL[0]]: 2, [ABIL[1]]: 2, [ABIL[2]]: 2 },
      fixedOrder: c % 4 !== 0, useChunks: true, useDrinks: true, horizon: 20000 };
    const t0 = performance.now();
    const r = plan(req);
    const ms = performance.now() - t0;
    if (r.ok) un += r.unreachable.length;
    worst = Math.max(worst, ms); sum += ms;
  }
  // (i) near goals (as the 3-piece horizon-60 timing builds them) sent with horizon 20000 cost no
  // more than at horizon 60: lanes dropped, then the cost order (the joint search over 60 steps
  // and the horizon-60 lanes in order are among the candidates).
  let nearPass = 0, nearWorst = 0, worst60 = 0, cheaper = 0;
  const key = (r) => [r.unreachable.length, r.totals.rolls, r.totals.battles, r.totals.tickets, r.totals.chunks, r.totals.scrubs];
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  for (let c = 0; c < 90; c++) {
    const pieces = [randPiece(0), randPiece(1), randPiece(2)];
    const st = randStock(pieces[0]), st2 = randStock(pieces[1]);
    const req = { pieces, chunks: { ...st.chunks, ...st2.chunks }, drinks: { ...st.drinks, ...st2.drinks }, fixedOrder: c % 2 === 0, useChunks: true, useDrinks: true };
    let t0 = performance.now();
    const a = plan({ ...req, horizon: 60 });
    worst60 = Math.max(worst60, performance.now() - t0);
    t0 = performance.now();
    const b = plan({ ...req, horizon: 20000 });
    nearWorst = Math.max(nearWorst, performance.now() - t0);
    const d = a.ok && b.ok ? cmp(key(b), key(a)) : 1;
    if (d <= 0) nearPass++; else fail(`near case ${c}: horizon 20000 ${JSON.stringify(key(b))} vs 60 ${JSON.stringify(key(a))} req ${JSON.stringify(req)}`);
    if (d < 0) cheaper++;
  }
  section('plan: near 3-piece goals at horizon 20000 cost no more than at 60 (90 cases)', nearPass, 90, `(${cheaper} cheaper; worst ${nearWorst.toFixed(0)} ms at horizon 20000, ${worst60.toFixed(0)} ms at 60)`);
  // (j) a burn drink roll moves the seed the same whatever the drink, so merged lanes burn under
  // another lane's drink phase: the hat and the shoes alone burn early with Respawn tickets, the
  // shirt alone needs kept Swim Speed rolls early, and some lane goes past 20 rolls (the far merge,
  // not the joint search). Seeds searched (k * 7919) on the one-piece plans only, so the same case
  // is found before and after the change; BEFORE = that request on the core before it (the shirt's
  // Swim Speed rolls waited for the Respawn burns until column 50).
  {
    const X = 'RespawnTime_Save', Y = 'SquidMove_Up', G = ['InkRecovery_Up', 'HumanMove_Up', 'SquidMove_Up'];
    const BEFORE = { battles: 120, tickets: 3, shirtY: 50 };
    const early = (r, burn, d) => r.lanes[0].steps.some((x) => x.k === 'drink' && !!x.burn === burn && x.d === d && x.key <= (burn ? 12 : 3));
    const base = { chunks: {}, drinks: { [X]: 2, [Y]: 1 }, fixedOrder: true, useChunks: false, useDrinks: true, horizon: 20000 };
    let k = 1, pieces, alone;
    for (; k < 200; k++) {
      const s = (j) => (k * 7919 + j * 104729) >>> 0;
      pieces = [{ row: 'Hed_W', brand: 'B11', seed: s(1), subs: ['', '', ''], goal: [G[0], G[1], ''] },
        { row: 'Clt_W', brand: 'B05', seed: s(2), subs: ['', '', ''], goal: [Y, Y, ''] },
        { row: 'Shs_W', brand: 'B17', seed: s(3), subs: ['', '', ''], goal: [G[2], G[0], ''] }];
      alone = pieces.map((p) => one(p, base));
      if (alone.every((r) => r.ok && !r.unreachable.length) && early(alone[0], true, X) && early(alone[2], true, X) &&
        early(alone[1], false, Y) && alone[1].totals.rolls <= 5 && alone.some((r) => r.totals.rolls > 20)) break;
    }
    const r = plan({ ...base, pieces });
    const sumT = alone.reduce((n, a) => n + a.totals.tickets, 0);
    // a hat or shoes burn now rolls in the shirt's Swim Speed phase (d = the drink of that column),
    // and the shirt's kept Swim Speed rolls come sooner
    const moved = r.ok && [0, 2].some((L) => r.lanes[L].steps.some((x) => x.k === 'drink' && x.burn && x.d === Y));
    const shirtY = r.ok ? r.lanes[1].steps.find((x) => x.k === 'drink' && !x.burn)?.key : undefined;
    const ok = k === 29 && r.ok && !r.unreachable.length && moved && shirtY < BEFORE.shirtY && r.totals.battles < BEFORE.battles &&
      r.totals.tickets <= BEFORE.tickets && r.totals.tickets <= sumT;
    section('plan: burn drink rolls under any lane\'s drink (3 pieces, horizon 20000)', ok ? 1 : 0, 1,
      `(k ${k}: before ${BEFORE.battles} battles, ${BEFORE.tickets} tickets, shirt's Swim Speed from column ${BEFORE.shirtY}; now ${r.totals?.battles}, ${r.totals?.tickets}, from ${shirtY}; alone ${sumT} tickets)`);
    if (!ok) fail(`burn under any drink k ${k}: ${JSON.stringify(r).slice(0, 400)}`);
  }
  return `| 3 pieces, horizon 20000, chunks+drinks (6 tickets): worst ${worst.toFixed(1)} ms, mean ${(sum / 20).toFixed(1)} ms, ${un}/60 lanes unreachable`;
}
