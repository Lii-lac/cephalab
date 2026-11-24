// The Switch stock on the Path screen (path.ts stockOf): botbase snapshot.stock goes into the plan request (the toggles show
// no numbers), and without it a quiet note says none is read and each toggle's picture opens the typed counts. Same fake-EventSource harness as path-tick.mjs.
// Run from the repo root: node tests/web/path-stock.mjs   (PASS/FAIL lines, exit 1 on any failure)
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../.."), web = path.join(repo, "web");
const need = createRequire(path.join(web, "package.json"));
const { chromium } = need("playwright");
const { createServer } = await import(pathToFileURL(need.resolve("vite")).href);
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };

const S = "SquidMove_Up", MI = "MainInk_Save", R = "RespawnTime_Save", KEY = "u-aaaaaaaaaaaaaaaaaaaa";
const ROWS = { head: "Hed_CAP002", clothes: "Clt_TES001", shoes: "Shs_BOT003" };
const GOALS = { head: [S, "", R], clothes: [R, "", MI], shoes: ["", "", ""] };
const BUILD = { id: 1, title: "Stock test", modes: ["SZ"], weapon: "Shooter_Normal_00", set: ["head", "clothes", "shoes"].map(s => [ROWS[s], "", GOALS[s]]) };
const pc = (slot, gearId, subs, seed) => ({ slot, gearId, row: ROWS[slot], brand: "B03", main: "", subs: [...subs, "", "", ""].slice(0, 3), seed });
const pieces = [pc("head", 1, [S], 7919), pc("clothes", 2, [R], 104729 * 3 + 5), pc("shoes", 3, [S, R], 31337)];
const stateOf = stock => ({ snapshots: { botbase: { source: "botbase", gameVersion: "11.0.0", playerKey: KEY, pieces, at: 1, ...(stock ? { stock } : {}) } }, status: { botbase: { state: "ok" } } });
const STOCK1 = { chunks: { [S]: 100, [MI]: 114 }, drinks: { [R]: 4, [S]: 5 } };   // 214 chunks, 9 drinks
const STOCK2 = { chunks: { [S]: 100, [MI]: 114, [R]: 6 }, drinks: { [R]: 4, [S]: 5 } };   // 220 chunks

const mock = { state: stateOf(STOCK1) };
const handle = route => {
  const p = new URL(route.request().url()).pathname;
  if (p === "/api/state") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mock.state) });
  if (p === "/api/events") return route.abort();
  return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
};
const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5178, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const errs = [];
const open = async state => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
  await ctx.addInitScript(b => {
    try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify([b])); localStorage.setItem("seedtracker.pathbuild", "1"); } } catch {}
    window.__h = {}; window.__reqs = [];
    window.EventSource = class { addEventListener(ev, fn) { (window.__h[ev] = window.__h[ev] || []).push(fn); } close() {} };
    window.__emit = (ev, d) => (window.__h[ev] || []).forEach(fn => fn({ data: JSON.stringify(d) }));
    const pm = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, ...r) { try { const q = m && (m.req || m); if (q && q.fn === "plan" && !q.whatIf && q.pieces && q.from == null) window.__reqs.push(JSON.parse(JSON.stringify(q))); } catch {} return pm.call(this, m, ...r); };
  }, BUILD);
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
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const reqs = page => page.evaluate(() => window.__reqs);
const last = async page => (await reqs(page)).at(-1);
const waitReqs = async (page, n, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await reqs(page)).length >= n) return true; await page.waitForTimeout(100); } return false; };
const waitLast = async (page, ok, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const q = await last(page); if (q && ok(q)) return true; await page.waitForTimeout(100); } return false; };
const toggles = page => page.evaluate(() => ({ c: (() => { const t = document.querySelector('#path .tog[data-t="c"]').cloneNode(true); t.querySelector(".bud")?.remove(); return t.textContent.replace(/\s+/g, " ").trim(); })(), d: document.querySelector('#path .tog[data-t="d"]').textContent.replace(/\s+/g, " ").trim(),
  note: document.querySelector("#path .stknote")?.textContent || null }));

