// The Path's "more chunks would save rolls" card (web/src/path-tip.ts, path.ts runTips): with Chunks on and a settled plan,
// path.ts asks the core again with each lacking goal ability's chunks at the next slap tier; the one saving the most rolls
// shows as a card over the bottom right corner. Same fake-EventSource harness as path-stock.mjs; the expected suggestion
// comes from core.mjs in Node, asked with the page's own plan request.
// Run from the repo root: node tests/web/path-tip.mjs   (PASS/FAIL lines, exit 1 on any failure; shots in tests/web/out/w12-*.png)
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

const M = await (await import(pathToFileURL(path.join(repo, "core/dist/core.mjs")).href)).default();
const ref = req => { const p = M.stringToNewUTF8(JSON.stringify(req)); const r = M.UTF8ToString(M._st_call(p)); M._free(p); return JSON.parse(r); };
const rollsOf = out => out.lanes.reduce((t, l) => t + l.steps.filter(s => s.k === "roll" || s.k === "drink").reduce((u, s) => u + (s.times || 1), 0), 0);

// a fixture where more chunks really save rolls (found with a scratch core.mjs search): the head lacks R in slot 3, the
// clothes lack MI in slot 3; 4 chunks of each is under a slap, 10 is one
const S = "SquidMove_Up", MI = "MainInk_Save", R = "RespawnTime_Save", KEY = "u-aaaaaaaaaaaaaaaaaaaa";
const ROWS = { head: "Hed_CAP002", clothes: "Clt_TES001", shoes: "Shs_BOT003" };
const GOALS = { head: [S, "", R], clothes: [R, "", MI], shoes: ["", "", ""] };
const BUILD = { id: 1, title: "Chunk tip", modes: ["SZ"], weapon: "Shooter_Normal_00", set: ["head", "clothes", "shoes"].map(s => [ROWS[s], "", GOALS[s]]) };
const pc = (slot, gearId, subs, seed) => ({ slot, gearId, row: ROWS[slot], brand: "B03", main: "", subs: [...subs, "", "", ""].slice(0, 3), seed });
const pieces = [pc("head", 1, [S], 47514), pc("clothes", 2, [R], 628379), pc("shoes", 3, [S, R], 31337)];
const STOCK = { chunks: { [R]: 4, [MI]: 4 }, drinks: {} };
const state = { snapshots: { botbase: { source: "botbase", gameVersion: "11.0.0", playerKey: KEY, pieces, at: 1, stock: STOCK } }, status: { botbase: { state: "ok" } } };

const handle = route => {
  const p = new URL(route.request().url()).pathname;
  if (p === "/api/state") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
  if (p === "/api/events") return route.abort();
  return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
};
fs.mkdirSync(path.join(here, "out"), { recursive: true });
const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5186, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const errs = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
await ctx.addInitScript(b => {
  try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "1"); } } catch {}
  window.__h = {}; window.__reqs = []; window.__ifs = [];
  window.EventSource = class { addEventListener(ev, fn) { (window.__h[ev] = window.__h[ev] || []).push(fn); } close() {} };
  const pm = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...r) { try { const q = m && (m.req || m); if (q && q.fn === "plan" && q.pieces && q.from == null) (q.whatIf ? window.__ifs : window.__reqs).push({ q: JSON.parse(JSON.stringify(q)), t: performance.now() }); } catch {} return pm.call(this, m, ...r); };
}, BUILD);
await ctx.route(/^https?:\/\//, r => /^http:\/\/(localhost|127\.0\.0\.1)/.test(r.request().url()) ? r.fallback() : r.abort());
const page = await ctx.newPage();
page.on("pageerror", e => errs.push(String(e)));
page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|404/.test(m.text())) errs.push(m.text()); });
await page.route("**/img/**", r => r.fallback());
await page.route("**/api/**", handle);
const shownCard = (ms = 30000) => page.waitForFunction(() => { const c = document.getElementById("psug"); return !!c && c.classList.contains("show") && getComputedStyle(c).opacity === "1"; }, null, { timeout: ms }).then(() => true, () => false);
const card = () => page.evaluate(() => { const c = document.getElementById("psug"); if (!c) return null; const r = c.getBoundingClientRect(); return { a: c.dataset.a, text: c.querySelector(".pstx").textContent.replace(/\s+/g, " ").trim(), title: c.title || c.dataset.tip || "", show: c.classList.contains("show"), op: getComputedStyle(c).opacity, vis: getComputedStyle(c).visibility, pos: getComputedStyle(c).position, art: c.querySelector(".psart .chunkonly img")?.src.split("/").pop() || null, r: [r.left, r.top, r.right, r.bottom].map(Math.round), vw: innerWidth, vh: innerHeight }; });
// the card's box against everything it must not cover: the banner's content and each lane's head, route, cap, goal and cost pill
const covers = () => page.evaluate(() => { const c = document.getElementById("psug").getBoundingClientRect(), hit = [];
  for (const e of document.querySelectorAll("#path .pl > .next:not(.pcnext) > :not(.ink), #path .lane .lnow, #path .lane .tview, #path .lane .ccap, #path .lane .goal, #path .lane .lcost, #path .lane .cap")) {
    if (e.closest(".pcnext, .pcalc")) continue; const r = e.getBoundingClientRect(); if (r.width && r.height && r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) hit.push(e.className || e.tagName); }
  return hit; });
