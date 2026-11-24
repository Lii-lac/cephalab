"""web/src/data/weapon-ids.json: each weapon row in web/src/data/weapons.json -> the game's weapon id (sendou.ink links use it:
https://sendou.ink/analyzer?weapon=<id>&build=...). Rerun after data/ changes:  .venv/Scripts/python.exe tools/gen_weapon_ids.py"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
info = json.loads((ROOT / "data" / "WeaponInfoMain.json").read_text(encoding="utf-8"))
ids = {w["__RowId"]: w["Id"] for w in info}
rows = [w["row"] for w in json.loads((ROOT / "web" / "src" / "data" / "weapons.json").read_text(encoding="utf-8"))]
out = {r: ids[r] for r in rows if r in ids}
missing = [r for r in rows if r not in ids]
(ROOT / "web" / "src" / "data" / "weapon-ids.json").write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"{len(out)} weapons" + (f", no id for {missing}" if missing else ""))
