// The Path screen's live loop (web/src/path-tick.ts): a roll that happened in the game inks its step over, then the lane moves
// on. Same harness as path-live.mjs, but the event stream is a fake EventSource the test fires by hand (window.__emit), so two
// snapshots can land 100 ms apart. Run from the repo root: node tests/web/path-tick.mjs   (PASS/FAIL lines, exit 1 on any failure)
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../.."), web = path.join(repo, "web");
const need = createRequire(path.join(web, "package.json"));
const { chromium } = need("playwright");
const { createServer } = await import(pathToFileURL(need.resolve("vite")).href);
const { xorstep, progress, liveSteps, warnAt } = await import(pathToFileURL(path.join(web, "src/path-tick.ts")).href);

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };
const M = await (await import(pathToFileURL(path.join(repo, "core/dist/core.mjs")).href)).default();
const ref = req => { const p = M.stringToNewUTF8(JSON.stringify(req)); const r = M.UTF8ToString(M._st_call(p)); M._free(p); return JSON.parse(r); };

const S = "SquidMove_Up", MI = "MainInk_Save", R = "RespawnTime_Save";
const KEY = "u-aaaaaaaaaaaaaaaaaaaa";
const ROWS = { head: "Hed_CAP002", clothes: "Clt_TES001", shoes: "Shs_BOT003" };
const GOALS = { head: [S, "", R], clothes: [R, "", MI], shoes: ["", "", ""] };
const BUILD = { id: 1, title: "Tick test", modes: ["SZ"], weapon: "Shooter_Normal_00", set: ["head", "clothes", "shoes"].map(s => [ROWS[s], "", GOALS[s]]) };
const pc = (slot, gearId, subs, seed) => ({ slot, gearId, row: ROWS[slot], brand: "B03", main: "", subs: [...subs, "", "", ""].slice(0, 3), seed });
const snap = pieces => ({ source: "botbase", gameVersion: "11.0.0", playerKey: KEY, pieces, at: Date.now() });
const stateOf = pieces => ({ snapshots: { botbase: snap(pieces) }, status: { botbase: { state: "ok" } } });
const pin = pieces => ({ pieces: pieces.map(p => ({ row: p.row, brand: p.brand, seed: p.seed, subs: p.subs, goal: GOALS[p.slot] })),
  chunks: {}, drinks: {}, fixedOrder: true, useChunks: true, useDrinks: true, horizon: 200 });
const planOf = pieces => ref({ fn: "plan", ...pin(pieces) });
const simple = (l, min = 2) => l && l.steps.length >= min && (l.steps[0].k === "roll" || l.steps[0].k === "drink") && !l.steps[0].times && !l.steps[0].burn;
// the piece after the game rolled its planned first step: the next seed, the ability in the next slot
const rolled = (p, lane) => { const k = p.subs.filter(Boolean).length, subs = [...p.subs]; subs[k] = lane.steps[0].a; return { ...p, seed: xorstep(p.seed), subs }; };

let A = null, planA = null, planA1 = null, B = null, planB = null, nextA = null, nextB = null;
for (let k = 1; k < 3000 && !A; k++) {
  const ps = [pc("head", 1, [S], k * 7919), pc("clothes", 2, [R], k * 104729 + 5), pc("shoes", 3, [S, R], 31337)];
  const p = planOf(ps);
  if (!p.ok || p.unreachable.length || !simple(p.lanes[0]) || !simple(p.lanes[1])) continue;
  const a = ps.map((x, i) => i < 2 ? rolled(x, p.lanes[i]) : x), pa = planOf(a);
  if (!pa.ok || pa.unreachable.length || !simple(pa.lanes[0], 1)) continue;
  const b = [rolled(a[0], pa.lanes[0]), a[1], a[2]], pb = planOf(b);
  if (!pb.ok || pb.unreachable.length) continue;
  A = ps; planA = p; planA1 = pa; nextA = a; B = b; planB = pb; nextB = b;
}
check("setup: found pieces whose first steps are plain rolls in two lanes", !!A);
const idx3 = [0, 1, 2];
const sigOf = (out) => JSON.stringify(idx3.map(i => out.unreachable.includes(i) ? null : { have: out.lanes[i].have.filter(h => h[0]).map(h => h[0]), steps: out.lanes[i].steps.map(s => s.k === "scrub" ? "Unknown" : s.a) }));

