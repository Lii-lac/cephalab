// The real Settings screen (web/src/signin.ts + web/src/settings/*) on the Vite dev server with the companion stubbed (page.route):
// every category opens and fits 1440x900 and 1280x720 without a scrollbar, each control sends the right request, the offline
// state greys rows, Reset needs two clicks, builds export then import round-trips. Shots: tests/web/out/settings-<category>.png
// and settings-offline.png. Run from the repo root: node tests/web/settings.mjs   (PASS/FAIL lines, exit 1 on any failure)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../.."), web = path.join(repo, "web");
const need = createRequire(path.join(web, "package.json"));
const { chromium } = need("playwright");
const { createServer } = await import(pathToFileURL(need.resolve("vite")).href);
const OUT = path.join(here, "out");
fs.mkdirSync(OUT, { recursive: true });
const CATS = ["connections", "display", "data"];
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };

function makeMock(over = {}) {
  const m = { settings: { switch: { host: "192.168.1.20", port: 6000, every: 15 }, splatnet: { every: "battle" }, data: { folder: "C:\\SeedTracker\\state", cacheBytes: 39845888 } },
    login: { enabled: true, signedIn: true, fApi: "https://api.imink.app/f" }, test: { ok: true, version: "11.3.0" }, offline: false, reqs: [], ...over };
  m.handle = route => {
    const req = route.request(), p = new URL(req.url()).pathname, json = (s, b) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (m.offline || !/^\/api\/(settings|switch|data|cache|reset|login|logout|import|log)/.test(p)) return json(404, { error: "mock" });
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    m.reqs.push({ method: req.method(), path: p, ct: req.headers()["content-type"], body });
    if (p === "/api/settings") { if (req.method() === "POST") { for (const k of Object.keys(body)) Object.assign(m.settings[k], body[k]); } return json(200, m.settings); }
    if (p === "/api/log") return json(200, { text: "Cephalab v0.1.0 (exe)\n2026-11-24 [INFO] Listening", path: "C:\\SeedTracker\\state\\cephalab.log" });
    if (p === "/api/switch/test") return json(200, m.test);
    if (p === "/api/data/open" || p === "/api/reset") return json(200, { ok: true });
    if (p === "/api/cache/clear") { m.settings.data.cacheBytes = 0; return json(200, { ok: true, cacheBytes: 0 }); }
    if (p === "/api/login") return json(200, m.login);
    if (p === "/api/logout") { m.login.signedIn = false; return json(200, { ok: true }); }
    if (p === "/api/import") return json(200, { ok: true, pieces: 3 });
    return json(404, {});
  };
  return m;
}
const sent = (m, method, p) => m.reqs.filter(r => r.method === method && r.path === p);

async function newPage(browser, url, m, opts = {}, seed = null) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "en-US", acceptDownloads: true, ...opts });
  if (seed) await ctx.addInitScript(s => { if (!localStorage.getItem("seedtracker.mybuilds.v2") && !sessionStorage.getItem("seeded")) { localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify(s)); sessionStorage.setItem("seeded", "1"); } }, seed);
  const page = await ctx.newPage();
  page.on("pageerror", e => { console.log("  page error:", e.message); failed++; });
  await page.route("**/api/**", m.handle);
  await page.goto(url);
  await page.waitForFunction(() => window.seedtracker);
  await page.waitForSelector("#settings .st-cat", { state: "attached" });
  await page.click("#cog");
  await page.waitForSelector("#settings.on .st-pg.on");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  return { ctx, page };
}
const pickCat = async (page, cat) => { await page.click(`.st-cat[data-cat=${cat}]`); await page.waitForTimeout(450); };
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `settings-${name}.png`), caret: "hide" });
const measure = page => page.evaluate(() => {
  const els = [".st-menu", ".st-cats", ".st-credits"].map(s => document.querySelector("#settings " + s).getBoundingClientRect().bottom);
  const pg = document.querySelector("#settings .st-pg.on"), scr = document.querySelector("#settings"), doc = document.scrollingElement;
  const d = [scr.scrollHeight - scr.clientHeight, doc.scrollHeight - doc.clientHeight, pg.scrollHeight - pg.clientHeight];
  return { d, room: innerHeight - Math.max(...els), scrolls: scr.scrollHeight > scr.clientHeight + 1 || doc.scrollHeight > doc.clientHeight + 1 || pg.scrollHeight > pg.clientHeight + 5 };
});
const post = (m, p) => sent(m, "POST", p);

