"""Ability chunk and drink ticket counts, read out of the save the game keeps in RAM.

The save sits in memory as MessagePack. Each table is a map under a fixed 32-bit field hash, keyed by ability index
(0..13 = seedmath.ABILITY_ORDER), for example the drink tickets:

    ce 5c b5 b8 75   8e   00 0b  01 0b  02 0b  03 09 ...      (hash, a 14-entry map, index -> count)

Counts of 128 and more take more bytes (d1 00 84 = 132), so the tables are found by their hash and decoded, never
read at a fixed stride. Found on Splatoon 3 v12.0.0 (2026-11-20): chunks c5943b25, drinks 5cb5b875, about 7 MB
below the gear tables. state/stock_offsets.json remembers where each table was ("at", and "rel" to the gear head) so a poll is one small
read; a search (window, then wide) only runs when they moved, and reads gently (Botbase.gentle) so the game keeps
its frame rate. tools/find_stock.py learns new hashes from counts read off the game's menus if an update renames them.
"""
import json
import time
from pathlib import Path

from .botbase import Botbase, BotbaseError
from .seedmath import ABILITY_ORDER

KINDS = ("chunks", "drinks")
HASHES = {"chunks": 0xC5943B25, "drinks": 0x5CB5B875}
NEAR_GEAR = -0x6CDD67           # where they sat relative to the gear head on v12
WINDOW = 0x10000                # a poll reads this much either side of where they were last seen
BLOCK = 0x8000
TABLE = 0x100                  # a table is never longer than this (15 entries, 4 bytes at most each)
WIDE_EVERY = 600               # seconds between wide scans while a table stays missing (one takes ~a minute)
_wide_at: dict[str, float] = {}


class Bad(ValueError):
    pass


def load_offsets(path: Path) -> dict:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_offsets(path: Path, **fields):
    d = {**load_offsets(path), **fields}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(path)


def _int(b: bytes, i: int) -> tuple[int, int]:
    """One MessagePack integer at b[i]: (value, index after it)."""
    t = b[i]
    if t <= 0x7F:
        return t, i + 1
    if t >= 0xE0:
        return t - 0x100, i + 1
    size, signed = {0xCC: (1, False), 0xCD: (2, False), 0xCE: (4, False), 0xCF: (8, False),
                    0xD0: (1, True), 0xD1: (2, True), 0xD2: (4, True), 0xD3: (8, True)}.get(t, (0, False))
    if not size or i + 1 + size > len(b):
        raise Bad("not an integer")
    return int.from_bytes(b[i + 1:i + 1 + size], "big", signed=signed), i + 1 + size


def decode_table(b: bytes, i: int) -> dict[str, int]:
    """The map right after a field hash: {ability: count} for keys 0..13 (other keys, like -1, are skipped)."""
    t = b[i]
    if 0x80 <= t <= 0x8F:
        n, i = t & 0x0F, i + 1
    elif t == 0xDE:
        n, i = int.from_bytes(b[i + 1:i + 3], "big"), i + 3
    else:
        raise Bad("not a map")
    if not 14 <= n <= 32:
        raise Bad("not an ability table")
    out = {}
    for _ in range(n):
        k, i = _int(b, i)
        v, i = _int(b, i)
        if 0 <= k < len(ABILITY_ORDER):
            if not 0 <= v <= 9999:
                raise Bad("count out of range")
            out[ABILITY_ORDER[k]] = v
    if len(out) != len(ABILITY_ORDER):
        raise Bad("missing abilities")
    return out


def find_tables(data: bytes, base: int, hashes: dict = HASHES) -> dict:
    """{kind: (address of the hash, counts)} for every table found in data (read at address base)."""
    found = {}
    for kind, h in hashes.items():
        tag = b"\xce" + int(h).to_bytes(4, "big")
        at = data.find(tag)
        while at >= 0:
            try:
                found[kind] = (base + at, decode_table(data, at + 5))
                break
            except (Bad, IndexError):
                at = data.find(tag, at + 1)
    return found


