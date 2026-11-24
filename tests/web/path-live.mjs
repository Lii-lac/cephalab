// The Path screen plans from your real gear (web/src/path.ts + pieces.ts + the wasm core in a worker), against a mocked
// companion: /api/state and /api/events via page.route. Run from the repo root: node tests/web/path-live.mjs
// Proves: (1) a botbase snapshot draws the core's real lanes (compared with core.mjs run in Node), (2) a new snapshot
// replans in place, (3) an s3s piece with an ambiguous seed shows "N possible seeds, one more roll" and no steps, and a
// later snapshot with more rolls refines it to a locked seed and plans it, (4) a goal only reachable far ahead shows the
// searching widget, the nudge, then the route found by slicing, and a build change mid-search cancels it. PASS/FAIL lines, exit 1 on any failure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../.."), web = path.join(repo, "web");
const need = createRequire(path.join(web, "package.json"));
const { chromium } = need("playwright");
const { createServer } = await import(pathToFileURL(need.resolve("vite")).href);

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };

// ---- the reference core, in Node
const M = await (await import(pathToFileURL(path.join(repo, "core/dist/core.mjs")).href)).default();
const ref = req => { const p = M.stringToNewUTF8(JSON.stringify(req)); const r = M.UTF8ToString(M._st_call(p)); M._free(p); return JSON.parse(r); };
const step = s => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };

const S = "SquidMove_Up", MI = "MainInk_Save", R = "RespawnTime_Save";
const KEY = "u-aaaaaaaaaaaaaaaaaaaa";
const ROWS = { head: "Hed_CAP002", clothes: "Clt_TES001", shoes: "Shs_BOT003" };
const GOALS = { head: [S, "", ""], clothes: [R, "", ""], shoes: ["", "", ""] };
const BUILD = { id: 1, title: "Live test", modes: ["SZ"], weapon: "Shooter_Normal_00", set: ["head", "clothes", "shoes"].map(s => [ROWS[s], "", GOALS[s]]) };
const pc = (slot, gearId, subs, extra = {}) => ({ slot, gearId, row: ROWS[slot], brand: "B03", main: "", subs: [...subs, "", "", ""].slice(0, 3), ...extra });
const snap = (source, pieces) => ({ source, gameVersion: "11.0.0", playerKey: KEY, pieces, at: Date.now() });
const openOf = p => typeof p.rarity === "number" && p.rarity < 2 ? { openSlots: p.rarity + 1 } : {};   // pieces.ts openSlots, sent when < 3
const pin = (pieces, goals = GOALS) => ({ pieces: pieces.map(p => ({ row: p.row, brand: p.brand, seed: p.seed, subs: p.subs, goal: goals[p.slot], ...openOf(p) })),
  chunks: {}, drinks: {}, fixedOrder: true, useChunks: true, useDrinks: true, horizon: 200 });   // path.ts asks horizon 200 first
const UNREACH = "This goal can't be reached with these settings";
// what the screen should show for a plan (planned = the plan lane index of each build lane, -1 = a note lane): signature + notes
const expect = (out, planned, notes = {}) => ({
  sig: JSON.stringify(planned.map(i => i < 0 || out.unreachable.includes(i) ? null : { have: out.lanes[i].have.filter(h => h[0]).map(h => h[0]), steps: out.lanes[i].steps.filter((s, k, a) => !(s.k === "unlock" && a[k - 1]?.k === "unlock")).map(s => s.k === "scrub" ? "Unknown" : s.k === "unlock" ? "" : s.a) })),
  notes: planned.map((i, k) => notes[k] ?? (i >= 0 && out.unreachable.includes(i) ? UNREACH : null)) });

// DOM -> the same signature (skill image names: the have row and each step)
const read = () => {
  const base = u => (u || "").split("/").pop().replace(".png", "");
  return [...document.querySelectorAll("#path .lane")].map(l => ({
    note: l.querySelector(".lnote")?.textContent || null,
    have: [...l.querySelectorAll(".have .ab:not(.q) img")].map(i => base(i.src)),   // the abilities only ("?" and locked slots are counted in 1b)
    steps: [...l.querySelectorAll(".track .step:not(.ph)")].map(s => base(s.querySelector('img[src*="/skill/"]')?.src)),
  }));
};
const domSig = lanes => JSON.stringify(lanes.map(l => l.note ? null : { have: l.have, steps: l.steps }));

