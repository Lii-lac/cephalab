// Pure Splatoon 3 v12 build-stat math for the editor Stats panel (no DOM or Vite asset imports,
// so Node 24 can import this module directly in unit tests).

export type WeightCode = "L" | "N" | "H";
export type SecId = "main" | "sub" | "sp" | "subdef" | "move" | "res" | "misc";
export type BuildSet = [string, string, string[]][];

export interface WeaponStatParam {
  spp: number;
  wt: WeightCode;
  ink: number;
  act: string;
  ink2?: number;
  act2?: string;
  rec: number;
  mspd?: number;
  rsu?: boolean;
  rsuCurve?: [number, number, number];
  mis?: [number, number, number];
  tank?: number;
}

export interface SubStatParam {
  ink: number;
  rec: number;
  lv: number;
}

export interface SpecialStatSpec {
  n: string;
  low: number;
  mid: number;
  high: number;
  d: number;
  u: string;
  du?: string;
  inv?: boolean;
}

export interface WeaponStatsData {
  ver: number;
  player: {
    surgeFrm: [number, number, number];
    bombDmgRt: [number, number, number];
  };
  weapons: Record<string, WeaponStatParam>;
  subs: Record<string, SubStatParam>;
  specials: Record<string, SpecialStatSpec[]>;
}

export interface WeaponRef {
  row: string;
  cls: string;
  sub: string;
  sp: string;
}

export interface ActionKindStat {
  label: string;
  noSub0: number;
  noSub1: number;
  withSub0: number;
  withSub1: number;
  per: number;
}

export interface NumStatRow {
  kind: "num";
  id: string;
  sec: SecId;
  name: string;
  ability?: string;
  base: number;
  val: number;
  max: number;
  d: number;
  u: string;
  du?: string;
  baseFmt: string;
  valFmt: string;
  deltaFmt: string;
  changed: boolean;
}

export interface TextStatRow {
  kind: "text";
  id: string;
  sec: SecId;
  name: string;
  text: string;
  changed: false;
}

export interface ActsStatRow {
  kind: "acts";
  id: string;
  sec: SecId;
  subName: string;
  kinds: ActionKindStat[];
  sharedPer: number | null;
  changed: boolean;
}

export type StatRow = NumStatRow | TextStatRow | ActsStatRow;

export interface StatSection {
  id: SecId;
  title: string;
  rows: StatRow[];
  changedCount: number;
}

export const SECS: [SecId, string][] = [
  ["main", "Main weapon"],
  ["sub", "Sub weapon"],
  ["sp", "Special"],
  ["subdef", "Sub defense"],
  ["move", "Movement"],
  ["res", "Ink resistance"],
  ["misc", "Misc"],
];

export const SUB_ABILITIES: readonly string[] = [
  "MainInk_Save",
  "SubInk_Save",
  "InkRecovery_Up",
  "HumanMove_Up",
  "SquidMove_Up",
  "SpecialIncrease_Up",
  "RespawnSpecialGauge_Save",
  "SpecialSpec_Up",
  "RespawnTime_Save",
  "JumpTime_Save",
  "SubSpec_Up",
  "OpInkEffect_Reduction",
  "SubEffect_Reduction",
  "Action_Up",
];

const SUB_ABILITY_SET = new Set<string>(SUB_ABILITIES);

export const SUB_NAMES: Record<string, string> = {
  Beacon: "Squid Beakon",
  Bomb_Curling: "Curling Bomb",
  Bomb_Fizzy: "Fizzy Bomb",
  Bomb_Quick: "Burst Bomb",
  Bomb_Robot: "Autobomb",
  Bomb_Splash: "Splat Bomb",
  Bomb_Suction: "Suction Bomb",
  Bomb_Torpedo: "Torpedo",
  LineMarker: "Angle Shooter",
  PointSensor: "Point Sensor",
  PoisonMist: "Toxic Mist",
  Shield: "Splash Wall",
  Sprinkler: "Sprinkler",
  Trap: "Ink Mine",
};

