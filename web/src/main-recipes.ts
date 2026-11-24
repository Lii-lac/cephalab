// A main-only ability (data.ts MAINONLY, only on its own slot) can be put on a piece at Murch for 15 chunks each of three standard
// abilities: its recipe. Keyed by the internal ability id (data.ts NAMES). Source: the game's own spl__GearSkillTraitsParam for
// v12.0.0 (Leanny/splat3 data/parameter/1200/misc), ConsistsOfChip, 15 chunks each. ExSkillDouble (clothes) has no recipe: it can't be made from chunks, so it is missing here on purpose and the Path says the build needs a piece
// that already has it.
export const MAIN_RECIPES: Record<string, [string, string, string]> = {
  // head
  ComeBack: ["HumanMove_Up", "SquidMove_Up", "SpecialIncrease_Up"],
  StartAllUp: ["HumanMove_Up", "SquidMove_Up", "OpInkEffect_Reduction"],
  EndAllUp: ["MainInk_Save", "SubInk_Save", "InkRecovery_Up"],
  MinorityUp: ["SpecialIncrease_Up", "RespawnSpecialGauge_Save", "SpecialSpec_Up"],
  // clothes
  SquidMoveSpatter_Reduction: ["InkRecovery_Up", "HumanMove_Up", "SquidMove_Up"],
  DeathMarking: ["RespawnTime_Save", "SubSpec_Up", "OpInkEffect_Reduction"],
  Exorcist: ["RespawnSpecialGauge_Save", "RespawnTime_Save", "SubEffect_Reduction"],
  ThermalInk: ["MainInk_Save", "SubInk_Save", "Action_Up"],
  // shoes
  SuperJumpSign_Hide: ["JumpTime_Save", "SubEffect_Reduction", "Action_Up"],
  ObjectEffect_Up: ["InkRecovery_Up", "SpecialSpec_Up", "SubSpec_Up"],
  SomersaultLanding: ["JumpTime_Save", "OpInkEffect_Reduction", "Action_Up"],
};
