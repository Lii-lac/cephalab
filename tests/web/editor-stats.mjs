// Unit tests for web/src/editor-stats.ts (real Splatoon 3 v12 stat math + distilled weapon-stats.json).
// Run from the repo root: node tests/web/editor-stats.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SECS,
  apOfSet,
  apPct,
  apTotal,
  computeStats,
  lerp3,
} from "../../web/src/editor-stats.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const catalog = JSON.parse(fs.readFileSync(path.join(repo, "web/src/data/gear-catalog.json"), "utf8"));
const statsData = JSON.parse(fs.readFileSync(path.join(repo, "web/src/data/weapon-stats.json"), "utf8"));

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

const EMPTY_SET = [
  ["", "", ["", "", ""]],
  ["", "", ["", "", ""]],
  ["", "", ["", "", ""]],
];

// 1. Every weapon in gear-catalog.json produces finite, valid stats across all 7 sections
const MIXED_SET = [
  ["Hed_CAP002", "MainInk_Save", ["SubInk_Save", "SpecialIncrease_Up", "Action_Up"]],
  ["Clt_TES001", "SquidMoveSpatter_Reduction", ["SquidMove_Up", "HumanMove_Up", "InkRecovery_Up"]],
  ["Shs_BOT003", "SuperJumpSign_Hide", ["OpInkEffect_Reduction", "SubEffect_Reduction", "JumpTime_Save"]],
];
let badWeapons = [];
for (const w of catalog.weapons) {
  for (const [label, set] of [["empty", EMPTY_SET], ["mixed", MIXED_SET]]) {
    const secs = computeStats(w, set, statsData);
    if (secs.length !== SECS.length) {
      badWeapons.push(`${w.row}(${label}): ${secs.length} secs`);
      continue;
    }
    for (const sec of secs) {
      if (!sec.rows.length) badWeapons.push(`${w.row}(${label}): empty sec ${sec.id}`);
      for (const r of sec.rows) {
        if (r.kind === "num") {
          const ok =
            Number.isFinite(r.base) &&
            Number.isFinite(r.val) &&
            Number.isFinite(r.max) &&
            r.max > 0 &&
            !/NaN|Infinity|undefined/.test(r.baseFmt + r.valFmt + r.deltaFmt + r.name);
          if (!ok) badWeapons.push(`${w.row}(${label})/${r.id}: ${JSON.stringify(r)}`);
        } else if (r.kind === "text") {
          if (!r.text || /undefined/.test(r.text)) badWeapons.push(`${w.row}(${label})/${r.id}: ${r.text}`);
        } else if (r.kind === "acts") {
          const ok =
            r.kinds.length >= 1 &&
            r.kinds.every(
              k =>
                Number.isFinite(k.noSub0) &&
                k.noSub0 > 0 &&
                Number.isFinite(k.noSub1) &&
                k.noSub1 > 0 &&
                Number.isFinite(k.withSub0) &&
                k.withSub0 >= 0 &&
                Number.isFinite(k.withSub1) &&
                k.withSub1 >= 0 &&
                Number.isFinite(k.per) &&
                k.per >= 1,
            );
          if (!ok) badWeapons.push(`${w.row}(${label})/${r.id}: ${JSON.stringify(r)}`);
        }
      }
    }
  }
}
check(
  `every weapon in gear-catalog.json (${catalog.weapons.length}) produces finite valid stats across all 7 sections`,
  badWeapons.length === 0,
  badWeapons.slice(0, 5).join("; "),
);

// 2. lerp3 spot checks at 0 / 10 / 28.5 / 57 AP (linear and non-linear curves)
const p10 = apPct(10); // (33 - 2.7)/100 = 0.303
const p285 = apPct(28.5); // (94.05 - 21.93075)/100 = 0.7211925
const linOk =
  near(lerp3(1.92, 2.16, 2.4, 0), 1.92) &&
  near(lerp3(1.92, 2.16, 2.4, 10), 1.92 + 0.48 * p10) &&
  near(lerp3(1.92, 2.16, 2.4, 28.5), 1.92 + 0.48 * p285) &&
  near(lerp3(1.92, 2.16, 2.4, 57), 2.4);