// Splatoon 3 SubInkSaveLv 0..4 [high, mid, low] consumption multipliers.
// Lv4 is Burst Bomb (45% * 0.71111 = 32% at 57 AP).
export const SUB_INK_SAVE_CURVES: Record<number, [number, number, number]> = {
  0: [0.8, 0.9, 1.0],
  1: [0.7, 0.85, 1.0],
  2: [0.65, 0.825, 1.0],
  3: [0.6, 0.8, 1.0],
  4: [0.71111, 0.85556, 1.0],
};

const SWIM_CURVES: Record<WeightCode, [number, number, number]> = {
  L: [2.016, 2.208, 2.4],
  N: [1.92, 2.16, 2.4],
  H: [1.728, 2.064, 2.4],
};

const RUN_CURVES: Record<WeightCode, [number, number, number]> = {
  L: [1.04, 1.24, 1.44],
  N: [0.96, 1.2, 1.44],
  H: [0.88, 1.16, 1.44],
};

const WEIGHT_LABEL: Record<WeightCode, string> = {
  L: "Light",
  N: "Normal",
  H: "Heavy",
};

/** Official Splatoon 3 AP scaling percentage (0..1) for `ap` Ability Points (0..57). */
export function apPct(ap: number): number {
  if (!(ap > 0)) return 0;
  return Math.min(3.3 * ap - 0.027 * ap * ap, 100) / 100;
}

/** Official Splatoon 3 three-point ability curve from `low` (0 AP) through `mid` (p = 0.5) to `high` (57 AP). */
export function lerp3(low: number, mid: number, high: number, ap: number): number {
  const p = apPct(ap);
  if (p <= 0) return low;
  if (p >= 1) return high;
  const span = high - low;
  if (Math.abs(span) < 1e-12) return low;
  const s = (mid - low) / span;
  if (!(s > 0 && s < 1) || Math.abs(s - 0.5) < 1e-4) return low + span * p;
  return low + span * Math.pow(p, -Math.log(s) / Math.LN2);
}

/** Compute effective stackable AP from a 3-piece build set, doubling clothes subs for Ability Doubler. */
export function apOfSet(set: BuildSet): Record<string, number> {
  const ap: Record<string, number> = {};
  for (let i = 0; i < 3; i++) {
    const piece = set?.[i];
    if (!piece) continue;
    const main = piece[1] || "";
    if (main && SUB_ABILITY_SET.has(main)) ap[main] = (ap[main] || 0) + 10;
    const subWorth = i === 1 && main === "ExSkillDouble" ? 6 : 3;
    const subs = Array.isArray(piece[2]) ? piece[2] : [];
    for (let k = 0; k < 3; k++) {
      const s = subs[k] || "";
      if (s && SUB_ABILITY_SET.has(s)) ap[s] = (ap[s] || 0) + subWorth;
    }
  }
  return ap;
}

/** Sum of stackable AP across the build (matches gear14's header AP counter). */
export function apTotal(set: BuildSet): number {
  let sum = 0;
  for (const v of Object.values(apOfSet(set))) sum += v;
  return sum;
}

export function hasNinjaSquid(set: BuildSet): boolean {
  for (let i = 0; i < 3; i++) {
    if (set?.[i]?.[1] === "SquidMoveSpatter_Reduction") return true;
  }
  return false;
}

export function nfmt(v: number, d: number): string {
  const n = +(+v).toFixed(d);
  return String(n === 0 ? 0 : n);
}

export function fl2(v: number): number {
  return Math.floor(v * 100 + 1e-6) / 100;
}

function pluralAct(label: string): string {
  return /(?:sh|ch)$/i.test(label) ? label + "es" : label + "s";
}

function numRow(
  id: string,
  sec: SecId,
  name: string,
  base: number,
  val: number,
  lim57: number,
  d: number,
  u: string,
  ability?: string,
  du?: string,
): NumStatRow {
  const baseFmt = nfmt(base, d) + u;
  const valFmt = nfmt(val, d) + u;
  const changed = baseFmt !== valFmt;
  const dv = val - base;
  const deltaFmt = changed ? (dv > 0 ? "+" : "−") + nfmt(Math.abs(dv), d) + (du ?? u) : "";
  const max = Math.max(Math.abs(base), Math.abs(lim57), Math.abs(val), 1e-9);
  return { kind: "num", id, sec, name, ability, base, val, max, d, u, du, baseFmt, valFmt, deltaFmt, changed };
}

