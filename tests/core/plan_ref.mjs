// Planner checks for plan_tests.mjs: a brute-force reference for 1-2 pieces planned jointly
// (every route of each piece alone, every pairing, each on its cheapest real timeline, column
// by column with idle drink columns) and a replay of a plan reply with the roll math and phases.
// make(jsRoll, ABIL, rate) -> { refJoint, replayPlan, done }. rate > 0: costs compare rolls * rate * 2 + weighted
// chunks first (chunkRate; a chunk weighs 4 / 2 / 1 on a piece with chunkLean 0 / 1 (or none) / 2).
export const DRINK_COLUMNS = 8;

// Locked slots (openSlots, default 3; a sub in a slot opens it): the plan first opens (one Super Sea
// Snail each) the ones a goal ability needs (fixed: up to the last goal ability's slot; off: as many
// slots as goal abilities); the rest hold 'L': filled for done(), never rolled, slapped or scrubbed.
export function lockSlots(p, fixed) {
  let open = p.openSlots ?? 3;
  p.subs.forEach((s, i) => { if (s !== '' && open < i + 1) open = i + 1; });
  let need = 0;
  p.goal.forEach((g, i) => { if (g !== '') need = fixed ? i + 1 : need + 1; });
  const o2 = Math.max(open, need);
  return { open, unlocks: o2 - open, slots: p.subs.map((s, i) => (i >= o2 ? 'L' : s)) };
}