// Non-linear curve: Squid Surge charge [45, 18, 5], s = (18 - 45) / (5 - 45) = 0.675
const sSurge = (18 - 45) / (5 - 45);
const expSurge = -Math.log(sSurge) / Math.LN2;
const nlOk =
  near(lerp3(45, 18, 5, 0), 45) &&
  near(lerp3(45, 18, 5, 10), 45 + (5 - 45) * Math.pow(p10, expSurge)) &&
  near(lerp3(45, 18, 5, 28.5), 45 + (5 - 45) * Math.pow(p285, expSurge)) &&
  near(lerp3(45, 18, 5, 57), 5);
check("lerp3 matches exact Splatoon 3 curve at 0 / 10 / 28.5 / 57 AP (linear & non-linear)", linOk && nlOk);

// 3. Ability Doubler doubles clothes subs only
const dblSet = [
  ["Hed_CAP002", "SquidMove_Up", ["MainInk_Save", "MainInk_Save", "MainInk_Save"]],
  ["Clt_HAP001", "ExSkillDouble", ["SquidMove_Up", "SubInk_Save", "SubInk_Save"]],
  ["Shs_BOT003", "SuperJumpSign_Hide", ["JumpTime_Save", "OpInkEffect_Reduction", "SubEffect_Reduction"]],
];
const dblAp = apOfSet(dblSet);
check(
  "Ability Doubler doubles clothes subs (6 AP each) while head/shoes subs stay 3 AP",
  dblAp.SquidMove_Up === 16 &&
    dblAp.SubInk_Save === 12 &&
    dblAp.MainInk_Save === 9 &&
    dblAp.JumpTime_Save === 3 &&
    apTotal(dblSet) === 46,
  JSON.stringify({ dblAp, total: apTotal(dblSet) }),
);

// 4. Ninja Squid reduces swim speed by 10% (base and with Swim Speed Up)
const wShot = catalog.weapons.find(w => w.row === "Shooter_Normal_00");
const wMint = catalog.weapons.find(w => w.row === "Saber_Heavy_00");
const rowOf = (secs, secId, rowId) => secs.find(s => s.id === secId).rows.find(r => r.id === rowId);

const nsOnly = [
  ["", "", ["", "", ""]],
  ["Clt_TES001", "SquidMoveSpatter_Reduction", ["", "", ""]],
  ["", "", ["", "", ""]],
];
const nsSwim = rowOf(computeStats(wShot, nsOnly, statsData), "move", "mv-swim");
const nsRain = rowOf(computeStats(wShot, nsOnly, statsData), "move", "mv-swim-rm");
const nsPlusSsu = [
  ["", "SquidMove_Up", ["SquidMove_Up", "SquidMove_Up", ""]],
  ["Clt_TES001", "SquidMoveSpatter_Reduction", ["", "", ""]],
  ["", "", ["", "", ""]],
];
const ssuNoNs = [
  ["", "SquidMove_Up", ["SquidMove_Up", "SquidMove_Up", ""]],
  ["", "", ["", "", ""]],
  ["", "", ["", "", ""]],
];
const swimWithNs = rowOf(computeStats(wShot, nsPlusSsu, statsData), "move", "mv-swim");
const swimNoNs = rowOf(computeStats(wShot, ssuNoNs, statsData), "move", "mv-swim");
check(
  "Ninja Squid reduces swim speed by exactly 10% (at 0 SSU and with SSU)",
  near(nsSwim.val, nsSwim.base * 0.9) &&
    nsSwim.changed === true &&
    near(nsRain.val, nsRain.base * 0.9) &&
    near(swimWithNs.val, swimNoNs.val * 0.9),
  JSON.stringify({ nsSwim: nsSwim.val, base: nsSwim.base, swimWithNs: swimWithNs.val, swimNoNs: swimNoNs.val }),
);

