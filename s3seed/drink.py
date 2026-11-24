"""The drink the player has active (and battles left on it), read out of the save the game keeps in RAM.

Like equip.py: MessagePack fields under 32-bit hashes, in the same save copy as the worn-gear record (found on Splatoon 3
v12.0.0, 2026-11-22, ~0x690 bytes before the record's head field):

    ce 8871b197 11 | ce fbc8a6f8 04
    (battles left 17) (the drink: an index into seedmath.ABILITY_ORDER, 4 = SquidMove_Up, 8 = RespawnTime_Save)

The save moves when it is rewritten. state/drink_offsets.json remembers where ("at": the drink field's hash, "rel": relative
to the worn record's head field); read() is one small read there, checked against the hash. find() looks around the worn
record. What the field holds with no drink active has never been seen: battles 0, a missing battles field or an index
outside 0..13 all mean no drink, and the raw bytes are kept once in state/drink_none.json so we learn it.
"""
import time
from pathlib import Path

from .botbase import Botbase, BotbaseError
from .equip import Stopped, _read
from .seedmath import ABILITY_ORDER
from .stock import Bad, _int, load_offsets, save_offsets

DRINK = bytes.fromhex("cefbc8a6f8")
BATTLES = bytes.fromhex("ce8871b197")
BACK = 16                        # the battles field sits this close before the drink field (6 bytes on v12)
READ = 32                        # one poll's read: BACK bytes before the drink field's hash, the rest after it
# find(): around the worn record's head field, the near one first. The drink lives in another save copy than the record
# equip.worn() follows: on 2026-11-22 it sat 0x1612F after that head field, so the last window is wide (one find per DRINK_RETRY).
WINDOWS = ((-0x1000, 0x200), (-0x4000, 0x4400), (-0x8000, 0x20000))


def decode(data: bytes, i: int) -> dict | None:
    """The drink field at data[i] (its hash): {"ability": name or None, "battles": n or None, "raw": hex}; None when the
    hash isn't there. ability None = no drink active."""
    if data[i:i + 5] != DRINK:
        return None
    try:
        v = _int(data, i + 5)[0]
    except (Bad, IndexError):
        v = None
    b = data.rfind(BATTLES, max(0, i - BACK), i)
    try:
        n = _int(data, b + 5)[0] if b >= 0 else None
    except (Bad, IndexError):
        n = None
    ok = isinstance(v, int) and 0 <= v < len(ABILITY_ORDER) and isinstance(n, int) and n > 0
    return {"ability": ABILITY_ORDER[v] if ok else None, "battles": n if ok else 0,
            "raw": data[max(0, i - BACK):i + 12].hex()}


def _at(bot: Botbase, addr: int) -> dict | None:
    try:
        data = bot.peek(addr - BACK, READ)
    except BotbaseError:
        return None
    return decode(data, BACK)


def _none_once(path: Path, addr: int, got: dict):
    """Keep the first no-drink reading's bytes (never seen yet: what the game writes there with no drink)."""
    p = path.with_name("drink_none.json")
    if not p.exists():
        save_offsets(p, at=time.time(), addr=hex(addr), bytes=got["raw"])


def _out(path: Path, addr: int, got: dict) -> dict:
    if got["ability"] is None:
        _none_once(path, addr, got)
        return {"ability": None, "battles": 0}
    return {"ability": got["ability"], "battles": got["battles"]}


def read(bot: Botbase, path: Path) -> dict | None:
    """{"ability": name or None, "battles": n} in one small read where the field was last seen; None when it isn't there
    (never found, or the save moved: relocate() / find())."""
    at = load_offsets(path).get("at")
    if not isinstance(at, int):
        return None
    got = _at(bot, at)
    return _out(path, at, got) if got else None


def relocate(bot: Botbase, path: Path, worn_head: int) -> dict | None:
    """The field at the worn record's head + the remembered distance (one small read; the save moved as a whole)."""
    rel = load_offsets(path).get("rel")
    if not isinstance(rel, int):
        return None
    got = _at(bot, worn_head + rel)
    if not got:
        return None
    save_offsets(path, at=worn_head + rel)
    return _out(path, worn_head + rel, got)


def find(bot: Botbase, path: Path, worn_head: int, cancel=None, peek=None) -> dict | None:
    """Look for the drink field around the worn record's head field (the near window first, a wider one on a miss), in
    SLICE reads; the hit nearest the record wins. Remembers where. None when not found or cancelled."""
    peek = peek or bot.peek
    for lo, hi in WINDOWS:
        try:
            data = _read(peek, worn_head + lo, hi - lo, cancel, None, None)
        except (Stopped, BotbaseError):
            return None
        hits = []
        i = data.find(DRINK)
        while i >= 0:
            got = decode(data, i)
            if got and data.rfind(BATTLES, max(0, i - BACK), i) >= 0:
                hits.append((abs(lo + i), lo + i, got))
            i = data.find(DRINK, i + 1)
        if hits:
            _, off, got = min(hits, key=lambda h: h[0])
            save_offsets(path, at=worn_head + off, rel=off)
            return _out(path, worn_head + off, got)
    return None


def worn_head(equip_path: Path) -> int | None:
    """Where the worn record's head field was last seen (equip.worn() keeps it current)."""
    at = load_offsets(equip_path).get("at") or {}
    h = at.get("head") if isinstance(at, dict) else None
    return h if isinstance(h, int) else None