const rollsDom = () => page.evaluate(() => [...document.querySelectorAll('#path .lane .lcost .lc[data-tip^="Rolls left"] b')].map(b => +b.textContent.replace(/,/g, "")));
// the banner and lanes: where they sit (offsets, so the lanes' slight rotation doesn't count)
const layout = () => page.evaluate(() => [...document.querySelectorAll("#path .pl > .next:not(.pcnext), #path .pl > .lanes, #path .lanes > .lane")].map(e => [e.offsetTop, e.offsetLeft, e.offsetWidth, e.offsetHeight].join(",")).join(" | "));

try {
  await page.goto(url);
  await page.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  await page.click('.tab[data-s="builds"]');
  await page.waitForSelector("#path .lanes > .lane .lcost", { timeout: 30000 });
  const ok = await shownCard(), shownAt = await page.evaluate(() => performance.now());
  const reqs = await page.evaluate(() => window.__reqs), ifs = await page.evaluate(() => window.__ifs);
  // the expectation: the page's own base request, and each ability raised to 10 (4 is under one slap), asked in Node
  const base = reqs.at(-1).q, { whatIf, ...bq } = base, b0 = rollsOf(ref(bq));
  const opts = [R, MI].map(a => ({ a, extra: 6, rolls: rollsOf(ref({ ...bq, chunks: { ...bq.chunks, [a]: 10 } })) })).filter(o => b0 - o.rolls >= 1).sort((x, y) => x.rolls - y.rolls);
  const want = opts[0], saved = want && b0 - want.rolls;
  const c = await card(), dom = await rollsDom(), domSum = dom.reduce((t, n) => t + n, 0);
  const perLane = q => ref(q).lanes.map(l => l.steps.filter(s => s.k === "roll" || s.k === "drink").reduce((u, s) => u + (s.times || 1), 0));
  if (want) console.log(`      rolls per lane: shown ${JSON.stringify(dom)} = ${domSum}; with +6 ${want.a}: ${JSON.stringify(perLane({ ...bq, chunks: { ...bq.chunks, [want.a]: 10 } }))} = ${want.rolls}; saved ${saved}`);
  check("saving = the cost rows' rolls summed minus the what-if's summed the same way", domSum === b0 && saved === domSum - want.rolls, JSON.stringify({ dom, b0, want }));
  const cmp = await page.evaluate(async () => { const t = await import("/src/path-tip.ts"), L = { steps: [] };
    return [t.complete([L, L, L], 3), t.complete([L, L], 3), t.complete([L, { ...L, searching: true }, L], 3), t.complete([L, { ...L, note: "x" }, L], 3), t.complete([L, { row: "r" }, L], 3)]; });
  check("an incomplete what-if (missing, searching, note, no route) is discarded", JSON.stringify(cmp) === "[true,false,false,false,false]", JSON.stringify(cmp));
  check("fixture: more chunks save rolls in Node", !!want && opts.length === 2, JSON.stringify({ b0, opts }));
  check("what-ifs: one per lacking ability, each at the next tier", ifs.length === 2 && ifs.every(x => x.q.chunks[x.q.whatIf] === 10) && new Set(ifs.map(x => x.q.whatIf)).size === 2, JSON.stringify(ifs.map(x => [x.q.whatIf, x.q.chunks])));
  const abNames = { [R]: "Run Speed Up", [MI]: "Ink Saver (Main)" };
  check("card appears with the best ability and numbers", ok && c.a === want.a && c.text === `+6 ${abNames[want.a]} chunks: ${saved} fewer rolls` && !c.title && c.art === `${want.a}.png`, JSON.stringify({ c, want, saved }));
  const lanesBox = await page.evaluate(() => { const r = document.querySelector("#path .pl > .lanes").getBoundingClientRect(); return [r.top, r.right].map(Math.round); }), hit = await covers();
  check("card sits right-aligned in the gap above the lanes, out of the flow, covering nothing", c.pos === "absolute" && Math.abs(c.r[2] - lanesBox[1]) <= 2 && c.r[1] < lanesBox[0] && c.r[3] > lanesBox[0] - 30 && hit.length === 0, JSON.stringify({ r: c.r, lanesBox, hit }));
  if (ifs.length) console.log(`      first what-if sent ${Math.round(ifs[0].t - reqs.at(-1).t)} ms after the base request; card fully shown ${Math.round(shownAt - ifs[0].t)} ms after it (incl. the 240 ms fade)`);
  await page.waitForTimeout(1500);   // the calculating screen's fade-out ends first
  await page.screenshot({ path: path.join(here, "out", "w12-card.png") });
  const layOn = await layout(), layOff = await page.evaluate(() => { const c = document.getElementById("psug"); c.style.display = "none"; return null; }) ?? await layout();
  await page.evaluate(() => { document.getElementById("psug").style.display = ""; });
  check("no layout shift when the card shows (banner and lanes sit the same with it taken out)", layOn === layOff, JSON.stringify([layOn, layOff]));
  await page.setViewportSize({ width: 760, height: 700 });
  await page.waitForTimeout(500);
  const cn = await card();
  const hitN = await covers();
  check("narrow window: the card stays inside it and covers nothing", cn.show && cn.r[0] >= 0 && cn.r[2] <= cn.vw && hitN.length === 0, JSON.stringify({ r: cn.r, hitN }));
  await page.screenshot({ path: path.join(here, "out", "w12-card-narrow.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  const lay1 = await layout();
  await page.click("#psug .psx");
  const fading = await page.evaluate(() => { const c = document.getElementById("psug"); const o = +getComputedStyle(c).opacity; return { o, anims: c.getAnimations().map(a => a.transitionProperty) }; });
  await page.waitForTimeout(600);
  const cd = await card();
  check("x: the card fades out (opacity transition) and is gone", fading.anims.includes("opacity") && !cd.show && cd.op === "0" && cd.vis === "hidden", JSON.stringify([fading, cd]));
  check("no layout shift when it is dismissed", lay1 === await layout(), JSON.stringify([lay1, await layout()]));
  await page.reload();
  await page.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  await page.click('.tab[data-s="builds"]');
  await page.waitForSelector("#path .lanes > .lane .lcost", { timeout: 30000 });
  await page.waitForTimeout(2500);
  const cr = await card(), ifs2 = await page.evaluate(() => window.__ifs);
  check("after reload: still dismissed", !cr || (!cr.show && cr.vis === "hidden"), JSON.stringify(cr));
  check("after reload: the what-ifs come from the plan cache (no core call)", ifs2.length === 0, JSON.stringify(ifs2.map(x => x.q.whatIf)));
  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
  check("harness ran", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
