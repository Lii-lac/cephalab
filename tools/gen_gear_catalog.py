"""Writes web/src/data/gear-catalog.json for the build editor, reusing mockups/parts/gear_catalog.py's
filtering/sorting logic from data/GearInfo*.json, data/BrandTraitsParam.raw.json, data/USen.json and
data/WeaponInfoMain.json, plus arrow clearance bitmasks from cache/img/weapon_flat (tools/art_busy.py).
Run again after data/ changes: .venv/Scripts/python.exe tools/gen_gear_catalog.py"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CLASSES = [
    ["Shooter", "Shooters"],
    ["Roller", "Rollers"],
    ["Charger", "Chargers"],
    ["Slosher", "Sloshers"],
    ["Spinner", "Splatlings"],
    ["Maneuver", "Dualies"],
    ["Shelter", "Brellas"],
    ["Blaster", "Blasters"],
    ["Brush", "Brushes"],
    ["Stringer", "Stringers"],
    ["Saber", "Splatanas"],
]


def build_gear(msg: dict) -> dict[str, list]:
    brands = msg["CommonMsg/Gear/GearBrandName"]
    out = {}
    for slot, fn, key in (
        ("head", "Head", "GearName_Head"),
        ("clothes", "Clothes", "GearName_Clothes"),
        ("shoes", "Shoes", "GearName_Shoes"),
    ):
        names = msg["CommonMsg/Gear/" + key]
        rows, seen = [], set()
        for g in json.loads((DATA / f"GearInfo{fn}.json").read_text(encoding="utf-8")):
            row = g["__RowId"]
            code = row.split("_", 1)[1]
            name = names.get(code)
            if g.get("HowToGet") == "Impossible" or not name or name in seen:
                continue
            seen.add(name)
            bid = g["Brand"]
            rows.append([row, name, brands.get(bid, ""), g["Skill"], g["Rarity"], bid])
        out[slot] = sorted(rows, key=lambda r: r[1].lower())
    return out


def build_brands(msg: dict) -> dict[str, list[str]]:
    bnames = msg["CommonMsg/Gear/GearBrandName"]
    traits = json.loads((DATA / "BrandTraitsParam.raw.json").read_text(encoding="utf-8"))["Traits"]
    out = {}
    for bid, t in traits.items():
        if bid in bnames:
            out[bid] = [bnames[bid], t.get("UsualGearSkill", ""), t.get("UnusualGearSkill", "")]
    return out


def build_weapons() -> list[dict[str, str]]:
    existing = {w["row"]: w for w in json.loads((ROOT / "web" / "src" / "data" / "weapons.json").read_text(encoding="utf-8"))}
    wm = json.loads((DATA / "WeaponInfoMain.json").read_text(encoding="utf-8"))
    cls_ord = {c[0]: i for i, c in enumerate(CLASSES)}
    ordered = sorted(
        (w for w in wm if w["__RowId"] in existing),
        key=lambda w: (cls_ord.get(existing[w["__RowId"]]["cls"], 99), w["Id"]),
    )
    return [
        {"row": w["__RowId"], "cls": existing[w["__RowId"]]["cls"], "sub": existing[w["__RowId"]]["sub"], "sp": existing[w["__RowId"]]["sp"]}
        for w in ordered
    ]


def build_art_busy(rows: list[str]) -> dict[str, str]:
    flat_dir = ROOT / "cache" / "img" / "weapon_flat"
    if not flat_dir.exists():
        return {}
    from PIL import Image

    lift = 12
    out = {}
    for row in rows:
        f = flat_dir / f"Path_Wst_{row}.png"
        if not f.exists():
            continue
        im = Image.open(f).convert("RGBA")
        w, h = im.size
        s = 150 / max(w, h)
        im = im.resize((round(w * s), round(h * s)))
        W, H = im.size
        ox, oy = (150 - W) // 2, (150 - H) // 2
        a = im.getchannel("A").load()
        bits = []
        for x in range(150):
            busy = 0
            for y in range(108, 132):
                for dx in (-3, -2, -1, 0, 1, 2, 3):
                    ix, iy = x - ox + dx - 2, y + lift - oy - 3
                    if 0 <= ix < W and 0 <= iy < H and a[ix, iy] > 24:
                        busy = 1
                        break
                if busy:
                    break
            bits.append(str(busy))
        out[row] = format(int("".join(bits) + "00", 2), "038x")
    return out


def main() -> None:
    msg = json.loads((DATA / "USen.json").read_text(encoding="utf-8"))
    weapons = build_weapons()
    catalog = {
        "gear": build_gear(msg),
        "brands": build_brands(msg),
        "classes": CLASSES,
        "weapons": weapons,
        "artBusy": build_art_busy([w["row"] for w in weapons]),
    }
    dest = ROOT / "web" / "src" / "data" / "gear-catalog.json"
    dest.write_text(json.dumps(catalog, separators=(",", ":")), encoding="utf-8")
    counts = {k: len(v) for k, v in catalog["gear"].items()}
    print(dest, dest.stat().st_size, "bytes", counts, "brands:", len(catalog["brands"]), "weapons:", len(weapons), "artBusy:", len(catalog["artBusy"]))


if __name__ == "__main__":
    main()
