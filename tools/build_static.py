"""Second half of `npm run build:static`: puts the game images the app can ask for into web/dist-static/img/.

Each image comes from cache/img (the dev server's and the companion's cache); a missing one is fetched once from Leanny's CDN
(sendou's CDN for the mode icons), the way companion/images.py does, then copied. Needs web/dist-static from `vite build --mode static`.
  .venv/Scripts/python.exe tools/build_static.py
"""
import json
import re
import shutil
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC, CACHE, OUT = ROOT / "web" / "src", ROOT / "cache" / "img", ROOT / "web" / "dist-static"
LEANNY = "https://leanny.github.io/splat3/images"
SENDOU_MODES = "https://sendou-assets.nyc3.cdn.digitaloceanspaces.com/img/modes"
MAGIC = {"png": b"\x89PNG", "avif": b"ftypavi"}
CLASS_ICONS = ["%02d" % n for n in range(11)]            # weapons.ts CLASSICON
# weapons.ts STICKERS (the charms on build cards)
STICKERS = ([f"Grf_Sti_Graffiti_{n:02d}" for n in (0, 1, 2, 3, 4, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39)]
            + [f"Grf_Sti_Decoration_{n}" for n in (14, 15, 16, 17, 21, 25, 26, 27)]
            + [f"Stc_Sti_Character_{n:02d}" for n in (0, 1, 2, 3, 6, 7, 9, 10)]
            + [f"Stc_Sti_Decoration_{n:02d}" for n in (3, 10)] + ["Stc_Sti_Logo_10"])


def needed() -> list[tuple[str, str]]:
    """(kind, name) for every image the app can ask for, read from web/src (data.ts lists, weapons.json)."""
    data = (SRC / "data.ts").read_text(encoding="utf-8")
    names = re.search(r"export const NAMES = \{(.*?)\};", data, re.S).group(1)
    skills = re.findall(r"(\w+):\"", names)
    gear = re.findall(r'\["((?:Hed|Clt|Shs)_\w+)","', data)
    weapons = json.loads((SRC / "data" / "weapons.json").read_text(encoding="utf-8"))
    out = [("skill", s) for s in skills + ["Unknown"]] + [("gear", g) for g in dict.fromkeys(gear)]
    out += [("weapon_flat", f"Path_Wst_{w['row']}") for w in weapons]
    out += [("subspe", f"Wsb_{s}00") for s in dict.fromkeys(w["sub"] for w in weapons)]
    out += [("subspe", f"Wsp_{s}00") for s in dict.fromkeys(w["sp"] for w in weapons)]
    out += [("weapon_type", f"IconTypeWpn_{c}") for c in CLASS_ICONS]
    out += [("zakka", s) for s in STICKERS] + [("modes", m) for m in ("TW", "SZ", "TC", "RM", "CB")]
    return list(dict.fromkeys(out))


def file_of(kind: str, name: str) -> str:
    return f"{kind}/{name}.{'avif' if kind == 'modes' else 'png'}"


def fetch(rel: str) -> bool:
    kind, fname = rel.split("/", 1)
    ext = fname.rsplit(".", 1)[1]
    url = f"{SENDOU_MODES}/{fname}" if kind == "modes" else f"{LEANNY}/{rel}"
    for attempt in range(4):                              # the CDN answers a burst with 503 and the odd false 404
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Cephalab"}), timeout=15) as r:
                data = r.read()
            if MAGIC[ext] in data[:16]:
                dest = CACHE / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_suffix(".tmp")
                tmp.write_bytes(data)
                tmp.replace(dest)
                return True
        except OSError:
            pass
        time.sleep(0.5 * 2 ** attempt)
    return False


def main() -> int:
    if not (OUT / "index.html").exists():
        print("web/dist-static is missing: run npm run build:static in web/", file=sys.stderr)
        return 1
    files = [file_of(k, n) for k, n in needed()]
    missing = [f for f in files if not (CACHE / f).exists()]
    if missing:
        print(f"fetching {len(missing)} missing images")
        with ThreadPoolExecutor(4) as pool:
            got = list(pool.map(fetch, missing))
        lost = [f for f, ok in zip(missing, got) if not ok]
        for f in lost:
            print("not found:", f, file=sys.stderr)
        files = [f for f in files if f not in lost]
    shutil.rmtree(OUT / "img", ignore_errors=True)
    for f in files:
        (OUT / "img" / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(CACHE / f, OUT / "img" / f)
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"{len(files)} images copied; web/dist-static is {size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
