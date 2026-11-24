// sendou.ink's build links (what its share card's QR code holds too): https://sendou.ink/analyzer?weapon=<game weapon id>&build=
// twelve ability codes, comma separated: head main, its three subs, then clothes, then shoes ("U" = an empty slot). No gear,
// no title. Paste one on any screen and it opens in the editor (seek.ts / wiring.ts); the editor's sendou button opens
// the build there.
import IDS from "./data/weapon-ids.json";

export const CODES: Record<string, string> = {   // sendou's ability codes -> the game's internal names (as companion/sendou.py)
  ISM: "MainInk_Save", ISS: "SubInk_Save", IRU: "InkRecovery_Up", RSU: "HumanMove_Up", SSU: "SquidMove_Up",
  SCU: "SpecialIncrease_Up", SS: "RespawnSpecialGauge_Save", SPU: "SpecialSpec_Up", QR: "RespawnTime_Save",
  QSJ: "JumpTime_Save", BRU: "SubSpec_Up", RES: "OpInkEffect_Reduction", SRU: "SubEffect_Reduction",
  IA: "Action_Up", OG: "StartAllUp", LDE: "EndAllUp", T: "MinorityUp", CB: "ComeBack",
  NS: "SquidMoveSpatter_Reduction", H: "DeathMarking", TI: "ThermalInk", RP: "Exorcist", AD: "ExSkillDouble",
  SJ: "SuperJumpSign_Hide", OS: "ObjectEffect_Up", DR: "SomersaultLanding",
};
const BACK: Record<string, string> = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, k]));
const ROWOF: Record<number, string> = Object.fromEntries(Object.entries(IDS as Record<string, number>).map(([r, id]) => [id, r]));

export type Linked = { row: string; set: [string, string, string[]][] };

/** A sendou analyzer link -> the weapon row ("" when sendou's id isn't one we know) and the build's three gear rows (any
 *  gear); null for anything else. */
export function parseLink(text: string): Linked | null {
  let u: URL;
  try { u = new URL(String(text || "").trim()); } catch { return null; }
  if (!/(^|\.)sendou\.ink$/i.test(u.hostname) || !/^\/analyzer\/?$/.test(u.pathname)) return null;
  const codes = (u.searchParams.get("build") || "").split(",").map(c => c.trim().toUpperCase());
  if (codes.length !== 12 || !codes.every(c => c === "U" || c in CODES)) return null;
  const a = (k: number) => CODES[codes[k]] || "";
  return { row: ROWOF[Number(u.searchParams.get("weapon"))] || "", set: [0, 1, 2].map(g => ["", a(g * 4), [a(g * 4 + 1), a(g * 4 + 2), a(g * 4 + 3)]]) as Linked["set"] };
}

/** The analyzer link for a build (gear rows aren't part of it). */
export function linkFor(row: string, set: any[]): string {
  const codes = [0, 1, 2].flatMap(g => { const [, main, subs] = set[g] || ["", "", []]; return [main, ...[0, 1, 2].map(k => (subs || [])[k])].map(x => BACK[x] || "U"); });
  const id = (IDS as Record<string, number>)[row];
  return `https://sendou.ink/analyzer?${id != null ? `weapon=${id}&` : ""}build=${encodeURIComponent(codes.join(","))}`;
}
