"""sendou.ink's top builds for one weapon, cached for a day, in our saved-build shape.

https://sendou.ink/builds/<slug>.data is the page's own JSON (robots.txt allows it). Builds keep sendou's order.
Gear sendou leaves blank comes back as row "" (the page draws its placeholder).
"""
import json
import re
import threading
import time
import urllib.request
from pathlib import Path

from s3seed import gear as G
from s3seed.seedmath import DATA

TTL = 24 * 3600
ROUTE = "features/builds/routes/builds.$slug"
CODES = {  # sendou's ability codes -> the game's internal names
    "ISM": "MainInk_Save", "ISS": "SubInk_Save", "IRU": "InkRecovery_Up", "RSU": "HumanMove_Up", "SSU": "SquidMove_Up",
    "SCU": "SpecialIncrease_Up", "SS": "RespawnSpecialGauge_Save", "SPU": "SpecialSpec_Up", "QR": "RespawnTime_Save",
    "QSJ": "JumpTime_Save", "BRU": "SubSpec_Up", "RES": "OpInkEffect_Reduction", "SRU": "SubEffect_Reduction",
    "IA": "Action_Up", "OG": "StartAllUp", "LDE": "EndAllUp", "T": "MinorityUp", "CB": "ComeBack",
    "NS": "SquidMoveSpatter_Reduction", "H": "DeathMarking", "TI": "ThermalInk", "RP": "Exorcist", "AD": "ExSkillDouble",
    "SJ": "SuperJumpSign_Hide", "OS": "ObjectEffect_Up", "DR": "SomersaultLanding",
}
_WEAPONS = {w["Id"]: w["__RowId"] for w in json.loads((DATA / "WeaponInfoMain.json").read_text(encoding="utf-8"))}
_lock = threading.Lock()


class SendouError(Exception):
    pass


def convert(payload: dict) -> dict:
    data = ((payload or {}).get(ROUTE) or {}).get("data") or {}
    out = []
    for b in data.get("builds") or []:
        try:
            abil = b["abilities"]
            set3 = []
            for slot, gid_key, row_abil in zip(G.TYPES, ("headGearSplId", "clothesGearSplId", "shoesGearSplId"), abil):
                info = G.GEAR_INFO.get((slot, b.get(gid_key))) if b.get(gid_key) is not None else None
                set3.append([info[3] if info else "", CODES.get(row_abil[0], ""), [CODES.get(a, "") for a in row_abil[1:4]]])
        except (KeyError, TypeError, IndexError, ValueError):
            continue                                  # one odd build doesn't sink the list
        weapons = [_WEAPONS.get(w.get("weaponSplId")) for w in b.get("weapons") or []]
        out.append({"id": b.get("id"), "title": b.get("title") or "", "modes": b.get("modes") or [],
                    "notes": b.get("description") or "", "set": set3, "weapon": next((w for w in weapons if w), ""),
                    "src": {"sendou": b.get("id"), "owner": ((b.get("owner") or {}).get("username") or ""),
                            "top500": any(w.get("isTop500") for w in b.get("weapons") or [])}})
    return {"weapon": _WEAPONS.get(data.get("weaponId"), ""), "slug": data.get("slug", ""), "count": data.get("buildsCount", len(out)),
            "builds": out}


def builds(slug: str, cache_dir: Path, fetch=None) -> dict:
    """The converted list for a weapon slug (e.g. "splattershot"). Serves a stale copy when sendou can't be reached."""
    if not re.fullmatch(r"[a-z0-9-]{1,60}", slug or ""):
        raise SendouError("bad weapon slug")
    path = cache_dir / f"{slug}.json"
    with _lock:
        if path.exists() and time.time() - path.stat().st_mtime < TTL:
            return json.loads(path.read_text(encoding="utf-8"))
        try:
            raw = (fetch or _fetch)(slug)
            res = convert(json.loads(raw))
        except (OSError, ValueError) as e:
            if path.exists():
                return {**json.loads(path.read_text(encoding="utf-8")), "stale": True}
            raise SendouError(f"Couldn't reach sendou.ink ({e.__class__.__name__})") from None
        res["fetchedAt"] = time.time()
        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(res), encoding="utf-8")
        tmp.replace(path)
        return res


def _fetch(slug: str) -> bytes:
    req = urllib.request.Request(f"https://sendou.ink/builds/{slug}.data", headers={"User-Agent": "Cephalab"})
    with urllib.request.urlopen(req, timeout=15) as r:
        if r.status != 200:
            raise OSError(f"HTTP {r.status}")
        return r.read()
