// Core tests: node tests/core/run_tests.mjs  (needs core/dist from `bash core/build.sh`)
// 1 rolls vs Leanny's JS (tests/js_reference.cjs) and the Python reference; 2 startSeed vs pymmh3 and
// murmur3's published vectors; 3 recovery and refine vs a brute force; 4 bad input; 5 timing;
// 6 planner (tests/core/plan_tests.mjs): 1-2 pieces vs a brute-force joint reference, hand cases, replay, bad input.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const createCore = (await import(new URL('../../core/dist/core.mjs', import.meta.url))).default;
const M = await createCore();

function callRaw(text) {
  const p = M.stringToNewUTF8(text);
  const r = M._st_call(p);
  M._free(p);
  return M.UTF8ToString(r);
}
const call = (obj) => JSON.parse(callRaw(JSON.stringify(obj)));

let failures = 0;
const results = [];
function section(name, pass, total, extra = '') {
  results.push(`RESULT ${name}: ${pass}/${total} pass${extra ? ' ' + extra : ''}`);
  if (pass !== total) failures += total - pass;
  console.log(results.at(-1));
}
function fail(msg) {
  if (fail.count++ < 20) console.log('  FAIL ' + msg);
}
fail.count = 0;

// ---- reference roll math in JS (same algorithm as s3seed/seedmath.py), for brute-force checks
const traits = JSON.parse(readFileSync(join(ROOT, 'data', 'BrandTraitsParam.raw.json'), 'utf8'));
const ABIL = ['MainInk_Save', 'SubInk_Save', 'InkRecovery_Up', 'HumanMove_Up', 'SquidMove_Up',
  'SpecialIncrease_Up', 'RespawnSpecialGauge_Save', 'SpecialSpec_Up', 'RespawnTime_Save',
  'JumpTime_Save', 'SubSpec_Up', 'OpInkEffect_Reduction', 'SubEffect_Reduction', 'Action_Up'];
const next = (s) => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
function lut(brand, exclude) {
  const t = traits.Traits[brand] ?? traits.Traits.None;
  const [wu, wn, ws] = traits.SkillEasilyToGetParam;
  const out = [];
  for (const a of ABIL) {
    if (a === exclude) continue;
    const w = t.UnusualGearSkill === a ? wu : t.UsualGearSkill === a ? ws : wn;
    for (let i = 0; i < w; i++) out.push(a);
  }
  return out;
}
function jsRoll(seed, brand, drink) {
  seed = next(seed);
  if (drink) {
    if (seed % 100 <= 29) return [seed, drink, true];
    seed = next(seed);
    const l = lut(brand, drink);
    return [seed, l[seed % l.length], false];
  }
  const l = lut(brand, null);
  return [seed, l[seed % l.length], false];
}
function runMatches(seed, brand, observed) {
  for (const o of observed) {
    const [s, a] = jsRoll(seed, brand, o.drink);
    if (o.a !== null && a !== o.a) return null;
    seed = s;
  }
  return seed;
}