// ---- the mocked companion
const mock = { state: { snapshots: {}, status: {} } };
const handle = route => {
  const p = new URL(route.request().url()).pathname, json = (st, b) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });
  if (p === "/api/state") return json(200, mock.state);
  if (p === "/api/events") return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    body: `event: state\ndata: ${JSON.stringify(mock.state)}\n\n` });         // the stream ends; live.ts reconnects after ~1 s and takes the newest state
  return json(404, { error: "mock" });
};
const setSnaps = snaps => { mock.state = { snapshots: snaps, status: Object.fromEntries(Object.keys(snaps).map(k => [k, { state: "ok" }])) }; };
const waitFor = (page, fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const untilDom = async (page, want, ms = 20000) => {
  const t0 = Date.now(); let got = [];
  while (Date.now() - t0 < ms) { got = await page.evaluate(read); if (domSig(got) === want.sig && JSON.stringify(got.map(l => l.note)) === JSON.stringify(want.notes)) return { ok: true, got }; await new Promise(r => setTimeout(r, 250)); }
  return { ok: false, got };
};

// ---- the expected answers, from the Node core
const botbasePieces = [pc("head", 1, [S], { seed: 123456, rarity: 1 }),pc("clothes", 2, [], { seed: 777 }), pc("shoes", 3, [S, R], { seed: 31337 })];
const exp1 = ref({ fn: "plan", ...pin(botbasePieces) });
const botbase2 = [pc("head", 1, [S, MI], { seed: 424242 }), botbasePieces[1], botbasePieces[2]];
const exp2 = ref({ fn: "plan", ...pin(botbase2) });
const idx3 = [0, 1, 2];

// the s3s case: a real run from the true start seed of the head piece (skipping 50 seed steps); look for a gear id whose
// run is ambiguous after one sub and locked by two or three
const startOf = (slot, id) => ref({ fn: "startSeed", playerKey: KEY, slot, gearId: id }).seed;
let HEAD = 0, start = 0, run = [], lockN = 0;
const rec = n => ref({ fn: "recover", start, brand: "B03", observed: run.slice(0, n).map(r => ({ a: r.ability, drink: null })) });
for (let id = 21; id < 80 && !lockN; id++) {
  start = startOf("head", id);
  let s0 = start; for (let i = 0; i < 50; i++) s0 = step(s0);
  run = ref({ fn: "rolls", seed: s0, brand: "B03", drink: null, n: 8 }).rolls;
  if (rec(1).count > 1) for (let n = 2; n <= 3 && !lockN; n++) if (rec(n).locked) { lockN = n; HEAD = id; }
}
const one = rec(1);
const s3sBase = [pc("clothes", 22, []), pc("shoes", 23, [])];
const cs = [{ ...s3sBase[0], seed: startOf("clothes", 22) }, { ...s3sBase[1], seed: startOf("shoes", 23) }];
const exp3 = ref({ fn: "plan", ...pin(cs) });
const runSubs = n => run.slice(0, n).map(r => r.ability);

console.log(`(info) head gear ${HEAD}: one-sub recover ${one.count} candidate(s); locks at ${lockN || "never"} subs`);
check("setup: the ambiguous case is really ambiguous", one.ok && one.count > 1 && lockN >= 2);
check("setup: the reference plans are ok", exp1.ok && exp2.ok && exp3.ok);
check("setup: the reference plans have steps", [exp1, exp2, exp3].every(p => p.lanes.some(l => l.steps.length)));

// the far case (progressive search): a head goal only reachable thousands of seed steps ahead. The screen asks horizon 200,
// then slices from = searchedTo with horizon min(20000, max(200, from)) (path.ts sliceOf) until it's found: replayed here.
const FARGOALS = { head: [S, S, S], clothes: [R, "", ""], shoes: ["", "", ""] };
const FARBUILD = { id: 3, title: "Far test", modes: ["SZ"], weapon: "Shooter_Normal_00", set: ["head", "clothes", "shoes"].map(s => [ROWS[s], "", FARGOALS[s]]) };
const sliced = input => {
  let out = ref({ fn: "plan", ...input }), from = input.horizon, n = 1;
  while (out.ok && out.unreachable.length && from <= 1000000) { const h = Math.min(20000, Math.max(200, from)); out = ref({ fn: "plan", ...input, from, horizon: h }); from += h; n++; }
  return { out, end: from, n };
};
let farPieces = null, farRun = null;
for (let k = 1; k < 200 && !farPieces; k++) {
  const ps = [pc("head", 1, [], { seed: k * 7919 }), pc("clothes", 2, [], { seed: 777 }), pc("shoes", 3, [S, R], { seed: 31337 })];
  const r = sliced(pin(ps, FARGOALS));
  if (r.out.ok && !r.out.unreachable.length && r.n >= 5 && r.end <= 40000) { farPieces = ps; farRun = r; }
}
const expF = farRun?.out, nearOnFar = farPieces && ref({ fn: "plan", ...pin(farPieces) });
const farGroup = expF?.lanes[0].steps[0];
console.log(`(info) far head seed ${farPieces?.[0].seed}: found after ${farRun?.n} requests (searched to ${farRun?.end}), ${expF?.totals.battles} battles, first step ${JSON.stringify(farGroup)}`);
check("setup: a far goal was found by scanning seeds (5+ requests)", !!expF && !!nearOnFar?.ok);
check("setup: the far route starts with a burn group (times)", !!farGroup && farGroup.times > 1000 && !!farGroup.burn);

// hmr off: a core rebuild (core/dist) while this runs would otherwise reload the page mid-test
const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5176, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
  await ctx.addInitScript(b => { try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "1"); } } catch {} }, BUILD);
  await ctx.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
  const page = await ctx.newPage();
  const errs = [], imgs = [], imgs1 = [], bad = [];
  page.on("pageerror", e => errs.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|404/.test(m.text())) errs.push(m.text()); });
  page.on("response", r => { if (r.status() >= 400 && /\/img\//.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
  await page.route("**/img/**", r => { imgs1.push(r.request().url()); return r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") }); });
  await page.route("**/api/**", handle);

  // 1. a botbase snapshot: real lanes
  setSnaps({ botbase: snap("botbase", botbasePieces) });
  await page.goto(url);
  await page.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });       // wiring.ts has run
  await page.click('.tab[data-s="builds"]');
  const e1 = expect(exp1, idx3);
  const r1 = await untilDom(page, e1);
  check("botbase snapshot: the Path screen draws the core's lanes", r1.ok, JSON.stringify(r1.got).slice(0, 400) + " WANT " + e1.sig.slice(0, 400));
  check("botbase snapshot: lanes carry real steps", r1.got.length === 3 && r1.got.some(l => l.steps.length > 0));
  // 1b. lane head slots: a 1-star piece (2 open slots) with 1 sub shows its ability, one "?" and one locked slot; a piece with
  // no star info (no `rarity`) shows "?" for every empty slot, never a lock
  const heads = await page.evaluate(() => [...document.querySelectorAll("#path .lane .have")].map(h => [...h.children].map(e =>
    e.classList.contains("lock") ? "lock" : e.classList.contains("q") ? (e.querySelector('img[src$="/skill/Unknown.png"]') ? "?" : "q-noimg") : e.querySelector("img") ? "ab" : "empty")));
  check("lane heads: 1 star + 1 sub = ability, ?, locked; no star info = ? for each empty slot",
    JSON.stringify(heads) === JSON.stringify([["ab", "?", "lock"], ["?", "?", "?"], ["ab", "ab", "?"]]), JSON.stringify(heads));

  // 2. a new snapshot replans in place (the head piece rolled a second sub, new seed)
  setSnaps({ botbase: snap("botbase", botbase2) });
  const e2 = expect(exp2, idx3);
  const r2 = await untilDom(page, e2);
  check("a new snapshot replans the shown build in place", r2.ok && domSig(r2.got) !== domSig(r1.got), JSON.stringify(r2.got).slice(0, 400) + " WANT " + e2.sig.slice(0, 400));

  // 3. an s3s piece with an ambiguous seed: one line, no steps; the other lanes still plan
  setSnaps({ s3s: snap("s3s", [pc("head", HEAD, runSubs(1)), ...s3sBase]) });
  const note = `${one.count} possible seeds, one more roll`;
  const e3 = expect(exp3, [-1, 0, 1], { 0: note });
  const r3 = await untilDom(page, e3);
  check("s3s, ambiguous seed: the lane says \"N possible seeds, one more roll\" instead of steps", r3.ok, JSON.stringify(r3.got).slice(0, 500));
  if (process.env.SHOT) { await page.waitForTimeout(800); await page.screenshot({ path: path.join(here, "out", "path-live-ambiguous.png") }); }   // SHOT=1: look at the note lane
  check("s3s, ambiguous seed: that lane has no steps", r3.ok && r3.got[0].steps.length === 0 && r3.got[0].have.length === 1);

  // 4. one more snapshot with more rolls: refine (only the new rolls) locks the seed and the lane plans
  const locked = rec(lockN);
  const exp4 = ref({ fn: "plan", ...pin([{ ...pc("head", HEAD, runSubs(lockN)), seed: locked.candidates[0].seed }, ...cs]) });
  setSnaps({ s3s: snap("s3s", [pc("head", HEAD, runSubs(lockN)), ...s3sBase]) });
  const e4 = expect(exp4, idx3);
  const r4 = await untilDom(page, e4);
  check("s3s, more rolls: the seed locks and the lane is planned", r4.ok, JSON.stringify(r4.got).slice(0, 400) + " WANT " + e4.sig.slice(0, 400));
  await ctx.close();

  // 5. a sendou-style build whose gear rows are "" (any gear): all three lanes plan from the snapshot, no empty gear image asked for
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
  const BLANK = { ...BUILD, id: 2, title: "Blank rows", set: ["head", "clothes", "shoes"].map(s => ["", "", GOALS[s]]) };
  await ctx2.addInitScript(b => { try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "2"); } } catch {} }, BLANK);
  await ctx2.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
  const page2 = await ctx2.newPage();
  page2.on("pageerror", e => errs.push(String(e)));
  await page2.route("**/img/**", r => { imgs.push(r.request().url()); return r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") }); });
  page2.on("response", r => { if (r.status() >= 400 && /\/img\//.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
  await page2.route("**/api/**", handle);
  setSnaps({ botbase: snap("botbase", botbasePieces) });
  await page2.goto(url);
  await page2.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  await page2.click('.tab[data-s="builds"]');
  const r5 = await untilDom(page2, e1);
  check('blank "" gear rows: all three lanes plan from the snapshot', r5.ok, JSON.stringify(r5.got).slice(0, 400) + " WANT " + e1.sig.slice(0, 400));
  await page2.waitForTimeout(500);
  await ctx2.close();
  // 5b. a build whose clothes slot you own no piece of: that lane's note sits where a route would start (the track's left edge),
  // and its goal pill lines up with the other lanes' goal pills
  {
    const ctxN = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    await ctxN.addInitScript(b => { try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "1"); } } catch {} }, BUILD);
    await ctxN.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
    const pageN = await ctxN.newPage();
    pageN.on("pageerror", e => errs.push(String(e)));
    await pageN.route("**/img/**", r => r.fallback());
    await pageN.route("**/api/**", handle);
    setSnaps({ botbase: snap("botbase", [botbasePieces[0], botbasePieces[2]]) });
    await pageN.goto(url);
    await pageN.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
    await pageN.click('.tab[data-s="builds"]');
    await waitFor(pageN, () => document.querySelectorAll("#path .lane .track").length === 2 && !!document.querySelector("#path .lane .lnote"));
    await pageN.waitForTimeout(900);
    const geo = await pageN.evaluate(() => [...document.querySelectorAll("#path .lane")].map(l => {
      const r = e => e ? e.getBoundingClientRect() : null, g = r(l.querySelector(".lend .goal")), t = r(l.querySelector(".track")), n = r(l.querySelector(".lnote")), h = { height: l.offsetHeight };
      return { goal: g && g.left, goalW: g && g.width, track: t && t.left, note: n && n.left, h: h.height, text: l.querySelector(".lnote")?.textContent || null };
    }));
    const nl = geo.find(g => g.note != null), others = geo.filter(g => g.note == null);
    await pageN.screenshot({ path: path.join(here, "out", "path-nopiece.png") });
    console.log("(info) nopiece geometry " + JSON.stringify(geo));
    check("no piece for a slot: the lane says so", !!nl && /don't have a clothes piece/.test(nl.text || "") && others.length === 2, JSON.stringify(geo));
    check("no piece for a slot: the goal pill sits at the same x as the other lanes' goal pills", !!nl && others.every(o => Math.abs(o.goal - nl.goal) <= 1), JSON.stringify(geo));
    check("no piece for a slot: the note starts at the track's left edge", !!nl && others.every(o => Math.abs(o.track - nl.note) <= 1), JSON.stringify(geo));
    check("no piece for a slot: the lane keeps the others' height", !!nl && others.every(o => Math.abs(o.h - nl.h) <= 1), JSON.stringify(geo));
    await ctxN.close();
  }
  // 5c. chunks: one plan call per input, each piece's own cap (maxChunks, 20 by default) and no build-wide budget; Up next has
  // pages only for pieces with a step this turn and shows each kind of step as its lane draws it; the Chunks pill is on/off
  {
    const ctxU = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    await ctxU.addInitScript(b => {
      try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "1"); } } catch {}
      window.__plans = [];
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { const q = m && m.req; if (q && q.fn === "plan" && !q.whatIf && !q.from) window.__plans.push({ cb: q.chunkBudget ?? null, uc: q.useChunks, mc: (q.pieces || []).map(p => "maxChunks" in p ? p.maxChunks : "none") }); return post.call(this, m, ...rest); };
    }, BUILD);
    await ctxU.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
    const pageU = await ctxU.newPage();
    pageU.on("pageerror", e => errs.push(String(e)));
    await pageU.route("**/img/**", r => r.fallback());
    await pageU.route("**/api/**", handle);
    setSnaps({ botbase: snap("botbase", botbasePieces) });
    await pageU.goto(url);
    await pageU.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
    await pageU.click('.tab[data-s="builds"]');
    const drew = (await untilDom(pageU, e1)).ok;
    await pageU.waitForTimeout(1200);
    const n1 = await pageU.evaluate(() => window.__plans.length);
    await pageU.waitForTimeout(3500);                                                  // 3+ live "state" events, same snapshot
    const plansU = await pageU.evaluate(() => window.__plans);
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check("chunks: one plan call per input, no build-wide budget, every piece capped at 20 chunks (the default)", drew && plansU.length >= 1 && plansU.every(q => q.uc === true && q.cb === null && eq(q.mc, [20, 20, 20])), JSON.stringify(plansU));
    check("chunks: live state events with the same input don't ask the core again (the plan is kept)", plansU.length === n1, JSON.stringify({ n1, n: plansU.length }));
    const ch = await pageU.evaluate(async () => {
      const m = await import("/src/path.ts"), calls = [];
      const fn = async q => { calls.push(q.chunkBudget ?? null); return { ok: true, lanes: [], unreachable: [], totals: { rolls: 0, battles: 1, tickets: 0, chunks: 0, scrubs: 0 } }; };
      const q = { pieces: [{ row: "x", brand: "", seed: 91, subs: ["", "", ""], goal: ["", "", ""], maxChunks: 10 }], chunks: {}, drinks: {}, fixedOrder: true, useChunks: true, chunkRate: 5, useDrinks: true, horizon: 200 };
      const a = await m.chunkPlan(q, fn), b = await m.chunkPlan({ ...q }, fn);
      return { calls, same: a.input === q && b.input === q, caps: m.CAPMAX };
    });
    check("chunkPlan: one core call with the input as given (no budget added), kept for the same input; caps 0 / 10 / 20 / none", eq(ch.calls, [null]) && ch.same && eq(ch.caps, [0, 10, 20, null]), JSON.stringify(ch));

    // Up next: Alex's case (the hat sits out battles 1-2 and starts with two drink rolls a scrub throws away; the tee
    // scrubs and the shoes take chunks first), the soonest lane when nobody has a step now, and every kind of first step
    const up = await pageU.evaluate(async ({ ROWS, S, R, MI }) => {
      const m = await import("/src/path.ts");
      const lane = (row, steps) => ({ row, have: [["", ""], ["", ""], ["", ""]], goal: [[S, ""], ["", ""], ["", ""]], steps });
      const hatSteps = [{ k: "drink", a: MI, d: S, burn: 1, key: 3, roll: 1, tr: 8 }, { k: "drink", a: R, d: S, burn: 1, key: 4, roll: 2, tr: -5 }, { k: "scrub" }, { k: "roll", a: S, key: 5, roll: 3 }];
      const hat = lane(ROWS.head, hatSteps), tee = lane(ROWS.clothes, [{ k: "scrub" }, { k: "roll", a: R, key: 1, roll: 1 }, { k: "roll", a: S, key: 2, roll: 2 }]);
      const shoes = lane(ROWS.shoes, [{ k: "slap", slot: 1, a: R, cost: 10 }, { k: "roll", a: S, key: 1, roll: 1 }]);
      const totals = { rolls: 7, battles: 12, tickets: 2, chunks: 10, scrubs: 2 };
      const host = document.createElement("div"); host.id = "uptest"; host.style.cssText = "display:flex;flex-direction:column;gap:18px;padding:12px 0";
      document.querySelector("#path .pl").insertBefore(host, document.querySelector("#path .lanes"));
      const add = (lanes, t = totals) => { const w = document.createElement("div"); w.innerHTML = m.upNextCard({ id: 1 }, lanes, t); const c = w.firstElementChild; host.append(c); return c; };
      const pagesOf = c => ({ dots: c.querySelectorAll(".udot").length, titles: [...c.querySelectorAll(".utitle h2")].map(h => h.textContent), steps: [...c.querySelectorAll(".ustep b")].map(b => b.textContent),
        badges: [...c.querySelectorAll(".badges > .badge:not(.stepb)")].map(b => b.textContent.replace(/\s+/g, " ").trim()) });
      const alex = add([hat, tee, shoes]);
      // nobody now: a burn group of 3 rolls from battle 1 ends in column 3, the other lane's first roll is battle 2 (column 2)
      const burn3 = lane(ROWS.head, [{ k: "roll", a: MI, burn: 1, key: 1, times: 3, roll: 1 }, { k: "scrub" }]), late = lane(ROWS.clothes, [{ k: "roll", a: R, key: 2, roll: 1 }, { k: "roll", a: S, key: 3, roll: 2 }]);
      const soonHtml = (() => { const w = document.createElement("div"); w.innerHTML = m.upNextCard({ id: 1 }, [burn3, late], totals); return pagesOf(w.firstElementChild); })();
      const kinds = { plain: [{ k: "roll", a: S, key: 1, roll: 1 }], burn: [{ k: "roll", a: MI, burn: 1, key: 1, roll: 1 }, { k: "scrub" }, { k: "roll", a: S, key: 2, roll: 2 }],
        drink: [{ k: "drink", a: S, d: R, key: 1, roll: 1, tr: 8 }], "drink burn": hatSteps.map(s => s.key ? { ...s, key: s.key - 2 } : s), scrub: [{ k: "scrub" }, { k: "roll", a: R, key: 1, roll: 1 }],
        slap: [{ k: "slap", slot: 1, a: R, cost: 10 }, { k: "roll", a: S, key: 1, roll: 1 }] };
      const cards = Object.entries(kinds).map(([name, steps]) => [name, add([lane(ROWS.head, steps)], null)]);
      await new Promise(r => setTimeout(r, 600));                                    // images in
      const R4 = e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
      const geo = cards.map(([name, c]) => {
        const pg = c.querySelector(".flow .upg.on"), kids = [...pg.children], cell = pg.querySelector(".ucell"), mark = cell && (cell.querySelector(":scope > .ab") || cell.querySelector(":scope > .chunkonly")), tk = cell && cell.querySelector(".ticket");
        return { name, order: kids.map(k => k.classList.contains("arrow") ? "arrow" : k.classList.contains("ucell") ? "cell" : "gear"), mark: mark && { cls: mark.className, ...R4(mark), q: !!mark.querySelector('img[src*="Unknown"]') },
          arrow: R4(pg.querySelector(".arrow")), tk: tk && R4(tk), card: R4(c), title: c.querySelector(".utitle h2").textContent };
      });
      return { alex: pagesOf(alex), soon: soonHtml, geo };
    }, { ROWS, S, R, MI });
    console.log("(info) up next " + JSON.stringify({ alex: up.alex, soon: up.soon }));
    check("Up next: only pieces with a step this turn get a page (the hat, sitting out, doesn't)", up.alex.dots === 2 && up.alex.titles.length === 2 && up.alex.titles[0] === "Scrub" && up.alex.titles[1] === "Chunk it on" && !up.alex.titles.some(t => /twice/.test(t)), JSON.stringify(up.alex));
    check("Up next: the Step badges follow the pages; tickets and chunks stay the whole build's", up.alex.steps.length === 2 && up.alex.badges.some(b => /2 tickets/.test(b)) && up.alex.badges.some(b => /10 chunks/.test(b)), JSON.stringify(up.alex));
    check("Up next: nobody has a step now -> the lane whose step comes soonest", up.soon.dots === 0 && up.soon.titles.length === 1 && /^Wear your /.test(up.soon.titles[0]), JSON.stringify(up.soon));
    for (const g of up.geo) {
      const ok = eq(g.order, ["gear", "arrow", "cell"]) && !!g.mark && g.mark.w >= 50 && g.mark.l > g.arrow.r;
      const q = g.name === "burn" || g.name === "scrub" || g.name === "drink burn" ? g.mark?.q : g.name === "slap" ? /chunkonly/.test(g.mark?.cls) : !g.mark?.q;
      const tk = /drink/.test(g.name) ? !!g.tk && g.tk.l > g.mark.l + g.mark.w * .3 && g.tk.l < g.mark.r && g.tk.t < g.mark.t + g.mark.h * .5 && g.tk.b > g.mark.t && g.tk.t >= g.card.t && g.tk.r < g.card.r : !g.tk;
      check(`Up next, ${g.name}: after the › its own cell${/drink/.test(g.name) ? ", the ticket stapled on its ring" : ""}`, ok && q && tk, JSON.stringify(g));
    }
    { const hs = up.geo.map(g => Math.round(g.card.h)), bh = await pageU.evaluate(() => [...document.querySelectorAll("#uptest .badge")].map(b => Math.round(b.getBoundingClientRect().height)));
      const ah = await pageU.evaluate(() => Math.round(document.querySelector("#uptest > .next").getBoundingClientRect().height));
      check("Up next: every banner is the same height whatever its badges (room for four)", hs.every(h => Math.abs(h - ah) <= 1), JSON.stringify({ alex: ah, kinds: hs, badges: bh })); }
{ const mid = await pageU.evaluate(() => [...document.querySelectorAll("#uptest > .next")].map(c => { const h = c.querySelector(".utitle .upg.on h2"), u = c.querySelector(".unbattles"), a = c.getBoundingClientRect(), t = h.getBoundingClientRect(), b = u.getBoundingClientRect(), s = c.querySelector(".utitle").getBoundingClientRect(), f = c.querySelector(".flow").getBoundingClientRect();
        return { title: h.textContent, lines: Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)), above: Math.round(t.top - a.top), below: Math.round(a.bottom - b.bottom), stackH: Math.round(s.height), flowMid: Math.round((f.top + f.bottom) / 2 - a.top), h: Math.round(a.height) }; }));
      console.log("(info) up next centring " + JSON.stringify(mid)); }
    check("Up next, drink burn: says \"Roll twice\"", up.geo.find(g => g.name === "drink burn")?.title === "Roll twice", JSON.stringify(up.geo.find(g => g.name === "drink burn")));
{ // W5: a one-line title sits level in the banner like the two-line one (also when another page of the same banner has two lines)
      const mk = await pageU.evaluate(async ({ ROWS, S, R }) => {
        const m = await import("/src/path.ts"), host = document.getElementById("uptest");
        const lane = (row, steps) => ({ row, have: [["", ""], ["", ""], ["", ""]], goal: [[S, ""], ["", ""], ["", ""]], steps });
        const one = [{ k: "scrub" }, { k: "roll", a: R, key: 1, roll: 1 }], two = [{ k: "scrub" }, { k: "unlock", slot: 2 }, { k: "slap", slot: 1, a: R, cost: 10 }, { k: "roll", a: S, key: 1, roll: 1 }];
        const add = (id, lanes) => { const w = document.createElement("div"); w.innerHTML = m.upNextCard({ id: 1 }, lanes, { rolls: 7, battles: 26, tickets: 0, chunks: 0, scrubs: 1 }); const c = w.firstElementChild; c.id = id; host.append(c); return c; };
        add("w5one", [lane(ROWS.head, [{ k: "roll", a: R, burn: 1, key: 1, roll: 1 }, { k: "scrub" }, { k: "roll", a: S, key: 2, roll: 2 }])]); add("w5two", [lane(ROWS.head, two)]); add("w5mix", [lane(ROWS.head, [{ k: "roll", a: R, burn: 1, key: 1, roll: 1 }, { k: "scrub" }]), lane(ROWS.clothes, two)]);
        await new Promise(r => setTimeout(r, 500));
        const f = id => { const c = document.getElementById(id), a = c.getBoundingClientRect(), pages = [...c.querySelectorAll(".utitle .upg")].map(p => p.querySelector("h2")), h = c.querySelector(".utitle .upg.on h2").getBoundingClientRect(), u = c.querySelector(".unbattles").getBoundingClientRect();
          return { id, titles: pages.map(h => h.textContent + " /" + Math.round(h.getBoundingClientRect().height)), above: Math.round(h.top - a.top), gapBar: Math.round(u.top - h.bottom), below: Math.round(a.bottom - u.bottom), h: Math.round(a.height) }; };
        return ["w5one", "w5two", "w5mix"].map(f);
      }, { ROWS, S, R });
      console.log("(info) w5 banners " + JSON.stringify(mk));
      for (const [id, name] of [["w5one", "w5-upnext-oneline"], ["w5two", "w5-upnext-twoline"], ["w5mix", "w5-upnext-mixed"]]) await pageU.locator("#" + id).screenshot({ path: path.join(here, "out", name + ".png") }); }
    await pageU.locator("#uptest > .next").first().screenshot({ path: path.join(here, "out", "path-upnext-alex.png") });
    await pageU.setViewportSize({ width: 1440, height: 2400 });                       // the Path screen scrolls inside itself: room for every card
    await pageU.waitForTimeout(300);
    await pageU.locator("#uptest").screenshot({ path: path.join(here, "out", "path-upnext-kinds.png") });
    await pageU.setViewportSize({ width: 1440, height: 900 });
    await pageU.evaluate(() => document.getElementById("uptest").remove());

    // the Chunks pill: a plain on/off toggle, kept in the store; the old budget key migrates (0 = off, > 0 or none = on)
    const pill = () => pageU.evaluate(() => { const t = document.querySelector('#path .tog[data-t="c"]'); return { tag: t.tagName, on: t.classList.contains("on"), knob: !!t.querySelector(".knob"), bud: !!t.querySelector(".bud, .snail, .bstep, svg") }; });
    const p0 = await pill();
    check("Chunks pill: a plain toggle (knob, no budget widget), on by default", p0.tag === "BUTTON" && p0.on && p0.knob && !p0.bud, JSON.stringify(p0));
    await pageU.locator("#path .toggles").screenshot({ path: path.join(here, "out", "path-chunks-on.png") });
    const nOff = await pageU.evaluate(() => window.__plans.length);
    await pageU.click('#path .tog[data-t="c"]');
    await waitFor(pageU, n => window.__plans.length > n && !document.querySelector('#path .tog[data-t="c"]').classList.contains("on"), nOff);
    await pageU.waitForTimeout(500);                                                   // the knob slides
    await pageU.locator("#path .toggles").screenshot({ path: path.join(here, "out", "path-chunks-off.png") });
    const off = await pageU.evaluate(async () => { const { store } = await import("/src/store.ts"); await store.flush(); return { p: window.__plans[window.__plans.length - 1], v: store.get("seedtracker.chunks") }; });
    check("Chunks off: the request says useChunks false, no budget; stored as false", off.p.uc === false && off.p.cb === null && off.v === false, JSON.stringify(off));
    await pageU.reload();
    await pageU.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
    const p1 = await pill();
    const mig = await pageU.evaluate(async () => {
      const { store } = await import("/src/store.ts"), m = await import("/src/path.ts"), was = store.get("seedtracker.chunks");
      const at = (nw, old) => { store.set("seedtracker.chunks", nw); store.set("seedtracker.chunkbudget", old); return m.chunksOn(); };
      const r = [at(undefined, "0"), at(undefined, "30"), at(undefined, undefined), at(true, "0"), at(false, "30")];
      store.set("seedtracker.chunks", was); store.set("seedtracker.chunkbudget", undefined);
      return r;
    });
    check("Chunks off stays off after a reload", !p1.on, JSON.stringify(p1));
    check("Chunks: the old budget migrates (0 off, 30 on, none on; the new key wins)", eq(mig, [false, true, true, true, false]), JSON.stringify(mig));
    await ctxU.close();
  }
  // 5d. a lane's chunk cap (path.ts capBox), left of its goal pill: level 0 none / 1 at most 10 / 2 at most 20 (default) /
  // 3 thirty or more, sent as that piece's maxChunks (level 3: none sent). Alex's tee case: the shoes need 30 chunks for
  // their two S, the tee (S, MainInk, Q; wants S, S, Q) wants 20. Each step replans that lane at once; a cap of 0 gives the
  // lane no chunk step; looks by level (grey / yellow pips / red); hidden with Chunks off
  {
    const Q = "InkRecovery_Up", TEEGOALS = { head: [S, "", ""], clothes: [S, S, Q], shoes: [S, S, Q] };
    const TEEBUILD = { id: 4, title: "Cap test", modes: ["SZ"], weapon: "Shooter_Normal_00", set: ["head", "clothes", "shoes"].map(s => [ROWS[s], "", TEEGOALS[s]]) };
    const teePieces = [pc("head", 1, [S], { seed: 150461 }), pc("clothes", 2, [S, MI, Q], { seed: 1989868 }), pc("shoes", 3, [MI, R], { seed: 24694476 })];
    const teeStock = { chunks: { [S]: 80 }, drinks: {} };
    const capIn = caps => { const b = pin(teePieces, TEEGOALS); return { ...b, ...teeStock, chunkRate: 5, pieces: b.pieces.map((p, i) => caps[i] == null ? p : { ...p, maxChunks: caps[i] }) }; };
    const slapsOf = (r, i) => r.lanes[i].steps.filter(s => s.k === "slap").reduce((t, s) => t + s.cost, 0);
    const c20 = ref({ fn: "plan", ...capIn([20, 20, 20]) }), c3 = ref({ fn: "plan", ...capIn([20, 20, null]) }), c0 = ref({ fn: "plan", ...capIn([20, 0, null]) }), c1 = ref({ fn: "plan", ...capIn([10, 0, null]) });
    console.log(`(info) cap fixture: 20/20/20 tee ${slapsOf(c20, 1)} shoes ${slapsOf(c20, 2)}; shoes 30+ tee ${slapsOf(c3, 1)} shoes ${slapsOf(c3, 2)}; tee 0 tee ${slapsOf(c0, 1)} shoes ${slapsOf(c0, 2)} (${c20.totals.battles} / ${c3.totals.battles} / ${c0.totals.battles} battles)`);
    check("setup: Alex's tee: at 20 each the shoes take 20 and the tee none; shoes 30+: 30 and the tee its 20; tee 0: no tee chunks",
      [c20, c3, c0, c1].every(o => o.ok && !o.unreachable.length) && slapsOf(c20, 2) === 20 && slapsOf(c20, 1) === 0 && slapsOf(c3, 2) === 30 && slapsOf(c3, 1) === 20 && slapsOf(c0, 1) === 0 && slapsOf(c0, 2) === 30);
    const ctxL = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    await ctxL.addInitScript(b => {
      try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", String(b.id)); } } catch {}
      window.__plans = []; window.__noPlanCache = true;                  // these count plan calls: a saved route (plan-cache.ts) would hide them
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { const q = m && m.req; if (q && q.fn === "plan" && !q.whatIf && !q.from) window.__plans.push({ cb: q.chunkBudget ?? null, uc: q.useChunks, t: performance.now(), lean: (q.pieces || []).some(p => "chunkLean" in p), mc: (q.pieces || []).map(p => "maxChunks" in p ? p.maxChunks : "none") }); return post.call(this, m, ...rest); };
      document.addEventListener("click", e => { if (e.target.closest?.(".ccap")) window.__clickAt = performance.now(); }, true);
    }, TEEBUILD);
    await ctxL.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
    const pageL = await ctxL.newPage();
    pageL.on("pageerror", e => errs.push(String(e)));
    await pageL.route("**/img/**", r => r.fallback());
    await pageL.route("**/api/**", handle);
    setSnaps({ botbase: { ...snap("botbase", teePieces), stock: teeStock } });
    await pageL.goto(url);
    await pageL.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
    await pageL.click('.tab[data-s="builds"]');
    const caps = () => pageL.evaluate(() => [...document.querySelectorAll("#path .lane")].map(l => { const w = l.querySelector(".ccap"); if (!w) return null; const cs = getComputedStyle(w), g = l.querySelector(".lend .goal").getBoundingClientRect(), r = w.getBoundingClientRect();
      const lit = [...w.querySelectorAll(".pips i.lit")];
      return { v: +w.getAttribute("aria-valuenow"), dv: w.dataset.v, title: w.dataset.tip, lit: lit.length, pip: lit[0] ? getComputedStyle(lit[0]).backgroundColor : null, icon: !!w.querySelector('img[src*="chunk"]'),
        dim: +getComputedStyle(w.querySelector(".cic")).opacity, grey: /grayscale/.test(getComputedStyle(w.querySelector(".cic img")).filter), red: +getComputedStyle(w.querySelector(".ctint")).opacity,
        left: r.right + 8 <= g.left + .5, level: Math.abs((r.top + r.bottom) / 2 - (g.top + g.bottom) / 2) < 14, off: w.classList.contains("off"), op: +cs.opacity, vis: cs.visibility, text: w.textContent.trim() }; }));
    const sigOf = l => l.steps.map(s => s.k === "scrub" ? "Unknown" : s.k === "unlock" ? "" : s.a);
    const lanesNow = () => pageL.evaluate(read);
    const waitPlan = (o, ms = 30000) => untilDom(pageL, expect(o, idx3), ms);
    const plans = () => pageL.evaluate(() => window.__plans);
    const YEL = "rgb(234, 255, 61)", RED = "rgb(255, 80, 94)";
    const shotL = async name => {                                                     // the three lanes in view (they end below the fold), no focus ring
      await pageL.evaluate(() => { document.activeElement?.blur?.(); document.querySelector("#path .lanes").scrollIntoView({ block: "end" }); });
      await pageL.waitForTimeout(300);
      const clip = await pageL.evaluate(() => { const r = document.querySelector("#path .lanes").getBoundingClientRect(), y = Math.max(0, r.y); return { x: r.x, y, width: r.width, height: Math.min(r.bottom, 900) - y }; });
      await pageL.screenshot({ path: path.join(here, "out", name + ".png"), clip });
    };
    const r20 = await waitPlan(c20);
    await pageL.waitForTimeout(600);
    const w0 = await caps(), p0 = await plans();
    check("cap: a widget in every lane left of its goal pill and level with it, the chunk sticker over three pips, no words; at most 20 by default (2 yellow pips)",
      r20.ok && w0.every(w => w && w.icon && w.left && w.level && w.v === 2 && w.dv === "2" && w.lit === 2 && w.pip === YEL && w.red === 0 && w.dim === 1 && !w.grey && w.text === "" && w.title === "Chunks: at most 20" && !w.off), JSON.stringify({ ok: r20.ok, w0 }));
    check("cap: the live plan sends maxChunks 20 for every piece, no chunkBudget, no chunkLean", p0.length >= 1 && p0.every(q => q.cb === null && !q.lean && JSON.stringify(q.mc) === "[20,20,20]"), JSON.stringify(p0));
    // Up next overhangs the lanes by 14px each side at 1440x900 and 1280x720, no sideways scroll
    const bannerFit = () => pageL.evaluate(() => { const n = document.querySelector("#path .tag.next"), l = document.querySelector("#path .lanes"), p = document.getElementById("path");
      const a = n.getBoundingClientRect(), q = p.getBoundingClientRect();              // (#path's own scrollWidth counts the clipped tracks: not a scrollbar)
      return { over: (n.offsetWidth - l.offsetWidth) / 2, nl: n.offsetLeft - l.offsetLeft, sx: Math.max(q.left - a.left, a.right - (q.left + p.clientWidth), p.offsetHeight - p.clientHeight), dx: document.documentElement.scrollWidth - innerWidth }; });
    const bf1 = await bannerFit();
    if (process.env.SHOT) { await pageL.evaluate(() => { document.activeElement?.blur?.(); document.getElementById("path").scrollTop = 0; }); await pageL.waitForTimeout(300); await pageL.screenshot({ path: path.join(here, "out", "path-banner.png") }); }
    await pageL.setViewportSize({ width: 1280, height: 720 }); await pageL.waitForTimeout(600);
    const bf2 = await bannerFit();
    await pageL.setViewportSize({ width: 1440, height: 900 }); await pageL.waitForTimeout(600);
    check("Up next: 14px wider than the lanes on each side (1440x900, 1280x720), no sideways scrollbar",
      [bf1, bf2].every(f => f.over === 14 && f.nl === -14 && f.sx <= 0 && f.dx <= 0), JSON.stringify({ bf1, bf2 }));
    if (process.env.SHOT) await shotL("path-cap-default");
    // scrolled down, a snapshot that loses the stock (2026-11-21: a Switch read after a scrub, the counts found again 0.8 s
    // later) replans the lanes with no chunks and back: the lane in view stays put on screen, and you end exactly where you were
    {
      const where = () => pageL.evaluate(() => { const h = document.getElementById("path"), t = h.getBoundingClientRect().top;
        return { st: h.scrollTop, max: h.scrollHeight - h.clientHeight, y: [...h.querySelectorAll(".lanes > .lane")].map(l => Math.round(l.getBoundingClientRect().top - t)) }; });
      await pageL.evaluate(() => { document.activeElement?.blur?.(); document.querySelector("#path .lanes > .lane.t2").scrollIntoView({ block: "start" }); });
      await pageL.waitForTimeout(300);
      const s0 = await where(), sig0 = domSig(await lanesNow());
      setSnaps({ botbase: snap("botbase", teePieces) });
      const t0 = Date.now(); while (Date.now() - t0 < 20000 && domSig(await lanesNow()) === sig0) await pageL.waitForTimeout(100);
      await pageL.waitForTimeout(900);
      const s1 = await where(), sig1 = domSig(await lanesNow());
      setSnaps({ botbase: { ...snap("botbase", teePieces), stock: teeStock } });
      const back = await waitPlan(c20);
      await pageL.waitForTimeout(900);
      const s2 = await where();
      const held = (a, b) => Math.abs(a.y[1] - b.y[1]) <= 1 || b.st >= b.max - 1;   // the tee lane where it was, unless the page got too short
      check("scroll: losing the stock and getting it back keeps the lane in view put, and you end exactly where you were",
        s0.st > 0 && sig1 !== sig0 && back.ok && held(s0, s1) && Math.abs(s2.y[1] - s0.y[1]) <= 1 && Math.abs(s2.st - s0.st) <= 1, JSON.stringify({ s0, s1, s2, changed: sig1 !== sig0, back: back.ok }));
    }
    // shoes: one click, 2 -> 3 (30 or more): maxChunks omitted for it, the plan arrives with its 30 chunks
    let n = (await plans()).length;                                                // (after the scroll check's replans)
    await pageL.click("#path .lane.t3 .ccap");
    const r3 = await waitPlan(c3);
    const p3 = (await plans()).slice(n), clickAt = await pageL.evaluate(() => window.__clickAt), w3 = await caps();
    check("cap 30 or more: the shoes' maxChunks is left out, the others stay 20; asked at once; the shoes get their 30 chunks",
      r3.ok && p3.length >= 1 && p3.every(q => JSON.stringify(q.mc) === '[20,20,"none"]') && p3[0].t - clickAt < 300, JSON.stringify({ ok: r3.ok, p3, clickAt, got: r3.got.map(l => l.steps) }));
    check("cap 30 or more: 3 red pips and a red sticker, titled", w3[2].v === 3 && w3[2].lit === 3 && w3[2].pip === RED && w3[2].red === 1 && w3[2].title === "Chunks: 30 or more", JSON.stringify(w3[2]));
    // tee: two clicks, 2 -> 3 -> 0 (none): maxChunks 0, the tee loses its chunk step, the other lanes keep theirs
    const before0 = await lanesNow();
    n = (await plans()).length;
    await pageL.click("#path .lane.t2 .ccap"); await pageL.waitForTimeout(150); await pageL.click("#path .lane.t2 .ccap");
    const r0 = await waitPlan(c0);
    const p0b = (await plans()).slice(n), w0b = await caps(), tee0 = await pageL.evaluate(() => document.querySelectorAll("#path .lane.t2 .track .step.slapped").length);
    check("cap none: the tee sends maxChunks 0 and its lane has no chunk step; the head and shoes lanes look the same as before",
      r0.ok && JSON.stringify(p0b.at(-1)?.mc) === '[20,0,"none"]' && tee0 === 0
      && JSON.stringify([r0.got[0], r0.got[2]]) === JSON.stringify([before0[0], before0[2]]), JSON.stringify({ ok: r0.ok, p0b, got: r0.got, before0 }));
    check("cap none: no pip lit, the sticker greyed and dim, titled", w0b[1].v === 0 && w0b[1].lit === 0 && w0b[1].grey && w0b[1].dim < 1 && w0b[1].red === 0 && w0b[1].title === "Chunks: none", JSON.stringify(w0b[1]));
    // head: arrow keys step and clamp (left x3 from 2: 1, 0, still 0; right: 1), the focus stays
    n = (await plans()).length;
    await pageL.focus("#path .lane.t1 .ccap");
    for (const k of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowRight"]) { await pageL.keyboard.press(k); await pageL.waitForTimeout(150); }
    const r1 = await waitPlan(c1);
    await pageL.waitForTimeout(400);
    const w1 = await caps(), p1 = (await plans()).slice(n), foc = await pageL.evaluate(() => document.activeElement?.closest?.(".lane")?.className || null);
    const saved = await pageL.evaluate(async () => { const { store } = await import("/src/store.ts"); await store.flush(); return store.get("seedtracker.chunkcap"); });
    check("cap at most 10: arrows step and clamp, the focus stays; 1 yellow pip; maxChunks 10 sent",
      r1.ok && w1[0].v === 1 && w1[0].lit === 1 && w1[0].pip === YEL && w1[0].title === "Chunks: at most 10" && /t1/.test(foc || "") && JSON.stringify(p1.at(-1)?.mc) === '[10,0,"none"]', JSON.stringify({ w1: w1[0], foc, p1 }));
    check("cap: saved per build and lane under seedtracker.chunkcap (the default 20 not stored)", JSON.stringify(Object.entries(saved || {}).sort()) === JSON.stringify([["4:0", 1], ["4:1", 0], ["4:2", 3]]), JSON.stringify(saved));
    if (process.env.SHOT) await shotL("path-cap-levels");
    // Chunks off: the widgets fade out (hidden, inert); on again: back with their levels
    const fading = pageL.evaluate(() => new Promise(res => { const seen = [], t0 = performance.now(); const f = () => { for (const w of document.querySelectorAll("#path .ccap")) seen.push(+getComputedStyle(w).opacity); performance.now() - t0 < 700 ? requestAnimationFrame(f) : res(seen); }; requestAnimationFrame(f); }));
    await pageL.click('#path .tog[data-t="c"]');
    const mid = (await fading).filter(o => o > 0 && o < 1).length;
    await pageL.waitForTimeout(600);
    const wOff = await caps();
    check("cap: Chunks off hides every widget (faded, not cut: seen part way)", wOff.every(w => w.off && w.op === 0 && w.vis === "hidden") && mid > 0, JSON.stringify({ mid, wOff }));
    if (process.env.SHOT) await shotL("path-cap-chunks-off");
    await pageL.click('#path .tog[data-t="c"]');
    await pageL.waitForTimeout(900);
    const wOn = await caps();
    check("cap: Chunks on again shows them with their levels", wOn.every(w => !w.off && w.op === 1 && w.vis === "visible") && wOn.map(w => w.v).join() === "1,0,3", JSON.stringify(wOn));
    // press and drag (path.ts capDown): a strip of the four levels pops out above the widget (clear of the goal pill), the
    // current one marked; the option under the held pointer is lit; letting go on one picks it, anywhere else or after Esc
    // nothing changes; a press that never leaves the widget still steps round. The sticker scales .75 / .9 / 1 / 1.15 by level
    const SCALES = [0.75, 0.9, 1, 1.15];
    const ctr = sel => pageL.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; }, sel);
    const strip = lane => pageL.evaluate(lane => { const scale = e => { const v = /matrix\(([^,]+)/.exec(getComputedStyle(e).transform); return v ? Math.round(+v[1] * 1000) / 1000 : 1; }, el = document.querySelector(".ccpick"); if (!el) return null;
      const b = el.firstElementChild, w = document.querySelector(`#path .lane.${lane} .ccap`).getBoundingClientRect(), g = document.querySelector(`#path .lane.${lane} .lend .goal`).getBoundingClientRect(), r = el.getBoundingClientRect();
      return { on: el.classList.contains("on"), op: +getComputedStyle(b).opacity, above: r.bottom <= w.top + 1, clear: r.bottom <= g.top + 1 || r.right <= g.left + 1, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0,
        opts: [...b.children].map(o => ({ v: +o.dataset.v, cur: o.classList.contains("cur"), hot: o.classList.contains("hot"), s: scale(o.querySelector(".cic")), lit: o.querySelectorAll(".pips i.lit").length })) }; }, lane);
    const iconScales = () => pageL.evaluate(() => { const scale = e => { const v = /matrix\(([^,]+)/.exec(getComputedStyle(e).transform); return v ? Math.round(+v[1] * 1000) / 1000 : 1; };
      return [...document.querySelectorAll("#path .ccap")].map(w => ({ v: +w.dataset.v, s: scale(w.querySelector(".cic")), pip: w.querySelector(".pips i").offsetWidth })); });
    const lastMc = async (want, ms = 5000) => { const t0 = Date.now(); for (;;) { const p = await plans(); if (JSON.stringify(p.at(-1)?.mc) === want || Date.now() - t0 > ms) return p; await pageL.waitForTimeout(100); } };
    await pageL.evaluate(() => { document.activeElement?.blur?.(); document.querySelector("#path .lanes").scrollIntoView({ block: "end" }); });
    await pageL.waitForTimeout(300);
    // head (at most 10): drag onto 30+ and let go
    n = (await plans()).length;
    const h1 = await ctr("#path .lane.t1 .ccap");
    await pageL.mouse.move(h1.x, h1.y);
    const popping = pageL.evaluate(() => new Promise(res => { const seen = [], t0 = performance.now(); const f = () => { const b = document.querySelector(".ccpick .ccin"); if (b) seen.push(+getComputedStyle(b).opacity); performance.now() - t0 < 400 ? requestAnimationFrame(f) : res(seen); }; requestAnimationFrame(f); }));
    await pageL.mouse.down();
    const sPop = (await popping).filter(o => o > 0 && o < 1).length;
    const sRest = await strip("t1");
    if (process.env.SHOT) await pageL.screenshot({ path: path.join(here, "out", "path-cap-scales.png"), clip: await pageL.evaluate(() => { const r = document.querySelector(".ccpick").getBoundingClientRect(); return { x: r.x - 12, y: r.y - 12, width: r.width + 24, height: r.height + 24 }; }) });
    const o3 = await ctr('.ccpick .cco[data-v="3"]');
    await pageL.mouse.move(o3.x, h1.y, { steps: 8 });                       // sideways only: y stays on the widget
    await pageL.waitForTimeout(200);
    const sHot = await strip("t1"), reqHeld = (await plans()).length - n;
    if (process.env.SHOT) await pageL.screenshot({ path: path.join(here, "out", "path-cap-pick.png"), clip: await pageL.evaluate(() => { const a = document.querySelector(".ccpick").getBoundingClientRect(), b = document.querySelector("#path .lane.t1").getBoundingClientRect(); const x = Math.min(a.x, b.x) - 12, y = Math.min(a.y, b.y) - 12; return { x, y, width: Math.max(a.right, b.right) + 12 - x, height: Math.min(900, Math.max(a.bottom, b.bottom) + 12) - y }; }) });
    await pageL.mouse.up();
    const pDrag = (await lastMc('["none",0,"none"]')).slice(n);
    await pageL.waitForTimeout(400);
    const wDrag = await caps(), goneDrag = await pageL.evaluate(() => !document.querySelector(".ccpick"));
    const savedDrag = await pageL.evaluate(async () => { const { store } = await import("/src/store.ts"); await store.flush(); return store.get("seedtracker.chunkcap"); });
    check("cap drag: the press pops a strip above the widget, clear of the goal pill and on screen, scaling and fading in (seen part way)",
      sPop > 0 && sRest && sRest.op === 1 && sRest.above && sRest.clear && sRest.inView, JSON.stringify({ sPop, sRest: sRest && { ...sRest, opts: undefined } }));
    check("cap drag: the strip shows the 4 levels side by side (0-3 pips lit), the current one (at most 10) marked, none lit before the pointer moves",
      sRest && sRest.opts.map(o => `${o.v}${o.lit}${o.cur ? "c" : ""}${o.hot ? "h" : ""}`).join() === "00,11c,22,33", JSON.stringify(sRest?.opts));
    check("cap drag: the strip's stickers scale .75 / .9 / 1 / 1.15 by level", sRest && sRest.opts.map(o => o.s).join() === SCALES.join(), JSON.stringify(sRest?.opts));
    check("cap drag: held over 30+ it is lit and nothing is asked yet", sHot && sHot.opts.filter(o => o.hot).map(o => o.v).join() === "3" && reqHeld === 0, JSON.stringify({ hot: sHot?.opts, reqHeld }));
    check("cap drag: let go on 30+ -> the head is 30 or more, saved, its maxChunks left out (only it replans), the strip gone",
      wDrag[0].v === 3 && wDrag[0].lit === 3 && wDrag[1].v === 0 && wDrag[2].v === 3 && savedDrag?.["4:0"] === 3 && pDrag.length >= 1 && pDrag.every(q => JSON.stringify(q.mc) === '["none",0,"none"]') && goneDrag,
      JSON.stringify({ w: wDrag.map(w => w.v), savedDrag, pDrag, goneDrag }));
    // tee (none): slide far to the left: it stays on none (the lowest level) and nothing changes
    n = (await plans()).length;
    const t2 = await ctr("#path .lane.t2 .ccap");
    await pageL.mouse.move(t2.x, t2.y); await pageL.mouse.down(); await pageL.waitForTimeout(150);
    await pageL.mouse.move(t2.x - 320, t2.y + 10, { steps: 8 }); await pageL.waitForTimeout(100);
    const sOff = await strip("t2");
    await pageL.mouse.up(); await pageL.waitForTimeout(700);
    const wOut = await caps(), pOut = (await plans()).slice(n), goneOut = await pageL.evaluate(() => !document.querySelector(".ccpick"));
    check("cap drag: sliding past the left end stays on none -> no change, nothing asked, the strip gone",
      sOff && sOff.opts.filter(o => o.hot).map(o => o.v).join() === "0" && wOut.map(w => w.v).join() === "3,0,3" && pOut.length === 0 && goneOut, JSON.stringify({ sOff: sOff?.opts, w: wOut.map(w => w.v), pOut, goneOut }));
    // shoes (30+): slide onto "at most 10", Esc while held, let go there: no change
    n = (await plans()).length;
    const t3 = await ctr("#path .lane.t3 .ccap");
    await pageL.mouse.move(t3.x, t3.y); await pageL.mouse.down(); await pageL.waitForTimeout(150);
    const o1 = await ctr('.ccpick .cco[data-v="1"]');
    await pageL.mouse.move(o1.x, t3.y, { steps: 6 }); await pageL.waitForTimeout(100);
    const sEsc = await strip("t3");
    await pageL.keyboard.press("Escape"); await pageL.waitForTimeout(60);
    const goneEsc = await pageL.evaluate(() => !document.querySelector(".ccpick.on"));
    await pageL.mouse.up(); await pageL.waitForTimeout(700);
    const wEsc = await caps(), pEsc = (await plans()).slice(n);
    check("cap drag: Esc while held closes the strip (fading) and the release then changes nothing",
      sEsc && sEsc.opts.find(o => o.hot)?.v === 1 && goneEsc && wEsc.map(w => w.v).join() === "3,0,3" && pEsc.length === 0, JSON.stringify({ hot: sEsc?.opts, goneEsc, w: wEsc.map(w => w.v), pEsc }));
    // a plain click (no drag) still steps round: head 3 -> 0
    n = (await plans()).length;
    await pageL.click("#path .lane.t1 .ccap");
    const pClk = (await lastMc("[0,0,\"none\"]")).slice(n);
    await pageL.waitForTimeout(400);
    const wClk = await caps(), sc0 = await iconScales();
    check("cap: a plain click still steps round (30+ -> none), only that lane replans",
      wClk[0].v === 0 && pClk.length >= 1 && pClk.every(q => JSON.stringify(q.mc) === '[0,0,"none"]'), JSON.stringify({ w: wClk.map(w => w.v), pClk }));
    // the widgets' stickers by level (levels 1 and 2 set by the arrows), the pips the same size at every level
    await pageL.focus("#path .lane.t1 .ccap"); await pageL.keyboard.press("ArrowRight"); await pageL.waitForTimeout(150);
    await pageL.focus("#path .lane.t2 .ccap"); await pageL.keyboard.press("ArrowRight"); await pageL.keyboard.press("ArrowRight"); await pageL.waitForTimeout(500);
    const sc1 = await iconScales();
    check("cap: the widget's sticker scales .75 / .9 / 1 / 1.15 by level, the pips don't",
      [...sc0, ...sc1].every(x => x.s === SCALES[x.v]) && new Set([...sc0, ...sc1].map(x => x.v)).size === 4 && new Set([...sc0, ...sc1].map(x => Math.round(x.pip * 10))).size === 1, JSON.stringify({ sc0, sc1 }));
    if (process.env.SHOT) await shotL("path-cap-icons");
    await ctxL.close();
  }
  // 5e. locked slots: a piece with 1 open slot (rarity 0) and goals in all 3 slots gets 2 unlock steps (a Super Sea Snail
  // each, at Murch; two in a row draw as one cell) before its rolls; one with 2 open slots (rarity 1) and goal "" in slot 3 gets none and never rolls into
  // slot 3. The request carries openSlots (omitted when 3); Up next says "Unlock slot 2"; a snails badge counts them.
  {
    const nextRolls = (seed, n) => ref({ fn: "rolls", seed, brand: "B03", drink: null, n }).rolls.map(r => r.ability);
    const LK = [pc("head", 1, [], { seed: 5150, rarity: 0 }), pc("clothes", 2, [], { seed: 6160, rarity: 1 }), pc("shoes", 3, [S, R], { seed: 31337 })];
    const LKG = { head: nextRolls(5150, 3), clothes: [...nextRolls(6160, 2), ""], shoes: ["", "", ""] };
    const LKB = { ...BUILD, id: 5, title: "Locked slots", set: ["head", "clothes", "shoes"].map(s => [ROWS[s], "", LKG[s]]) };
    const expL = ref({ fn: "plan", ...pin(LK, LKG) });
    const kinds = l => l.steps.map(s => s.k);
    check("setup: locked slots: the core unlocks 2 and 3 first on the 1-slot head, nothing on the 2-slot tee", expL.ok &&
      JSON.stringify(kinds(expL.lanes[0])) === JSON.stringify(["unlock", "unlock", "roll", "roll", "roll"]) && expL.lanes[0].steps[0].slot === 2 &&
      JSON.stringify(kinds(expL.lanes[1])) === JSON.stringify(["roll", "roll"]) && expL.totals.snails === 2, JSON.stringify(expL).slice(0, 600));
    const ctxK = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    await ctxK.addInitScript(b => {
      try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "5"); } } catch {}
      window.__open = [];
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { const q = m && m.req; if (q && q.fn === "plan" && !q.whatIf && !q.from) window.__open.push(q.pieces.map(p => p.openSlots ?? null)); return post.call(this, m, ...rest); };
    }, LKB);
    await ctxK.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
    const pageK = await ctxK.newPage();
    pageK.on("pageerror", e => errs.push(String(e)));
    await pageK.route("**/img/**", r => r.fallback());
    await pageK.route("**/api/**", handle);
    setSnaps({ botbase: snap("botbase", LK) });
    await pageK.goto(url);
    await pageK.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
    await pageK.click('.tab[data-s="builds"]');
    const eK = expect(expL, idx3), rK = await untilDom(pageK, eK);
    check("locked slots: the Path draws the core's lanes", rK.ok, JSON.stringify(rK.got).slice(0, 400) + " WANT " + eK.sig.slice(0, 400));
    await pageK.waitForTimeout(900);
    const seen = await pageK.evaluate(() => {
      const lanes = [...document.querySelectorAll("#path .lane")].map(l => [...l.querySelectorAll(".track .step:not(.ph)")]
        .sort((a, b) => parseInt(a.style.gridColumn) - parseInt(b.style.gridColumn))
        .map(s => s.classList.contains("unlock") ? `unlock:${s.querySelector(".ab")?.dataset.tip}|${s.querySelector(".n")?.textContent}|${s.querySelector(".cnum")?.textContent || ""}` : s.classList.contains("tool") ? "scrub" : "roll"));
      const up = document.querySelector("#path .tag.next .utitle .upg.on h2")?.textContent || "";
      const badge = [...document.querySelectorAll("#path .tag.next .badges .badge")].map(b => b.textContent.replace(/\s+/g, " ").trim()).find(t => /snail/.test(t)) || "";
      return { lanes, up, badge, plans: window.__open };
    });
    const t23 = "Slots 2, 3";
    check("locked slots: the 1-slot head unlocks slots 2 and 3 in one Murch cell (snail ×2, labelled Unlock 2) before its rolls; the tee has no unlock",
      JSON.stringify(seen.lanes[0]) === JSON.stringify([`unlock:${t23}|Unlock 2|×2`, "roll", "roll", "roll"]) &&
      JSON.stringify(seen.lanes[1]) === JSON.stringify(["roll", "roll"]), JSON.stringify(seen.lanes));
    check("locked slots: every plan request carries openSlots 1 and 2 (none for the piece without star info)",
      seen.plans.length > 0 && seen.plans.every(o => JSON.stringify(o) === "[1,2,null]"), JSON.stringify(seen.plans));
    check("locked slots: Up next says unlock slot 2; a badge counts 2 snails", seen.up === "Unlock slot 2" && seen.badge === "2 snails", JSON.stringify({ up: seen.up, badge: seen.badge }));
    if (process.env.SHOT) {
      await pageK.screenshot({ path: path.join(here, "out", "path-unlock.png") });
      // clipped page shots: a live "state" event may redraw #path (a new element) while a locator shot waits for it
      const clip = sel => pageK.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, sel);
      await pageK.screenshot({ path: path.join(here, "out", "path-unlock-lane.png"), clip: await clip("#path .lane") });
      await pageK.screenshot({ path: path.join(here, "out", "path-unlock-upnext.png"), clip: await clip("#path .tag.next") });
    }
    await ctxK.close();
  }
  // 5f. the main ability: a goal main that differs from the piece's (and has chunks) is a first step of its own, "Main" x45 chunks,
  // before everything else; its 45 chunks come off the stock in the plan request and the lane's cap stays; short of chunks the x45 is
  // red; a main-only goal the piece lacks has no step and says it needs a piece that already has it.
  {
    const MP = [{ ...botbasePieces[0], main: MI }, { ...botbasePieces[1], main: R }, { ...botbasePieces[2], main: MI }];
    const MB = { ...BUILD, id: 6, title: "Main swap", set: [[ROWS.head, S, GOALS.head], [ROWS.clothes, "ExSkillDouble", GOALS.clothes], [ROWS.shoes, "", GOALS.shoes]] };   // ExSkillDouble: no recipe
    const withStock = n => ({ botbase: { ...snap("botbase", MP), stock: { chunks: { [S]: n, [R]: 10 }, drinks: {} } } });
    const ctxM = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    await ctxM.addInitScript(b => {
      try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "6"); } } catch {}
      window.__mp = [];
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { const q = m && m.req; if (q && q.fn === "plan" && !q.whatIf && !q.from) window.__mp.push({ ch: q.chunks, mc: q.pieces.map(p => p.maxChunks ?? null) }); return post.call(this, m, ...rest); };
    }, MB);
    await ctxM.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
    const pageM = await ctxM.newPage();
    pageM.on("pageerror", e => errs.push(String(e)));
    await pageM.route("**/img/**", r => r.fallback());
    await pageM.route("**/api/**", handle);
    setSnaps(withStock(80));
    await pageM.goto(url);
    await pageM.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
    await pageM.click('.tab[data-s="builds"]');
    const grab = () => pageM.evaluate(() => {
      const base = u => (u || "").split("/").pop().replace(".png", "");
      const lanes = [...document.querySelectorAll("#path .lane")].map(l => {
        const steps = [...l.querySelectorAll(".track .step:not(.ph):not(.pcs)")].sort((a, b) => parseInt(a.style.gridColumn) - parseInt(b.style.gridColumn));
        return { first: steps[0] ? { n: steps[0].querySelector(".n")?.textContent, img: base(steps[0].querySelector('img[src*="/skill/"]')?.src), cnum: steps[0].querySelector(".cnum")?.textContent || "", lack: !!steps[0].querySelector(".cnum.lack"), tip: steps[0].querySelector(".cnum")?.dataset.tip || "" } : null,
          mains: steps.filter(s => s.querySelector(".n")?.textContent === "Main").length,
          head: l.querySelector(".have .ab.main") ? { img: base(l.querySelector(".have .ab.main img")?.src), title: l.querySelector(".have .ab.main").dataset.tip } : null,
          goal: l.querySelector(".goal .ab.main") ? { img: base(l.querySelector(".goal .ab.main img")?.src) || "any", wrong: l.querySelector(".goal .ab.main").classList.contains("wrong"), title: l.querySelector(".goal .ab.main").dataset.tip } : null };
      });
      const next = [...document.querySelectorAll("#path .tag.next .utitle .upg h2")].map(h => h.textContent);
      const badge = [...document.querySelectorAll("#path .tag.next .badges .badge")].map(b => b.textContent.replace(/\s+/g, " ").trim()).find(t => /chunk/.test(t)) || "";
      return { lanes, next, badge, plans: window.__mp };
    });
    const has = async (f, ms = 30000) => { const t0 = Date.now(); let g; while (Date.now() - t0 < ms) { g = await grab(); if (f(g)) return g; await new Promise(r => setTimeout(r, 250)); } return g; };
    const g1 = await has(g => g.lanes.length === 3 && g.lanes[0].first?.n === "Main" && g.plans.length > 0);
    check("main: the head lane's first step is the Main swap (Swim Speed Up, x45 chunks), nothing else in the lane is one",
      g1.lanes[0].first && g1.lanes[0].first.n === "Main" && g1.lanes[0].first.img === S && g1.lanes[0].first.cnum === "×45" && !g1.lanes[0].first.lack && g1.lanes.map(l => l.mains).join() === "1,0,0", JSON.stringify(g1.lanes));