const read = () => {
  const base = u => (u || "").split("/").pop().replace(".png", "");
  return [...document.querySelectorAll("#path .lane")].map(l => ({
    note: l.querySelector(".lnote")?.textContent || null,
    have: [...l.querySelectorAll(".have .ab:not(.q) img")].map(i => base(i.src)),
    steps: [...l.querySelectorAll(".track .step:not(.ph)")].map(s => base(s.querySelector('img[src*="/skill/"]')?.src)),
  }));
};
const domSig = lanes => JSON.stringify(lanes.map(l => l.note ? null : { have: l.have, steps: l.steps }));
const settled = async (page, out, ms = 15000) => { const t0 = Date.now(); let got = []; while (Date.now() - t0 < ms) { got = await page.evaluate(read); if (domSig(got) === sigOf(out)) return { ok: true, got }; await new Promise(r => setTimeout(r, 100)); } return { ok: false, got }; };

const mock = { state: stateOf(A || []) };
const handle = route => {
  const p = new URL(route.request().url()).pathname;
  if (p === "/api/state") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mock.state) });
  if (p === "/api/events") return route.abort();
  return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
};

const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5177, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const errs = [];
// a page with a hand-fired event stream; logs every Element.animate's keyframe properties and whether a step ever got `.inked`
const open = async (state, opts = {}, build = BUILD) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC", ...opts });
  await ctx.addInitScript(b => {
    try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "1"); } } catch {}
    window.__h = {}; window.__anims = []; window.__inked = 0; window.__counts = [];
    window.EventSource = class { constructor() { window.__es = this; } addEventListener(ev, fn) { (window.__h[ev] = window.__h[ev] || []).push(fn); } close() {} };
    window.__emit = (ev, d) => (window.__h[ev] || []).forEach(fn => fn({ data: JSON.stringify(d) }));
    const an = Element.prototype.animate;
    Element.prototype.animate = function (f, o) { window.__anims.push(Object.keys(f)); return an.call(this, f, o); };
    const watch = () => {
      const host = document.getElementById("path"); if (!host) return setTimeout(watch, 10);
      new MutationObserver(() => { if (host.querySelector(".lane .step.inked")) window.__inked++;
        window.__counts.push([...host.querySelectorAll(".lane")].map(l => l.querySelectorAll(".track .step:not(.ph)").length).join(",")); }).observe(host, { subtree: true, childList: true, attributes: true });
    };
    watch();
  }, build);
  await ctx.route(/^https?:\/\//, r => /^http:\/\/(localhost|127\.0\.0\.1)/.test(r.request().url()) ? r.fallback() : r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|404/.test(m.text())) errs.push(m.text()); });
  await page.route("**/img/**", r => r.fallback());
  await page.route("**/api/**", handle);
  mock.state = state;
  await page.goto(url);
  await page.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  await page.click('.tab[data-s="builds"]');
  return { ctx, page };
};
const emit = (page, st) => page.evaluate(s => window.__emit("state", s), st);
const upNext = page => page.evaluate(() => ({ step: document.querySelector("#path .next .ustep .upg.on b")?.textContent, title: document.querySelector("#path .next .utitle .upg.on h2")?.textContent }));

