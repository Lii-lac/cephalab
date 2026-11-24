// Build editor guarantees (web/src/editor.ts, web/src/editor-leave.ts).
// Run from the repo root: node tests/web/editor.mjs
// Proves: (1) Save is disabled until name + every slot is filled, and a saved build survives a reload;
// (2) a short press on Delete deletes nothing; (3) a full hold (~700 ms) deletes exactly that build (others untouched,
// reload confirms) and lands on the Gear tab with no "Deleted" label; (4) Delete on a new unsaved build removes nothing;
// (5) holding Enter on Delete works the same.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../.."), web = path.join(repo, "web");
const need = createRequire(path.join(web, "package.json"));
const { chromium } = need("playwright");
const { createServer } = await import(pathToFileURL(need.resolve("vite")).href);

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };

const SET_A = [
  ["Hed_CAP002", "ComeBack", ["SquidMove_Up", "SquidMove_Up", "MainInk_Save"]],
  ["Clt_TES001", "SquidMoveSpatter_Reduction", ["SquidMove_Up", "RespawnTime_Save", "MainInk_Save"]],
  ["Shs_BOT003", "SuperJumpSign_Hide", ["SquidMove_Up", "OpInkEffect_Reduction", "SubEffect_Reduction"]],
];
const SET_B = [
  ["Hed_FST000", "EndAllUp", ["SpecialIncrease_Up", "SpecialIncrease_Up", "OpInkEffect_Reduction"]],
  ["Clt_TLY004", "SquidMove_Up", ["SquidMove_Up", "SquidMove_Up", "JumpTime_Save"]],
  ["Shs_SHI006", "SuperJumpSign_Hide", ["SubInk_Save", "SubInk_Save", "SubEffect_Reduction"]],
];
const SEED = [
  { id: 100001, title: "Alpha", modes: ["SZ"], set: SET_A, notes: "First", weapon: "Shooter_Normal_00" },
  { id: 100002, title: "Bravo", modes: ["TC", "RM"], set: SET_B, notes: "Second", weapon: "Saber_Heavy_00" },
];

