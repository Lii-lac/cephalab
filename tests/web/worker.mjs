// The wasm core behind web/src/core/bridge.ts (a Web Worker): node tests/web/worker.mjs  (from the repo root)
// Serves tests/web/worker-fixture (a blank page that exposes the bridge) with Vite in dev mode, then from a production
// build (build/web-b4a, vite preview), and in Chromium checks every call against core.mjs loaded directly in Node.
// Options: --mode=dev | build | both (default both)
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../..");
const web = path.join(repo, "web"), fixture = path.join(here, "worker-fixture");
const need = createRequire(path.join(web, "package.json"));
const { chromium } = need("playwright");
const vite = await import(pathToFileURL(need.resolve("vite")).href);
const mode = process.argv.find(a => a.startsWith("--mode="))?.slice(7) ?? "both";

// ---- the reference: core.mjs straight in Node
const M = await (await import(pathToFileURL(path.join(repo, "core/dist/core.mjs")).href)).default();
const ref = req => {
  const p = M.stringToNewUTF8(JSON.stringify(req)); const r = M.UTF8ToString(M._st_call(p)); M._free(p);
  return JSON.parse(r);
};
const step = s => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };

let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`); if (!ok) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- cases (inputs fixed here, answers from the Node core)
const KEY = "u-aaaaaaaaaaaaaaaaaaaa";
const SEEDS = [{ playerKey: KEY, slot: "head", gearId: 1 }, { playerKey: KEY, slot: "clothes", gearId: 26000 },
  { playerKey: KEY, slot: "shoes", gearId: 2013 }, { playerKey: "u-bbbbbbbbbbbbbbbbbbbb", slot: "head", gearId: 20005 },
  { playerKey: "u-0123456789abcdefghij", slot: "clothes", gearId: 21013 }, { playerKey: "u-0123456789abcdefghij", slot: "shoes", gearId: 98765 }];
const ROLLS = [[123456789, "B03", null, 10], [1, "B03", "SquidMove_Up", 12], [4000000000, "B00", null, 25],
  [987654321, "B05", "InkRecovery_Up", 7], [55555, "B10", "SquidMove_Up", 40], [2718281828, "B99", null, 3], [42, "B03", "Action_Up", 20]];

// recover: a start seed, k seed steps skipped, then a run of rolls whose abilities are observed
function runCase(start, k, brand, n, drink) {
  let s = start; for (let i = 0; i < k; i++) s = step(s);
  const r = ref({ fn: "rolls", seed: s, brand, drink, n }).rolls;
  return { start, k, brand, observed: r.map(x => ({ a: x.ability, drink })), end: r.at(-1).seed, next: r.at(-1).seed };
}
const RECOVER = [runCase(777, 30, "B03", 6, null), runCase(31337, 200, "B00", 7, null), runCase(4000000001, 5, "B10", 6, null),
  runCase(8675309, 1000, "B03", 8, null), runCase(99, 0, "B05", 6, null)];

async function suite(label, url, browser) {
  console.log(`-- ${label} (${url})`);
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.bridge, null, { timeout: 30000 });
  const inPage = (fn, arg) => page.evaluate(fn, arg);
  const t = (n, ok, x) => check(`${label}: ${n}`, ok, x);

  // startSeed
  for (const c of SEEDS) {
    const got = await inPage(c => window.bridge.startSeed(c.playerKey, c.slot, c.gearId), c);
    t(`startSeed ${c.slot} ${c.gearId}`, same(got, ref({ fn: "startSeed", ...c })) && got.ok === true, `seed=${got.seed}`);
  }
  // rolls
  for (const [seed, brand, drink, n] of ROLLS) {
    const got = await inPage(a => window.bridge.rolls(...a), [seed, brand, drink, n]);
    t(`rolls ${brand} ${drink} x${n}`, same(got, ref({ fn: "rolls", seed, brand, drink, n })) && got.ok === true);
  }
  // recover finds the true seed; refine narrows candidates with a following run
  for (const c of RECOVER) {
    const got = await inPage(c => window.bridge.recover(c.start, c.brand, c.observed, 5000), c);
    const want = ref({ fn: "recover", start: c.start, brand: c.brand, observed: c.observed, maxSteps: 5000 });
    t(`recover start=${c.start} skip=${c.k}`, same(got, want) && got.candidates.some(x => x.seed === c.end && x.skippedSteps === c.k),
      `${got.count} candidate(s)`);
    const nx = runCase(c.end, 0, c.brand, 4, null);
    const rg = await inPage(a => window.bridge.refine(a.cands, a.brand, a.observed), { cands: got.candidates, brand: c.brand, observed: nx.observed });
    const rw = ref({ fn: "refine", candidates: got.candidates, brand: c.brand, observed: nx.observed });
    t(`refine after skip=${c.k}`, same(rg, rw) && rg.candidates.some(x => x.seed === nx.end));
  }
  // bad input comes back as ok:false, not a throw
  const bad = await inPage(() => window.bridge.startSeed("", "head", 1));
  t("bad input -> ok:false", bad.ok === false && typeof bad.error === "string");
  // calls in flight together are all answered (serialized in the worker)
  const many = await inPage(() => Promise.all([1, 2, 3, 4, 5].map(i => window.bridge.rolls(i, "B03", null, 5))));
  t("5 concurrent calls", many.every((r, i) => same(r, ref({ fn: "rolls", seed: i + 1, brand: "B03", drink: null, n: 5 }))));

  // cancel(): a pile of big recovers is stopped quickly, then the next call works on a fresh worker
  const c = RECOVER[0];
  const cx = await inPage(async c => {
    await window.bridge.startSeed("u-aaaaaaaaaaaaaaaaaaaa", "head", 1);             // warm: the worker is loaded
    const t0 = performance.now(), res = [];
    const jobs = Array.from({ length: 30 }, () => window.bridge.recover(c.start, c.brand, c.observed, 2500000).then(
      r => res.push("done:" + r.ok), e => res.push(String(e.message))));
    await new Promise(r => setTimeout(r, 10));
    const tc = performance.now();
    window.bridge.cancel();
    await Promise.all(jobs);
    const rejectMs = performance.now() - tc;
    const after = await window.bridge.startSeed("u-aaaaaaaaaaaaaaaaaaaa", "head", 1);
    const again = await window.bridge.recover(c.start, c.brand, c.observed, 5000);
    return { res, rejectMs, sinceStart: performance.now() - t0, after, again };
  }, c);
  t("cancel rejects the pending recovers", cx.res.some(x => x === "cancelled"), `(${cx.res.filter(x => x === "cancelled").length}/30 cancelled, ${cx.res.filter(x => x.startsWith("done")).length} finished first)`);
  t("cancel is quick", cx.rejectMs < 500, `(${cx.rejectMs.toFixed(0)} ms)`);
  t("next call after cancel works", same(cx.after, ref({ fn: "startSeed", ...SEEDS[0] })) && cx.again.candidates.some(x => x.seed === c.end));

  // plan: ok:true lanes (the core's, or the stub when the core says ok:false)
  const pin = { pieces: [{ row: "Hed_AMB000", brand: "B03", seed: 123, subs: ["SquidMove_Up", "", ""], goal: ["SquidMove_Up", "SquidMove_Up", "InkRecovery_Up"] }],
    chunks: { SquidMove_Up: 40 }, drinks: { SquidMove_Up: 2 }, fixedOrder: true, useChunks: true, useDrinks: true, horizon: 60, mock: { buildId: 5 } };
  const p = await inPage(i => window.bridge.plan(i), pin);
  t("plan returns ok:true lanes", p.ok === true && Array.isArray(p.lanes) && p.lanes.length === 1 && p.lanes[0].row === "Hed_AMB000",
    ref({ fn: "plan", ...pin, mock: undefined }).ok ? "(core)" : "(stub fallback)");
  const pn = await inPage(i => window.bridge.planNow(i), pin);
  t("planNow still works", pn.ok === true && pn.lanes.length === 1);

  t("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await page.close();
}

const browser = await chromium.launch();
try {
  if (mode !== "build") {
    const server = await vite.createServer({ configFile: path.join(web, "vite.config.ts"), root: fixture, logLevel: "warn",
      server: { port: 5175, strictPort: false, fs: { allow: [repo] } } });
    await server.listen();
    try { await suite("dev", server.resolvedUrls.local[0], browser); } finally { await server.close(); }
  }
  if (mode !== "dev") {
    const outDir = path.join(repo, "build", "web-b4a");
    await vite.build({ configFile: path.join(web, "vite.config.ts"), root: fixture, logLevel: "warn", build: { outDir, emptyOutDir: true } });
    const srv = await vite.preview({ configFile: path.join(web, "vite.config.ts"), root: fixture, logLevel: "warn",
      build: { outDir }, preview: { port: 4175, strictPort: false } });
    try { await suite("build", srv.resolvedUrls.local[0], browser); } finally { await srv.close(); }
  }
} catch (e) {
  check("harness ran", false, String(e?.stack ?? e));
} finally {
  await browser.close();
}
console.log(failures ? `FAILED: ${failures} check(s)` : "ALL PASS");
process.exit(failures ? 1 : 0);