try {
  const { ctx, page } = await open(stateOf(STOCK1));
  check("stock: a plan request was sent", await waitReqs(page, 1));
  await page.waitForTimeout(900);
  const q = await last(page), t = await toggles(page);
  check("stock: the request carries the Switch chunks and drinks", JSON.stringify(q.chunks) === JSON.stringify(STOCK1.chunks) && JSON.stringify(q.drinks) === JSON.stringify(STOCK1.drinks), JSON.stringify(q));
  check("stock: the toggles carry no numbers and nothing to tap", t.c === "Chunks" && t.d === "Drinks" && t.note === null && await page.locator("#path .stktap").count() === 0, JSON.stringify(t));
  await page.screenshot({ path: path.join(here, "out", "path-stock.png") });
  const n = (await reqs(page)).length;
  await page.evaluate(s => window.__emit("state", s), stateOf(STOCK2));
  check("stock change: replans with the new chunks", await waitReqs(page, n + 1) && JSON.stringify((await last(page)).chunks) === JSON.stringify(STOCK2.chunks), JSON.stringify(await last(page)));
  const n2 = (await reqs(page)).length;
  await page.click('#path .tog[data-t="c"] .chunklit');   // the pill, not its budget buttons
  check("chunks off: the request says useChunks false", await waitReqs(page, n2 + 1) && (await last(page)).useChunks === false, JSON.stringify(await last(page)));
  await ctx.close();

  const c2 = await open(stateOf(null));
  check("no stock: a plan request was sent", await waitReqs(c2.page, 1));
  await c2.page.waitForTimeout(1200);
  const q2 = await last(c2.page), t2 = await toggles(c2.page);
  check("no stock: requests carry empty chunks and drinks", JSON.stringify(q2.chunks) === "{}" && JSON.stringify(q2.drinks) === "{}");
  check("no stock: the note shows and the toggles have no numbers", t2.note === "Chunk and ticket counts come from the Switch; none read yet." && t2.c === "Chunks" && t2.d === "Drinks", JSON.stringify(t2));
  await c2.page.screenshot({ path: path.join(here, "out", "path-nostock.png") });
  await c2.page.click('#path .tog[data-t="c"] .knob'); await c2.page.waitForTimeout(500);   // the pill, not its picture (that opens the counts)
  check("no stock: the note stays while Drinks is on", (await toggles(c2.page)).note !== null);
  await c2.page.click('#path .tog[data-t="d"]'); await c2.page.waitForTimeout(500);
  check("no stock: the note goes when both are off", (await toggles(c2.page)).note === null);
  await c2.ctx.close();

  // typed counts (no Switch stock)
  const c3 = await open(stateOf(null)), p3 = c3.page;
  await waitReqs(p3, 1); await p3.waitForTimeout(900);
  const pop = '#path .stockpop', shown = () => p3.evaluate(() => { const e = document.querySelector("#path .stockpop"); return !!e && e.classList.contains("on") && getComputedStyle(e).visibility === "visible"; });
  const useC = await p3.evaluate(() => document.querySelector('#path .tog[data-t="c"]').classList.contains("on"));
  const aria = () => p3.evaluate(() => [...document.querySelectorAll("#path .stktap")].map(s => [s.closest(".tog").dataset.t, s.classList.contains("chunklit") || s.classList.contains("tkt"), s.getAttribute("aria-haspopup"), s.getAttribute("aria-expanded")].join()));
  check("typed: the trigger is each toggle's own picture (chunk, ticket), a dialog trigger, shut", JSON.stringify(await aria()) === JSON.stringify(["c,true,dialog,false", "d,true,dialog,false"]), JSON.stringify(await aria()));
  await p3.click('#path .stktap[data-stock="chunks"]'); await p3.waitForTimeout(400);
  check("typed: tapping the chunk picture opens the popover (expanded) and leaves the toggle alone", await shown() && (await p3.evaluate(() => document.querySelector('#path .tog[data-t="c"]').classList.contains("on"))) === useC && (await aria())[0] === "c,true,dialog,true", JSON.stringify(await aria()));
  check("typed: 14 abilities with 32px icons", await p3.evaluate(() => { const i = [...document.querySelectorAll("#path .stockpop .sk-c img")]; return i.length === 14 && i.every(x => x.getBoundingClientRect().width > 0 && x.offsetWidth === 32); }));
  const n3 = (await reqs(p3)).length;
  await p3.fill(`${pop} input[data-id="${S}"]`, "30");
  await p3.fill(`${pop} input[data-id="${MI}"]`, "12");
  // each fill is its own request: wait for the one carrying both (waiting on n3+1 could return on the first fill's)
  check("typed: chunks reach the plan request", await waitReqs(p3, n3 + 1) && await waitLast(p3, q => same(q.chunks, { [S]: 30, [MI]: 12 })), JSON.stringify(await last(p3)));
  await p3.waitForTimeout(700);
  check("typed: the note is gone, the toggle has no number, the popover stayed open", (await toggles(p3)).c === "Chunks" && (await toggles(p3)).note === null && await shown(), JSON.stringify(await toggles(p3)));
  await p3.fill(`${pop} input[data-id="${R}"]`, "5000"); await p3.waitForTimeout(500);
  check("typed: values clamp to 999", await p3.inputValue(`${pop} input[data-id="${R}"]`) === "999" && await waitLast(p3, q => q.chunks[R] === 999), JSON.stringify((await last(p3)).chunks));
  await p3.fill(`${pop} input[data-id="${R}"]`, "-4"); await p3.waitForTimeout(500);
  check("typed: negatives clamp to 0 and zeros are omitted", await waitLast(p3, q => same(q.chunks, { [S]: 30, [MI]: 12 })), JSON.stringify((await last(p3)).chunks));
  await p3.focus(`${pop} input[data-id="${R}"]`); { const bb = await p3.locator(`${pop} input[data-id="${R}"]`).boundingBox(); await p3.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); } await p3.mouse.wheel(0, -100); await p3.waitForTimeout(400);
  check("typed: the wheel steps by one", await p3.inputValue(`${pop} input[data-id="${R}"]`) === "1");
  await p3.screenshot({ path: path.join(here, "out", "path-stock-popover.png") });
  await p3.keyboard.press("Escape"); await p3.waitForTimeout(400);
  check("typed: Esc closes", !(await shown()));
  await p3.click('#path .stktap[data-stock="drinks"]'); await p3.waitForTimeout(400);
  check("typed: the drinks popover opens and shows its own counts", await shown() && await p3.evaluate(t => document.querySelector("#path .stockpop .sk-t").textContent === t, "Drinks"));
  await p3.fill(`${pop} input[data-id="${R}"]`, "7"); await p3.keyboard.press("Enter"); await p3.waitForTimeout(500);
  check("typed: Enter closes; drinks reach the request", !(await shown()) && JSON.stringify((await last(p3)).drinks) === JSON.stringify({ [R]: 7 }), JSON.stringify((await last(p3)).drinks));
  await p3.click('#path .stktap[data-stock="chunks"]'); await p3.waitForTimeout(300);
  await p3.mouse.click(300, 600); await p3.waitForTimeout(400);
  check("typed: a click outside closes", !(await shown()));
  const saved = await p3.evaluate(() => localStorage.getItem("seedtracker.stock.v1"));
  check("typed: saved under seedtracker.stock.v1", JSON.stringify(JSON.parse(saved)) === JSON.stringify({ chunks: { [S]: 30, [MI]: 12, [R]: 1 }, drinks: { [R]: 7 } }), saved);
  await p3.reload(); await p3.waitForSelector("#path .pl", { state: "attached" }); await p3.click('.tab[data-s="builds"]');
  await waitReqs(p3, 1); await p3.waitForTimeout(900);
  const q3 = await last(p3);
  check("typed: counts persist across reload and reach the first request", same(q3.chunks, { [S]: 30, [MI]: 12, [R]: 1 }) && JSON.stringify(q3.drinks) === JSON.stringify({ [R]: 7 }), JSON.stringify(q3));
  await p3.evaluate(s => window.__emit("state", s), stateOf(STOCK1)); await p3.waitForTimeout(1200);
  const q4 = await last(p3), t4 = await toggles(p3);
  check("typed: Switch stock wins, the picture is not tappable, no note", JSON.stringify(q4.chunks) === JSON.stringify(STOCK1.chunks) && t4.c === "Chunks" && t4.note === null && await p3.locator("#path .stktap").count() === 0, JSON.stringify([q4.chunks, t4]));
  await c3.ctx.close();
  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
  check("harness ran", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
