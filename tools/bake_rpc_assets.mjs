// Bakes every Discord Rich Presence image as a 512x512 PNG into dist/rpc-assets/.
// Look = mockups/discord-rpc.html (option A), every px value scaled from the mockup's 60 px tile.
// Run: node tools/bake_rpc_assets.mjs   (needs the main copy's web/node_modules and cache/img)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = process.env.MAIN_COPY || "C:/Users/alexd/Desktop/personal/Coding/splat3-seed-tracker";
const { chromium } = await import(pathToFileURL(path.join(MAIN, "web/node_modules/playwright/index.mjs")).href);

const OUT = path.join(ROOT, "dist/rpc-assets");
const CACHE = path.join(ROOT, "dist/rpc-cache");
const LEANNY = "https://leanny.github.io/splat3/images";
const RAW = "https://raw.githubusercontent.com/Leanny/splat3/main/data";
const url = (p) => pathToFileURL(p).href;
const find = (...c) => c.map((p) => path.join(...p)).find((p) => fs.existsSync(p));
const asset = (p) => find([ROOT, p], [MAIN, p]);
const SZ = 512, S = SZ / 60; // mockup tile = 60 px

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

// Leanny's CDN answers bursts with 503 and false 404s: retry 4x, 4 parallel.
async function get(u, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u);
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      last = r.status;
    } catch (e) { last = String(e); }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error(`${u}: ${last}`);
}
async function pool(items, fn, n = 4) {
  const q = [...items], out = [];
  await Promise.all(Array.from({ length: n }, async () => { for (let it; (it = q.shift()); ) out.push(await fn(it)); }));
  return out;
}
async function cached(name, u) {
  const f = path.join(CACHE, name);
  if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, await get(u)); }
  return f;
}
const json = async (name, u) => JSON.parse(fs.readFileSync(await cached(name, u), "utf8"));

// Newest numbered data/mush dir ("latest" is a symlink the raw host can't follow).
const dirs = await (await fetch("https://api.github.com/repos/Leanny/splat3/contents/data/mush")).json();
const ver = dirs.filter((d) => d.type === "dir" && /^\d+$/.test(d.name)).map((d) => +d.name).sort((a, b) => b - a)[0];
if (!ver) throw new Error("no mush version found");
console.log("Leanny data version", ver);
const versus = await json(`mush_${ver}_Versus.json`, `${RAW}/mush/${ver}/VersusSceneInfo.json`);
const coop = await json(`mush_${ver}_Coop.json`, `${RAW}/mush/${ver}/CoopSceneInfo.json`);
const usen = JSON.parse(fs.readFileSync(asset("data/USen.json"), "utf8"));
const vsNames = usen["CommonMsg/VS/VSStageName"], coopNames = usen["CommonMsg/Coop/CoopStageName"];
const wNames = usen["CommonMsg/Weapon/WeaponName_Main"];
const weaponInfo = JSON.parse(fs.readFileSync(asset("data/WeaponInfoMain.json"), "utf8"));

// Playable stages: versus rows shown in the game's stage list (IsDisplayInStageList) that have an English name
// (Vss_Manbou00 is flagged off, so skipped); salmon rows that have an English name (Random/Tutorial/Unknown aren't scenes).
const stages = [];
for (const r of versus) {
  const n = vsNames[r.__RowId.replace(/^Vss_/, "").replace(/\d+$/, "")];
  if (r.IsDisplayInStageList && n) stages.push({ code: r.__RowId, name: n, modes: ["anarchy", "turf", "xbattle", "private", "challenge"] });
}
for (const r of coop) {
  const n = coopNames[r.__RowId.replace(/^Cop_/, "").replace(/\d+$/, "")];
  if (n) stages.push({ code: r.__RowId, name: n, modes: ["salmon"] });
}

// Weapons: Versus main weapons (or any row that already has art in cache/img).
const imgDir = asset("cache/img/weapon_flat");
const weapons = [];
await pool(weaponInfo, async (w) => {
  const id = w.__RowId;
  const have = path.join(imgDir || "", `Path_Wst_${id}.png`);
  let f = fs.existsSync(have) ? have : null;
  if (!f && w.Type === "Versus") {
    try { f = await cached(`weapon_flat/Path_Wst_${id}.png`, `${LEANNY}/weapon_flat/Path_Wst_${id}.png`); } catch { console.log("no art for", id); }
  }
  if (f && wNames[id]) weapons.push({ id, name: wNames[id], file: f });
});
weapons.sort((a, b) => a.id.localeCompare(b.id));