const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5179, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const errs = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(b => {
    try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify(b)); } catch {}
  }, SEED);
  await ctx.route(/^https?:\/\//, r => /^http:\/\/(localhost|127\.0\.0\.1)/.test(r.request().url()) ? r.fallback() : r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(String(e)));

  let backed = null;
  await page.route("**/api/**", r => {
    const p = new URL(r.request().url()).pathname;
    if (p === "/api/builds" && r.request().method() === "POST") { backed = JSON.parse(r.request().postData()).builds; return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
    if (p === "/api/builds") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ builds: backed }) });
    if (p === "/api/state") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ snapshots: {}, status: {} }) });
    if (p === "/api/events") return r.fulfill({ status: 200, contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify({ snapshots: {}, status: {} })}\n\n` });
    return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  const savedBuilds = () => page.evaluate(async () => {
    const { store } = await import("/src/store.ts");
    await store.flush();
    return (store.get("seedtracker.mybuilds.v2") || []).map(b => ({ id: b.id, title: b.title, weapon: b.weapon, modes: b.modes }));
  });

  await page.goto(url);
  await page.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  await page.click('.tab[data-s="gear"]');
  await page.waitForSelector("#gear.on .newb", { timeout: 10000 });

  // 1. New build: Save is disabled until title + all 12 ability slots are filled; saving survives a reload
  await page.click("#gear .newb");
  await page.waitForSelector("#editor.on #save", { timeout: 10000 });
  await page.waitForTimeout(400);

  const statsInit = await page.evaluate(() => ({
    hasPanel: !!document.querySelector("#editor .stats"),
    secs: document.querySelectorAll("#editor #srows .sec").length,
    tot: (document.querySelector("#editor #tot")?.textContent || "").trim(),
    ink: (document.querySelector('#editor [data-rid="main-ink"] .bv b')?.textContent || "").trim(),
    spp: (document.querySelector('#editor [data-rid="sp-pts"] .bv b')?.textContent || "").trim(),
    acts: (document.querySelector('#editor [data-rid="main-acts"] .pl .pv')?.textContent || "").trim(),
  }));
  check("Stats panel renders all 7 sections and 0 AP on a blank build", statsInit.hasPanel && statsInit.secs === 7 && statsInit.tot === "0 AP", JSON.stringify(statsInit));

  const disNoName = await page.evaluate(() => ({ dis: document.querySelector("#editor #save").disabled, tip: document.querySelector("#editor #save").dataset.tip || "" }));
  await page.fill("#editor #title", "Charlie");
  const disGap = await page.evaluate(() => ({ dis: document.querySelector("#editor #save").disabled, tip: document.querySelector("#editor #save").dataset.tip || "" }));

  // Pick a weapon from another family via the popover so weapon-specific stats change, toggle SZ mode, and fill all 3 mains + 9 subs
  await page.click("#editor #wpick");
  await page.waitForSelector("#editor #wpop.open .wcell:not(.on)", { timeout: 5000 });
  const otherFamCell = await page.evaluate(() => {
    const on = document.querySelector("#editor #wpop .wcell.on");
    const onFam = on?.closest(".wfam");
    const alt = [...document.querySelectorAll("#editor #wpop .wcell")].find(c => c.closest(".wfam") !== onFam);
    return (alt || document.querySelector("#editor #wpop .wcell:not(.on)"))?.getAttribute("data-w") || "";
  });
  const pickedW = otherFamCell;
  await page.click(`#editor #wpop .wcell[data-w="${pickedW}"]`);
  await page.waitForTimeout(350);
  const statsAfterW = await page.evaluate(() => ({
    ink: (document.querySelector('#editor [data-rid="main-ink"] .bv b')?.textContent || "").trim(),
    spp: (document.querySelector('#editor [data-rid="sp-pts"] .bv b')?.textContent || "").trim(),
    acts: (document.querySelector('#editor [data-rid="main-acts"] .pl .pv')?.textContent || "").trim(),
  }));
  check(
    "changing weapons updates weapon-specific stats",
    statsAfterW.ink !== statsInit.ink || statsAfterW.spp !== statsInit.spp || statsAfterW.acts !== statsInit.acts,
    JSON.stringify({ statsInit, statsAfterW, pickedW }),
  );

  await page.click('#editor #mods .chip[data-m="SZ"]');
  for (let p = 0; p < 3; p++) {
    await page.click(`#editor .slot[data-p="${p}"][data-s="-1"]`);
    await page.click('#editor #psubs .popt[data-a="SquidMove_Up"]');
    for (let k = 0; k < 3; k++) {
      await page.click('#editor #psubs .popt[data-a="MainInk_Save"]');
    }
  }
  await page.waitForTimeout(400);
  const totFilled = await page.evaluate(() => (document.querySelector("#editor #tot")?.textContent || "").trim());
  check("#tot updates to 57 AP when all stackable slots are filled", totFilled === "57 AP", JSON.stringify({ totFilled }));

  // Toggle collapse/expand on a stats section header (.sh)
  const mainSecSel = '#editor #srows .sec[data-sec="main"]';
  const beforeToggle = await page.evaluate(s => ({
    shut: document.querySelector(s).classList.contains("shut"),
    exp: document.querySelector(s + " .sh").getAttribute("aria-expanded"),
  }), mainSecSel);
  await page.click(mainSecSel + " .sh");
  const afterCollapse = await page.evaluate(s => ({
    shut: document.querySelector(s).classList.contains("shut"),
    exp: document.querySelector(s + " .sh").getAttribute("aria-expanded"),
  }), mainSecSel);
  await page.click(mainSecSel + " .sh");
  const afterExpand = await page.evaluate(s => ({
    shut: document.querySelector(s).classList.contains("shut"),
    exp: document.querySelector(s + " .sh").getAttribute("aria-expanded"),
  }), mainSecSel);
  check(
    "clicking .sh collapses and expands a stats section",
    !beforeToggle.shut && beforeToggle.exp === "true" && afterCollapse.shut && afterCollapse.exp === "false" && !afterExpand.shut && afterExpand.exp === "true",
    JSON.stringify({ beforeToggle, afterCollapse, afterExpand }),
  );

  const readySave = await page.evaluate(() => ({ dis: document.querySelector("#editor #save").disabled, tip: document.querySelector("#editor #save").dataset.tip || "" }));
  check("Save is disabled until title and every slot are filled", disNoName.dis && disNoName.tip === "Needs a name" && disGap.dis && disGap.tip === "Fill every slot" && !readySave.dis && !readySave.tip, JSON.stringify({ disNoName, disGap, readySave }));

  await page.click("#editor #save");
  await page.waitForSelector("#gear.on", { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  const afterSave = await savedBuilds();
  const charlie = afterSave.find(b => b.title === "Charlie");
  check("saved build survives a reload with its weapon and modes", afterSave.length === 3 && !!charlie && charlie.weapon === pickedW && JSON.stringify(charlie.modes) === JSON.stringify(["SZ"]), JSON.stringify({ pickedW, afterSave }));

  // 2. Short press on Delete deletes nothing
  await page.click('.tab[data-s="gear"]');
  await page.waitForSelector("#gear.on .bcard2", { timeout: 10000 });
  const bravoCard = page.locator("#gear .bcard2", { has: page.locator("h3", { hasText: /^Bravo$/ }) });
  await bravoCard.locator("[data-edit]").click();
  await page.waitForSelector("#editor.on #discard", { timeout: 10000 });
  await page.waitForTimeout(400);

  const delBox = await page.locator("#editor #discard").boundingBox();
  await page.mouse.move(delBox.x + delBox.width / 2, delBox.y + delBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterShort = await savedBuilds();
  const stillEditing = await page.evaluate(() => document.getElementById("editor").classList.contains("on") && !document.querySelector("#editor #discard").classList.contains("holding"));
  check("short press on Delete deletes nothing and stays in editor", stillEditing && afterShort.map(b => b.title).join(",") === "Alpha,Bravo,Charlie", JSON.stringify({ stillEditing, titles: afterShort.map(b => b.title) }));

  // 3. Full hold on Delete (~700 ms) deletes exact build, leaves others untouched, lands on Gear tab, survives reload
  await page.mouse.move(delBox.x + delBox.width / 2, delBox.y + delBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(850);
  await page.mouse.up();
  await page.waitForSelector("#gear.on", { timeout: 10000 });
  await page.waitForTimeout(300);
  const navAfterDel = await page.evaluate(() => ({
    gearOn: document.getElementById("gear").classList.contains("on"),
    tabOn: document.querySelector('.tab[data-s="gear"]').classList.contains("on"),
    hasDeletedText: (document.querySelector("#editor #discard")?.textContent || "").includes("Deleted"),
  }));
  const afterDel = await savedBuilds();
  await page.reload();
  await page.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  const afterDelReload = await savedBuilds();
  check("full hold on Delete removes only that build, lands on Gear tab with no Deleted label, and survives reload",
    navAfterDel.gearOn && navAfterDel.tabOn && !navAfterDel.hasDeletedText
    && afterDel.map(b => b.title).join(",") === "Alpha,Charlie"
    && afterDelReload.map(b => b.title).join(",") === "Alpha,Charlie",
    JSON.stringify({ navAfterDel, afterDel: afterDel.map(b => b.title), afterDelReload: afterDelReload.map(b => b.title) }));

  // 4. Delete on a new unsaved build removes nothing and lands on Gear tab
  await page.click('.tab[data-s="gear"]');
  await page.waitForSelector("#gear.on .newb", { timeout: 10000 });
  await page.click("#gear .newb");
  await page.waitForSelector("#editor.on #discard", { timeout: 10000 });
  await page.waitForTimeout(400);
  const delBox2 = await page.locator("#editor #discard").boundingBox();
  await page.mouse.move(delBox2.x + delBox2.width / 2, delBox2.y + delBox2.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(850);
  await page.mouse.up();
  await page.waitForSelector("#gear.on", { timeout: 10000 });
  await page.waitForTimeout(300);
  const afterUnsavedDel = await savedBuilds();
  check("Delete on a new unsaved build removes nothing and lands on Gear tab", afterUnsavedDel.map(b => b.title).join(",") === "Alpha,Charlie", JSON.stringify(afterUnsavedDel.map(b => b.title)));

  // 5. Keyboard hold (Enter) on Delete deletes Charlie and leaves Alpha intact
  const charlieCard = page.locator("#gear .bcard2", { has: page.locator("h3", { hasText: /^Charlie$/ }) });
  await charlieCard.locator("[data-edit]").click();
  await page.waitForSelector("#editor.on #discard", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.focus("#editor #discard");
  await page.keyboard.down("Enter");
  await page.waitForTimeout(850);
  await page.keyboard.up("Enter");
  await page.waitForSelector("#gear.on", { timeout: 10000 });
  await page.waitForTimeout(300);
  const afterKeyDel = await savedBuilds();
  check("keyboard Enter hold on Delete deletes the build and lands on Gear tab", afterKeyDel.map(b => b.title).join(",") === "Alpha", JSON.stringify(afterKeyDel.map(b => b.title)));

  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
  check("harness ran", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