// progress(): what a snapshot did to a lane's first step, for the steps that aren't plain rolls
{
  const sn = (o) => ({ slot: "head", gearId: 1, seed: 5, subs: ["", "", ""], open: 1, ...o });
  const U = [{ k: "unlock", slot: 2 }, { k: "unlock", slot: 3 }, { k: "roll", a: S, key: 1 }];
  check("progress: both snails of a double unlock -> done; one of them -> count; stars from elsewhere with a moved seed -> nothing",
    progress(sn(), sn({ open: 3 }), U) === "done" && progress(sn(), sn({ open: 2 }), U) === "count" && progress(sn(), sn({ open: 3, seed: 6 }), U) === null && progress(sn(), sn({ open: 2 }), U.slice(1)) === "done");
  check("progress: a chunk filling the planned slot -> done; a scrub that empties the slots -> done",
    progress(sn({ subs: [S, "", ""] }), sn({ subs: [S, R, ""] }), [{ k: "slap", slot: 2, a: R }]) === "done" && progress(sn({ subs: [S, R, ""] }), sn(), [{ k: "scrub" }]) === "done"
    && progress(sn({ subs: [S, "", ""] }), sn({ subs: [S, MI, ""] }), [{ k: "slap", slot: 2, a: R }]) === null);
  check("progress: a main swap: the piece's main became the goal's with the seed unmoved -> done; seed moved, another main, or no change -> nothing",
    progress(sn({ main: MI }), sn({ main: S }), [{ k: "main", slot: 1, a: S }]) === "done" && progress(sn({ main: MI }), sn({ main: S, seed: 6 }), [{ k: "main", slot: 1, a: S }]) === null
    && progress(sn({ main: MI }), sn({ main: R }), [{ k: "main", slot: 1, a: S }]) === null && progress(sn({ main: MI }), sn({ main: MI }), [{ k: "main", slot: 1, a: S }]) === null);
  check("progress: one roll of a burn group -> count (the cell stays); two seed steps -> nothing",
    progress(sn(), sn({ seed: xorstep(5) }), [{ k: "roll", a: S, key: 1, times: 8 }]) === "count" && progress(sn(), sn({ seed: xorstep(xorstep(5)) }), [{ k: "roll", a: S, key: 1, times: 8 }]) === null);
}
// liveSteps(): the live Take off / Drink steps from what is worn, its XP and the active drink (T = warnAt(xpGainMax))
{
  const W = { head: 1, clothes: 2, shoes: 3 }, T = warnAt(0), one = (roll, p, drink) => JSON.stringify(liveSteps([{ slot: "head", gearId: 1, roll }], [{ slot: "head", gearId: 1, ...p }], W, drink, T)[0]);
  const near = { subs: [S, "", ""], exp: 8000 - 5000 }, far = { subs: [S, "", ""], exp: 100 };
  check("liveSteps: near cap + no roll wanted -> take off; roll wanted with the right drink -> nothing; wrong drink -> drink step; drink active + plain roll next + near cap -> take off; full piece -> nothing",
    one(null, near, null) === '{"k":"off"}' && one(null, far, null) === "null" && one({ d: R }, near, { ability: R }) === "null"
    && one({ d: R }, far, { ability: S }) === `{"k":"drink","d":"${R}"}` && one({ d: R }, far, null) === `{"k":"drink","d":"${R}"}`
    && one({ d: null }, near, { ability: S }) === '{"k":"off"}' && one({ d: null }, near, null) === "null"
    && one(null, { subs: [S, S, R], exp: 13999 }, null) === "null" && T === 5500 && warnAt(8000) === 10000,
    one(null, near, null) + one({ d: R }, near, { ability: R }) + one({ d: R }, far, { ability: S }) + one({ d: null }, near, { ability: S }));
}