def scan(bot: Botbase, center: int, reach: int, hashes: dict = HASHES, want=KINDS, cancel=None) -> dict:
    """Read outward from center (up to reach either side) until every wanted table is found, or cancel() is true."""
    pad = 0x200                                            # a table never spans more than this
    found: dict = {}
    for k in range(0, reach // BLOCK + 1):
        for addr in ((center,) if k == 0 else (center + k * BLOCK, center - k * BLOCK)):
            if addr < 0:
                continue
            if cancel and cancel():
                return found
            try:
                data = bot.peek(addr - (BLOCK // 2), BLOCK + pad)
            except BotbaseError:
                continue
            for kind, hit in find_tables(data, addr - BLOCK // 2, {k2: hashes[k2] for k2 in want if k2 not in found}).items():
                found[kind] = hit
            if all(w in found for w in want):
                return found
    return found


def read_at(bot: Botbase, at: dict, hashes: dict) -> dict:
    """The tables at their remembered addresses, in one small read when they sit close together (they do)."""
    at = {k: a for k, a in at.items() if k in hashes and a >= 0}
    if not at:
        return {}
    lo, hi = min(at.values()), max(at.values()) + TABLE
    spans = [(lo, hi)] if hi - lo <= 0x4000 else [(a, a + TABLE) for a in at.values()]
    found = {}
    for s, e in spans:
        try:
            data = bot.peek(s, e - s)
        except BotbaseError:
            continue
        for kind, a in at.items():
            if s <= a < e and data[a - s:a - s + 5] == b"\xce" + int(hashes[kind]).to_bytes(4, "big"):
                try:
                    found[kind] = (a, decode_table(data, a - s + 5))
                except (Bad, IndexError):
                    pass
    return found


def read_stock(bot: Botbase, path: Path, gear_head: int, search: bool = True, cancel=None) -> dict | None:
    """{"chunks": {ability: n}, "drinks": {...}} for the tables found, or None. Remembers where they were.
    search=False only reads where they were (one small read), never looks for them."""
    known = load_offsets(path)
    hashes = {**HASHES, **{k: int(v) for k, v in (known.get("hashes") or {}).items()}}
    at = {k: v for k, v in (known.get("at") or {}).items() if isinstance(v, int)}
    rel = {k: v for k, v in (known.get("rel") or {}).items() if isinstance(v, int)}
    found = read_at(bot, at, hashes)
    missing = lambda: [k for k in KINDS if k not in found]
    if missing() and rel:                                     # a restart moved the save along with the gear
        found = {**read_at(bot, {k: gear_head + rel[k] for k in missing() if k in rel}, hashes), **found}
    near = known.get("near") if isinstance(known.get("near"), int) else (min(at.values()) if at else None)
    centers = (gear_head + min(rel.values()) if rel else None, near) if search else ()
    for center in dict.fromkeys(c for c in centers if c is not None):
        if missing():                                          # close by: where they sit relative to the gear, then where they were
            with bot.gentle():
                found = {**scan(bot, center, WINDOW, hashes, missing(), cancel), **found}
    now = time.monotonic()
    if search and missing() and now - _wide_at.get(str(path), -WIDE_EVERY) >= WIDE_EVERY:
        _wide_at[str(path)] = now                             # first time, or the save moved: look wider, not every poll
        with bot.gentle():
            found = {**scan(bot, gear_head + NEAR_GEAR, 24 << 20, hashes, missing(), cancel), **found}
    if not found:
        return None
    new_at = {k: a for k, (a, _) in found.items()}
    if any(at.get(k) != a for k, a in new_at.items()):
        save_offsets(path, near=min(new_at.values()), at={**at, **new_at},
                     rel={**rel, **{k: a - gear_head for k, a in new_at.items()}})
    return {kind: counts for kind, (_, counts) in found.items()}