// Stage art: stageL if it exists, else stage. Leanny's file name is the row id without its trailing digits
// (Vss_Hiagari04 -> Vss_Hiagari.png); Big Run stages (Cop_Carousel...) have none and use the versus stage's art.
const stageFile = {};
await pool(stages, async (s) => {
  const base = s.code.replace(/\d+$/, "");
  for (const n of [base, base.replace(/^Cop_/, "Vss_")]) for (const d of ["stageL", "stage"]) {
    try { stageFile[s.code] = await cached(`${d}/${n}.png`, `${LEANNY}/${d}/${n}.png`); return; } catch {}
  }
  console.log("no stage art for", s.code, s.name);
});

// Shared CSS (values from the mockup, scaled by S).
const px = (v) => `${(v * S).toFixed(2)}px`;
const FRAMES = {
  anarchy: [55, "#f55012", "#d43b06"], salmon: [-55, "#7a2f08", "#ff8c1a"], turf: [55, "#9be01e", "#7ec20e"],
  xbattle: [-55, "#0db58a", "#2be3b2"], private: [55, "#9444db", "#7b2ec2"], challenge: [55, "#e047aa", "#c73292"],
};
const SQUIDS = {
  blue: ["url('BGBLUE') center/" + px(260), "normal", "hue-rotate(2deg) brightness(0.85)"],
  cyan: ["url('BGYELLOW') center/" + px(260), "normal", "hue-rotate(130deg) brightness(0.85)"],
  orange: ["#f28233 url('TAPES') center/" + px(240), "soft-light", "brightness(0.94)"],
  purple: ["#8352ca url('TAPES') center/" + px(240), "soft-light", "brightness(0.91)"],
  red: ["#d33c45 url('TAPES') center/" + px(240), "soft-light", "brightness(0.9)"],
  yellow: ["url('BGYELLOW') center/" + px(260), "normal", "hue-rotate(359deg) brightness(0.94)"],
};
const sub = (s) => s.replace("BGBLUE", url(asset("assets/battle-bg-pattern-blue.jpg"))).replace(/BGYELLOW/g, url(asset("assets/battle-bg-pattern-yellow.jpg")))
  .replace(/TAPES/g, url(asset("assets/tapes-transparent.png")));

const css = `
html,body{margin:0;background:transparent}
.t{position:relative;width:${SZ}px;height:${SZ}px;overflow:hidden}
.t img{display:block}
/* lobby squid */
.sq::before{content:"";position:absolute;inset:0;background:var(--bg);background-blend-mode:var(--bl);filter:var(--f)}
.sq img{position:absolute;left:12%;top:12%;width:76%;height:76%;object-fit:contain}
.sqn img{position:absolute;left:6%;top:6%;width:88%;height:88%;object-fit:contain}
/* stage in its mode frame */
.fr{padding:${px(3)};box-sizing:border-box;background-image:repeating-linear-gradient(var(--ang),var(--s1) 0 ${px(5)},var(--s2) ${px(5)} ${px(10)})}
.fr .in{position:relative;width:100%;height:100%;border-radius:${px(5.5)};overflow:hidden;background:#232428}
.fr img{width:100%;height:100%;object-fit:cover}
/* round badges: full square, Discord crops the circle */
.bd{display:grid;place-items:center}
.wp{background:var(--bg)}
.wp img{width:${(21 / 24 * 100).toFixed(3)}%;height:${(21 / 24 * 100).toFixed(3)}%;object-fit:contain;filter:drop-shadow(0 ${(SZ / 48).toFixed(2)}px ${(SZ / 48).toFixed(2)}px rgba(0,0,0,.4))}
.kg{background:#f68031}
.kg img,.kg i{position:absolute;left:12.5%;top:12.5%;width:75%;height:75%;object-fit:contain}
.kg i{background:#511f1f;-webkit-mask:var(--m) center/contain no-repeat;mask:var(--m) center/contain no-repeat}
`;

const jobs = []; // {file, html, transparent}
const add = (file, html) => jobs.push({ file, html });
for (const [c, [bg, bl, f]] of Object.entries(SQUIDS))
  add(`squid/${c}.png`, `<div class="t sqn"><img src="${url(asset(`assets/squids/${c}.svg`))}"></div>`);   // outlined squid alone, no tile (Alex 2026-11-26)
