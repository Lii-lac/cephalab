"""Writes web/src/local/gear-table.json: gear id -> [row id, brand] per slot, from data/GearInfo*.json (what the in-browser
s3s import needs). Run it again after data/ changes: .venv/Scripts/python.exe tools/gen_gear_table.py"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = {"head": "GearInfoHead", "clothes": "GearInfoClothes", "shoes": "GearInfoShoes"}
out = {slot: {str(g["Id"]): [g["__RowId"], g["Brand"]] for g in json.loads((ROOT / "data" / f"{f}.json").read_text(encoding="utf-8"))}
       for slot, f in FILES.items()}
dest = ROOT / "web" / "src" / "local" / "gear-table.json"
dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
print(dest, dest.stat().st_size, "bytes")
