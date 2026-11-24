// Your builds survive sendou's builds arriving and a second tab (2026-11-21: builds got "lost" often). Run from the repo
// root: node tests/web/builds-keep.mjs. Proves: (1) a Gear card drawn before sendou's builds were spliced in ahead of
// yours still opens its own build in the editor, and saving it changes that build and no other; (2) a tab left open
// takes the list another tab saved, so its own later save doesn't write an older list over it.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../.."), web = path.join(repo, "web");
const need = createRequire(path.join(web, "package.json"));
const { chromium } = need("playwright");
const { createServer } = await import(pathToFileURL(need.resolve("vite")).href);
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`); if (!ok) failed++; };

const set = [["Hed_CAP002", "", ["SquidMove_Up", "", ""]], ["Clt_TES001", "", ["", "", ""]], ["Shs_BOT003", "", ["", "", ""]]];
const fullSet = [
  ["Hed_CAP002", "ComeBack", ["SquidMove_Up", "SquidMove_Up", "MainInk_Save"]],
  ["Clt_TES001", "SquidMoveSpatter_Reduction", ["SquidMove_Up", "RespawnTime_Save", "MainInk_Save"]],
  ["Shs_BOT003", "SuperJumpSign_Hide", ["SquidMove_Up", "OpInkEffect_Reduction", "SubEffect_Reduction"]],
];
const MINE = [{ id: 100001, title: "Alpha", modes: ["SZ"], set: fullSet, notes: "", weapon: "Shooter_Normal_00" }, { id: 100002, title: "Bravo", modes: ["SZ"], set: fullSet, notes: "", weapon: "Shooter_Normal_00" }];
const SENDOU = { builds: [1, 2, 3].map(i => ({ id: 100001 + i - 1, title: "Sendou " + i, modes: ["SZ"], set: fullSet, weapon: "Shooter_Normal_00" })), count: 3 };   // ids that clash with yours on purpose

const server = await createServer({ configFile: path.join(web, "vite.config.ts"), root: web, logLevel: "warn", server: { port: 5177, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
// 0. a build's look comes from its contents, not its id: same set = same ink; a gear row or a sub changes it; weapon and title don't
{
  const { buildKey, inkFor } = await server.ssrLoadModule("/src/identity.ts");
  const clone = () => JSON.parse(JSON.stringify(set)), css = b => inkFor(buildKey(b)).css;
  const base = { id: 100001, title: "A", weapon: "Shooter_Normal_00", set: clone() };
  const other = { id: 987654, title: "Zed", weapon: "Blaster_Light_00", set: clone() };
  const row = { ...base, set: clone() }; row.set[1][0] = "Clt_TES002";
  const sub = { ...base, set: clone() }; sub.set[2][2][1] = "SquidMove_Up";
  const blank = { ...base, set: clone() }; blank.set[1][0] = "";
  check("same contents, different id/weapon/title: same ink", css(base) === css(other) && buildKey(base) === buildKey(other));
  check("one gear row changed: different ink", css(base) !== css(row));
  check("one sub changed: different ink", css(base) !== css(sub));
  check("a blank gear row differs from a chosen one, and a missing set reads as blank slots", css(base) !== css(blank) && buildKey({ id: 1 }) === buildKey({ id: 2, set: [["", "", ["", "", ""]], [undefined, undefined, []], [] ] }));
}
const errs = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(b => { try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify(b)); } catch {} }, MINE);
  await ctx.route(/^https?:\/\//, r => /^http:\/\/(localhost|127\.0\.0\.1)/.test(r.request().url()) ? r.fallback() : r.abort());
  const backup = { builds: null, posts: 0 };              // the companion's copy (GET/POST /api/builds)
  const api = r => { const p = new URL(r.request().url()).pathname;
    if (p === "/api/builds" && r.request().method() === "POST") { backup.builds = JSON.parse(r.request().postData()).builds; backup.posts++; return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
    if (p === "/api/builds") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ builds: backup.builds }) });
    if (p.startsWith("/api/sendou/")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SENDOU) });
    if (p === "/api/state") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ snapshots: {}, status: {} }) });
    return r.fulfill({ status: 404, contentType: "application/json", body: "{}" }); };
  const open = async () => { const p = await ctx.newPage(); p.on("pageerror", e => errs.push(String(e))); await p.route("**/api/**", api); await p.goto(url); await p.waitForSelector("#path .pl", { state: "attached", timeout: 30000 }); return p; };
  const saved = p => p.evaluate(async () => { const { store } = await import("/src/store.ts"); await store.flush(); return (store.get("seedtracker.mybuilds.v2") || []).map(b => b.id + ":" + b.title); });

  // 1. the Gear tab drawn, then sendou's builds arrive (spliced in ahead of yours), then Edit on Bravo's card and save
  const a = await open();
  await a.click('.tab[data-s="gear"]');
  await a.waitForSelector("#gear .bcard2 [data-edit]");
  await a.evaluate(async () => { const s = await import("/src/sendou.ts"); await new Promise(res => s.wantSendou("Shooter_Normal_00", res)); });
  const n = await a.evaluate(async () => (await import("/src/data.ts")).BUILDS.filter(b => b.sendou).length);
  const card = a.locator("#gear .bcard2", { has: a.locator("h3", { hasText: /^Bravo$/ }) });
  await card.locator("[data-edit]").click();
  await a.waitForSelector("#editor .tin");
  const opened = await a.inputValue("#editor .tin");
  await a.fill("#editor .tin", "Bravo 2");
  await a.click("#editor #save");
  await a.waitForTimeout(900);
  const after1 = await saved(a);
  check("sendou's builds arrived after the Gear tab was drawn (ahead of yours, ids clashing)", n === 3, String(n));
  check("Edit on Bravo's card opens Bravo", opened === "Bravo", JSON.stringify(opened));
  check("saving it changes Bravo only: Alpha is untouched, nothing added or lost", JSON.stringify(after1) === JSON.stringify(["100001:Alpha", "100002:Bravo 2"]), JSON.stringify(after1));

  // 2. a second tab, left open; the first renames Alpha; then the second tab saves its list (a remove of nothing: storeMine)
  const b = await open();
  await a.evaluate(async () => { const d = await import("/src/data.ts"); d.BUILDS.find(x => x.mine && x.id === 100001).title = "Alpha 2"; d.storeMine(); });
  await b.waitForTimeout(400);
  await b.evaluate(async () => (await import("/src/data.ts")).storeMine());
  const after2 = await saved(b), inB = await b.evaluate(async () => (await import("/src/data.ts")).BUILDS.filter(x => x.mine).map(x => x.title));
  check("a tab left open takes the other tab's save, and its own save keeps it", JSON.stringify(after2) === JSON.stringify(["100001:Alpha 2", "100002:Bravo 2"]) && JSON.stringify(inB) === JSON.stringify(["Alpha 2", "Bravo 2"]), JSON.stringify({ after2, inB }));

  // 3. a reload shows the same builds
  await a.reload(); await a.waitForSelector("#path .pl", { state: "attached" });
  const after3 = await a.evaluate(async () => (await import("/src/data.ts")).BUILDS.filter(x => x.mine).map(x => x.id + ":" + x.title));
  check("after a reload the builds are the saved ones", JSON.stringify(after3) === JSON.stringify(["100001:Alpha 2", "100002:Bravo 2"]), JSON.stringify(after3));
  check("the companion has a copy of every save", backup.posts > 0 && JSON.stringify(backup.builds.map(b => b.id + ":" + b.title)) === JSON.stringify(["100001:Alpha 2", "100002:Bravo 2"]), JSON.stringify(backup.builds?.map(b => b.title)));

  // 4. the browser's storage wiped (a fresh profile): the builds come back from the companion, before anything is drawn
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx2.route(/^https?:\/\//, r => /^http:\/\/(localhost|127\.0\.0\.1)/.test(r.request().url()) ? r.fallback() : r.abort());
  const c = await ctx2.newPage(); c.on("pageerror", e => errs.push(String(e))); await c.route("**/api/**", api);
  await c.goto(url); await c.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  const back = await c.evaluate(async () => (await import("/src/data.ts")).BUILDS.filter(x => x.mine).map(x => x.id + ":" + x.title));
  check("a wiped browser gets its builds back from the companion", JSON.stringify(back) === JSON.stringify(["100001:Alpha 2", "100002:Bravo 2"]), JSON.stringify(back));
  // 5. a browser with a build of its own (same id as one of the companion's): both kept, the companion's gets a new id
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx3.addInitScript(b => { try { if (!localStorage.getItem("seedtracker.mybuilds.v2")) localStorage.setItem("seedtracker.mybuilds.v2", JSON.stringify(b)); } catch {} }, [{ ...MINE[0], title: "Charlie" }]);
  await ctx3.route(/^https?:\/\//, r => /^http:\/\/(localhost|127\.0\.0\.1)/.test(r.request().url()) ? r.fallback() : r.abort());
  const e3 = await ctx3.newPage(); e3.on("pageerror", e => errs.push(String(e))); await e3.route("**/api/**", api);
  await e3.goto(url); await e3.waitForSelector("#path .pl", { state: "attached", timeout: 30000 });
  const merged = await e3.evaluate(async () => (await import("/src/data.ts")).BUILDS.filter(x => x.mine).map(x => x.id + ":" + x.title));
  check("a browser's own builds stay and the companion's missing ones are added (clashing id renumbered)", JSON.stringify(merged) === JSON.stringify(["100001:Charlie", "100003:Alpha 2", "100002:Bravo 2"]), JSON.stringify(merged));
  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) { check("harness ran", false, String(e?.stack ?? e)); }
finally { await browser.close(); await server.close(); }
console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