function evalSpecial(spec: SpecialStatSpec, ap: number): number {
  const raw = lerp3(spec.low, spec.mid, spec.high, ap);
  return spec.inv ? 1 / raw : raw;
}

/** Compute all 7 stat sections for weapon `w` and gear `set` using distilled v1200 `data`. */
export function computeStats(w: WeaponRef, set: BuildSet, data: WeaponStatsData): StatSection[] {
  const wp = data.weapons[w.row];
  const sub = data.subs[w.sub];
  const spList = data.specials[w.sp] || [];
  if (!wp || !sub) {
    return SECS.map(([id, title]) => ({ id, title, rows: [], changedCount: 0 }));
  }

  const ap = apOfSet(set);
  const getAp = (a: string) => ap[a] || 0;
  const ninja = hasNinjaSquid(set);
  const subName = SUB_NAMES[w.sub] || w.sub;

  // Main ink saver curve
  const [misHi, misMid, misLo] = wp.mis || [0.55, 0.775, 1.0];
  const misMult = (a: number) => lerp3(misLo, misMid, misHi, a);
  const mainInk0 = wp.ink;
  const mainInk1 = wp.ink * misMult(getAp("MainInk_Save"));
  const mainInk57 = wp.ink * misHi;

  // Sub ink saver curve
  const [sisHi, sisMid, sisLo] = SUB_INK_SAVE_CURVES[sub.lv] || SUB_INK_SAVE_CURVES[2];
  const sisMult = (a: number) => lerp3(sisLo, sisMid, sisHi, a);
  const subInk0 = sub.ink;
  const subInk1 = sub.ink * sisMult(getAp("SubInk_Save"));
  const subInk57 = sub.ink * sisHi;

  // 1. Main weapon
  const mainRows: StatRow[] = [
    numRow("main-ink", "main", `Ink per ${wp.act.toLowerCase()}`, mainInk0, mainInk1, mainInk57, 2, "%", "MainInk_Save"),
  ];
  if (wp.ink2 != null && wp.act2) {
    const ink2_1 = wp.ink2 * misMult(getAp("MainInk_Save"));
    const ink2_57 = wp.ink2 * misHi;
    mainRows.push(
      numRow("main-ink2", "main", `Ink per ${wp.act2.toLowerCase()}`, wp.ink2, ink2_1, ink2_57, 2, "%", "MainInk_Save"),
    );
  }
  mainRows.push(numRow("main-rec", "main", "No ink recovery after use", wp.rec, wp.rec, wp.rec, 3, "s"));

  const tank = wp.tank ?? 100;
  const rawKinds: [string, number, number][] = [[pluralAct(wp.act), mainInk0, mainInk1]];
  if (wp.ink2 != null && wp.act2) {
    rawKinds.push([pluralAct(wp.act2), wp.ink2, wp.ink2 * misMult(getAp("MainInk_Save"))]);
  }
  const kinds: ActionKindStat[] = rawKinds.map(([label, c0, c1]) => {
    const noSub0 = fl2(tank / c0);
    const noSub1 = fl2(tank / c1);
    const withSub0 = fl2(Math.max(0, tank - subInk0) / c0);
    const withSub1 = fl2(Math.max(0, tank - subInk1) / c1);
    const per = Math.max(1, Math.ceil(Math.max(noSub0, noSub1) / 20));
    return { label, noSub0, noSub1, withSub0, withSub1, per };
  });
  const sharedPer = kinds.every(k => k.per === kinds[0].per) ? kinds[0].per : null;
  const actsChanged = kinds.some(k => k.noSub0 !== k.noSub1 || k.withSub0 !== k.withSub1);
  mainRows.push({ kind: "acts", id: "main-acts", sec: "main", subName, kinds, sharedPer, changed: actsChanged });
  mainRows.push({ kind: "text", id: "main-wt", sec: "main", name: "Weight", text: WEIGHT_LABEL[wp.wt], changed: false });

  // 2. Sub weapon
  const subRows: StatRow[] = [
    numRow("sub-ink", "sub", `${subName} ink`, subInk0, subInk1, subInk57, 2, "%", "SubInk_Save"),
    numRow("sub-rec", "sub", "No ink recovery after sub", sub.rec, sub.rec, sub.rec, 3, "s"),
  ];

  // 3. Special
  const sppVal = (a: number) => Math.ceil(wp.spp / lerp3(1.0, 1.15, 1.3, a));
  const spLost = (a: number) => (1 - lerp3(0.5, 0.75, 1.0, a)) * 100;
  const spLostRp = (a: number) => Math.min(100, Math.max(0, (1 - lerp3(0.5, 0.75, 1.0, a * 0.7)) * 100 + 22.5));
  const spRows: StatRow[] = [
    numRow("sp-pts", "sp", "Points to special", wp.spp, sppVal(getAp("SpecialIncrease_Up")), sppVal(57), 0, "p", "SpecialIncrease_Up"),
    numRow("sp-lost", "sp", "Special lost when splatted", spLost(0), spLost(getAp("RespawnSpecialGauge_Save")), spLost(57), 1, "%", "RespawnSpecialGauge_Save"),
    numRow("sp-lost-rp", "sp", "...by a Respawn Punisher user", spLostRp(0), spLostRp(getAp("RespawnSpecialGauge_Save")), spLostRp(57), 1, "%", "RespawnSpecialGauge_Save"),
  ];
  spList.forEach((spec, idx) => {
    const v0 = evalSpecial(spec, 0);
    const v1 = evalSpecial(spec, getAp("SpecialSpec_Up"));
    const v57 = evalSpecial(spec, 57);
    spRows.push(numRow(`sp-pow-${idx}`, "sp", spec.n, v0, v1, v57, spec.d, spec.u, "SpecialSpec_Up", spec.du));
  });

  // 4. Sub defense
  const [bdLo, bdMid, bdHi] = data.player.bombDmgRt;
  const sruAp = getAp("SubEffect_Reduction");
  const subDefRows: StatRow[] = [
    numRow("sd-bomb", "subdef", "Bomb damage reduction", bdLo, lerp3(bdLo, bdMid, bdHi, sruAp), bdHi, 1, "%", "SubEffect_Reduction"),
    numRow("sd-mist", "subdef", "Toxic Mist movement reduction", 100, lerp3(100, 75, 50, sruAp), 50, 2, "%", "SubEffect_Reduction"),
    numRow("sd-sensor", "subdef", "Point Sensor tracking", 8.0, lerp3(8.0, 4.75, 2.5, sruAp), 2.5, 3, "s", "SubEffect_Reduction"),
    numRow("sd-mine", "subdef", "Ink Mine tracking", 5.0, lerp3(5.0, 3.3, 2.0, sruAp), 2.0, 3, "s", "SubEffect_Reduction"),
    numRow("sd-marker", "subdef", "Angle Shooter tracking", 5.0, lerp3(5.0, 3.3, 2.0, sruAp), 2.0, 3, "s", "SubEffect_Reduction"),
  ];

  // 5. Movement
  const [swLo, swMid, swHi] = SWIM_CURVES[wp.wt];
  const ssuAp = getAp("SquidMove_Up");
  const swim0 = swLo;
  const swim1 = lerp3(swLo, swMid, swHi, ssuAp) * (ninja ? 0.9 : 1);
  const [rnLo, rnMid, rnHi] = RUN_CURVES[wp.wt];
  const rsuAp = getAp("HumanMove_Up");
  const run0 = rnLo;
  const run1 = lerp3(rnLo, rnMid, rnHi, rsuAp);
  const [sgLo, sgMid, sgHi] = data.player.surgeFrm;
  const iaAp = getAp("Action_Up");

  const moveRows: StatRow[] = [
    numRow("mv-swim", "move", "Swim speed", swim0, swim1, swHi, 2, "", "SquidMove_Up"),
    numRow("mv-swim-rm", "move", "Swim speed with Rainmaker", swim0 * 0.8, swim1 * 0.8, swHi * 0.8, 3, "", "SquidMove_Up"),
    numRow("mv-run", "move", "Run speed", run0, run1, rnHi, 2, "", "HumanMove_Up"),
  ];
  if (wp.mspd != null && wp.mspd > 0) {
    const label =
      w.cls === "Charger" || w.cls === "Stringer" || w.cls === "Saber"
        ? "Run speed while charging"
        : w.cls === "Roller" || w.cls === "Brush"
          ? "Run speed while swinging"
          : "Run speed while firing";
    if (wp.rsu === false) {
      moveRows.push(numRow("mv-fire", "move", label, wp.mspd, wp.mspd, wp.mspd, 2, ""));
    } else {
      const [cLo, cMid, cHi] = wp.rsuCurve || [1.0, 1.125, 1.25];
      moveRows.push(
        numRow("mv-fire", "move", label, wp.mspd, wp.mspd * lerp3(cLo, cMid, cHi, rsuAp), wp.mspd * cHi, 2, "", "HumanMove_Up"),
      );
    }
  }
  moveRows.push(
    numRow("mv-surge", "move", "Squid Surge charge", sgLo, Math.round(lerp3(sgLo, sgMid, sgHi, iaAp)), sgHi, 0, " frames", "Action_Up", "f"),
    numRow("mv-jrng", "move", "Jump RNG reduction", 0, lerp3(0, 28, 50, iaAp), 50, 1, "%", "Action_Up"),
  );

  // 6. Ink resistance
  const irAp = getAp("OpInkEffect_Reduction");
  const resRows: StatRow[] = [
    numRow("res-run", "res", "Run speed in enemy ink", 0.24, lerp3(0.24, 0.48, 0.72, irAp), 0.72, 3, "", "OpInkEffect_Reduction"),
    numRow("res-jump", "res", "Jump height in enemy ink", 0.8, lerp3(0.8, 1.05, 1.3, irAp), 1.3, 3, "", "OpInkEffect_Reduction"),
    numRow("res-frm", "res", "Frames before enemy ink damage", 0, Math.round(lerp3(0, 18, 39, irAp)), 39, 0, " frames", "OpInkEffect_Reduction", "f"),
    numRow("res-dps", "res", "Enemy ink damage per second", 18, lerp3(18, 12, 6, irAp), 6, 1, "hp", "OpInkEffect_Reduction"),
    numRow("res-max", "res", "Max enemy ink damage", 40, lerp3(40, 30, 20, irAp), 20, 1, "hp", "OpInkEffect_Reduction"),
  ];

  // 7. Misc
  const recAp = getAp("InkRecovery_Up");
  const qrAp = getAp("RespawnTime_Save");
  const qsjAp = getAp("JumpTime_Save");
  const qrRp = (a: number) => lerp3(7.5, 5.5, 3.5, a * 0.15) + 0.75;
  const miscRows: StatRow[] = [
    numRow("ms-rec-sq", "misc", "Ink tank refill (squid)", 180 / 60, lerp3(180, 145, 111, recAp) / 60, 111 / 60, 2, "s", "InkRecovery_Up"),
    numRow("ms-rec-hu", "misc", "Ink tank refill (humanoid)", 600 / 60, lerp3(600, 425, 250, recAp) / 60, 250 / 60, 2, "s", "InkRecovery_Up"),
    numRow("ms-qr", "misc", "Quick respawn time", 7.5, lerp3(7.5, 5.5, 3.5, qrAp), 3.5, 2, "s", "RespawnTime_Save"),
    numRow("ms-qr-rp", "misc", "...by a Respawn Punisher user", qrRp(0), qrRp(qrAp), qrRp(57), 2, "s", "RespawnTime_Save"),
    numRow("ms-qsj-v", "misc", "Super jump vulnerable frames", 80, Math.round(lerp3(80, 44, 20, qsjAp)), 20, 0, " frames", "JumpTime_Save", "f"),
    numRow("ms-qsj-t", "misc", "Super jump total time", 3.633, lerp3(3.633, 2.917, 2.433, qsjAp), 2.433, 3, "s", "JumpTime_Save"),
  ];

  const byId: Record<SecId, StatRow[]> = {
    main: mainRows,
    sub: subRows,
    sp: spRows,
    subdef: subDefRows,
    move: moveRows,
    res: resRows,
    misc: miscRows,
  };

  return SECS.map(([id, title]) => {
    const rows = byId[id];
    const changedCount = rows.reduce((n, r) => n + (r.changed ? 1 : 0), 0);
    return { id, title, rows, changedCount };
  });
}