for (const s of stages) for (const m of s.modes) {
  if (!stageFile[s.code]) continue;
  const [ang, s1, s2] = FRAMES[m];
  add(`stage/${m}/${s.code}.png`, `<div class="t fr" style="--ang:${ang}deg;--s1:${s1};--s2:${s2}"><div class="in"><img src="${url(stageFile[s.code])}"></div></div>`);
}
for (const w of weapons) {   // the badge in its mode's color (Alex 2026-11-26), plain white when the mode isn't known
  add(`weapon/${w.id}.png`, `<div class="t bd wp" style="--bg:#fff"><img src="${url(w.file)}"></div>`);
  for (const m of ["anarchy", "turf", "xbattle", "private", "challenge"])
    add(`weapon/${m}/${w.id}.png`, `<div class="t bd wp" style="--bg:${FRAMES[m][1]}"><img src="${url(w.file)}"></div>`);
}
const sal = asset("cache/img/salmometer");
for (let n = 0; n <= 5; n++)
  add(`salmometer/${n}.png`, `<div class="t bd kg"><img src="${url(path.join(sal, `cohozuna_${n}_fill.png`))}"><i style="--m:url('${url(path.join(sal, `cohozuna_${n}_empty.png`))}')"></i></div>`);

// Render: one page at file:// (so file:/// images load), body replaced per job.
const page0 = path.join(CACHE, "render.html");
fs.writeFileSync(page0, `<!doctype html><meta charset=utf-8><style>${css}</style><body></body>`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SZ, height: SZ }, deviceScaleFactor: 1 });
await page.goto(url(page0));
const sizes = {}; let total = 0;
const ONLY = process.env.ONLY;   // e.g. ONLY=squid/ re-bakes just those
for (const j of ONLY ? jobs.filter((j) => j.file.startsWith(ONLY)) : jobs) {
  await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, j.html);
  const buf = await page.locator(".t").screenshot({ omitBackground: true });
  const f = path.join(OUT, j.file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  const k = j.file.split("/")[0];
  sizes[k] = sizes[k] || { n: 0, bytes: 0 };
  sizes[k].n++; sizes[k].bytes += buf.length; total += buf.length;
}

const manifest = { stages: {}, weapons: {}, version: 1 };
for (const s of stages) if (stageFile[s.code]) manifest.stages[s.code] = { name: s.name, modes: s.modes };
for (const w of weapons) manifest.weapons[w.id] = w.name;
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

// Contact sheet (not committed).
const img = (f, t) => `<figure><img src="${f}" width=128 height=128><figcaption>${t}</figcaption></figure>`;
const pick = [
  ...["blue", "cyan", "orange", "purple", "red", "yellow"].map((c) => [`squid/${c}.png`, c]),
  ...["anarchy", "turf", "xbattle", "private", "challenge"].map((m) => [`stage/${m}/Vss_Hiagari04.png`, m]),
  ["stage/salmon/Cop_Shakeup.png", "salmon"],
  ...["Shooter_Normal_00", "Charger_Normal_00", "Roller_Normal_00"].map((w) => [`weapon/${w}.png`, w]),
  ...[0, 3, 5].map((n) => [`salmometer/${n}.png`, "king " + n]),
].filter(([f]) => fs.existsSync(path.join(OUT, f)));
const sheetCss = `body{background:#2b2d31;color:#ccc;font:12px sans-serif;display:flex;flex-wrap:wrap;gap:12px;padding:12px;width:1000px}figure{margin:0}
.c img{border-radius:50%}.r img{border-radius:20px}`;
const roundSet = (f) => /^(weapon|salmometer)/.test(f);
fs.writeFileSync(path.join(OUT, "_sheet.html"), `<!doctype html><meta charset=utf-8><style>${sheetCss}</style><body>${
  pick.map(([f, t]) => `<div class="${roundSet(f) ? "c" : "r"}">${img(f, t)}</div>`).join("")}</body>`);
const sp = await browser.newPage({ viewport: { width: 1024, height: 520 } });
await sp.goto(url(path.join(OUT, "_sheet.html")));
await sp.waitForLoadState("load");
await sp.screenshot({ path: path.join(OUT, "_sheet.png"), fullPage: true });
await browser.close();

for (const [k, v] of Object.entries(sizes)) console.log(`${k}: ${v.n} files, ${(v.bytes / 1e6).toFixed(2)} MB`);
console.log(`total: ${jobs.length} files, ${(total / 1e6).toFixed(2)} MB`);