// 5. Special Charge Up on Splattershot (200p) and Mint Decavitator (210p)
const scu6 = [
  ["", "", ["SpecialIncrease_Up", "SpecialIncrease_Up", ""]],
  ["", "", ["", "", ""]],
  ["", "", ["", "", ""]],
];
const scu57 = [
  ["", "SpecialIncrease_Up", ["SpecialIncrease_Up", "SpecialIncrease_Up", "SpecialIncrease_Up"]],
  ["", "SpecialIncrease_Up", ["SpecialIncrease_Up", "SpecialIncrease_Up", "SpecialIncrease_Up"]],
  ["", "SpecialIncrease_Up", ["SpecialIncrease_Up", "SpecialIncrease_Up", "SpecialIncrease_Up"]],
];
const shotSp0 = rowOf(computeStats(wShot, EMPTY_SET, statsData), "sp", "sp-pts");
const shotSp57 = rowOf(computeStats(wShot, scu57, statsData), "sp", "sp-pts");
const mintSp0 = rowOf(computeStats(wMint, EMPTY_SET, statsData), "sp", "sp-pts");
const mintSp6 = rowOf(computeStats(wMint, scu6, statsData), "sp", "sp-pts");
const mintSp57 = rowOf(computeStats(wMint, scu57, statsData), "sp", "sp-pts");
check(
  "Special Charge Up matches exact v12 points on Splattershot (200p) and Mint Decavitator (210p -> 199p at 6 AP)",
  shotSp0.base === 200 &&
    shotSp57.val === Math.ceil(200 / 1.3) &&
    mintSp0.base === 210 &&
    mintSp6.val === 199 &&
    mintSp57.val === Math.ceil(210 / 1.3),
  JSON.stringify({ shot: [shotSp0.base, shotSp57.val], mint: [mintSp0.base, mintSp6.val, mintSp57.val] }),
);

// 6. Actions per ink tank increases with Main Ink Saver and Sub Ink Saver; exact SubInkSaveLv curves
const misSet = [
  ["", "MainInk_Save", ["MainInk_Save", "MainInk_Save", ""]],
  ["", "", ["", "", ""]],
  ["", "", ["", "", ""]],
];
const sisSet = [
  ["", "", ["SubInk_Save", "SubInk_Save", ""]],
  ["", "", ["", "", ""]],
  ["", "", ["", "", ""]],
];
const sis57 = [
  ["", "SubInk_Save", ["SubInk_Save", "SubInk_Save", "SubInk_Save"]],
  ["", "SubInk_Save", ["SubInk_Save", "SubInk_Save", "SubInk_Save"]],
  ["", "SubInk_Save", ["SubInk_Save", "SubInk_Save", "SubInk_Save"]],
];
const mintMisActs = rowOf(computeStats(wMint, misSet, statsData), "main", "main-acts");
const mintSisSecs = computeStats(wMint, sisSet, statsData);
const mintSisActs = rowOf(mintSisSecs, "main", "main-acts");
const mintSisSub = rowOf(mintSisSecs, "sub", "sub-ink");
const wBurst = catalog.weapons.find(w => w.sub === "Bomb_Quick");
const burst57 = rowOf(computeStats(wBurst, sis57, statsData), "sub", "sub-ink");
check(
  "Actions per ink tank increases with ISM & ISS; Suction 6 AP = 65.39%, Burst Bomb 57 AP = 32%",
  mintMisActs.changed &&
    mintMisActs.kinds[0].noSub1 > mintMisActs.kinds[0].noSub0 &&
    mintMisActs.kinds[0].withSub1 > mintMisActs.kinds[0].withSub0 &&
    mintSisActs.changed &&
    mintSisActs.kinds[0].noSub1 === mintSisActs.kinds[0].noSub0 &&
    mintSisActs.kinds[0].withSub1 > mintSisActs.kinds[0].withSub0 &&
    mintSisSub.valFmt === "65.39%" &&
    burst57.valFmt === "32%",
  JSON.stringify({ mis: mintMisActs.kinds[0], sis: mintSisActs.kinds[0], suc6: mintSisSub.valFmt, burst57: burst57.valFmt }),
);

// 7. Stealth Jump does not add fake Super Jump time
const sjOnly = [
  ["", "", ["", "", ""]],
  ["", "", ["", "", ""]],
  ["Shs_BOT003", "SuperJumpSign_Hide", ["", "", ""]],
];
const sjTime = rowOf(computeStats(wShot, sjOnly, statsData), "misc", "ms-qsj-t");
check("Stealth Jump does not add fake Super Jump time", !sjTime.changed && near(sjTime.val, 3.633), JSON.stringify(sjTime));

console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASS");
process.exit(failed ? 1 : 0);