const lendGeo = pg => pg.evaluate(() => [...document.querySelectorAll("#path .lane")].map(l => { const e = l.querySelector(".lend").getBoundingClientRect(), g = l.querySelector(".goal").getBoundingClientRect(), c = l.querySelector(".ccap")?.getBoundingClientRect(), k = l.querySelector(".lcost")?.getBoundingClientRect(), chips = [...l.querySelectorAll(".lcost .lc")].map(x => x.getBoundingClientRect());
      return { cl: c && Math.round(c.left - e.left), cw: c && Math.round(c.width), gl: Math.round(g.left - e.left), gw: Math.round(g.width), el: Math.round(e.width), main: !!l.querySelector(".goal .ab.main"), gap: c ? Math.round((g.left - c.right) * 10) / 10 : null, goalIn: g.left >= e.left - 1 && g.right <= e.right + 1, chips: chips.length, costIn: !chips.length || chips.every(x => x.left >= e.left - 1 && x.right <= e.right + 1), costRight: chips.length ? Math.round(e.right - Math.max(...chips.map(x => x.right))) : null }; }));
    let lg1 = await lendGeo(pageM); for (let k = 0; k < 40 && !lg1.every(x => x.el > 0); k++) { await pageM.waitForTimeout(250); lg1 = await lendGeo(pageM); }   // the screen can still be fading in
    check("lend: with a main ring the cap sits 8px or more clear left of its goal pill, the pill and the cost row inside the lane's end", lg1.length === 3 && lg1.every(x => x.main && x.gap >= 8 && x.goalIn && x.costIn), JSON.stringify(lg1));
