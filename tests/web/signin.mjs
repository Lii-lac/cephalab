// SplatNet sign-in on the Settings screen (web/src/signin.ts) against mocked /api routes: every state shot to tests/web/out/settings-<state>.png,
// the requests it sends asserted (method, Content-Type, body), opening via the cog and the Switch pill, the cog's badge following the login state.
// Run from the repo root: node tests/web/signin.mjs   (prints PASS/FAIL lines, exit 1 on any failure)
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

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };
const GOOD = "npf71b963c1b7b6d119://auth#session_state=abc&session_token_code=xyz";
const shots = [];
const await0 = lp => lp.evaluate(() => document.querySelector(".switch")?.dataset.tip);

// ---- the mocked companion --------------------------------------------------------------------------------------
function makeMock() {
  const m = { login: { enabled: true, signedIn: false, fApi: "https://api.imink.app/f" }, linkStatus: 200, linkDelay: 0, importReply: { status: 200, body: { ok: true, pieces: 3 } }, reqs: [] };
  m.handle = async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!/^\/api\/(login|logout|import|settings)/.test(p)) return json(404, { error: "mock" });
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    m.reqs.push({ method: req.method(), path: p, ct: req.headers()["content-type"], body });
    if (p === "/api/settings") return json(200, { switch: { host: "", port: 6000, every: 15 }, splatnet: { every: "battle" }, data: { folder: "state", cacheBytes: 0 } });
    if (p === "/api/login" && req.method() === "GET") return json(200, m.login);
    if (p === "/api/login/link") { if (m.linkDelay) await new Promise(r => setTimeout(r, m.linkDelay)); return m.linkStatus === 200 ? json(200, { url: "https://accounts.nintendo.com/connect/1.0.0/authorize?mock=1" }) : json(m.linkStatus, { error: "SplatNet is off" }); }
    if (p === "/api/login") { if (body.link === GOOD) { m.login = { ...m.login, signedIn: true }; return json(200, { ok: true }); } return json(400, { error: "That link has no session token. Copy the red button's link." }); }
    if (p === "/api/logout") { m.login = { ...m.login, signedIn: false }; return json(200, { ok: true }); }
    if (p === "/api/import") return json(m.importReply.status, m.importReply.body);
    return json(404, {});
  };
  return m;
}
const sent = (m, method, p) => m.reqs.filter(r => r.method === method && r.path === p);

async function newPage(browser, url, m, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", ...opts });
  await ctx.route(/^https?:\/\//, route => {
    const u = route.request().url();
    if (u.startsWith("http://localhost") || u.startsWith("http://127.0.0.1")) return route.fallback();
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>Nintendo (mock)</title>" });
  });
  await ctx.addInitScript(() => { window.__seedtrackerMock = true; });
  const page = await ctx.newPage();
  page.on("pageerror", e => { console.log("  page error:", e.message); failed++; });
  await page.route("**/api/**", m.handle);
  await page.goto(url);
  await page.waitForFunction(() => window.seedtracker);
  await page.evaluate(async () => { window.si = await import("/src/signin.ts"); });
  return { ctx, page };
}