try {
  if (!A) throw new Error("no setup");
  // 1. the planned roll happens: the step inks, then the lane has one step fewer and Up next shows the next step
  const { ctx, page } = await open(stateOf(A));
  check("start: the first plan is drawn", (await settled(page, planA)).ok);
  await page.waitForTimeout(600);
  const before = await upNext(page), n0 = planA.lanes[0].steps.length;
  // where the old second step will be once the track has slid one column left; the new first step must land right there
  await page.evaluate(n0 => {
    const l = document.querySelectorAll("#path .lane")[0], st = [...l.querySelectorAll(".track .step:not(.ph)")], tr = l.querySelector(".track");
    const k = st[0].getBoundingClientRect().width / parseFloat(getComputedStyle(st[0]).width);
    window.__ref = st[1] ? st[1].getBoundingClientRect().left - parseFloat(getComputedStyle(tr).getPropertyValue("--col")) * k : null; window.__land = null;
    new MutationObserver((r, o) => { const s = document.querySelectorAll("#path .lane")[0]?.querySelectorAll(".track .step:not(.ph)");
      if (s && s.length === n0 - 1) { window.__land = s[0].getBoundingClientRect().left; o.disconnect(); } }).observe(document.getElementById("path"), { subtree: true, childList: true });
  }, n0);
  await emit(page, stateOf(nextA));
  await page.waitForSelector("#path .lane .step.inked", { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
  await page.waitForTimeout(50);
  await page.screenshot({ path: path.join(here, "out", "path-tick-1.png") });
  const mid = await page.evaluate(read), inkedMid = await page.evaluate(() => !!document.querySelector("#path .lane .step.inked"));
  await page.evaluate(() => document.getAnimations().forEach(a => a.play()));
  await page.waitForFunction(() => document.getAnimations().some(a => a.effect?.getKeyframes?.().some(f => f.translate && f.translate !== "0 0" && f.translate !== "0px 0px")), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
  const midSlide = await page.evaluate(() => { const st = [...document.querySelectorAll("#path .lane")[0].querySelectorAll(".track .step")];
    const tv = document.querySelector("#path .lane .tview"); return { tv: tv && [getComputedStyle(tv).clipPath, Math.round(tv.getBoundingClientRect().left), getComputedStyle(tv).overflow], f: Math.round(st.find(s => !s.classList.contains("ph")).getBoundingClientRect().left), tr: getComputedStyle(st[1] || st[0]).translate, op: +getComputedStyle(st.find(s => !s.classList.contains("ph"))).opacity }; });
  await page.screenshot({ path: path.join(here, "out", "path-tick-slide.png") });
  await page.evaluate(() => document.getAnimations().forEach(a => a.play()));
  console.log("(info) mid-slide " + JSON.stringify(midSlide));
  check("planned roll: mid-slide the lane's steps are moved left and the finished one is fading", /^-\d/.test(midSlide.tr) && midSlide.op < .9, JSON.stringify(midSlide));
  check("planned roll: the step gets the done state first, the lane still has its old steps", inkedMid && mid[0].steps.length === n0, JSON.stringify(mid[0]));
  const r1 = await settled(page, planA1);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(here, "out", "path-tick-2.png") });
  const after = await upNext(page);
  check("planned roll: the lane has one step fewer, as planned from the new snapshot", r1.ok && r1.got[0].steps.length === n0 - 1 && r1.got[1].steps.length === planA1.lanes[1].steps.length, JSON.stringify(r1.got));
  console.log("(dbg)", JSON.stringify({ before, after }));
  check("planned roll: Up next shows the next step", after.step === `1/${n0 - 1}` && before.step === `1/${n0}` && !!after.title, JSON.stringify({ before, after }));
  const slide = await page.evaluate(() => ({ tr: window.__anims.filter(k => k.includes("translate")).length, ref: window.__ref, land: window.__land }));
  check("planned roll: the track slides left and the finished step fades out before it's dropped; the next step lands where the slide left it",
    slide.tr >= 2 && slide.ref != null && slide.land != null && Math.abs(slide.ref - slide.land) < 3, JSON.stringify(slide));
  check("planned roll: two lanes rolled, so both inked together", await page.evaluate(() => window.__anims.filter(k => k.includes("scale")).length) >= 2);
  await ctx.close();

  // 1b. nothing moves when a step completes: the head's main must be swapped for a main-only one (its title is long, two or three
  // lines), the snapshot with the swap done leaves an ordinary one-line title; the banner's height and the lanes' top stay put
  {
    const BM = { ...BUILD, set: BUILD.set.map((x, i) => i === 0 ? [x[0], "ComeBack", x[2]] : x) };
    const withMain = (ps, m) => ps.map((p, i) => i === 0 ? { ...p, main: m } : p);
    const cm = await open(stateOf(withMain(A, "MainInk_Save")), {}, BM);
    const geo = () => cm.page.evaluate(() => { const n = document.querySelector("#path .tag.next"), l = document.querySelector("#path .lanes"), t = document.querySelector("#path .utitle .upg.on h2 > span");
      return { next: n.getBoundingClientRect().height, top: l.getBoundingClientRect().top, text: t.textContent, lines: Math.round(t.offsetHeight / (parseFloat(getComputedStyle(t).fontSize) * 1.04)) }; });
    const got = await cm.page.waitForFunction(() => document.querySelector("#path .utitle .upg.on h2")?.textContent === "Swap main", null, { timeout: 15000 }).then(() => true, () => false);
    await cm.page.waitForTimeout(900);
    const g0 = await geo();
    await emit(cm.page, stateOf(withMain(A, "ComeBack")));
    const gone = await cm.page.waitForFunction(() => (document.querySelector("#path .utitle .upg.on h2")?.textContent || "Swap main") !== "Swap main", null, { timeout: 15000 }).then(() => true, () => false);
    await cm.page.waitForTimeout(1500);
    const g1 = await geo();
    check("a step completes: Up next's height and the lanes' top stay put (0.5 px)",
      got && gone && g0.text === "Swap main" && g1.text !== "Swap main" && Math.abs(g0.next - g1.next) < .5 && Math.abs(g0.top - g1.top) < .5, JSON.stringify({ got, gone, g0, g1 }));
    await cm.ctx.close();
  }

  // 3. (checked in 1 too) two lanes in one snapshot: both steps carry .inked at the same time
  const c3 = await open(stateOf(A));
  await settled(c3.page, planA); await c3.page.waitForTimeout(600);
  await c3.page.evaluate(() => { window.__both = 0; new MutationObserver(() => { if (document.querySelectorAll("#path .lane .step.inked").length >= 2) window.__both++; }).observe(document.getElementById("path"), { subtree: true, attributes: true, childList: true }); });
  await emit(c3.page, stateOf(nextA));
  await settled(c3.page, planA1);
  check("two lanes roll in one snapshot: both complete together", await c3.page.evaluate(() => window.__both) > 0);
  await c3.ctx.close();

  // 2. a wrong roll (a seed that isn't the planned step): no done state; the lane replans
  let wrongP = null, planW = null;      // a seed that is neither 1 nor 2 steps on, and still plans within the horizon
  for (let k = 1; k < 500 && !wrongP; k++) { const w = [{ ...A[0], seed: (A[0].seed ^ (0x5bd1e995 + k * 7)) >>> 0 }, A[1], A[2]], pw = planOf(w);
    if (pw.ok && !pw.unreachable.length && w[0].seed !== xorstep(A[0].seed)) { wrongP = w; planW = pw; } }
  const c2 = await open(stateOf(A));
  await settled(c2.page, planA); await c2.page.waitForTimeout(600);
  await emit(c2.page, stateOf(wrongP));
  const r2 = await settled(c2.page, planW);
  await c2.page.waitForTimeout(700);
  check("wrong roll: the lane replans from the new snapshot", planW.ok && r2.ok, JSON.stringify(r2.got));
  check("wrong roll: no step is inked", await c2.page.evaluate(() => window.__inked) === 0);
  await c2.ctx.close();

  // 4. two snapshots 100 ms apart: the last one wins, same as a fresh render of it
  const c4 = await open(stateOf(A));
  await settled(c4.page, planA); await c4.page.waitForTimeout(600);
  await emit(c4.page, stateOf(nextA));
  await c4.page.waitForTimeout(100);
  await emit(c4.page, stateOf(nextB));
  const r4 = await settled(c4.page, planB);
  await c4.page.waitForTimeout(1200);
  const html4 = await c4.page.evaluate(() => document.querySelector("#path .pl").innerHTML), run4 = await c4.page.evaluate(() => document.getAnimations().length);
  const fresh = await open(stateOf(nextB));
  await settled(fresh.page, planB);
  await fresh.page.waitForFunction(() => !document.querySelector("#path .pcalc, #path .lanes .pcs, #path .pcnext"), null, { timeout: 6000 });
  await fresh.page.waitForTimeout(300);
  const htmlF = await fresh.page.evaluate(() => document.querySelector("#path .pl").innerHTML);
  check("two snapshots 100 ms apart: the lanes show the last plan", r4.ok, JSON.stringify(r4.got));
  check("two snapshots 100 ms apart: the DOM equals a fresh render of the last snapshot, nothing still animating", html4 === htmlF && run4 === 0, `same html ${html4 === htmlF}, animations ${run4}`);
  await c4.ctx.close(); await fresh.ctx.close();

  // 5. reduced motion: fades only
  const c5 = await open(stateOf(A), { reducedMotion: "reduce" });
  await settled(c5.page, planA); await c5.page.waitForTimeout(600);
  await c5.page.evaluate(() => { window.__anims = []; });
  await emit(c5.page, stateOf(nextA));
  const r5 = await settled(c5.page, planA1);
  await c5.page.waitForTimeout(700);
  const anims5 = await c5.page.evaluate(() => window.__anims.flat());
  check("reduced motion: the lane still moves on", r5.ok);
  check("reduced motion: only opacity fades, no transform animations", anims5.length > 0 && anims5.every(k => k === "opacity"), JSON.stringify(anims5));
  await c5.ctx.close();
  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
  check("harness ran", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