// deterministic RNG for the JS-side cases
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x5EED);
const randInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const randU32 = () => Math.floor(rnd() * 4294967296) >>> 0;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// ---- 1. rolls
{
  let pass = 0, total = 0;
  const js = spawnSync(process.execPath, [join(ROOT, 'tests', 'js_reference.cjs')], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const vec = JSON.parse(js.stdout);
  for (const [s, b, d, ns, ab, hit] of vec) {
    total++;
    const r = call({ fn: 'rolls', seed: s >>> 0, brand: b, drink: d === 'None' ? null : d, n: 1 });
    const x = r.ok && r.rolls[0];
    if (x && x.seed === ns && x.ability === ab && x.drink_hit === hit && x.n === 1) pass++;
    else fail(`js vector ${JSON.stringify([s, b, d])} -> ${JSON.stringify(r)}`);
  }
  section('rolls vs Leanny JS (3000)', pass, total);

  const py = existsSync(join(ROOT, '.venv', 'Scripts', 'python.exe')) ? join(ROOT, '.venv', 'Scripts', 'python.exe')
    : existsSync(join(ROOT, '.venv', 'bin', 'python')) ? join(ROOT, '.venv', 'bin', 'python') : 'python';
  const gen = spawnSync(py, [join(ROOT, 'tests', 'core', 'gen_vectors.py')], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (gen.status !== 0) { console.log(gen.stderr); process.exit(2); }
  globalThis.PYVEC = JSON.parse(gen.stdout);
  pass = 0; total = 0;
  for (const c of PYVEC.rolls) {
    total++;
    const r = call({ fn: 'rolls', seed: c.seed, brand: c.brand, drink: c.drink, n: c.n });
    if (r.ok && JSON.stringify(r.rolls) === JSON.stringify(c.expect)) pass++;
    else fail(`py vector ${JSON.stringify(c)} -> ${JSON.stringify(r)}`);
  }
  section('rolls vs seedmath.py (10000)', pass, total);
}

// ---- 2. startSeed
{
  let pass = 0, total = 0;
  for (const c of PYVEC.startSeed) {
    total++;
    const r = call({ fn: 'startSeed', playerKey: c.playerKey, slot: c.slot, gearId: c.gearId });
    if (r.ok && r.seed === c.expect) pass++;
    else fail(`startSeed ${JSON.stringify(c)} -> ${JSON.stringify(r)}`);
  }
  section('startSeed vs pymmh3 (1000)', pass, total);

  // murmur3_x86_32 published test vectors (text, seed, hash)
  const pub = [
    ['', 0, 0], ['', 1, 0x514E28B7], ['', 0xffffffff, 0x81F16F39],
    ['\0\0\0\0', 0, 0x2362F9DE], ['\0\0\0', 0, 0x85F0B427], ['\0\0', 0, 0x30F4C306], ['\0', 0, 0x514E28B7],
    ['!Ce', 0, 0x7E4A8634], ['!C', 0, 0xA0F7B07A], ['!', 0, 0x72661CF4],
    ['Hello, world!', 0x9747b28c, 0x24884CBA], ['π'.repeat(8), 0x9747b28c, 0xD58063C1],
    ['a', 0x9747b28c, 0x7FA09EA6], ['aa', 0x9747b28c, 0x5D211726], ['aaa', 0x9747b28c, 0x283E0130],
    ['aaaa', 0x9747b28c, 0x5A97808A], ['abc', 0x9747b28c, 0xC84A62DD], ['abcd', 0x9747b28c, 0xF0478627],
    ['The quick brown fox jumps over the lazy dog', 0x9747b28c, 0x2FA826CD],
  ];
  pass = 0; total = 0;
  for (const [text, seed, h] of pub) {
    total++;
    const r = call({ fn: '_murmur3', text, seed });
    if (r.ok && r.hash === h) pass++;
    else fail(`murmur3 ${JSON.stringify([text, seed])} want ${h} -> ${JSON.stringify(r)}`);
  }
  section('murmur3 published vectors', pass, total);
}

// ---- 3. recovery
{
  let pass = 0, total = 0;
  const brands = Object.keys(traits.Traits);
  const bruteForce = (start, brand, observed, maxSteps) => {
    const out = [], seen = new Set();
    let s = start;
    for (let k = 0; k <= maxSteps; k++) {
      const after = runMatches(s, brand, observed);
      if (after !== null && !seen.has(after)) { seen.add(after); out.push({ skippedSteps: k, seed: after }); }
      s = next(s);
    }
    return out;
  };
  // Roll from seed with drinks; returns {observed (with some a masked), end}.
  const makeRun = (seed, brand, count, maskP) => {
    const observed = [];
    let runFirst = null;
    for (let i = 0; i < count; i++) {
      const drink = rnd() < 0.4 ? pick(ABIL) : null;
      const [s, a] = jsRoll(seed, brand, drink);
      if (i === 0) runFirst = a;
      observed.push({ a: rnd() < maskP ? null : a, drink });
      seed = s;
    }
    if (observed.every((o) => o.a === null)) observed[0].a = runFirst;  // the core needs one seen ability
    return { observed, end: seed };
  };

  let lockedCases = 0, refinedToOne = 0, refineRounds = 0;
  for (let c = 0; c < 200; c++) {
    total++;
    const brand = pick(brands), start = randU32(), maxSteps = 10000, k = randInt(0, maxSteps);
    let s = start;
    for (let i = 0; i < k; i++) s = next(s);
    const { observed, end } = makeRun(s, brand, randInt(2, 6), 0.2);
    const r = call({ fn: 'recover', start, brand, observed, maxSteps });
    const want = bruteForce(start, brand, observed, maxSteps);
    let ok = r.ok && r.count === want.length && r.candidates.length === want.length &&
      JSON.stringify(r.candidates) === JSON.stringify(want) && r.locked === (want.length === 1) &&
      r.candidates.some((x) => x.skippedSteps <= k && x.seed === end);  // deduped: an earlier k may reach the same seed
    if (r.locked) lockedCases++;
    // refine until one is left
    let cands = r.ok ? r.candidates : [], trueSeed = end, rounds = 0;
    while (ok && cands.length > 1 && rounds < 20) {
      rounds++;
      const run = makeRun(trueSeed, brand, randInt(1, 3), 0.1);
      trueSeed = run.end;
      const rr = call({ fn: 'refine', candidates: cands, brand, observed: run.observed });
      const seen = new Set(), wantR = [];
      for (const x of cands) {
        const a = runMatches(x.seed, brand, run.observed);
        if (a !== null && !seen.has(a)) { seen.add(a); wantR.push({ skippedSteps: 0, seed: a }); }
      }
      ok = rr.ok && JSON.stringify(rr.candidates) === JSON.stringify(wantR) && rr.count === wantR.length &&
        rr.locked === (wantR.length === 1) && rr.candidates.some((x) => x.seed === trueSeed);
      cands = rr.ok ? rr.candidates : [];
    }
    refineRounds += rounds;
    if (ok && cands.length === 1 && cands[0].seed === trueSeed) refinedToOne++;
    else if (ok) { ok = false; fail(`case ${c}: refine never narrowed to the true seed (${cands.length} left)`); }
    if (ok) pass++;
    else fail(`recover case ${c} brand=${brand} start=${start} k=${k} obs=${JSON.stringify(observed)} -> count ${r.count}, want ${want.length}`);
  }
  section('recover + refine vs brute force (200 cases)', pass, total,
    `(${lockedCases} locked at once, all ${refinedToOne} refined to the true seed, ${(refineRounds / 200).toFixed(1)} refine calls/case)`);

  // refine accepts bare seeds too, and drops repeated seeds
  pass = 0; total = 0;
  {
    total++;
    const s0 = randU32(), brand = 'B03';
    const { observed, end } = makeRun(s0, brand, 3, 0);
    const r = call({ fn: 'refine', candidates: [s0, s0, { seed: s0, skippedSteps: 7 }], brand, observed });
    if (r.ok && r.count === 1 && r.locked && r.candidates[0].seed === end && r.candidates[0].skippedSteps === 0) pass++;
    else fail('refine bare seeds/dedupe ' + JSON.stringify(r));
    total++;
    const e = call({ fn: 'refine', candidates: [], brand, observed });
    if (e.ok && e.count === 0 && !e.locked) pass++; else fail('refine empty ' + JSON.stringify(e));
  }
  // maxSteps: inclusive bound, default 10000, cap 2500000
  {
    const brand = 'B00', start = 123456789;
    const at = (k) => { let s = start; for (let i = 0; i < k; i++) s = next(s); return s; };
    const obsAt = (k, n) => makeRun(at(k), brand, n, 0);
    const checkK = (k, maxSteps, expectFound) => {
      total++;
      const { observed, end } = obsAt(k, 6);
      const req = { fn: 'recover', start, brand, observed };
      if (maxSteps !== undefined) req.maxSteps = maxSteps;
      const r = call(req);
      const lim = maxSteps ?? 10000;
      const found = r.ok && r.candidates.some((x) => x.skippedSteps === k && x.seed === end);
      if (r.ok && found === expectFound && r.candidates.every((x) => x.skippedSteps <= lim)) pass++;
      else fail(`maxSteps k=${k} max=${maxSteps} -> found=${found} ${JSON.stringify(r).slice(0, 200)}`);
    };
    checkK(500, 500, true);
    checkK(501, 500, false);
    checkK(0, 0, true);
    checkK(10000, undefined, true);
    checkK(10001, undefined, false);
    total++;
    const big = call({ fn: 'recover', start, brand, observed: [{ a: 'SubInk_Save', drink: null }], maxSteps: 2500001 });
    if (!big.ok) pass++; else fail('maxSteps 2500001 accepted');
  }
  section('refine forms + maxSteps bounds', pass, total);
}

// ---- 4. bad input
{
  let pass = 0, total = 0;
  const obs = [{ a: 'SquidMove_Up', drink: null }];
  const bad = [
    '', ' ', 'null', '[]', '"x"', '42', '{', '{"fn":', '{"fn":"rolls"', '{"fn":"rolls",}', '{fn:"rolls"}',
    '{"fn":"rolls"} x', '{"fn":"\\x"}', '{"fn":"\\ud800"}', '{"fn":"\\udc00x"}', '{"fn":"\\u12"}', '{"fn":"a\u0001"}',
    '{"fn":"rolls","seed":01,"brand":"B00","n":1}', '{"fn":"rolls","seed":1.,"brand":"B00","n":1}',
    '{"fn":"rolls","seed":-,"brand":"B00","n":1}', '{"fn":"rolls","seed":NaN,"brand":"B00","n":1}',
    '{"fn":"rolls","seed":0x10,"brand":"B00","n":1}', '{"fn":"rolls","seed":1e400,"brand":"B00","n":1}',
    '[' .repeat(100000), '{"a":'.repeat(5000), '{"fn":"rolls","seed":tru,"brand":"B00","n":1}',
    '{"fn":"recover","start":1,"brand":"B00","observed":[' + '{"a":null},'.repeat(1001) + '{"a":null}]}',
  ];
  const badObj = [
    {}, { fn: 1 }, { fn: 'nope' }, { fn: 'plan' },
    { fn: 'startSeed' }, { fn: 'startSeed', playerKey: 'u-x', slot: 'hat', gearId: 1 },
    { fn: 'startSeed', playerKey: '', slot: 'head', gearId: 1 }, { fn: 'startSeed', playerKey: 5, slot: 'head', gearId: 1 },
    { fn: 'startSeed', playerKey: 'u-x', slot: 'head' }, { fn: 'startSeed', playerKey: 'u-x', slot: 'head', gearId: -1 },
    { fn: 'startSeed', playerKey: 'u-x', slot: 'head', gearId: '12' }, { fn: 'startSeed', playerKey: 'x'.repeat(300), slot: 'head', gearId: 1 },
    { fn: 'rolls', brand: 'B00', n: 1 }, { fn: 'rolls', seed: 1, n: 1 }, { fn: 'rolls', seed: 1, brand: 'B00' },
    { fn: 'rolls', seed: -1, brand: 'B00', n: 1 }, { fn: 'rolls', seed: 4294967296, brand: 'B00', n: 1 },
    { fn: 'rolls', seed: 1.5, brand: 'B00', n: 1 }, { fn: 'rolls', seed: '1', brand: 'B00', n: 1 },
    { fn: 'rolls', seed: 1, brand: 'Zink', n: 1 }, { fn: 'rolls', seed: 1, brand: 'B1', n: 1 }, { fn: 'rolls', seed: 1, brand: 3, n: 1 },
    { fn: 'rolls', seed: 1, brand: 'B00', n: 0 }, { fn: 'rolls', seed: 1, brand: 'B00', n: 1001 },
    { fn: 'rolls', seed: 1, brand: 'B00', n: 1e12 }, { fn: 'rolls', seed: 1, brand: 'B00', n: 2 ** 53 },
    { fn: 'rolls', seed: 1, brand: 'B00', n: 1, drink: 'None' }, { fn: 'rolls', seed: 1, brand: 'B00', n: 1, drink: '' },
    { fn: 'rolls', seed: 1, brand: 'B00', n: 1, drink: 7 },
    { fn: 'recover', brand: 'B00', observed: obs }, { fn: 'recover', start: 1, observed: obs }, { fn: 'recover', start: 1, brand: 'B00' },
    { fn: 'recover', start: 1, brand: 'B00', observed: [] }, { fn: 'recover', start: 1, brand: 'B00', observed: {} },
    { fn: 'recover', start: 1, brand: 'B00', observed: [1] }, { fn: 'recover', start: 1, brand: 'B00', observed: [{}] },
    { fn: 'recover', start: 1, brand: 'B00', observed: [{ a: 'Ninja_Squid', drink: null }] },
    { fn: 'recover', start: 1, brand: 'B00', observed: [{ a: '', drink: null }] },
    { fn: 'recover', start: 1, brand: 'B00', observed: [{ a: null, drink: 'Comeback' }] },
    { fn: 'recover', start: 1, brand: 'B00', observed: obs, maxSteps: -1 },
    { fn: 'recover', start: 1, brand: 'B00', observed: obs, maxSteps: 1e9 }, { fn: 'recover', start: 1, brand: 'B00', observed: obs, maxSteps: '5' },
    { fn: 'refine', brand: 'B00', observed: obs }, { fn: 'refine', candidates: 5, brand: 'B00', observed: obs },
    { fn: 'refine', candidates: ['1'], brand: 'B00', observed: obs }, { fn: 'refine', candidates: [{ skippedSteps: 1 }], brand: 'B00', observed: obs },
    { fn: 'refine', candidates: [-1], brand: 'B00', observed: obs }, { fn: 'refine', candidates: [1], observed: obs },
    { fn: 'refine', candidates: [1], brand: 'B00' }, { fn: 'refine', candidates: [1], brand: 'B00', observed: [] },
  ];
  const isErr = (txt) => { try { const r = JSON.parse(txt); return r.ok === false && typeof r.error === 'string' && r.error.length > 0; } catch { return false; } };
  for (const t of bad) { total++; const out = callRaw(t); if (isErr(out)) pass++; else fail(`raw ${JSON.stringify(t.slice(0, 60))} -> ${out.slice(0, 120)}`); }
  for (const o of badObj) { total++; const out = callRaw(JSON.stringify(o)); if (isErr(out)) pass++; else fail(`${JSON.stringify(o).slice(0, 100)} -> ${out.slice(0, 120)}`); }
  total++;
  { const out = M.UTF8ToString(M._st_call(0)); if (isErr(out)) pass++; else fail('null pointer -> ' + out); }
  // observed with no seen ability at all
  total++;
  { const r = call({ fn: 'recover', start: 1, brand: 'B00', observed: [{ a: null, drink: null }, { a: null, drink: 'SubInk_Save' }] });
    if (r.ok === false && r.error === 'need at least one seen ability') pass++; else fail('all-unknown observed ' + JSON.stringify(r).slice(0, 100)); }
  total++;
  { const r = call({ fn: 'refine', candidates: [1, 2], brand: 'B00', observed: [{ a: null }] });
    if (r.ok === false && r.error === 'need at least one seen ability') pass++; else fail('refine all-unknown ' + JSON.stringify(r).slice(0, 100)); }
  // things that must be accepted: unknown well-formed brand -> None row, missing drink = null, JSON escapes in keys
  const good = [
    [{ fn: 'rolls', seed: 7, brand: 'B42', n: 3 }, { fn: 'rolls', seed: 7, brand: 'None', n: 3 }],
    [{ fn: 'rolls', seed: 7, brand: 'B03', n: 3 }, { fn: 'rolls', seed: 7, brand: 'B03', drink: null, n: 3 }],
    [{ fn: 'rolls', seed: 4294967295, brand: 'B03', n: 1000 }, null],
    ['{"fn":"rolls","seed":7e0,"brand":"B\\u0030\\u0033","n":3.0}', { fn: 'rolls', seed: 7, brand: 'B03', n: 3 }],
  ];
  for (const [a, b] of good) {
    total++;
    const ra = JSON.parse(typeof a === 'string' ? callRaw(a) : callRaw(JSON.stringify(a)));
    const ok = ra.ok && (b === null || JSON.stringify(ra) === JSON.stringify(call(b)));
    if (ok) pass++; else fail('should accept ' + JSON.stringify(a) + ' -> ' + JSON.stringify(ra).slice(0, 120));
  }
  // still alive and correct after all of that
  total++;
  { const r = call({ fn: 'rolls', seed: 1, brand: 'B00', n: 1 }); if (r.ok && r.rolls.length === 1) pass++; else fail('core broken after bad input'); }
  section('bad input gives ok:false, good edge input accepted', pass, total);
}

// ---- 5. timing
{
  const brand = 'B11', start = 3141592653;
  const at = (k) => { let s = start; for (let i = 0; i < k; i++) s = next(s); return s; };
  const time = (req, reps) => {
    const ms = [];
    let r;
    for (let i = 0; i < reps; i++) { const t0 = performance.now(); r = call(req); ms.push(performance.now() - t0); }
    ms.sort((a, b) => a - b);
    return [ms[Math.floor(ms.length / 2)], r];
  };
  let pass = 0, total = 0;
  const lines = [];
  for (const [maxSteps, k, reps] of [[10000, 9000, 21], [2500000, 2400000, 5]]) {
    total++;
    let s = at(k);
    const observed = [];
    for (let i = 0; i < 3; i++) { const drink = i === 1 ? 'SubInk_Save' : null; const [ns, a] = jsRoll(s, brand, drink); observed.push({ a, drink }); s = ns; }
    const [ms, r] = time({ fn: 'recover', start, brand, observed, maxSteps }, reps);
    if (r.ok && r.candidates.some((x) => x.skippedSteps <= k && x.seed === s)) pass++; else fail(`timing run ${maxSteps}`);
    lines.push(`recover ${maxSteps} steps, 3 rolls: ${ms.toFixed(1)} ms (${r.count} candidates)`);
  }
  total++;
  {
    const [end1, a] = jsRoll(at(2400000), brand, null);
    const [ms, r] = time({ fn: 'recover', start, brand, observed: [{ a, drink: null }], maxSteps: 2500000 }, 1);
    if (r.ok && r.count > 10000 && r.candidates.some((x) => x.skippedSteps <= 2400000 && x.seed === end1)) pass++; else fail('one-roll 2.5M');
    lines.push(`recover 2500000 steps, 1 known roll (many match): ${ms.toFixed(0)} ms incl. JSON (${r.count} candidates)`);
  }
  for (const l of lines) console.log('  ' + l);
  section('timing', pass, total, '| ' + lines.join(' | '));
}

// ---- 6. planner (fn plan): tests/core/plan_tests.mjs
{
  const { planTests } = await import(new URL('./plan_tests.mjs', import.meta.url));
  await planTests({ call, jsRoll, ABIL, traits, rnd, randInt, randU32, pick, section, fail });
}

console.log(failures === 0 ? 'RESULT all: PASS' : `RESULT all: FAIL (${failures} failing)`);
process.exit(failures === 0 ? 0 : 1);