const lg4 = await pageM.evaluate(async () => {                                        // the widest cost row: 1,330 rolls, 12 tickets, 140 chunks, 2 snails
      const m = await import("/src/path.ts"), host = document.getElementById("path"), D = "SquidMove_Up";
      const html = m.laneCost([{ k: "roll", a: D, times: 1234 }, { k: "drink", a: D, d: D, times: 96 }, { k: "slap", a: D, cost: 140 }, { k: "unlock", slot: 2 }, { k: "unlock", slot: 3 }]);
      const keep = [...host.querySelectorAll(".lanes > .lane .lend > .lcost")].map(k => [k, k.outerHTML]);
      for (const [k] of keep) k.outerHTML = html;
      m.fitCosts(host);
      const out = [...host.querySelectorAll(".lanes > .lane")].map(l => { const e = l.querySelector(".lend").getBoundingClientRect(), k = l.querySelector(".lcost"), r = [...k.children].filter(x => !x.hidden).map(x => x.getBoundingClientRect());
        return { n: r.length, inside: r.every(x => x.left >= e.left - 1 && x.right <= e.right + 1), line: r.every(x => Math.abs(x.top - r[0].top) < 2), tip: k.querySelector('.lc[data-tip^="Rolls left"]')?.dataset.tip, tight: k.classList.contains("tight") }; });
      [...host.querySelectorAll(".lanes > .lane .lend > .lcost")].forEach((k, i) => { k.outerHTML = keep[i][1]; });
      m.fitCosts(host);
      return out; });
    check("lend: the widest cost row (rolls, tickets, chunks, snails) stays on one line inside the lane's end, stepped down, what doesn't fit named in the rolls tooltip",
      lg4.length === 3 && lg4.every(x => x.inside && x.line && x.n >= 2 && x.tight && (x.n === 4 || /\+/.test(x.tip))), JSON.stringify(lg4));
{ await pageM.waitForTimeout(400);                                                  // the three lanes' right ends, as the screen draws them
      const clip = await pageM.evaluate(() => { document.activeElement?.blur?.(); document.querySelector("#path .lanes").scrollIntoView({ block: "end" }); const r = document.querySelector("#path .lanes").getBoundingClientRect(), y = Math.max(0, r.y); return { x: Math.max(0, r.right - 330), y, width: Math.min(330, r.width), height: Math.min(r.bottom, 900) - y }; });
      await pageM.waitForTimeout(300); await pageM.screenshot({ path: path.join(here, "out", "w5-lend.png"), clip }); }
    const p1 = g1.plans[g1.plans.length - 1];
    check("main: the plan request has 45 fewer chunks of that ability than the stock (80 -> 35, the others as they were); every lane's maxChunks is still its cap (20)",
      p1 && p1.ch[S] === 35 && p1.ch[R] === 10 && JSON.stringify(p1.mc) === "[20,20,20]", JSON.stringify(p1));
    check("main: the lane head shows the piece's main (Ink Saver), the goal pill the build's (Swim Speed Up); the open main is an empty ring; the main-only goal is a dimmed ring and says what it needs",
      g1.lanes[0].head?.img === MI && g1.lanes[0].goal?.img === S && !g1.lanes[0].goal.wrong && g1.lanes[1].head?.img === R && g1.lanes[2].goal?.img === "any"
      && g1.lanes[1].goal?.wrong === true && /^Needs .+ main$/.test(g1.lanes[1].head?.title) && /^Needs .+ main$/.test(g1.lanes[1].goal?.title) && !g1.lanes[1].first?.n?.startsWith("Main"), JSON.stringify(g1.lanes));
    check("main: Up next says to swap main, and its chunk badge counts the 45",
      g1.next.some(t => t === "Swap main") && /(^|\D)(\d+) chunks/.test(g1.badge) && +/(\d+) chunks/.exec(g1.badge)[1] >= 45, JSON.stringify({ next: g1.next, badge: g1.badge }));
    if (process.env.SHOT) {
      await pageM.waitForTimeout(500);
      fs.mkdirSync(path.join(here, "out"), { recursive: true });
      const clip = await pageM.evaluate(() => { document.activeElement?.blur?.(); document.querySelector("#path .lanes").scrollIntoView({ block: "start" }); const r = document.querySelector("#path .lanes").getBoundingClientRect(); return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, 900 - Math.max(0, r.y)) }; });
      await pageM.waitForTimeout(300);
      await pageM.screenshot({ path: path.join(here, "out", "path-main.png"), clip });
    }
    setSnaps(withStock(30));                                                     // fewer than 45 of it: the cost goes red and the tooltip says how many
    const g2 = await has(g => g.lanes[0]?.first?.lack === true);
    check("main: with 30 of those chunks the x45 shows red and its tooltip says 15 short; the request has none of that ability left",
      g2.lanes[0].first?.lack === true && g2.lanes[0].first.cnum === "×45" && /15 short/.test(g2.lanes[0].first.tip) && g2.plans[g2.plans.length - 1].ch[S] === 0, JSON.stringify({ l: g2.lanes[0].first, p: g2.plans[g2.plans.length - 1] }));
    await ctxM.close();
    // a main-only goal with a recipe (Comeback on the head: 15 each of Run Speed Up, Swim Speed Up and Special Charge Up): one Main step
    // with the three chunk kinds x15, 15 of each off the stock in the plan request; short of one of them the x15 goes red
    const HM = "HumanMove_Up", SP = "SpecialIncrease_Up";
    const CB = { ...BUILD, id: 7, title: "Comeback", set: [[ROWS.head, "ComeBack", GOALS.head], [ROWS.clothes, "", GOALS.clothes], [ROWS.shoes, "", GOALS.shoes]] };
    const cbStock = { botbase: { ...snap("botbase", MP), stock: { chunks: { [S]: 80, [HM]: 100, [SP]: 14 }, drinks: {} } } };
    const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    await ctxC.addInitScript(b => {
      try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "7"); } } catch {}
      window.__mp = [];
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { const q = m && m.req; if (q && q.fn === "plan" && !q.whatIf && !q.from) window.__mp.push({ ch: q.chunks, mc: q.pieces.map(p => p.maxChunks ?? null) }); return post.call(this, m, ...rest); };
    }, CB);
    await ctxC.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
    const pageC = await ctxC.newPage();
    pageC.on("pageerror", e => errs.push(String(e)));
    await pageC.route("**/img/**", r => r.fallback());
    await pageC.route("**/api/**", handle);
    setSnaps(cbStock);
    await pageC.goto(url);
    await pageC.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
    await pageC.click('.tab[data-s="builds"]');
    const grabC = () => pageC.evaluate(() => {
      const base = u => (u || "").split("/").pop().replace(".png", "");
      const l = document.querySelector("#path .lane.t1"), st = l && [...l.querySelectorAll(".track .step:not(.ph)")].sort((a, b) => parseInt(a.style.gridColumn) - parseInt(b.style.gridColumn))[0];
      const l2 = document.querySelector("#path .lane.t2 .goal .ab.main");
      return { n: st?.querySelector(".n")?.textContent, imgs: st ? [...st.querySelectorAll('.chunktrio img[src*="/skill/"]')].map(i => base(i.src)) : [], cnum: st?.querySelector(".cnum")?.textContent || "", lack: !!st?.querySelector(".cnum.lack"),
        tip: st?.querySelector(".cnum")?.dataset.tip || "", up: [...document.querySelectorAll("#path .tag.next .utitle .upg h2")].map(h => h.textContent), any: !!l2 && l2.classList.contains("empty"), plans: window.__mp };
    });
    let gc; { const t0 = Date.now(); while (Date.now() - t0 < 30000) { gc = await grabC(); if (gc.n === "Main" && gc.plans.length) break; await new Promise(r => setTimeout(r, 250)); } }
    const pc1 = gc.plans[gc.plans.length - 1];
    check("main recipe: Comeback on the head is one Main step with its three chunk kinds (Run Speed Up, Swim Speed Up, Special Charge Up) x15, red as Special Charge Up is short",
      gc.n === "Main" && JSON.stringify(gc.imgs) === JSON.stringify([HM, S, SP]) && gc.cnum === "×15" && gc.lack === true && /1 Special Charge Up short/.test(gc.tip), JSON.stringify(gc));
    check("main recipe: 15 of each kind came off the stock in the plan request (100 -> 85, 80 -> 65, 14 -> 0), the caps stay, the open main on the clothes is an empty ring, Up next says Swap main",
      pc1 && pc1.ch[HM] === 85 && pc1.ch[S] === 65 && pc1.ch[SP] === 0 && JSON.stringify(pc1.mc) === "[20,20,20]" && gc.any && gc.up.some(t => t === "Swap main"), JSON.stringify({ pc1, any: gc.any, up: gc.up }));
    if (process.env.SHOT) { await pageC.waitForTimeout(400); const clip = await pageC.evaluate(() => { document.querySelector("#path .lanes").scrollIntoView({ block: "start" }); const r = document.querySelector("#path .lane.t1").getBoundingClientRect(); return { x: r.x, y: Math.max(0, r.y), width: r.width, height: r.height }; }); await pageC.screenshot({ path: path.join(here, "out", "path-main-recipe.png"), clip }); }
    await ctxC.close();
    // 5g. the calculating lanes turn into the real ones in place (W13, W16): the main swap build's first plan held back 2.5 s; every
    // real cell lies where a calculating cell was (same column, x and row within 2px; the Main first, the other lanes a dot
    // there), the calculating rows show just the whole columns in view, the plan lands cell by cell left to right (each lane's
    // real cells in view shown as a prefix that only grows, the lanes top first, calculating cells still on the rest), and no
    // lane's have row or cost row leaves its lane (the lane's ragged edge cuts up to 6% at the bottom) while calculating or after, at 1920x1080 and 1440x900
    for (const [vw, vh] of [[1920, 1080], [1440, 900]]) {
      const ctxG = await browser.newContext({ viewport: { width: vw, height: vh }, locale: "en-US", timezoneId: "UTC" });
      await ctxG.addInitScript(b => {
        try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "6"); } } catch {}
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (m, ...rest) { const q = m && m.req; if (q && q.fn === "plan" && !q.whatIf && !q.from) { setTimeout(() => post.call(this, m, ...rest), 2500); return; } return post.call(this, m, ...rest); };
        window.__landFrames = [];
        new MutationObserver(() => {                                                   // from the frame the real lanes arrive after .pcalc: each lane's real cells in view, shown (1) or not yet (0), left to right
          if (!window.__sawCalc) { if (document.querySelector("#path .lanes > .pcalc")) window.__sawCalc = true; return; }
          if (window.__landAt || document.querySelectorAll("#path .lanes > .lane").length !== 3) return;
          window.__landAt = performance.now();
          const f = () => {
            const lanes = [...document.querySelectorAll("#path .lanes > .lane")].map(l => { const t = l.querySelector(".track.grid"); if (!t) return ""; const c = parseFloat(getComputedStyle(t).gridTemplateColumns), whole = Math.floor(t.parentElement.clientWidth / c + 1e-6);
              return [...t.children].filter(el => !el.classList.contains("pcs")).map(el => [parseInt(el.style.gridColumn), +getComputedStyle(el).opacity > 0 ? 1 : 0]).filter(x => x[0] <= whole).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(""); });
            window.__landFrames.push({ t: performance.now() - window.__landAt, lanes, pcs: document.querySelectorAll("#path .lanes > .lane .step.pcs").length });
            if (performance.now() - window.__landAt < 3000) requestAnimationFrame(f);
          };
          f();
        }).observe(document, { subtree: true, childList: true });
      }, MB);
      await ctxG.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
      const pageG = await ctxG.newPage();
      pageG.on("pageerror", e => errs.push(String(e)));
      await pageG.route("**/img/**", r => r.fallback());
      await pageG.route("**/api/**", handle);
      setSnaps(withStock(80));
      await pageG.goto(url);
      await pageG.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
      await pageG.click('.tab[data-s="builds"]');
      const geoG = sel => pageG.evaluate(sel => [...document.querySelectorAll(sel)].map(l => {
        l.style.transform = "none";                                                    // the lanes' .3-.4deg tilt off while measuring
        const lr = l.getBoundingClientRect(), z = lr.height / l.offsetHeight, low = lr.top + .94 * lr.height;
        const cells = [...l.querySelectorAll(".track > .step")].filter(c => getComputedStyle(c).visibility !== "hidden" && +getComputedStyle(c).opacity > 0)
          .map(c => { const r = c.getBoundingClientRect(), v = c.querySelector(".vis").getBoundingClientRect(); return { col: parseInt(c.style.gridColumn), x: (r.left - lr.left) / z, y: (v.top - lr.top) / z, n: c.querySelector(".n")?.textContent || "" }; });
        const have = l.querySelector(".have").getBoundingClientRect(), e = l.querySelector(".lend").getBoundingClientRect();
        const chips = [...l.querySelectorAll(".lend > .lcost:not(.pcghost) > :not([hidden])")].map(x => x.getBoundingClientRect());
        const ok = { have: have.bottom <= low && have.left >= lr.left && have.top >= lr.top, cost: chips.every(x => x.left >= e.left - 1 && x.right <= e.right + 1 && x.bottom <= low && Math.abs(x.top - chips[0].top) < 2) };
        l.style.transform = "";
        return { cells, ok, h: l.offsetHeight, haveLow: Math.round((low - have.bottom) / z) };
      }), sel);
      await waitFor(pageG, () => document.querySelectorAll("#path .lanes > .pcalc:not(.out) > .pclane").length === 3, null, 15000);
      await pageG.waitForTimeout(900);
      const calcG = await geoG("#path .lanes > .pcalc:not(.out) > .pclane");
      const wholeG = await pageG.evaluate(() => { const v = document.querySelector("#path .pctview"); return Math.floor(v.clientWidth / parseFloat(getComputedStyle(v.firstElementChild).gridTemplateColumns) + 1e-6); });
      if (vw === 1920) await pageG.screenshot({ path: path.join(here, "out", "w13-calc.png") });
      const heldG = await waitFor(pageG, () => !!window.__landAt, null, 20000);
      if (vw === 1920) for (const [k, at] of [[1, 380], [2, 760], [3, 1140]]) {          // three moments of the landing: left cells real, right ones still rolling
        await pageG.evaluate(at => new Promise(res => { const f = () => performance.now() - window.__landAt >= at ? res() : requestAnimationFrame(f); f(); }), at);
        await pageG.screenshot({ path: path.join(here, "out", `w16-land-${k}.png`) });
      }
      await waitFor(pageG, () => !document.querySelector("#path .pcalc, #path .lanes .pcs, #path .pcnext"), null, 6000);
      await pageG.waitForTimeout(600);
      const realG = await geoG("#path .lanes > .lane");
      if (vw === 1920) await pageG.screenshot({ path: path.join(here, "out", "w13-path.png") });
      const framesG = await pageG.evaluate(() => window.__landFrames);
      const onesG = framesG.map(f => f.lanes.map(s => (s.match(/1/g) || []).length));
      const lrG = framesG.length > 10 && framesG.every(f => f.lanes.every(s => /^1*0*$/.test(s))) && onesG.every((o, k) => !k || o.every((n, i) => n >= onesG[k - 1][i])) && onesG.every(o => o[0] >= o[1] && o[1] >= o[2])
        && framesG.some(f => /^1+0+$/.test(f.lanes[0]) && f.pcs > 0) && framesG[framesG.length - 1].lanes.every(s => !s.includes("0"));
      const firstFull = framesG.find(f => f.lanes.every(s => s && !s.includes("0")))?.t;
      console.log(`(info) ${vw}x${vh}: landing ${framesG.length} frames, all lanes landed at ${firstFull?.toFixed(0)} ms; ${framesG.filter((f, i) => i % 8 === 0).map(f => f.lanes.join("/")).join(" ")}`);
      check(`calc lands left to right (${vw}x${vh}): each lane's real cells in view show as a growing prefix, top lane first, calculating cells on the rest, all landed by ~1.6 s`,
        lrG && firstFull < 1700, JSON.stringify({ firstFull, frames: framesG.filter((f, i) => i % 6 === 0).map(f => [Math.round(f.t), f.lanes.join("/"), f.pcs]) }));
      const miss = realG.flatMap((l, i) => l.cells.filter(c => { const p = calcG[i]?.cells.find(x => x.col === c.col); return !p || Math.abs(p.x - c.x) > 2 || Math.abs(p.y - c.y) > 2; }).map(c => ({ lane: i, ...c, calc: calcG[i]?.cells.find(x => x.col === c.col) || null })));
      const firstG = realG.map(l => l.cells.find(c => c.col === 1)?.n ?? null), firstC = calcG.map(l => l.cells.find(c => c.col === 1)?.n ?? null);
      console.log(`(info) ${vw}x${vh}: calculating cells a lane ${calcG.map(l => l.cells.length)}, real ${realG.map(l => l.cells.length)}, whole columns ${wholeG}; have row clear of the bottom edge by ${realG.map(l => l.haveLow)} px`);
      check(`calc to lanes (${vw}x${vh}): every real cell lies on a calculating cell (same column, x and row within 2px), column 1 the Main in the swap lane and a dot in the others (Murch work the planner adds there can't be known), the calculating rows show the ${wholeG} whole columns in view, after the landing`,
        heldG && realG.length === 3 && calcG.length === 3 && miss.length === 0 && firstG[0] === "Main" && firstC[0] === "Main" && firstC.slice(1).every(n => n === "") && calcG.every(l => l.cells.length === wholeG && l.cells.every(c => c.col <= wholeG)) && calcG.concat(realG).every(l => l.h === 180),
        JSON.stringify({ heldG, miss: miss.slice(0, 4), firstG, firstC, wholeG, calc: calcG.map(l => l.cells.map(c => c.col)) }));
      check(`no overflow (${vw}x${vh}): every lane's have row and cost row stay inside its lane (cost on one line), calculating and real`,
        calcG.concat(realG).every(l => l.ok.have && l.ok.cost), JSON.stringify(calcG.concat(realG).map(l => ({ ...l.ok, haveLow: l.haveLow }))));
      await ctxG.close();
    }
  }
  if (process.env.ONLY === "nopiece") { await browser.close(); await server.close(); console.log(failed ? "FAILED" : "ALL PASS"); process.exit(failed ? 1 : 0); }   // ONLY=nopiece: just sections 1-5e
  // 6. progressive search: the far head lane shows a growing widget, then the nudge, then its route; the other lanes draw
  // at once. The core is slowed down in the page (each slice request is posted `slow` ms late) so the search is watchable;
  // `zero` sends every slice with horizon 0 (nothing can be found), so the search runs to the core's limit fast.
  // Images come from the dev server's /img (cache/img, real art), only logged here.
  const farPage = async ({ slow = 400, zero = false, pieces = farPieces, first = 0, later = 0 } = {}) => {   // first: ms the first plan request (no from) is held back; later: the same for every one after it (until window.__fast)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    await ctx.addInitScript(({ bs, slow, zero, first, later }) => {
      try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify(bs)); localStorage.setItem("seedtracker.pathbuild", "3"); } } catch {}
      window.__log = []; window.__rec = []; window.__late = []; window.__switchAt = -1;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) {                     // log every plan request; slices go out late
        const q = m && m.req;
        if (q && q.fn === "plan" && !q.whatIf) window.__log.push({ from: q.from ?? 0, horizon: q.horizon, seed: q.pieces[0]?.seed, goal: q.pieces[0]?.goal.join(","), t: performance.now() });
        if (q && q.fn === "plan" && !q.whatIf && q.from) { if (zero) q.horizon = 0; setTimeout(() => post.call(this, m, ...rest), slow); return; }
        if (q && q.fn === "plan" && !q.whatIf && !q.from) window.__nf = (window.__nf || 0) + 1;
        if (q && q.fn === "plan" && !q.whatIf && !q.from && first) { setTimeout(() => post.call(this, m, ...rest), first); return; }
        if (q && q.fn === "plan" && !q.whatIf && !q.from && later && window.__nf > 1 && !window.__fast) { setTimeout(() => post.call(this, m, ...rest), later); return; }
        return post.call(this, m, ...rest);
      };
      document.addEventListener("click", e => { if (e.target.closest?.("[data-pb]")) window.__switchAt = window.__log.length; }, true);
      const watch = () => {
        const host = document.getElementById("path"); if (!host) return setTimeout(watch, 20);
        let last = "";
        new MutationObserver(recs => {
          const w = host.querySelector(".lsearch"), far = host.querySelector(".lfar");
          const now = w ? `S|${w.querySelector(".lslab").textContent}|${w.querySelector(".lnudge").classList.contains("on")}` : far ? `R|${far.querySelector(".lfarnote").textContent}` : "";
          if (now && now !== last) window.__rec.push(now);
          last = now;
          if (window.__switchAt >= 0) for (const r of recs) {                // after a build switch: nothing of the old search may draw
            const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
            if (el?.closest?.(".lsearch")) window.__late.push("paint " + r.type);
            for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches(".lsearch, .lfar") || n.querySelector?.(".lsearch, .lfar"))) window.__late.push("draw");
          }
        }).observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
      };
      watch();
    }, { bs: [BUILD, FARBUILD], slow, zero, first, later });
    await ctx.route(/^https?:\/\//, r => { const u = r.request().url(); return /^http:\/\/(localhost|127\.0\.0\.1)/.test(u) ? r.fallback() : r.abort(); });
    const page = await ctx.newPage();
    page.on("pageerror", e => errs.push(String(e)));
    await page.route("**/img/**", r => { imgs.push(r.request().url()); return r.fallback(); });
    await page.route("**/api/**", handle);
    setSnaps({ botbase: snap("botbase", pieces) });
    await page.goto(url);
    await page.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
    await page.click('.tab[data-s="builds"]');
    return { ctx, page };
  };
  const { ctx: ctx3, page: page3 } = await farPage();
  const sawWidget = await waitFor(page3, () => !!document.querySelector("#path .lsearch .lslab")?.textContent);
  const others = await page3.evaluate(read);
  check("far goal: the head lane shows the searching widget", sawWidget);
  const up6 = await page3.evaluate(() => document.querySelector("#path .unbattles > span")?.textContent);
  check("far goal: Up next says \"Still looking\" while the head lane searches", up6 === "Still looking for the full build", JSON.stringify(up6));
  check("far goal: the other lanes are drawn while it searches", sawWidget && others[1].steps.length > 0 && !others[1].note, JSON.stringify(others).slice(0, 300));
  const sawNudge = await waitFor(page3, () => !!document.querySelector("#path .lsearch .lnudge.on"));
  check("far goal: the nudge fades in while it's still searching", sawNudge);
  await page3.waitForTimeout(700);                                                   // the nudge's fade
  const mid = await page3.evaluate(() => ({ lab: document.querySelector("#path .lsearch .lslab")?.textContent, w: document.querySelector("#path .lsearch .lsbar i")?.style.width }));
  await page3.screenshot({ path: path.join(here, "out", "path-searching.png") });
  const eF = expect(expF, idx3);
  const rF = await untilDom(page3, eF, 30000);
  check("far goal: the route found by slicing replaces the widget (same as core.mjs)", rF.ok, JSON.stringify(rF.got).slice(0, 400) + " WANT " + eF.sig.slice(0, 400));
  const states = await page3.evaluate(() => window.__rec), log = await page3.evaluate(() => window.__log);
  const looked = states.filter(x => x.startsWith("S|")).map(x => +x.split("|")[1].replace(/\D/g, ""));
  const iNudge = states.findIndex(x => x.startsWith("S|") && x.endsWith("|true")), iRoute = states.findIndex(x => x.startsWith("R|"));
  console.log(`(info) widget states ${JSON.stringify(states)}; mid-search "${mid.lab}" bar ${mid.w}; ${log.length} plan requests`);
  check("far goal: the widget's count keeps growing", looked.length >= 3 && looked.every((v, i) => !i || v >= looked[i - 1]) && looked[looked.length - 1] > looked[0], JSON.stringify(looked));
  check("far goal: widget, then nudge, then route", iNudge > 0 && iRoute > iNudge && states.slice(iRoute).every(x => x.startsWith("R|")), JSON.stringify(states));
  const firsts = log.filter(q => !q.from), cuts = log.filter(q => q.from);       // the first request can go out twice (load + the first live state)
  check("far goal: the screen asked horizon 200 first, then the same slices as replayed", firsts.length >= 1 && firsts.every(q => q.horizon === 200) && log.indexOf(cuts[0]) > log.indexOf(firsts[0])
    && cuts.length === farRun.n - 1 && cuts[0].from === 200 && cuts.every((q, i) => !i || q.from === cuts[i - 1].from + cuts[i - 1].horizon), JSON.stringify(log));
  const fmtN = n => n.toLocaleString("en-US");
  const shownF = await page3.evaluate(() => ({ burn: [...document.querySelectorAll("#path .lane.t1 .step.past .n")].map(n => n.textContent), note: document.querySelector("#path .lfarnote")?.textContent,
    up: document.querySelector("#path .unbattles b")?.textContent, rolls: document.querySelector("#path .lane.t1 .lcost .lc b")?.textContent }));
  const lastCol = Math.max(...expF.lanes[0].steps.filter(s => s.k === "roll" || s.k === "drink").map(s => s.key + (s.times || 1) - 1));
  check("far goal: the burn group shows its count (\"Next: roll N times\")", shownF.burn[0] === `Roll ${fmtN(farGroup.times)} times`, JSON.stringify(shownF));
  check("far goal: the found lane says its battles and keeps the nudge", shownF.note === `${fmtN(Math.ceil(lastCol * 2.3 - 1e-9))} battlesFar off · try chunks or drinks`, JSON.stringify(shownF));
  check("far goal: Up next's battles are the core's total", shownF.up === fmtN(expF.totals.battles), JSON.stringify(shownF) + " core " + expF.totals.battles);
  await page3.waitForTimeout(900);                                                   // the route's fade-in
  await page3.screenshot({ path: path.join(here, "out", "path-far.png") });

  // 6b. the planned route survives a restart: reload with the same companion state, the core is asked for no plan at all
  // and the lanes come back as they were (a lane the search found is far, not fresh: no "found" class, nothing animates)
  const lanesHtml = () => page3.evaluate(() => document.querySelector("#path .lanes")?.innerHTML ?? "");
  const beforeHtml = await lanesHtml();
  await page3.evaluate(async () => { const { store } = await import("/src/store.ts"); await store.flush(); });
  await page3.reload();
  await page3.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  await page3.click('.tab[data-s="builds"]');
  const rR = await untilDom(page3, eF, 30000);
  await page3.waitForTimeout(900);
  const planCalls = await page3.evaluate(() => window.__log.length), afterHtml = await lanesHtml();
  await page3.evaluate(async () => { const { store, exportJSON } = await import("/src/store.ts"); for (const k of Object.keys(JSON.parse(exportJSON()).data)) if (k.startsWith("seedtracker.plan.")) store.set(k, undefined); });   // the search below is meant to start over

  // 7. a build change mid-search cancels it: switch to the near build, back to the far one (a new search), then away mid-search
  const pick = async id => { await page3.click("#path .pbuild"); await page3.click(`#path .pbrow[data-pb="${id}"]`); };
  const eN = expect(nearOnFar, idx3);
  await pick(1);
  check("build switch: the near build plans", (await untilDom(page3, eN)).ok);
  const n0 = await page3.evaluate(() => window.__log.length);
  await pick(3);
  const restarted = await waitFor(page3, n => window.__log.length >= n + 3 && !!document.querySelector("#path .lsearch"), n0);
  check("build switch: back on the far build the search starts over", restarted);
  await page3.evaluate(() => { window.__switchAt = -1; window.__late = []; });     // the next [data-pb] click sets __switchAt again
  await pick(1);                                                                     // mid-search
  const rN = await untilDom(page3, eN);
  await page3.waitForTimeout(2500);                                                  // longer than a slow slice + the 2 s nudge timer
  const after = await page3.evaluate(() => ({ at: window.__switchAt, log: window.__log, late: window.__late, lanes: document.querySelectorAll("#path .lsearch, #path .lfar").length }));
  const slicesAfter = after.log.slice(after.at).filter(q => q.from > 0);
  check("build switch mid-search: the near build's plan is shown", rN.ok && after.lanes === 0, JSON.stringify(rN.got).slice(0, 300));
  check("build switch mid-search: no slice is asked for after the switch", after.at > n0 && slicesAfter.length === 0, JSON.stringify({ at: after.at, n0, n: after.log.length, slicesAfter }));
  check("build switch mid-search: no late redraw of the old search", after.late.length === 0, JSON.stringify(after.late.slice(0, 5)));
  await ctx3.close();

  // 8. a slow core (1.5 s a slice): 2 s pass before 1,000 battles are looked through, so the timer brings the nudge; then
  // leaving the screen mid-search parks it and coming back goes on from where it got to, not from 0
  const { ctx: ctx4, page: page4 } = await farPage({ slow: 1500 });
  const nudged = await waitFor(page4, () => !!document.querySelector("#path .lsearch .lnudge.on"), null, 20000);
  const early = await page4.evaluate(() => ({ up: document.querySelector("#path .unbattles > span")?.textContent, rec: window.__rec, log: window.__log }));
  const firstOn = early.rec.find(x => x.startsWith("S|") && x.endsWith("|true"));
  check("slow core: the nudge comes after ~2 s, before 1,000 battles are looked through", nudged && !!firstOn && +firstOn.split("|")[1].replace(/\D/g, "") < 1000, JSON.stringify(early.rec));
  check("while a lane searches, Up next says \"Still looking\" instead of a total", early.up === "Still looking for the full build", JSON.stringify(early.up));
  await waitFor(page4, () => window.__log.filter(q => q.from).length >= 2, null, 20000);   // mid-search
  await page4.click('.tab[data-s="gear"]');
  const leftAt = await page4.evaluate(() => window.__log.length);
  await page4.waitForTimeout(4000);                                                  // longer than two slow slices
  const away = await page4.evaluate(() => window.__log.slice());
  await page4.click('.tab[data-s="builds"]');
  const resumed = await waitFor(page4, n => window.__log.length > n, away.length, 10000);
  const logB = await page4.evaluate(() => window.__log), prevQ = away[away.length - 1], nextQ = logB[away.length];
  check("left mid-search: no slice is asked for while the Path screen is away", away.length === leftAt, JSON.stringify(away.slice(leftAt)));
  check("back on the Path screen: the search goes on from searchedTo, not from 0", resumed && prevQ.from > 0 && nextQ?.from === prevQ.from + prevQ.horizon, JSON.stringify({ prevQ, nextQ }));
  const r8 = await untilDom(page4, eF, 40000);
  const up8 = await page4.evaluate(() => document.querySelector("#path .unbattles > span")?.textContent);
  check("slow core: the route still arrives, and Up next's total replaces \"Still looking\"", r8.ok && logB.filter(q => !q.from).length === early.log.filter(q => !q.from).length && up8 === `${fmtN(expF.totals.battles)} battles to the full build`, JSON.stringify(up8));
  await ctx4.close();

  // 9. the core's limit (from past 1,000,000 seed steps): every slice is sent with horizon 0 so nothing is ever found; the
  // widget ends: full grey bar, "Not within N battles." (N = what was looked through), the nudge stays, no more requests
  const { ctx: ctx5, page: page5 } = await farPage({ slow: 0, zero: true, pieces: [farPieces[0]] });
  let end = 200; while (end <= 1000000) end += Math.min(20000, Math.max(200, end), 8388607 - end);   // path.ts sliceOf, no tickets
  const notWithin = `Not within ${fmtN(Math.round(end * 2.3))} battles.`;
  const ended = await waitFor(page5, () => !!document.querySelector("#path .lsearch.end"), null, 60000);
  await page5.waitForTimeout(900);                                                   // the bar settles
  const lim = await page5.evaluate(() => { const w = document.querySelector("#path .lsearch"), i = w?.querySelector(".lsbar i");
    return { lab: w?.querySelector(".lslab").textContent, nudge: !!w?.querySelector(".lnudge.on"), full: !!i && i.getBoundingClientRect().width === w.querySelector(".lsbar").getBoundingClientRect().width,
      bg: i && getComputedStyle(i).backgroundColor, n: window.__log.length, last: window.__log[window.__log.length - 1] }; });
  await page5.waitForTimeout(1000);
  const n9 = await page5.evaluate(() => window.__log.length);
  check("at the core's limit the widget ends: full grey bar, \"Not within N battles.\", the nudge stays", ended && lim.lab === notWithin && lim.nudge && lim.full && lim.bg === "rgba(255, 255, 255, 0.35)", JSON.stringify(lim) + " WANT " + notWithin);
  check("at the core's limit no more slices are asked for", n9 === lim.n && lim.last.from + lim.last.horizon === end, JSON.stringify({ n9, lim: lim.n, last: lim.last, end }));
  await page5.screenshot({ path: path.join(here, "out", "path-limit.png") });
  await ctx5.close();

  // 10. a slow first plan (held back 2.5 s): the lanes area shows the calculating lanes (rings rolling through abilities,
  // changing), then they fade out over the arriving lanes (seen part way) and are gone
  {
    const { ctx: ctx6, page: page6 } = await farPage({ slow: 0, first: 2500 });
    const calcSeen = await waitFor(page6, () => { const c = document.querySelector("#path .lanes > .pcalc:not(.out)"); return !!c && c.getBoundingClientRect().height > 200; }, null, 15000);
    await page6.waitForTimeout(500);
    const mid = await page6.evaluate(() => { const c = document.querySelector("#path .lanes > .pcalc"); if (!c) return null;
      const m = [...c.querySelectorAll(".pcs .ab")].map(e => [...e.children].findIndex(i => +getComputedStyle(i).opacity > .5)).join("");
      const lanes3 = [...c.querySelectorAll(".pclane")].map(l => ({ scrubs: l.querySelectorAll(".pcs.tool").length, first: l.querySelector('.pcs[style*="grid-column:1;"], .pcs[style$="grid-column:1"]')?.className || "", dots: l.querySelectorAll(".pcs.ph").length }));
      return { rows: c.querySelectorAll(".pclane").length, rings: c.querySelectorAll(".pcs:not(.tool):not(.ph)").length, lanes3, label: c.getAttribute("aria-label"), text: c.textContent.trim(), nextTop: document.querySelector("#path .pl > .tag.next.pcnext")?.getBoundingClientRect().top ?? null, nextH: document.querySelector("#path .pl > .pcnext")?.getBoundingClientRect().height ?? null, laneTop: c.querySelector(".pclane").getBoundingClientRect().top, lanes: document.querySelectorAll("#path .lane").length,
        running: c.getAnimations({ subtree: true }).filter(a => a.playState === "running").length, m }; });
    const clipL = () => page6.evaluate(() => { const r = document.querySelector("#path .lanes").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(Math.max(r.height, 200), 900 - r.y) }; });
    if (process.env.SHOT) { await page6.screenshot({ path: path.join(here, "out", "path-calc-1.png"), clip: await clipL() }); await page6.screenshot({ path: path.join(here, "out", "path-calc-full.png") }); } await page6.waitForTimeout(450); if (process.env.SHOT) await page6.screenshot({ path: path.join(here, "out", "path-calc-2.png"), clip: await clipL() });
    const later = await page6.evaluate(() => [...document.querySelectorAll("#path .pcalc .pcs .ab")].map(e => [...e.children].findIndex(i => +getComputedStyle(i).opacity > .5)).join(""));
    check("slow first plan: the lanes area shows three calculating lanes of real lane cells (rings, dots, a scrub at most, column 1 the yellow next roll), one face showing each, rolling (no lanes yet)",
      calcSeen && !!mid && mid.rows === 3 && mid.rings >= 9 && mid.lanes3.every(l => l.scrubs <= 1 && l.dots > 0 && /\bhere\b/.test(l.first)) && mid.label === "Calculating a path" && mid.lanes === 0 && mid.running >= mid.rings && !/-/.test(mid.m) && later !== mid.m, JSON.stringify({ calcSeen, mid, later }));
    const fade = page6.evaluate(() => new Promise(res => { const seen = [], t0 = performance.now(); const f = () => { const pcs = document.querySelectorAll("#path .lanes > .lane .step.pcs").length; if (pcs) seen.push(pcs); performance.now() - t0 < 5000 && !(seen.length && !pcs) ? requestAnimationFrame(f) : res(seen); }; requestAnimationFrame(f); }));
    const landed = await waitFor(page6, () => document.querySelectorAll("#path .lane").length === 3, null, 15000);
    const pcsSeen = await fade;
    await waitFor(page6, () => !document.querySelector("#path .pcalc, #path .lanes .pcs, #path .pcnext"), null, 6000);
    await page6.waitForTimeout(300);
    const gone = await page6.evaluate(() => document.querySelectorAll("#path .pcalc, #path .lanes .pcs, #path .pcnext").length);
    const real6 = await page6.evaluate(() => { const n = document.querySelector("#path .pl > .tag.next"); return { nextTop: n?.getBoundingClientRect().top, nextH: n?.getBoundingClientRect().height, laneTop: document.querySelector("#path .lanes > .lane").getBoundingClientRect().top }; });
    check("slow first plan: the yellow Up next banner is there while calculating, where the real one lands (same top and height), so the lanes don't jump",
      mid?.nextTop != null && Math.abs(mid.nextTop - real6.nextTop) < 3 && Math.abs(mid.nextH - real6.nextH) < 3 && Math.abs(mid.laneTop - real6.laneTop) < 3, JSON.stringify({ mid: mid && { nextTop: mid.nextTop, nextH: mid.nextH, laneTop: mid.laneTop }, real6 }));
    check("slow first plan: when it lands the calculating cells settle onto the real lanes and are gone",
      landed && pcsSeen.length > 0 && gone === 0, JSON.stringify({ landed, pcsFrames: pcsSeen.length, gone }));
    await ctx6.close();
  }

  // 11. a replan you asked for (a cap click) that takes 1.5 s: the lanes stay, their tracks dim (seen part way) and the
  // clicked cap's pips ripple; when the plan lands they fade back to full and the marks are gone. A quick replan shows nothing.
  {
    const { ctx: ctx7, page: page7 } = await farPage({ slow: 0, later: 1500 });
    await waitFor(page7, () => document.querySelectorAll("#path .lanes > .lane .ccap").length >= 2 && !document.querySelector("#path .pcalc"), null, 20000);
    await page7.waitForTimeout(600);
    await page7.evaluate(() => { const h = document.getElementById("path"); window.__rc = []; new MutationObserver(() => window.__rc.push(h.classList.contains("recalc"))).observe(h, { attributes: true, attributeFilter: ["class"] }); });
    const n7 = await page7.evaluate(() => window.__log.length);
    await page7.click('#path .ccap[data-cap="1"]');
    const early7 = await page7.evaluate(() => document.getElementById("path").classList.contains("recalc"));
    await page7.waitForTimeout(700);
    const mid7 = await page7.evaluate(() => { const h = document.getElementById("path"), tv = h.querySelector(".lanes > .lane .tview"), cap = h.querySelector('.ccap[data-cap="1"]');
      return { on: h.classList.contains("recalc"), rc: h.dataset.rc, op: tv && +getComputedStyle(tv).opacity, lanes: h.querySelectorAll(".lanes > .lane").length,
        pips: cap ? cap.getAnimations({ subtree: true }).filter(a => a.animationName === "rcpip").length : -1, other: h.querySelector('.ccap[data-cap="0"]')?.getAnimations({ subtree: true }).filter(a => a.animationName === "rcpip").length,
        asked: window.__log.length }; });
    if (process.env.SHOT) await page7.screenshot({ path: path.join(here, "out", "path-recalc.png") });
    const back = page7.evaluate(() => new Promise(res => { const seen = [], t0 = performance.now(); const f = () => { const tv = document.querySelector("#path .lanes > .lane .tview"); if (tv) seen.push(+getComputedStyle(tv).opacity); performance.now() - t0 < 3000 ? requestAnimationFrame(f) : res(seen); }; requestAnimationFrame(f); }));
    const ops7 = await back;
    const end7 = await page7.evaluate(() => { const h = document.getElementById("path"); return { on: h.classList.contains("recalc"), rc: h.dataset.rc ?? null, op: +getComputedStyle(h.querySelector(".lanes > .lane .tview")).opacity }; });
    check("slow replan: nothing marked at the click; then the lanes stay, tracks dimmed, the clicked cap's pips ripple (only that cap)",
      !early7 && mid7.on && mid7.rc === "1" && mid7.op < .5 && mid7.lanes === 3 && mid7.pips === 3 && mid7.other === 0 && mid7.asked > n7, JSON.stringify({ early7, mid7, n7 }));
    check("slow replan: when the plan lands the tracks fade back (seen part way) and the marks are gone",
      !end7.on && end7.rc === null && end7.op === 1 && ops7.some(o => o > .4 && o < .95), JSON.stringify({ end7, ops: ops7.filter((o, i) => i % 6 === 0).map(o => +o.toFixed(2)) }));
    await page7.evaluate(() => { window.__fast = true; window.__rc = []; });
    await page7.click('#path .ccap[data-cap="1"]');
    await page7.waitForTimeout(1200);
    const fast7 = await page7.evaluate(() => window.__rc);
    check("quick replan: the lanes are never marked", fast7.every(x => !x), JSON.stringify(fast7));
    await page7.evaluate(() => { window.__fast = false; });
    await page7.click('#path .tog[data-t="d"]');
    const tog7 = await waitFor(page7, () => document.getElementById("path").classList.contains("recalc"), null, 1400);
    const tog7rc = await page7.evaluate(() => document.getElementById("path").dataset.rc ?? null);
    const tog7end = await waitFor(page7, () => !document.getElementById("path").classList.contains("recalc"), null, 6000);
    check("a toggle's slow replan dims the tracks too (no cap ripples), and lifts when it lands", tog7 && tog7rc === null && tog7end, JSON.stringify({ tog7, tog7rc, tog7end }));
    await ctx7.close();
  }

  check("no /img/ request with an empty name", imgs.concat(imgs1).every(u => !/\/(\.png|undefined\.png)(\?|$)/.test(u)), imgs.concat(imgs1).filter(u => /\/(\.png|undefined\.png)(\?|$)/.test(u)).slice(0, 3).join(" "));
  check("no /img/ response >= 400", bad.length === 0, bad.slice(0, 3).join(" | "));
  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
  check("harness ran", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
