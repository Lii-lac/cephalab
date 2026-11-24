// sendou build links (web/src/sendou-link.ts): parse the analyzer link (the share card's QR holds the same), build one back,
// and pasting one on the weapons screen opens that weapon's build in the editor; the editor's "Sendou" button opens it, and "Copy outfit" fills it from what the avatar wears.
// Run from the repo root: node tests/web/sendou-link.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../.."), web = path.join(repo, "web");
const need = createRequire(path.join(web, "package.json"));
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };

// Alex's two links (2026-11-21): the analyzer link, and the QR code on a sendou share card
const DECAV = "https://sendou.ink/analyzer?weapon=8020&build=CB%2CSSU%2CSSU%2CRES%2CQR%2CQR%2CQR%2CQR%2CSJ%2CQSJ%2CQSJ%2CSRU";
const ZAP = "https://sendou.ink/analyzer?weapon=60&build=CB%2CSPU%2CSPU%2CSPU%2CSCU%2CRSU%2CRSU%2CIRU%2CSJ%2CIA%2CIA%2CSRU";
const { createServer } = await import(pathToFileURL(need.resolve("vite")).href);
const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5178, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const { chromium } = need("playwright");
const browser = await chromium.launch();
const errs = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(/^https?:\/\//, r => /^http:\/\/(localhost|127\.0\.0\.1)/.test(r.request().url()) ? r.fallback() : r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(String(e)));
  await page.route("**/api/**", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ snapshots: {}, status: {}, builds: [] }) }));
  await page.goto(url);
  await page.waitForSelector("#weapons.on", { timeout: 30000 });
  const unit = await page.evaluate(async ([a, b]) => {
    const L = await import("/src/sendou-link.ts");
    const pa = L.parseLink(a), pb = L.parseLink(b);
    return { pa, pb, back: L.linkFor(pa.row, pa.set), backB: L.linkFor(pb.row, pb.set),
      bad: [L.parseLink("https://example.com/analyzer?build=CB"), L.parseLink("https://sendou.ink/analyzer?weapon=60&build=CB%2CSPU"), L.parseLink("not a link")],
      empty: L.linkFor("", [["", "", ["", "", ""]], ["", "", ["", "", ""]], ["", "", ["", "", ""]]]) };
  }, [DECAV, ZAP]);
  check("the analyzer link: Mint Decavitator, Comeback / Swim Speed x2 / Ink Resistance, Quick Respawn x4, Stealth Jump / Quick Super Jump x2 / Sub Resistance",
    JSON.stringify(unit.pa.set) === JSON.stringify([["", "ComeBack", ["SquidMove_Up", "SquidMove_Up", "OpInkEffect_Reduction"]], ["", "RespawnTime_Save", ["RespawnTime_Save", "RespawnTime_Save", "RespawnTime_Save"]], ["", "SuperJumpSign_Hide", ["JumpTime_Save", "JumpTime_Save", "SubEffect_Reduction"]]]), JSON.stringify(unit.pa));
  check("the share card's QR link parses too (N-ZAP '85)", !!unit.pb && unit.pb.set[2][1] === "SuperJumpSign_Hide" && unit.pb.set[1][2][0] === "HumanMove_Up", JSON.stringify(unit.pb));
  check("a build turns back into the same link", unit.back === DECAV && unit.backB === ZAP, JSON.stringify([unit.back, unit.backB]));
  check("other sites, short builds and plain text aren't links", unit.bad.every(x => x === null));
  check("empty slots go out as U, no weapon id when there's no weapon", unit.empty === "https://sendou.ink/analyzer?build=" + encodeURIComponent(Array(12).fill("U").join(",")), unit.empty);
  const wname = await page.evaluate(async row => (await import("/src/data.ts")).WEAPONS.find(w => w.row === row)?.name, unit.pa.row);
  check("weapon 8020 is the Mint Decavitator", wname === "Mint Decavitator", String(wname));

  // paste it on the weapons screen
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  await page.evaluate(t => navigator.clipboard.writeText(t), DECAV);
  await page.mouse.click(5, 880);                                     // focus the page, nothing in particular
  await page.keyboard.press("Control+V");                              // a real paste, as Alex would
  await page.waitForSelector("#editor.on", { timeout: 5000 }).catch(() => {});
  if (errs.length) console.log("(info) errors after paste: " + errs.join(" | "));
  await page.waitForTimeout(800);
  const ed = await page.evaluate(async () => { const { ui } = await import("/src/state.ts"); return { on: document.getElementById("editor").classList.contains("on"), title: document.querySelector("#editor .tin")?.value, set: ui.ed.set, weapon: ui.ed.weapon, pick: ui.pick, idx: ui.edIdx }; });
  check("pasting the link opens the editor with that build, titled with the weapon, new (unsaved)", ed.on && ed.title === "Mint Decavitator" && JSON.stringify(ed.set) === JSON.stringify(unit.pa.set) && ed.weapon === unit.pa.row && ed.idx === -1, JSON.stringify(ed));
  await page.screenshot({ path: path.join(here, "out", "sendou-paste.png") });
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.click("#editor #sendou");
  const opened = await page.evaluate(() => window.__opened);
  check("Open in sendou opens the analyzer with this build", opened.length === 1 && opened[0] === DECAV, JSON.stringify(opened));
  // Copy outfit: disabled with the reason as its title while there's no Switch; otherwise puts the three worn gear rows from
  // /api/wearing in the build; its mains, subs and weapon stay (Alex, 2026-11-21: only the outfit, not its abilities)
  const WORN = { head: { gearId: 5004, row: "Hed_HDP004", main: "ComeBack", subs: ["JumpTime_Save", "", ""] }, clothes: { gearId: 1035, row: "Clt_TES035", main: "SquidMove_Up", subs: ["SquidMove_Up", "", ""] }, shoes: { gearId: 1012, row: "Shs_SLO012", main: "SuperJumpSign_Hide", subs: ["", "", ""] } };
  const wear = { delay: 400, status: 200, body: WORN };                                // the mocked read: slow (400 ms) and fine, then 500
  await page.route("**/api/wearing", async r => { if (wear.delay) await new Promise(x => setTimeout(x, wear.delay)); await r.fulfill({ status: wear.status, contentType: "application/json", body: JSON.stringify(wear.body) }); });
  const names = await page.evaluate(() => [
    document.querySelector("#editor #sendou")?.textContent?.trim(),
    [...document.querySelector("#editor #copyfit").childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim(),
    document.querySelector("#editor #discard .dl > span")?.textContent?.trim(),
    document.querySelector("#editor #save > span:first-child")?.textContent?.trim(),
  ]);
  check("the editor's buttons: Sendou, Copy outfit, Delete, Save build", JSON.stringify(names) === JSON.stringify(["Sendou", "Copy outfit", "Delete", "Save build"]), JSON.stringify(names));
  const off = await page.evaluate(async () => {
    const { live } = await import("/src/live.ts"), { paintCopy } = await import("/src/wearing.ts");
    live.reachable = true; live.status = { botbase: { state: "off", message: "No Switch address set" } }; paintCopy();
    const b = document.querySelector("#editor #copyfit");
    return { disabled: b.disabled, title: b.dataset.tip || "" };
  });
  check("no Switch: Copy outfit is disabled and says why", off.disabled && off.title.includes("No Switch address set"), JSON.stringify(off));
  const before = await page.evaluate(async () => { const { ui } = await import("/src/state.ts"); return { weapon: ui.ed.weapon, set: JSON.stringify(ui.ed.set) }; });
  await page.evaluate(async () => {
    const { live } = await import("/src/live.ts"), { paintCopy } = await import("/src/wearing.ts");
    live.reachable = true; live.status = { botbase: { state: "ok", message: "" } }; paintCopy();
    window.__anim = 0; const tick = () => { window.__anim = Math.max(window.__anim, [...document.querySelectorAll("#editor .piece .gp")].reduce((n, e) => n + e.getAnimations().length, 0)); requestAnimationFrame(tick); }; tick();
    document.querySelector("#editor #copyfit").click();
  });
  await page.waitForTimeout(150);
  const busyNow = await page.evaluate(() => { const b = document.querySelector("#editor #copyfit"); return { disabled: b.disabled, busy: b.classList.contains("busy"), label: [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim(), dots: document.querySelector("#editor #cfdots")?.textContent || "", op: +getComputedStyle(b).opacity }; });
  check("Copy outfit: while the read is slow the button is disabled and looks busy (dimmed), its label unchanged", busyNow.disabled && busyNow.busy && busyNow.label === "Copy outfit" && busyNow.dots.length >= 1 && busyNow.op < .8, JSON.stringify(busyNow));
  for (let i = 0; i < 50 && !(await page.evaluate(async () => (await import("/src/state.ts")).ui.ed.set[0][0] === "Hed_HDP004")); i++) await page.waitForTimeout(100);   // (an async predicate in waitForFunction is a truthy promise)
  const fit = await page.evaluate(async () => { const { ui } = await import("/src/state.ts"); return { weapon: ui.ed.weapon, set: ui.ed.set, rows: [...document.querySelectorAll("#editor .piece .gp")].length }; });
  const want = JSON.parse(before.set).map(([, main, subs], i) => [["Hed_HDP004", "Clt_TES035", "Shs_SLO012"][i], main, subs]);
  check("Copy outfit puts only the worn gear in the build: its abilities and weapon stay", JSON.stringify(fit.set) === JSON.stringify(want) && fit.weapon === before.weapon && before.set !== JSON.stringify(fit.set), JSON.stringify({ fit, before }));
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ anim: window.__anim, disabled: document.querySelector("#editor #copyfit").disabled, busy: document.querySelector("#editor #copyfit").classList.contains("busy") }));
  check("Copy outfit: on success the gear slots animate (swap / ring) and the button is usable again", after.anim >= 3 && !after.disabled && !after.busy, JSON.stringify(after));
  // a failure: the reason shows beside the button (.why), fades out after ~3 s; the button shakes and keeps the reason as its title
  wear.delay = 0; wear.status = 500; wear.body = { error: "The Switch didn't answer" };
  await page.evaluate(async () => { const { live } = await import("/src/live.ts"), { paintCopy } = await import("/src/wearing.ts"); live.reachable = true; live.status = { botbase: { state: "ok", message: "" } }; paintCopy();
    window.__shake = 0; const b = document.querySelector("#editor #copyfit"); const tick = () => { window.__shake = Math.max(window.__shake, b.getAnimations().length); requestAnimationFrame(tick); }; tick(); b.click(); });
  await page.waitForFunction(() => document.querySelector("#editor .cfw .why")?.textContent, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
  const fail = await page.evaluate(() => { const l = document.querySelector("#editor .cfw .why"), b = document.querySelector("#editor #copyfit"), lr = l.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { text: l.textContent, op: +getComputedStyle(l).opacity, beside: lr.right <= br.left + 1, title: b.dataset.tip || "", shake: window.__shake }; });
  await page.screenshot({ path: path.join(here, "out", "w5-copy-fail.png") });
  check("Copy outfit fails (500): the reason shows beside the button, the button shook and keeps the reason as its title", fail.text === "The Switch didn't answer" && fail.op > .9 && fail.beside && fail.title === fail.text && fail.shake >= 1, JSON.stringify(fail));
  await page.waitForTimeout(3600);
  const gone = await page.evaluate(() => ({ text: document.querySelector("#editor .cfw .why").textContent, ops: +getComputedStyle(document.querySelector("#editor .cfw .why")).opacity }));
  check("Copy outfit: the reason fades out after about 3 s", gone.text === "" && gone.ops < .1, JSON.stringify(gone));
  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) { check("harness ran", false, String(e?.stack ?? e)); }
finally { await browser.close(); await server.close(); }
console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
