"""Game images (Splatoon 3's own, as extracted by Leanny), fetched once from his CDN into cache/img/ and served
locally, so the app works offline after the first look."""
import re
import threading
import urllib.request
from pathlib import Path

SRC = "https://leanny.github.io/splat3/images"
KINDS = {"skill", "gear", "weapon_flat", "weapon", "brand", "subspe", "weapon_type", "badge", "npl"}
# kind -> (source folder, file type) for images that don't come from Leanny's PNGs: sendou's ranked mode icons
OTHER = {"modes": ("https://sendou-assets.nyc3.cdn.digitaloceanspaces.com/img/modes", "avif")}
MAGIC = {"png": (b"\x89PNG",), "avif": (b"ftypavif", b"ftypavis")}


def ext(kind: str) -> str:
    return OTHER[kind][1] if kind in OTHER else "png"


_lock = threading.Lock()


def image(cache: Path, kind: str, name: str, fetch: bool = True) -> bytes | None:
    if (kind not in KINDS and kind not in OTHER) or not re.fullmatch(r"[A-Za-z0-9_]{1,80}", name or ""):
        return None
    e = ext(kind)
    path = cache / kind / f"{name}.{e}"
    if path.exists():
        return path.read_bytes()
    if not fetch:
        return None
    with _lock:
        if path.exists():
            return path.read_bytes()
        try:
            url = f"{OTHER[kind][0]}/{name}.{e}" if kind in OTHER else f"{SRC}/{kind}/{name}.png"
            req = urllib.request.Request(url, headers={"User-Agent": "Cephalab"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = r.read()
        except OSError:
            return None
        if not any(m in data[:16] for m in MAGIC[e]):    # an error page isn't an image: don't cache it
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        return data