const PILL = "header .switch", COG = "#cog";
const open = async (page, via = COG) => { await page.click(via); };
const dotOn = (page, on) => page.waitForFunction(o => (getComputedStyle(document.querySelector(".cog-dot")).opacity === "1") === o, on, { timeout: 5000 }).then(() => true, () => false);
const settle = async (page, sel) => {
  await page.waitForSelector(sel, { timeout: 5000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getComputedTiming().endTime === Infinity || a.playState !== "running"), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(450);
};
const shot = async (page, name) => { const f = path.join(OUT, `${name === "header-dot" ? name : "settings-" + name}.png`); await page.screenshot({ path: f, caret: "hide", ...(name === "header-dot" ? { clip: { x: 0, y: 0, width: 1440, height: 90 } } : {}) }); shots.push(f); };
const activeIs = (page, sel) => page.evaluate(s => document.activeElement?.matches(s), sel);

const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5175, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
try {
  // ---- signed out, link, bad paste, signed in, sign out ---------------------------------------------------------
  const m = makeMock();
  const { ctx, page } = await newPage(browser, url, m);
  check("cog: a small icon button labelled Settings, right of the Switch pill", await page.evaluate(() => { const c = document.getElementById("cog").getBoundingClientRect(), p = document.querySelector(".switch").getBoundingClientRect(); return document.getElementById("cog").getAttribute("aria-label") === "Settings" && c.left > p.right && c.width <= 40 && !!document.querySelector("#cog svg"); }));
  check("settings: closed until opened", !(await page.evaluate(() => document.getElementById("settings").classList.contains("on"))));
  await open(page);
  await settle(page, "#settings.on #nnOut:not([hidden]) #signin");
  await shot(page, "signed-out");
  check("signed out: Nintendo says Signed out, the button says Sign in with Nintendo, Check SplatNet waits", /Signed out/.test(await page.innerText("#nnStat")) && (await page.innerText("#signin")) === "Sign in" && (await page.evaluate(() => document.querySelector("#checkRow").classList.contains("dis"))));
  check("signed out: muted via nxapi holds the disclosure in its tooltip", (await page.innerText(".si-via")) === "via nxapi" && (await page.getAttribute(".si-via", "data-tip")) === "Uses nxapi-znca-api to authenticate with Nintendo. Tokens stay in Windows Credential Manager.");
  check("signed out: the strip is shown by default (open, not inert)", (await page.evaluate(() => document.querySelector("#strip").getBoundingClientRect().height)) > 20 && (await page.getAttribute("#strip", "inert")) === null, String(await page.evaluate(() => document.querySelector("#strip").getBoundingClientRect().height)));
  check("GET /api/login sent once", sent(m, "GET", "/api/login").length === 1);
  check("cog: dot is on while signed out", await dotOn(page, true));

  m.linkDelay = 400;
  const popup = page.waitForEvent("popup");
  await page.click("#signin");
  check("in flight: the sign-in button and field are disabled", await page.evaluate(() => document.querySelector("#signin").disabled && document.querySelector("#paste").disabled));
  const pop = await popup;
  check("link: the Nintendo page opened", pop.url().startsWith("https://accounts.nintendo.com/"), pop.url());
  await pop.close(); await page.bringToFront();
  await settle(page, "#strip.open");
  await shot(page, "link-opened");
  const strip = await page.evaluate(() => { const k = [...document.querySelectorAll(".si-strip > *")].map(e => e.getBoundingClientRect()), f = document.querySelector("#paste").getBoundingClientRect(), s = document.querySelector(".si-strip").getBoundingClientRect();
    return { h: document.querySelector("#strip").getBoundingClientRect().height, text: document.querySelector(".si-strip").innerText.replace(/\s+/g, " ").trim(), ph: document.querySelector("#paste").placeholder, labels: [...document.querySelectorAll(".si-strip [aria-label]")].map(e => e.getAttribute("aria-label")), svgs: document.querySelectorAll(".si-strip svg[aria-hidden=true]").length,
      focus: document.activeElement?.id === "paste", oneRow: Math.max(...k.map(r => r.top + r.height / 2)) - Math.min(...k.map(r => r.top + r.height / 2)) < 8, fieldFills: s.right - f.right < 1.5, closed: 0 }; });
  check("link: the strip eased open, one row: Select this person, right-click glyph, Copy link, arrows, a field filling the rest", strip.h > 20 && strip.text === "Select this person Copy link" && strip.ph === "Paste link" && strip.svgs === 3 && strip.oneRow && strip.fieldFills, JSON.stringify(strip));
  check("link: each strip part has an aria-label (the steps for a screen reader)", strip.labels.length === 3 && strip.labels.every(l => /Step|Steps/.test(l)), JSON.stringify(strip.labels));
  check("link: focus is in the paste field", strip.focus);
  const lk = sent(m, "POST", "/api/login/link");
  check("link: POST /api/login/link, application/json", lk.length === 1 && /^application\/json/.test(lk[0].ct), JSON.stringify(lk));
  check("link: the buttons are enabled again", await page.evaluate(() => !document.querySelector("#signin").disabled && !document.querySelector("#paste").disabled));

  await page.fill("#paste", "https://example.com/nope");
  await page.press("#paste", "Enter");
  await settle(page, "#nnMsg.err.on");
  await shot(page, "bad-paste");
  const bad = sent(m, "POST", "/api/login");
  check("bad paste: POST /api/login {link}, application/json", bad.length === 1 && bad[0].body.link === "https://example.com/nope" && /^application\/json/.test(bad[0].ct), JSON.stringify(bad));
  check("bad paste: one error line, field kept", (await page.inputValue("#paste")) === "https://example.com/nope" && /no session token/.test(await page.innerText("#nnMsg")));
  check("bad paste: field focused again", await activeIs(page, "#paste"));

  await page.fill("#paste", GOOD);
  await page.evaluate(() => document.querySelector("#paste").dispatchEvent(new Event("paste", { bubbles: true })));
  await page.waitForFunction(() => document.querySelector("#nnStat").dataset.s === "ok", null, { timeout: 3000 });
  await settle(page, "#nnIn:not([hidden]) #signout");
  await shot(page, "signed-in");
  check("paste: POST /api/login with the pasted link", sent(m, "POST", "/api/login").length === 2 && sent(m, "POST", "/api/login")[1].body.link === GOOD);
  check("cog: dot fades out once signed in", await dotOn(page, false));
  check("signed in: green dot, Signed in, Sign out; Check SplatNet is usable", /Signed in/.test(await page.innerText("#nnStat")) && (await page.innerText("#signout")) === "Sign out" && (await page.evaluate(() => getComputedStyle(document.querySelector("#nnStat i")).backgroundColor)) === "rgb(25, 215, 25)" && !(await page.evaluate(() => document.querySelector("#checkRow").classList.contains("dis"))));

  await page.click("#signout");
  await page.waitForFunction(() => document.querySelector("#nnStat").dataset.s === "off", null, { timeout: 3000 });
  await settle(page, "#nnOut:not([hidden]) #signin");
  check("sign out: POST /api/logout, application/json, back to signed out", sent(m, "POST", "/api/logout").length === 1 && /^application\/json/.test(sent(m, "POST", "/api/logout")[0].ct));
  check("cog: dot is back after signing out", await dotOn(page, true));

  // ---- the s3s gear file (Builds) -------------------------------------------------------------------------------
  await page.click(".st-cat[data-cat=data]");
  await page.waitForTimeout(400);
  const gear = { version: 1, gear: [{ id: 2000, name: "Zones" }] };
  await page.setInputFiles("#fileG", { name: "gear_1.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(gear)) });
  await settle(page, "#buildsMsg.on");
  await shot(page, "import-done");
  const im = sent(m, "POST", "/api/import");
  check("import: POST /api/import with the parsed file, application/json", im.length === 1 && JSON.stringify(im[0].body) === JSON.stringify(gear) && /^application\/json/.test(im[0].ct));
  check("import: 3 pieces imported", (await page.innerText("#buildsMsg")) === "3 pieces imported");

  m.importReply = { status: 400, body: { error: "That isn't an s3s gear file." } };
  await page.setInputFiles("#fileG", { name: "gear_2.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await settle(page, "#buildsMsg.err.on");
  await shot(page, "import-error");
  check("import error: shows the companion's error", /isn.t an s3s gear file/.test(await page.innerText("#buildsMsg")));
  await page.setInputFiles("#fileG", { name: "x.json", mimeType: "application/json", buffer: Buffer.from("not json") });
  await settle(page, "#buildsMsg.err.on");
  check("import: invalid JSON is reported and nothing is sent", /Not a JSON/.test(await page.innerText("#buildsMsg")) && sent(m, "POST", "/api/import").length === 2);

  // ---- leaving and coming back; the Switch pill opens Settings too ----------------------------------------------
  await page.click(".tab[data-s=weapons]");
  await page.waitForFunction(() => !document.getElementById("settings").classList.contains("on"), null, { timeout: 3000 });
  check("a tab leaves Settings", true);
  await open(page, PILL);
  check("Settings reopens on the category you left", await page.evaluate(() => document.querySelector(".st-cat.on").dataset.cat === "data"));
  await page.click(".st-cat[data-cat=connections]");
  await settle(page, "#settings.on #signin");
  check("the Switch pill opens Settings", await page.evaluate(() => document.getElementById("settings").classList.contains("on") && document.getElementById("cog").classList.contains("on")));
  await page.goto(url + "#s=settings");
  await page.waitForFunction(() => document.getElementById("settings").classList.contains("on"), null, { timeout: 3000 });
  check("deep link #s=settings opens Settings", true);
  await page.waitForFunction(() => window.seedtracker);

  // ---- 409 from a POST turns Nintendo to the off state ---------------------------------------------------------
  m.linkStatus = 409;
  await page.reload(); await page.waitForFunction(() => window.seedtracker);
  await open(page);
  await settle(page, "#settings.on #signin");
  await page.click("#signin");
  await page.waitForFunction(() => document.querySelector("#signin").closest(".st-slab").classList.contains("dis"), null, { timeout: 3000 });
  check("409 on a POST: the Account row greys out", true);
  await ctx.close();

  // ---- SplatNet off ---------------------------------------------------------------------------------------------
  const m2 = makeMock(); m2.login = { enabled: false };
  const o = await newPage(browser, url, m2);
  await open(o.page);
  await settle(o.page, "#settings.on #nnStat");
  await shot(o.page, "splatnet-off");
  check("off: Account and SplatNet rows grey out (no text)", (await o.page.innerText("#nnWhy")) === "" && (await o.page.evaluate(() => document.querySelector("#signin").closest(".st-slab").classList.contains("dis"))) && (await o.page.evaluate(() => document.querySelector("#checkRow").classList.contains("dis"))));
  check("off: no dot on the cog", await dotOn(o.page, false));
  await o.ctx.close();

  // ---- live data on (no mock flag): s3s needs a sign-in -> the pill's tooltip and the cog's badge --------------------------
  // The event stream is stubbed so it stays open (a stream that ends makes the app mark the companion unreachable and back off,
  // which flips the badge on and off); the test then waits on the real condition, the badge and tooltip together.
  const m4 = makeMock();
  const lv = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const lp = await lv.newPage();
  const st = { snapshots: {}, status: { s3s: { state: "login-needed", message: "s3s needs a login" } } };
  await lp.addInitScript(state => {
    window.EventSource = class { constructor() { this.h = {}; setTimeout(() => (this.h.state || []).forEach(f => f({ data: JSON.stringify(state) })), 50); } addEventListener(t, f) { (this.h[t] ??= []).push(f); } close() {} };
  }, st);
  await lp.route(/\/api\/state/, r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(st) }));
  await lp.route(/\/api\/(login|logout|import)/, m4.handle);
  await lp.goto(url);
  const both = await lp.waitForFunction(() => document.getElementById("cog")?.classList.contains("needs") && /needs a sign-in/.test(document.querySelector(".switch")?.dataset.tip || ""), null, { timeout: 15000 }).then(() => true, () => false);
  check("login-needed: the pill's tooltip says SplatNet needs a sign-in and the cog shows its dot", both);
  check("login-needed: the dot is visible on the home screen (Weapons)", await dotOn(lp, true) && (await lp.evaluate(() => document.getElementById("weapons").classList.contains("on"))));
  await lp.waitForTimeout(450);
  await shot(lp, "header-dot");
  check("login-needed: Settings does not open by itself", !(await lp.evaluate(() => document.getElementById("settings").classList.contains("on"))));
  await lv.close();

  // ---- reduced motion: the badge changes without a fade ---------------------------------------------------------
  const m3 = makeMock();
  const r = await newPage(browser, url, m3, { reducedMotion: "reduce" });
  await open(r.page);
  await settle(r.page, "#settings.on #signin");
  check("reduced motion: Settings opens and the badge has no fade", await r.page.evaluate(() => getComputedStyle(document.querySelector(".cog-dot")).transitionDuration === "0s"));
  await r.ctx.close();
} finally {
  await browser.close();
  await server.close();
}
console.log("screenshots:\n  " + shots.join("\n  "));
console.log(failed ? `RESULT: FAIL (${failed})` : "RESULT: PASS");
process.exit(failed ? 1 : 0);