const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5178, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  // ---- fit, at both sizes ------------------------------------------------------------------------------------------
  for (const [w, h] of [[1440, 900], [1280, 720]]) {
    const { ctx, page } = await newPage(browser, url, makeMock(), { viewport: { width: w, height: h } });
    const bad = [], hs = [];
    for (const cat of CATS) {
      await pickCat(page, cat);
      const m = await measure(page);
      if (m.room < 0 || m.scrolls) bad.push(`${cat} (${m.room.toFixed(0)}px${m.scrolls ? ", scrolls " + m.d : ""})`);
      await page.waitForTimeout(320);                // the board's resize to this page
      hs.push(await page.evaluate(() => { const paper = document.querySelector("#settings .st-paper").getBoundingClientRect(), pg = document.querySelector("#settings .st-pg.on");
        return paper.bottom - Math.max(...[...pg.querySelectorAll(".st-slab, .st-foot .st-btn")].map(e => e.getBoundingClientRect().bottom)); }));
      if (w === 1440) await shot(page, cat);
      if (w === 1280 && cat === "data") await shot(page, "data-1280");
    }
    check(`fit ${w}x${h}: every page leaves under 48px of empty paper below its last row`, hs.every(v => v < 48), hs.map(v => v.toFixed(0)).join(", "));
    check(`fit ${w}x${h}: every category opens with no scrollbar`, !bad.length, bad.join(", "));
    await ctx.close();
  }

  // ---- Connections -------------------------------------------------------------------------------------------------
  {
    const m = makeMock();
    const { ctx, page } = await newPage(browser, url, m);
    check("connections: GET /api/settings fills Address and port", (await page.inputValue("#ip")) === "192.168.1.20" && (await page.inputValue("#port")) === "6000");
    check("connections: Nintendo says Signed in", /Signed in/.test(await page.innerText("#nnStat")));
    await page.fill("#ip", "999.1.1.1"); await page.press("#ip", "Enter");
    await page.waitForSelector("#swMsg.err.on");
    check("address: an invalid IP shows its line in the error colour and sends nothing", post(m, "/api/settings").length === 0 && (await page.evaluate(() => getComputedStyle(document.querySelector("#swMsg")).color)) !== (await page.evaluate(() => getComputedStyle(document.querySelector("#settings .st-paper")).color)));
    await page.fill("#port", "70000"); await page.fill("#ip", "192.168.1.30"); await page.press("#ip", "Enter");
    await page.waitForTimeout(400);
    check("port: 70000 is refused, nothing sent", post(m, "/api/settings").length === 0);
    await page.fill("#port", "6001"); await page.press("#port", "Enter");
    await page.waitForFunction(() => /Saved/.test(document.querySelector("#swMsg").textContent) && document.querySelector("#swMsg").classList.contains("on"));
    const sv = post(m, "/api/settings");
    check("address + port: Enter POSTs {switch:{host,port}} as JSON and says Saved", sv.length === 1 && JSON.stringify(sv[0].body) === JSON.stringify({ switch: { host: "192.168.1.30", port: 6001 } }) && /^application\/json/.test(sv[0].ct));
    await page.waitForFunction(() => !document.querySelector("#swMsg").classList.contains("on"), null, { timeout: 5000 });
    check("Saved fades away", true);
    await page.click("#test");
    await page.waitForFunction(() => document.querySelector("#swStat").dataset.s === "ok");
    const t = post(m, "/api/switch/test");
    check("Test connection: POST /api/switch/test {host,port}; status Connected 11.3.0", t.length === 1 && JSON.stringify(t[0].body) === JSON.stringify({ host: "192.168.1.30", port: 6001 }) && /11\.3\.0/.test(await page.innerText("#swStat")));
    await page.waitForTimeout(300);
    await page.click("#readRow [data-v='5']");
    await page.waitForFunction(() => /Saved/.test(document.querySelector("#swMsg").textContent));
    check("Read every 5 s: POST {switch:{every:5}}", JSON.stringify(post(m, "/api/settings").at(-1).body) === JSON.stringify({ switch: { every: 5 } }));
    await page.click("#checkRow [data-v='5min']");
    await page.waitForTimeout(200);
    check("Check SplatNet Every 5 min: POST {splatnet:{every:'5min'}}", JSON.stringify(post(m, "/api/settings").at(-1).body) === JSON.stringify({ splatnet: { every: "5min" } }));
    check("Install sys-botbase opens the releases page in a new tab", (await page.getAttribute(".st-link", "href")) === "https://github.com/olliz0r/sys-botbase/releases" && (await page.getAttribute(".st-link", "target")) === "_blank");
    m.test = { ok: false, error: "Nothing answered at that address." };
    await page.click("#test");
    await page.waitForFunction(() => document.querySelector("#swStat").dataset.s === "err" && /Can.t reach/.test(document.querySelector("#swStat").textContent));
    check("Test connection failing: Can't reach, with the companion's error", /Can't reach/.test(await page.innerText("#swStat")) && /Nothing answered/.test(await page.innerText("#swMsg")));
    await page.click("#signout");
    await page.waitForTimeout(500);
    await page.waitForFunction(() => document.querySelector("#nnStat").dataset.s === "off");
    check("Nintendo: Sign out POSTs /api/logout, then Sign in is offered", post(m, "/api/logout").length === 1 && (await page.locator("#nnOut:not([hidden])").count()) === 1);
    await ctx.close();
  }

  // ---- offline -----------------------------------------------------------------------------------------------------
  {
    const m = makeMock({ offline: true });
    const { ctx, page } = await newPage(browser, url, m);
    await page.waitForTimeout(400);
    const o = await page.evaluate(() => ({ line: document.querySelector("#offText").innerText, btn: document.querySelector("#startComp").innerText, on: document.querySelector("#offLine").classList.contains("on"),
      grey: [...document.querySelectorAll("#settings .st-pg.on [data-api]")].map(e => +getComputedStyle(e).opacity), inert: [...document.querySelectorAll("#settings [data-api]")].every(e => e.inert) }));
    await shot(page, "offline");
    check("offline: quiet line + Start companion button and companion rows greyed", o.on && o.line === "Companion not running" && o.btn === "Start companion" && o.grey.length >= 2 && o.grey.every(v => v < 1) && o.inert, JSON.stringify(o));
    await pickCat(page, "data");
    check("offline: Data rows are greyed too", (await page.evaluate(() => [...document.querySelectorAll("#settings .st-pg.on [data-api]")].every(e => +getComputedStyle(e).opacity < 1 && e.inert))));
    // clicking Start companion wakes the settings screen once the companion answers
    await pickCat(page, "connections");
    await page.evaluate(() => { window.__uri = ""; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.href?.startsWith("cephalab://")) { window.__uri = this.href; return; } return orig.call(this); }; });
    await page.click("#startComp");
    m.offline = false;
    await page.waitForFunction(() => !document.querySelector("#offLine").classList.contains("on"), null, { timeout: 5000 });
    check("offline: Start companion triggers cephalab://start and reconnects when companion answers", (await page.evaluate(() => window.__uri)) === "cephalab://start" && (await page.evaluate(() => !document.querySelector(".st-page").classList.contains("offline"))));
    await ctx.close();
  }

  // ---- Display -----------------------------------------------------------------------------------------------------
  {
    const { ctx, page } = await newPage(browser, url, makeMock());
    await pickCat(page, "display");
    await page.click("[data-key=motion] [data-v=reduced]");
    await page.click("#contrast");
    await page.click("#zoom [data-v='1.1']");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("st.display")));
    check("display: choices saved in localStorage st.display", saved.motion === "reduced" && saved.contrast === true && saved.zoom === 1.1, JSON.stringify(saved));
    check("display: Reduced adds st-still (which motion.ts reads), contrast st-hc, zoom --stuz", await page.evaluate(() => document.documentElement.classList.contains("st-still") && document.documentElement.classList.contains("st-hc") && document.documentElement.style.getPropertyValue("--stuz") === "1.1"));
    check("display: with Reduced, transitions are off", await page.evaluate(() => getComputedStyle(document.querySelector(".st-cat")).transitionDuration === "0s"));
    await page.waitForTimeout(500);
    const m = await measure(page);
    check("display: at zoom 110 % the board still fits", m.room >= 0 && !m.scrolls, JSON.stringify(m));
    await page.reload(); await page.waitForSelector("#settings .st-cat", { state: "attached" });
    check("display: applied again after a reload", await page.evaluate(() => document.documentElement.classList.contains("st-still") && document.documentElement.style.getPropertyValue("--stuz") === "1.1"));
    await ctx.close();
  }

  // ---- Display: dragging the zoom strip zooms live and ends on the tick under the release point ----------------------
  {
    const { ctx, page } = await newPage(browser, url, makeMock());
    await pickCat(page, "display");
    const xs = () => page.evaluate(() => [...document.querySelectorAll("#zoom .st-tt i")].map(i => { const r = i.getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]; }));
    const at0 = await xs(), [x0, y] = at0[2], [x1] = at0[15];
    // the zoom at tick 15: anchors 90 % at tick 0, 100 % at 11, 110 % at 17, 125 % at 23, even steps between
    const want = Math.round((1 + (15 - 11) / 6 * 0.1) * 1e4) / 1e4;
    await page.mouse.move(x0, y); await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(x0 + (x1 - x0) * i / 12, y); await page.waitForTimeout(30); }
    await page.waitForTimeout(300);
    const mid = await page.evaluate(() => ({ stuz: document.documentElement.style.getPropertyValue("--stuz"), saved: localStorage.getItem("st.display") }));
    const moved = (await xs())[15][0];
    await shot(page, "zoom-drag");
    await page.mouse.up();
    await page.waitForTimeout(300);
    const end = await page.evaluate(() => ({ saved: JSON.parse(localStorage.getItem("st.display") || "{}").zoom, stuz: document.documentElement.style.getPropertyValue("--stuz"), lit: document.querySelectorAll("#zoom .st-tt i.lit").length }));
    check("zoom drag: the page zooms while dragging, nothing saved until release", mid.stuz === String(want) && !mid.saved && Math.abs(moved - x1) > 5, JSON.stringify({ mid, moved, x1 }));
    check("zoom drag: ends at the tick under the release point despite the live zoom", end.saved === want && end.stuz === String(want) && end.lit === 16, JSON.stringify({ end, want }));
    await page.reload(); await page.waitForSelector("#settings .st-cat", { state: "attached" });
    check("zoom drag: a value between the numbers loads", await page.evaluate(w => document.documentElement.style.getPropertyValue("--stuz") === String(w) && document.querySelectorAll("#zoom .st-tt i.lit").length === 16 && !document.querySelector("#zoom .at"), want));
    await ctx.close();
  }

  // ---- Data --------------------------------------------------------------------------------------------------------
  {
    const m = makeMock();
    const { ctx, page } = await newPage(browser, url, m);
    await pickCat(page, "data");
    check("data: folder and cache size from the companion", (await page.innerText("#dataDir")) === "C:\\SeedTracker\\state" && (await page.innerText("#imgSize")) === "38 MB", await page.innerText("#imgSize"));
    await page.click("#openDir"); await page.waitForTimeout(200);
    check("Open: POST /api/data/open", post(m, "/api/data/open").length === 1 && /^application\/json/.test(post(m, "/api/data/open")[0].ct));
    const openBefore = await page.evaluate(() => document.querySelector("#openDir").getBoundingClientRect().left);
    await page.evaluate(() => { window.__copied = ""; Object.defineProperty(navigator, "clipboard", { value: { writeText: async t => { window.__copied = t; } }, configurable: true }); });
    await page.click("#copyLog"); await page.waitForTimeout(300);
    const openAfter = await page.evaluate(() => document.querySelector("#openDir").getBoundingClientRect().left);
    check("Copy log: GET /api/log, copies log text, fades to Copied without layout shift", /Cephalab v0\.1\.0/.test(await page.evaluate(() => window.__copied)) && (await page.innerText("#copyLog")) === "Copied" && Math.abs(openAfter - openBefore) < 0.5);
    await page.click("#clearImg"); await page.waitForTimeout(400);
    check("Clear cached images: POST /api/cache/clear, size drops to 0", post(m, "/api/cache/clear").length === 1 && /^0 B$/.test(await page.innerText("#imgSize")));
    await page.click("#reset"); await page.waitForTimeout(300);
    check("reset: the first click only arms it (label changes, nothing sent)", (await page.innerText("#reset")) === "Click again" && post(m, "/api/reset").length === 0);
    await shot(page, "reset-armed");
    await page.waitForTimeout(4400);
    check("reset: lets go after 4 s", (await page.innerText("#reset")) === "Reset everything" && post(m, "/api/reset").length === 0);
    await page.evaluate(() => { localStorage.setItem("seedtracker.mybuilds.v2", "[]"); });
    await page.click("#reset"); await page.waitForTimeout(250);
    const nav = page.waitForEvent("load", { timeout: 8000 }).then(() => true, () => false);
    await page.click("#reset");
    check("reset: the second click reloads the page", await nav);
    await page.waitForFunction(() => window.seedtracker);
    check("reset: POST /api/reset sent once", post(m, "/api/reset").length === 1);
    const left = await page.evaluate(() => new Promise(ok => { const r = indexedDB.open("seedtracker"); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").getAllKeys(); q.onsuccess = () => ok(q.result); }; }));
    check("reset: IndexedDB holds nothing but its marker; st.display and the old keys are gone", left.length === 1 && (await page.evaluate(() => localStorage.getItem("st.display") === null && localStorage.getItem("seedtracker.mybuilds.v2") === null)), JSON.stringify(left));
    await ctx.close();
  }

  // ---- Builds: export, then import in a fresh browser --------------------------------------------------------------
  {
    const mk = (id, t) => ({ id, title: t, modes: ["SZ"], set: [["", "", ["", "", ""]], ["", "", ["", "", ""]], ["", "", ["", "", ""]]] });
    const A = await newPage(browser, url, makeMock(), {}, [mk(100001, "One"), mk(100002, "Two"), mk(100003, "Three")]);
    await pickCat(A.page, "data");
    check("builds: the Export chip counts your builds", (await A.page.innerText("#nBuilds")) === "3");
    const dl = A.page.waitForEvent("download");
    await A.page.click("#export");
    const file = path.join(OUT, "settings-builds-export.json");
    await (await dl).saveAs(file);
    const ex = JSON.parse(fs.readFileSync(file, "utf8"));
    check("builds: Export saves a JSON file with all 3 builds", ex.builds.length === 3 && ex.builds[0].title === "One");
    await A.ctx.close();
    const B = await newPage(browser, url, makeMock(), {}, [mk(100002, "Two"), mk(100009, "Nine")]);
    await pickCat(B.page, "data");
    await B.page.setInputFiles("#fileB", file);
    await B.page.waitForSelector("#incoming.open");
    check("builds import: the file's 3 builds are shown before anything changes", (await B.page.innerText("#nIn")) === "3" && (await B.page.innerText("#nBuilds")) === "2");
    await B.page.waitForTimeout(300);
    await shot(B.page, "builds-import");
    await B.page.click("#doImport");
    await B.page.waitForTimeout(500);
    await B.page.waitForFunction(() => /added/.test(document.querySelector("#buildsMsg").textContent));
    const ids = await B.page.evaluate(async () => (await import("/src/store.ts")).store.get("seedtracker.mybuilds.v2").map(b => b.id));
    check("builds import: merges by id, says 2 added (the shared one is skipped)", (await B.page.innerText("#buildsMsg")) === "2 added" && JSON.stringify(ids) === JSON.stringify([100002, 100009, 100001, 100003]) && (await B.page.innerText("#nBuilds")) === "4", JSON.stringify(ids));
    await B.page.evaluate(() => document.fonts.ready);
    await B.page.setInputFiles("#fileB", { name: "x.json", mimeType: "application/json", buffer: Buffer.from("nope") });
    await B.page.waitForSelector("#buildsMsg.err.on");
    check("builds import: a file that isn't JSON is refused with a line", /Not a JSON/.test(await B.page.innerText("#buildsMsg")));
    const gm = B.page.context();
    await B.page.setInputFiles("#fileG", { name: "gear_1.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ gear: [1] })) });
    await B.page.waitForFunction(() => /pieces imported/.test(document.querySelector("#buildsMsg").textContent));
    check("s3s gear file: still POSTs /api/import", true);
    void gm;
    await B.ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `RESULT: FAIL (${failed})` : "RESULT: PASS");
process.exit(failed ? 1 : 0);
