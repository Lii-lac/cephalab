// The static build (web/dist-static, from `cd web && npm run build:static`) served by a tiny node:http server, no companion at all.
// Proves: no /api request, no page error, no failed request on Weapons / Gear / Path / Settings; the Switch pill says offline;
// Settings shows Connections greyed without "companion" wording and no Folder / Image cache / Reset rows; the s3s gear export in
// tests/fixtures is read in the browser (same pieces as companion/server.py decode_export), kept over a reload, and Path plans from it.
// Run from the repo root: node tests/web/static.mjs   (PASS/FAIL lines, exit 1 on any failure)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../.."), web = path.join(repo, "web");
const dist = path.join(web, "dist-static");
const { chromium } = createRequire(path.join(web, "package.json"))("playwright");
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };
if (!fs.existsSync(path.join(dist, "index.html"))) { console.log("FAIL  web/dist-static is missing: run npm run build:static in web/"); process.exit(1); }

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".avif": "image/avif", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".jpg": "image/jpeg", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || "/").split("?")[0]), file = path.join(dist, p === "/" ? "index.html" : p);
  if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  res.end(fs.readFileSync(file));
});
await new Promise(ok => server.listen(5180, "127.0.0.1", ok));
const url = "http://127.0.0.1:5180/";

// ---- the TS reader against the Python one, on the fixture
const doc = JSON.parse(fs.readFileSync(path.join(repo, "tests/fixtures/s3s_gear_export.json"), "utf8"));
const py = execFileSync(path.join(repo, ".venv/Scripts/python.exe"), ["-c",
  "import json,sys; from companion.server import decode_export; k,p=decode_export(json.load(open(sys.argv[1],encoding='utf-8'))); print(json.dumps({'key':k,'pieces':p}))",
  path.join(repo, "tests/fixtures/s3s_gear_export.json")], { cwd: repo, encoding: "utf8" });
const { decodeExport } = await import(pathToFileURL(path.join(web, "src/local/outfit.ts")).href);
const ts = decodeExport(doc), pyOut = JSON.parse(py);
check("outfit: TS and Python read the fixture the same", JSON.stringify(ts) === JSON.stringify(pyOut) && ts.pieces.length === 3, JSON.stringify(ts).slice(0, 200));
let bad = null; try { decodeExport({ gear: doc.gear }); } catch (e) { bad = e.message; }
check("outfit: a file that isn't an export is refused in the Python words", bad === "not an s3s --getseed export (needs key, h and gear)", String(bad));

// ---- the page
const builds = JSON.parse(fs.readFileSync(path.join(repo, "tests/fixtures/builds.json"), "utf8"));
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(b => { try { if (!localStorage.getItem("seedtracker.mybuilds.v2") && !sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1");
    localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify(b)); localStorage.setItem("seedtracker.pathbuild", "200002"); } } catch {} }, builds);
  const page = await ctx.newPage();
  const api = [], errors = [], failedReq = [];
  page.on("request", r => { if (new URL(r.url()).pathname.includes("/api")) api.push(r.url()); });
  page.on("pageerror", e => errors.push(e.message));
  page.on("response", r => { if (r.status() >= 400) failedReq.push(r.status() + " " + r.url()); });
  page.on("requestfailed", r => failedReq.push("failed " + r.url()));
  await page.goto(url);
  await page.waitForSelector(".tab[data-s=gear]");
  await page.waitForTimeout(1500);
  const pill = await page.evaluate(() => ({ live: document.querySelector(".switch")?.dataset.live, text: document.querySelector(".switch")?.textContent }));
  check("pill: Switch offline", pill.live === "offline" && /offline/.test(pill.text || ""), JSON.stringify(pill));
  for (const s of ["gear", "weapons", "builds"]) { await page.click(`.tab[data-s="${s}"]`); await page.waitForTimeout(1200); }
  const imgs = await page.evaluate(() => [...document.images].filter(i => i.getAttribute("src")).map(i => i.getAttribute("src")));
  check("images: every image is a relative img/ path", imgs.length > 20 && imgs.filter(s => s.startsWith("./img/") || s.startsWith("img/")).length === imgs.filter(s => /\/img\//.test(s) && !s.includes("assets")).length, String(imgs.length));
  const broken = await page.evaluate(() => [...document.images].filter(i => i.getAttribute("src") && i.complete && i.naturalWidth === 0).map(i => i.src));
  check("images: none broken on Gear / Weapons / Path", broken.length === 0, broken.slice(0, 3).join(" "));
  // Settings
  await page.click("#cog"); await page.waitForSelector("#settings .st-cat", { state: "visible" }); await page.waitForTimeout(600);
  const conn = await page.evaluate(() => {
    const pg = document.querySelector("#settings .st-pg[data-cat=connections]");
    return { grey: [...pg.querySelectorAll("[data-api]")].every(r => r.hasAttribute("inert")), text: document.querySelector("#settings").innerText, offLine: getComputedStyle(document.querySelector("#offLine")).opacity };
  });
  check("settings: Connections greyed", conn.grey);
  check("settings: no 'companion' wording on screen", !/companion/i.test(conn.text), conn.text.match(/.{0,30}companion.{0,30}/i)?.[0]);
  await page.click(".st-cat[data-cat=data]"); await page.waitForTimeout(500);
  const data = await page.evaluate(() => {
    const vis = id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0 && getComputedStyle(e.closest(".st-grp") || e).display !== "none" && !e.closest("[style*='display: none']"); };
    return { folder: vis("openDir"), cache: vis("clearImg"), reset: vis("reset"), exp: vis("export"), imp: vis("importB"), gear: vis("importG") };
  });
  check("settings Data: Folder, Image cache and Reset are hidden", !data.folder && !data.cache && !data.reset, JSON.stringify(data));
  check("settings Data: export, import and s3s gear stay", data.exp && data.imp && data.gear, JSON.stringify(data));
  // the s3s file, read in the browser
  await page.setInputFiles("#fileG", path.join(repo, "tests/fixtures/s3s_gear_export.json"));
  await page.waitForTimeout(700);
  const said = await page.evaluate(() => document.querySelector("#buildsMsg").innerText);
  check("import: the file says 3 pieces imported", /3 pieces imported/.test(said), said);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("seedtracker.file-snapshot.v1") || "null"));
  check("import: kept in localStorage", stored?.source === "file" && stored.pieces.length === 3);
  await page.reload(); await page.waitForSelector(".tab[data-s=builds]"); await page.waitForTimeout(800);
  await page.click('.tab[data-s="builds"]');
  const lanes = await page.waitForFunction(() => document.querySelectorAll("#path .lane").length >= 1 && document.querySelectorAll("#path .have .ab:not(.q) img").length >= 1, null, { timeout: 20000 }).then(() => true, () => false);
  check("path: plans from the imported file after a reload (lanes with your current abilities)", lanes);
  await page.waitForTimeout(1500);
  check("no /api request at all", api.length === 0, api.join(" "));
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  check("no failed requests (404s)", failedReq.length === 0, failedReq.slice(0, 4).join(" | "));
} catch (e) { check("test ran", false, e.stack); }
await browser.close(); server.close();
console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: all PASS");
process.exit(failed ? 1 : 0);
