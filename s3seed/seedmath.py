"""Splatoon 3 gear roll math, ported from Leanny's seed checker (SeedCalculator.js).

A gear piece keeps one 32-bit seed. Each sub-slot roll steps it with xorshift32 and
picks an ability weighted by the brand: the brand's "usual" ability weighs 10, its
"unusual" one 1, every other ability 2. With a drink active, the first step is a 30%
check for the drink's ability; on a miss a second step rolls among the rest.
"""
import json
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"

# Same order as the game's ability ids 1..14 (ability id - 1 = index here).
ABILITY_ORDER = [
    "MainInk_Save", "SubInk_Save", "InkRecovery_Up", "HumanMove_Up", "SquidMove_Up",
    "SpecialIncrease_Up", "RespawnSpecialGauge_Save", "SpecialSpec_Up", "RespawnTime_Save",
    "JumpTime_Save", "SubSpec_Up", "OpInkEffect_Reduction", "SubEffect_Reduction", "Action_Up",
]

_traits = json.loads((DATA / "BrandTraitsParam.raw.json").read_text(encoding="utf-8"))
UNUSUAL_W, NORMAL_W, USUAL_W = _traits["SkillEasilyToGetParam"]
TRAITS = _traits["Traits"]

MASK = 0xFFFFFFFF


def next_seed(s: int) -> int:
    s ^= (s << 13) & MASK
    s ^= s >> 17
    s ^= (s << 5) & MASK
    return s & MASK


def _weights(brand: str, exclude: str | None = None) -> list[tuple[str, int]]:
    t = TRAITS.get(brand, TRAITS["None"])
    out = []
    for a in ABILITY_ORDER:
        if a == exclude:
            continue
        if t["UnusualGearSkill"] == a:
            w = UNUSUAL_W
        elif t["UsualGearSkill"] == a:
            w = USUAL_W
        else:
            w = NORMAL_W
        out.append((a, w))
    return out


def _pick(seed: int, weights: list[tuple[str, int]]) -> str:
    roll = seed % sum(w for _, w in weights)
    for a, w in weights:
        roll -= w
        if roll < 0:
            return a
    raise AssertionError("unreachable")


def roll(seed: int, brand: str, drink: str | None = None) -> tuple[int, str, bool]:
    """One sub-slot roll. Returns (new seed, ability, whether the drink hit)."""
    seed = next_seed(seed)
    if drink:
        if seed % 100 <= 0x1D:
            return seed, drink, True
        seed = next_seed(seed)
        return seed, _pick(seed, _weights(brand, exclude=drink)), False
    return seed, _pick(seed, _weights(brand)), False


def predict(seed: int, brand: str, drink: str | None = None, n: int = 10) -> list[dict]:
    """The next n rolls from this seed, as the checker lists them."""
    out = []
    for i in range(n):
        seed, ability, hit = roll(seed, brand, drink)
        out.append({"n": i + 1, "ability": ability, "drink_hit": hit, "seed": seed})
    return out


def explain_change(old: int, new: int, brand: str, max_steps: int = 64) -> int | None:
    """How many xorshift steps lead from old to new (None if not within max_steps)."""
    s = old
    for i in range(1, max_steps + 1):
        s = next_seed(s)
        if s == new:
            return i
    return None
