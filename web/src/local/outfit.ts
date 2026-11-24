// An s3s --getseed export read in the browser: the same as companion/server.py decode_export + splatnet.py pieces_from_outfit.
// Plain TS with a JSON import only (Node can load it for the tests).
import table from "./gear-table.json" with { type: "json" };

const ABILITY_ORDER = ["MainInk_Save", "SubInk_Save", "InkRecovery_Up", "HumanMove_Up", "SquidMove_Up", "SpecialIncrease_Up",
  "RespawnSpecialGauge_Save", "SpecialSpec_Up", "RespawnTime_Save", "JumpTime_Save", "SubSpec_Up", "OpInkEffect_Reduction",
  "SubEffect_Reduction", "Action_Up"];
const MAIN_ONLY = ["StartAllUp", "EndAllUp", "MinorityUp", "ComeBack", "SquidMoveSpatter_Reduction", "DeathMarking", "ThermalInk",
  "Exorcist", "ExSkillDouble", "SuperJumpSign_Hide", "ObjectEffect_Up", "SomersaultLanding"];
const SLOT_KEYS: Record<string, [string, string]> = { head: ["headGears", "headGearId"], clothes: ["clothingGears", "clothingGearId"], shoes: ["shoesGears", "shoesGearId"] };
const TABLE = table as unknown as Record<string, Record<string, [string, string]>>;

export type Piece = { slot: string; gearId: number; row: string; brand: string; main: string; subs: string[] };

function power(pid: unknown): string {
  const n = typeof pid === "number" || typeof pid === "string" ? parseInt(String(pid), 10) : NaN;
  if (!Number.isFinite(n)) return "";
  if (n >= 0 && n < ABILITY_ORDER.length) return ABILITY_ORDER[n];
  if (n >= 100 && n < 100 + MAIN_ONLY.length) return MAIN_ONLY[n - 100];
  return "";
}

export function piecesFromOutfit(outfit: any): Piece[] {
  const data = outfit?.data || {}, out: Piece[] = [];
  for (const [slot, [group, idKey]] of Object.entries(SLOT_KEYS)) {
    for (const node of data[group]?.nodes || []) {
      const gid = parseInt(String(node?.[idKey]), 10), info = Number.isFinite(gid) ? TABLE[slot][String(gid)] : undefined;
      if (!info) continue;
      const subs = (node.additionalGearPowers || []).slice(0, 3).map((p: any) => power(p?.gearPowerId));
      while (subs.length < 3) subs.push("");
      out.push({ slot, gearId: gid, row: info[0], brand: info[1], main: power(node.primaryGearPower?.gearPowerId), subs });
    }
  }
  return out;
}

/** key = base64 of the player id, each byte XORed with the low byte of h. Throws Error with the companion's wording. */
export function decodeExport(doc: any): { key: string; pieces: Piece[] } {
  const bad = new Error("not an s3s --getseed export (needs key, h and gear)");
  let key: string;
  try {
    const h = Number(doc.h) & 0xff;
    if (!Number.isFinite(Number(doc.h)) || typeof doc.key !== "string") throw bad;
    const bytes = Uint8Array.from(atob(doc.key), c => c.charCodeAt(0) ^ h);
    key = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw bad; }
  const pieces = piecesFromOutfit(doc.gear || {});
  if (!pieces.length) throw new Error("the export holds no gear");
  return { key, pieces };
}
