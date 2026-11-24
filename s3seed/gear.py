"""Reading Splatoon 3's owned-gear tables out of RAM (layout from LegoFigure11/Splat3GearView)."""
import json
import struct
from dataclasses import dataclass, asdict

from .botbase import Botbase
from .seedmath import ABILITY_ORDER, DATA

# Offsets for Splatoon 3 v11.3.0 (Splat3GearView v0.11.3). Heap-relative, read with `peek`.
GAME_VERSION = "11.3.0"
GEAR_LIST_HEAD = 0xBA24BDD8
GEAR_LIST_STRIDE = 0x2C020          # head -> clothes -> shoes
FIRST_RECORD = 0x40
DLC_OFFSET = 0x3B000                # everything sits this much later with the Side Order DLC
RECORD = 0xB0
MAX_RECORDS = 1000                  # the game's table holds about 1023 per type
CHUNK = 40                          # records per peek: small reads keep the game from hitching

TYPES = ["head", "clothes", "shoes"]
_INFO_FILES = {"head": "GearInfoHead", "clothes": "GearInfoClothes", "shoes": "GearInfoShoes"}
_NAME_KEYS = {"head": "GearName_Head", "clothes": "GearName_Clothes", "shoes": "GearName_Shoes"}

# Ability ids as the game stores them (1..14 are the sub-able ones, in ABILITY_ORDER).
_MAIN_ONLY = ["StartAllUp", "EndAllUp", "MinorityUp", "ComeBack", "SquidMoveSpatter_Reduction",
              "DeathMarking", "ThermalInk", "Exorcist", "ExSkillDouble", "SuperJumpSign_Hide",
              "ObjectEffect_Up", "SomersaultLanding"]
ABILITY_IDS = ["Unknown"] + ABILITY_ORDER + _MAIN_ONLY   # index = id


def _load_names():
    lang = json.loads((DATA / "USen.json").read_text(encoding="utf-8"))
    powers = lang["CommonMsg/Gear/GearPowerName"]
    brands = lang["CommonMsg/Gear/GearBrandName"]
    info = {}
    for t in TYPES:
        names = lang["CommonMsg/Gear/" + _NAME_KEYS[t]]
        for g in json.loads((DATA / f"{_INFO_FILES[t]}.json").read_text(encoding="utf-8")):
            key = g["__RowId"].split("_", 1)[1]
            info[(t, g["Id"])] = (names.get(key, g["__RowId"]), g["Brand"], brands.get(g["Brand"], g["Brand"]), g["__RowId"])
    return powers, info


POWER_NAMES, GEAR_INFO = _load_names()


def ability_name(internal: str) -> str:
    return POWER_NAMES.get(internal, internal)


@dataclass
class Gear:
    type: str
    id: int
    name: str
    brand: str          # brand code, e.g. B03 (what the roll weights use)
    brand_name: str
    rarity: int         # stars
    exp: int
    main: str
    subs: list          # internal ability names of filled slots, "" for empty
    seed: int
    row: str = ""       # Leanny row id, e.g. Hed_AMB000 (image name)

    @property
    def key(self) -> str:
        return f"{self.type}:{self.id}"

    def to_json(self) -> dict:
        d = asdict(self)
        d["key"] = self.key
        d["seed_hex"] = f"0x{self.seed:08x}"
        return d


def parse_record(t: str, raw: bytes) -> Gear | None:
    """One 0xB0 record, or None when it doesn't look like real gear (end of the list)."""
    gid = struct.unpack_from("<H", raw, 0x00)[0]
    exp = struct.unpack_from("<H", raw, 0x48)[0]
    rarity, primary, count = raw[0x50], raw[0x54], raw[0x68]
    subs = [raw[0x6C], raw[0x70], raw[0x74]]
    seed = struct.unpack_from("<I", raw, 0x80)[0]
    if gid == 0 or seed == 0 or rarity > 5 or count > 3 or count > rarity + 1:
        return None
    if primary >= len(ABILITY_IDS) or any(s > 14 for s in subs):
        return None
    if (t, gid) not in GEAR_INFO:
        return None
    name, brand, brand_name, row = GEAR_INFO[(t, gid)]
    return Gear(t, gid, name, brand, brand_name, rarity, exp, ABILITY_IDS[primary],
                [ABILITY_ORDER[s - 1] if 1 <= s <= 14 else "" for s in subs], seed, row)


HEADS = {GAME_VERSION: GEAR_LIST_HEAD,     # game version -> gear list head; gear_find.py learns new ones
         "12.0.0": 0xBA28E038}              # found on Alex's Switch 2026-11-20 (333 pieces read, every list ending clean)
_head = GEAR_LIST_HEAD


def use_head(head: int):
    """Read the tables at this head from now on (a version found by gear_find, DLC shift already inside it)."""
    global _head
    _head = head


def _list_base(t: str, dlc: int) -> int:
    return _head + TYPES.index(t) * GEAR_LIST_STRIDE + FIRST_RECORD + dlc


def detect_dlc(bot: Botbase) -> int | None:
    """Which layout this save uses: 0, DLC_OFFSET, or None if neither looks like gear."""
    for dlc in (0, DLC_OFFSET):
        if parse_record("head", bot.peek(_list_base("head", dlc), RECORD)):
            return dlc
    return None


def _read_list(bot: Botbase, t: str, dlc: int) -> list[Gear]:
    """One type's records, up to the first one that isn't gear, read CHUNK records per peek."""
    out, base, i = [], _list_base(t, dlc), 0
    while i < MAX_RECORDS:
        data = bot.peek(base + i * RECORD, RECORD * CHUNK)
        for j in range(CHUNK):
            g = parse_record(t, data[j * RECORD:(j + 1) * RECORD])
            if g is None:
                return out
            out.append(g)
        i += CHUNK
    return out


def read_all(bot: Botbase, dlc: int) -> list[Gear]:
    out = []
    for t in TYPES:
        out += _read_list(bot, t, dlc)
    return out


def _plausible(heads: list[Gear]) -> bool:
    """A real headgear list: 3+ records, and not 5+ that all share one main (a wrong head that happens to parse)."""
    if len(heads) < 3:
        return False
    return not (len(heads) >= 5 and len({g.main for g in heads}) == 1)


def pick_head(bot: Botbase, heads) -> tuple[int, int] | None:
    """The (head, dlc) among these candidate heads whose headgear list reads the most plausible records, or None.
    The game's version string can't be trusted (v12 reported 11.3.0 and the 11.3 head parsed as garbage), so each
    candidate is tried in order (put the version's own head first; a tie keeps the earlier). Leaves use_head on the winner."""
    best, seen = None, set()
    for h in heads:
        if h in seen:
            continue
        seen.add(h)
        use_head(h)
        dlc = detect_dlc(bot)
        if dlc is None:
            continue
        got = _read_list(bot, "head", dlc)
        if _plausible(got) and (best is None or len(got) > best[2]):
            best = (h, dlc, len(got))
    if best is None:
        return None
    use_head(best[0])
    return best[0], best[1]