export function make(jsRoll, ABIL, rate = 0) {
  // Every slot filled ('L' = locked counts); fixed: slot i == goal[i] unless ""; off: goal multiset inside the slots.
  function done(slots, goal, fixed) {
    if (slots.some((s) => s === '')) return false;
    if (fixed) return goal.every((g, i) => g === '' || slots[i] === g);
    const left = [...slots];
    for (const g of goal) {
      if (g === '') continue;
      const j = left.indexOf(g);
      if (j < 0) return false;
      left.splice(j, 1);
    }
    return true;
  }
  // Costs: [rolls, columns, tickets, chunks, scrubs, weighted chunks] (a timeline: the first 3).
  const W = (p) => (p.chunkLean === 0 ? 4 : p.chunkLean === 2 ? 1 : 2);
  const key = (a) => a[0] * rate * 2 + (a[5] ?? 0);
  const less = (a, b) => {
    if (rate && key(a) !== key(b)) return key(a) < key(b);
    for (let i = 0; i < Math.min(a.length, 5); i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const next = (s) => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };

  // Every route of one piece alone within the horizon, on the full stock: a Map from its word
  // (the letters of its rolls: '-' plain, else the drink's index in ABIL as a char) to the
  // Pareto-minimal entries [chunks spent per stocked ability (order of `kinds`)..., scrubs] of
  // the routes with that word. Exhaustive over rolls (any letter with stock), slaps (any stocked
  // ability, any filled slot or the first empty one) and scrubs, memoized per (seed steps, slots,
  // chunks left); a piece stops when done. Returns {kinds, map}.
  function routes(p, opts, stock) {
    const H = opts.horizon, seeds = [p.seed >>> 0];
    for (let i = 0; i < H; i++) seeds.push(next(seeds.at(-1)));
    const letters = [null, ...(opts.drinks ? ABIL.filter((a) => (stock.drinks?.[a] ?? 0) > 0) : [])];
    const kinds = opts.chunks ? ABIL.filter((a) => (stock.chunks?.[a] ?? 0) >= 10) : [];
    const K = kinds.length, memo = new Map();
    const le = (x, y) => { for (let i = 0; i <= K; i++) if (x[i] > y[i]) return false; return true; };
    const put = (out, w, e) => {
      const list = out.get(w);
      if (!list) { out.set(w, [e]); return; }
      for (const x of list) if (le(x, e)) return;
      out.set(w, list.filter((x) => !le(e, x)).concat([e]));
    };
    const go = (t, slots, c) => {
      const key = `${t}|${slots}|${c}`;
      if (memo.has(key)) return memo.get(key);
      const out = new Map();
      if (done(slots, p.goal, opts.fixed)) { out.set('', [new Array(K + 1).fill(0)]); memo.set(key, out); return out; }
      const fe = slots.indexOf('');
      if (fe >= 0) {
        for (const d of letters) {
          const [, a, hit] = jsRoll(seeds[t], p.brand, d);
          const n = d === null || hit ? 1 : 2;
          if (t + n > H) continue;
          const s2 = [...slots]; s2[fe] = a;
          const ch = d === null ? '-' : String.fromCharCode(97 + ABIL.indexOf(d));
          for (const [w, list] of go(t + n, s2, c)) for (const e of list) put(out, ch + w, e);
        }
      }
      for (let s = 0; s < 3; s++) {
        if ((slots[s] === '' && s !== fe) || slots[s] === 'L') continue;
        for (let k = 0; k < K; k++) {
          const a = kinds[k];
          if (slots[s] === a) continue;
          const cost = 10 * (1 + slots.filter((x, j) => j !== s && x === a).length);
          if (c[k] < cost) continue;
          if (p.maxChunks != null && c0 - c.reduce((x, y) => x + y, 0) + cost > p.maxChunks) continue;   // the piece's own cap (maxChunks)
          const s2 = [...slots]; s2[s] = a;
          const c2 = [...c]; c2[k] -= cost;
          for (const [w, list] of go(t, s2, c2)) for (const e of list) { const e2 = [...e]; e2[k] += cost; put(out, w, e2); }
        }
      }
      if (slots.some((x) => x !== '' && x !== 'L')) for (const [w, list] of go(t, slots.map((x) => (x === 'L' ? 'L' : '')), c)) for (const e of list) { const e2 = [...e]; e2[K]++; put(out, w, e2); }
      memo.set(key, out);
      return out;
    };
    const c0 = kinds.reduce((x, a) => x + stock.chunks[a], 0);
    return { kinds, map: go(0, lockSlots(p, opts.fixed).slots, kinds.map((a) => stock.chunks[a])) };
  }

  // Cheapest [rolls, columns, tickets] timeline holding each word as one lane's rolls, or null.
  // Column by column: outside a phase a column is plain (lanes whose next letter is plain roll)
  // or starts a phase (a ticket); inside one every roll is its drink and a column may pass idle.
  function timeline(words, drinks) {
    const memo = new Map(), n = words.length;
    const go = (pos, pd, pl, tk) => {
      if (pos.every((x, i) => x === words[i].length)) return [0, 0, 0];
      const key = `${pos}|${pd}|${pl}|${tk}`;
      if (memo.has(key)) return memo.get(key);
      let best = null;
      const offer = (step, rest) => { if (rest === null) return; const x = rest.map((v, i) => v + step[i]); if (!best || less(x, best)) best = x; };
      const kinds = pl > 0 ? [pd] : ['-', ...Object.keys(drinks).filter((ch) => (tk.split(ch).length - 1) < drinks[ch])];
      for (const k of kinds) {
        for (let mask = pl > 0 ? 0 : 1; mask < 1 << n; mask++) {
          if (words.some((w, i) => (mask >> i) & 1 && w[pos[i]] !== k)) continue;
          const p2 = pos.map((x, i) => x + ((mask >> i) & 1));
          const r = mask ? 1 : 0;
          if (pl > 0) offer([r, 1, 0], go(p2, pl > 1 ? pd : null, pl - 1, tk));
          else if (k === '-') offer([r, 1, 0], go(p2, null, 0, tk));
          else offer([r, 1, 1], go(p2, k, DRINK_COLUMNS - 1, tk + k));
        }
      }
      memo.set(key, best);
      return best;
    };
    return go(words.map(() => 0), null, 0, '');
  }

  // Cheapest [rolls, columns, tickets, chunks, scrubs, weighted chunks] for the pieces together, or null: every
  // pair of routes (one per piece) whose chunks fit the stock, on its cheapest timeline.
  const cache = new Map();  // the last few pieces' routes (refJoint runs alone, then together)
  const cached = (p, opts, stock) => {
    const k = JSON.stringify([p, opts, stock]);
    if (!cache.has(k)) { if (cache.size > 8) cache.clear(); cache.set(k, routes(p, opts, stock)); }
    return cache.get(k);
  };
  function refJoint(pieces, opts, stock) {
    if (!pieces.length) return [0, 0, 0, 0, 0, 0];
    const rs = pieces.map((p) => cached(p, opts, stock)), kinds = rs[0].kinds, K = kinds.length;
    const all = rs.map((r) => [...r.map].sort((x, y) => x[0].length - y[0].length));
    if (all.some((r) => r.length === 0)) return null;
    const drinks = {};
    for (const [a, k] of Object.entries(stock.drinks ?? {})) if (opts.drinks && k > 0) drinks[String.fromCharCode(97 + ABIL.indexOf(a))] = k;
    let best = null;
    const pickAll = (i, words, spent, tl, wch) => {
      if (i === pieces.length) {
        const x = [...tl, spent.slice(0, K).reduce((a, b) => a + b, 0), spent[K], wch];
        if (!best || less(x, best)) best = x;
        return;
      }
      for (const [w, list] of all[i]) {
        const ws = [...words, w];
        const most = Math.max(...ws.map((v) => v.length));  // no fewer rolls than its longest word, any chunks
        if (best && (rate ? most * rate * 2 > key(best) : most > best[0])) break;
        const t = i === pieces.length - 1 ? timeline(ws, drinks) : [0, 0, 0];
        if (t === null || (best && less(best, [...t, 0, 0]))) continue;
        for (const e of list) {
          const sp = spent.map((v, k) => v + e[k]), w2 = wch + e.slice(0, K).reduce((x, y) => x + y, 0) * W(pieces[i]);
          if (kinds.every((a, k) => sp[k] <= stock.chunks[a]) && (stock.budget == null || sp.slice(0, K).reduce((x, y) => x + y, 0) <= stock.budget)) pickAll(i + 1, ws, sp, t, w2);   // budget: the plan's chunks in all
        }
      }
    };
    pickAll(0, [], new Array(K + 1).fill(0), null, 0);
    return best;
  }

  // Replays a plan reply against its request; returns an error string or null.
  function replayPlan(req, rep) {
    if (!rep.ok) return 'not ok: ' + rep.error;
    const chunks = { ...(req.chunks ?? {}) }, drinks = { ...(req.drinks ?? {}) };
    const tot = { chunks: 0, scrubs: 0, snails: 0 };
    const colState = new Map();  // column -> drink (null = plain)
    if (rep.lanes.length !== req.pieces.length) return 'lane count';
    for (let L = 0; L < req.pieces.length; L++) {
      const p = req.pieces[L], lane = rep.lanes[L], steps = lane.steps;
      if (lane.row !== p.row) return `lane ${L} row`;
      const unreach = rep.unreachable.includes(L);
      if (unreach) {
        if (steps.length) return `lane ${L} unreachable but has steps`;
        const want = (req.from ?? 0) + req.horizon;
        if (lane.searchedTo !== want) return `lane ${L} searchedTo ${lane.searchedTo} want ${want}`;
        continue;
      }
      if (lane.searchedTo !== undefined) return `lane ${L} searchedTo on a planned lane`;
      let seed = p.seed >>> 0, t = 0, rolls = 0, prevKey = -Infinity, lastRoll = -1, rid = 0;
      // from[slot] = id of the roll in it; rollStep[id] = its step; burned = ids scrubbed or chunked over
      const lk = lockSlots(p, req.fixedOrder);
      const slots = p.subs.map((s, i) => (i >= lk.open ? 'L' : s)), from = [-1, -1, -1], burned = new Set(), rollStep = [];
      let unlocks = 0;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (!(s.key > prevKey)) return `lane ${L} step ${i} key not increasing`;
        prevKey = s.key;
        if (s.k === 'roll' || s.k === 'drink') {
          // times = N burn rolls in columns key..key+N-1; between them a full piece is scrubbed
          const times = s.times ?? 1;
          if (!(Number.isInteger(times) && times >= 1)) return `lane ${L} step ${i} times`;
          if (s.times !== undefined && (times < 2 || !s.burn)) return `lane ${L} step ${i} times on a kept roll`;
          const d = s.k === 'drink' ? s.d : null;
          if (d !== null && !req.useDrinks) return `lane ${L} drink with drinks off`;
          if (s.k === 'drink' && !ABIL.includes(d)) return `lane ${L} step ${i} drink without d`;
          if (!Number.isInteger(s.key) || s.key < 1) return `lane ${L} roll key not a column`;
          let implied = 0, a = null;
          for (let j = 0; j < times; j++) {
            if (j > 0 && !slots.includes('')) {
              for (let k = 0; k < 3; k++) { if (from[k] >= 0) burned.add(from[k]); if (slots[k] !== 'L') slots[k] = ''; from[k] = -1; }
              implied++; tot.scrubs++;
            }
            const fe = slots.indexOf('');
            if (fe < 0) return `lane ${L} step ${i} rolls a full piece`;
            const r3 = jsRoll(seed, p.brand, d);
            a = r3[1];
            t += d === null || r3[2] ? 1 : 2; seed = r3[0];
            slots[fe] = a; from[fe] = rid; rollStep[rid++] = i; rolls++; lastRoll = fe;
            const col = s.key + j, cs = colState.get(col);
            if (cs !== undefined && cs !== d) return `column ${col} mixes drink states`;
            colState.set(col, d);
          }
          if (times > 1) prevKey = s.key + times - 1;
          if (times > 1 && s.scrubs !== implied) return `lane ${L} step ${i} scrubs ${s.scrubs} want ${implied}`;
          if (a !== s.a) return `lane ${L} step ${i} rolled ${a}, plan says ${s.a}`;
          if (s.roll !== rolls) return `lane ${L} step ${i} roll count`;
        } else if (s.k === 'slap') {
          if (!req.useChunks) return `lane ${L} slap with chunks off`;
          const k = s.slot - 1;
          if (!(k >= 0 && k < 3) || (slots[k] === '' && k !== slots.indexOf('')) || slots[k] === 'L') return `lane ${L} slap slot ${s.slot}`;
          const cost = 10 * (1 + slots.filter((x, j) => j !== k && x === s.a).length);
          if (s.cost !== cost) return `lane ${L} slap cost ${s.cost} want ${cost}`;
          if (!((chunks[s.a] ?? 0) >= cost)) return `lane ${L} slap without stock`;
          if (s.sameColumn !== (k === lastRoll)) return `lane ${L} sameColumn`;
          chunks[s.a] -= cost; tot.chunks += cost;
          if (from[k] >= 0) burned.add(from[k]);
          slots[k] = s.a; from[k] = -1;
        } else if (s.k === 'unlock') {
          // one star upgrade opens the next locked slot, before the lane's first roll
          if (s.slot !== slots.indexOf('L') + 1 || s.slot < 2) return `lane ${L} step ${i} unlocks slot ${s.slot}`;
          if (rolls > 0) return `lane ${L} step ${i} unlock after a roll`;
          slots[s.slot - 1] = ''; unlocks++; tot.snails++;
        } else if (s.k === 'scrub') {
          for (let k = 0; k < 3; k++) { if (from[k] >= 0) burned.add(from[k]); if (slots[k] !== 'L') slots[k] = ''; from[k] = -1; }
          tot.scrubs++; lastRoll = -1;
        } else return `lane ${L} step kind ${s.k}`;
        if (t > (req.from ?? 0) + req.horizon) return `lane ${L} past the horizon`;
      }
      // one piece looks past from only; 2-3 pieces plan from 0 (lanes found within from keep their routes)
      if (req.pieces.length === 1 && (req.from ?? 0) > 0 && t <= req.from) return `lane ${L} ends at ${t}, within from`;
      for (let id = 0; id < rollStep.length; id++)
        if (burned.has(id) !== !!steps[rollStep[id]].burn) return `lane ${L} step ${rollStep[id]} burn flag`;
      if (!done(slots, p.goal, req.fixedOrder)) return `lane ${L} ends at ${slots} not ${p.goal}`;
      if (unlocks !== lk.unlocks) return `lane ${L} unlocks ${unlocks} want ${lk.unlocks}`;
    }
    // Phases: a drink column outside a phase starts one (a ticket) covering DRINK_COLUMNS columns,
    // and every roll column inside it must be that drink.
    const cols = [...colState.keys()].sort((a, b) => a - b);
    let ph = null, tickets = 0;
    for (const c of cols) {
      const x = colState.get(c);
      if (ph && c < ph.start + DRINK_COLUMNS) {
        if (x !== ph.d) return `column ${c} (${x ?? 'plain'}) inside the ${ph.d} phase from ${ph.start}`;
        continue;
      }
      ph = null;
      if (x === null) continue;
      if (!(drinks[x] > 0)) return `column ${c}: no ticket left for ${x}`;
      drinks[x]--; tickets++;
      ph = { d: x, start: c };
    }
    const last = cols.length ? cols.at(-1) : 0;
    const want = { rolls: cols.length, battles: Math.ceil((last * 23) / 10), tickets, ...tot };
    for (const k of Object.keys(want)) if (rep.totals[k] !== want[k]) return `totals.${k} ${rep.totals[k]} want ${want[k]}`;
    return null;
  }
  return { refJoint, replayPlan, done, routes };
}
