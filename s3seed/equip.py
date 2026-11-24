"""What the player is wearing right now (head, clothes, shoes, and the weapon), read out of the save the game keeps in RAM.

Like stock.py: the save is MessagePack, and its fields sit under 32-bit hashes (ce hh hh hh hh, then the value). The worn
gear and weapon ids sit in one record, each under a fixed hash (found on Splatoon 3 v12.0.0, 2026-11-21):

    ce e297f85f d1 1388 | ce ddcbe978 d1 0bd5 | ce 4b347ee2 00 | ce 5e46a8c1 d1 1b69 | ce 69e24289 01 | ce 425935d4 d1 61b4
    (weapon 5000)         (head 3029)                            (clothes 7017)                          (shoes 25012)

The record moves whenever the save is rewritten. state/equip_offsets.json remembers where ("at": the address of each field's
hash, "rel": relative to the gear head); worn() is one small read there, checked against the hashes and the game's tables,
and says None when they are gone. find() then looks for the hashes near the chunk tables and the gear head (near first, wider
only on a miss, a slice at a time, cancelable). Another structure holds gear ids too (a fixarray of 3 maps keyed c3aaee2e):
it is not the worn gear and has none of these hashes.
"""
import json
import time
from pathlib import Path

from . import gear as G
from .botbase import SLICE, Botbase, BotbaseError
from .seedmath import DATA
from .stock import Bad, _int, load_offsets, save_offsets

SLOTS = G.TYPES                 # head, clothes, shoes
HASHES = {"weapon": 0xE297F85F, "head": 0xDDCBE978, "clothes": 0x5E46A8C1, "shoes": 0x425935D4}
TAGS = {k: bytes([0xCE]) + h.to_bytes(4, "big") for k, h in HASHES.items()}
SPAN = 0x80                     # the fields sit this close together (one record, about 40 bytes)
BLOCK = 0x8000
PAD = 0x400                     # a block is read this much past its end, so a record never falls between two blocks
REACHES = (256 << 10, 2 << 20)  # find() looks this far either side of each centre, the near ring first, the wider one only on a miss
BUDGET = 60.0                   # seconds a find may take in all


class Stopped(Exception):
    """A search was cancelled, or ran out of time (args[0]: "cancelled" or "time")."""


class Aborted(Exception):
    """The connection went away under a search."""


_rows: dict[int, str] = {}


def weapon_row(wid) -> str:
    """The weapon's row id (Spewer_Normal_00 style) for a game weapon id, "" when unknown."""
    if not _rows:
        for w in json.loads((DATA / "WeaponInfoMain.json").read_text(encoding="utf-8")):
            _rows.setdefault(w["Id"], w["__RowId"])
    return _rows.get(wid, "")


def _valid(slot: str, v) -> bool:
    if not isinstance(v, int):
        return False
    return (slot, v) in G.GEAR_INFO if slot in SLOTS else bool(weapon_row(v))


def _value(data: bytes, i: int):
    try:
        return _int(data, i)[0]
    except (Bad, IndexError):
        return None


def find_fields(data: bytes, base: int) -> list[dict[str, int]]:
    """The records in data (read at address base): [{slot: address of the field's hash}] where head, clothes and shoes sit
    close together, each holding a gear id of its slot; the weapon is in it when its field is."""
    hits: dict[str, list[int]] = {}
    for k, tag in TAGS.items():
        hits[k] = []
        at = data.find(tag)
        while at >= 0:
            if _valid(k, _value(data, at + 5)):
                hits[k].append(base + at)
            at = data.find(tag, at + 1)
    out = []
    for h in hits["head"]:
        for c in (x for x in hits["clothes"] if abs(x - h) <= SPAN):
            for s in (x for x in hits["shoes"] if abs(x - h) <= SPAN and abs(x - c) <= SPAN):
                rec = {"head": h, "clothes": c, "shoes": s}
                w = [x for x in hits["weapon"] if abs(x - h) <= SPAN]
                if w:
                    rec["weapon"] = min(w, key=lambda x: abs(x - h))
                out.append(rec)
    return out


def _read(peek, addr: int, size: int, cancel, deadline, progress) -> bytes:
    """size bytes at addr, one SLICE at a time so the caller's lock is free between slices; cancel and the deadline are
    checked before every slice."""
    out = []
    for o in range(0, size, SLICE):
        if cancel and cancel():
            raise Stopped("cancelled")
        if deadline is not None and time.monotonic() >= deadline:
            raise Stopped("time")
        n = min(SLICE, size - o)
        out.append(peek(addr + o, n))
        if progress:
            progress(n)
    return b"".join(out)


def scan(peek, center: int, reach: int, look, seen: dict, cancel=None, start: int = 0, deadline=None, progress=None):
    """Read outward from center (from `start` up to `reach` either side) with look(data, base); what it finds goes into
    `seen`. Raises Stopped."""
    for k in range(start // BLOCK, reach // BLOCK + 1):
        for addr in ((center,) if k == 0 else (center + k * BLOCK, center - k * BLOCK)):
            if addr < 0:
                continue
            try:
                data = _read(peek, addr - BLOCK // 2, BLOCK + PAD, cancel, deadline, progress)
            except BotbaseError:
                continue
            for g in look(data, addr - BLOCK // 2):
                seen[tuple(sorted(g.items()))] = g


def read_ids(bot: Botbase, at: dict[str, int]) -> dict[str, int] | None:
    """The ids at their addresses, when each field still has its hash and a valid id; else None (the weapon is optional)."""
    if not all(t in at for t in SLOTS):
        return None
    lo, hi = min(at.values()), max(at.values()) + 16
    try:
        data = bot.peek(lo, hi - lo) if hi - lo <= 0x4000 else None       # close together (they are): one read
        out = {}
        for t, a in at.items():
            chunk = data[a - lo:a - lo + 16] if data is not None else bot.peek(a, 16)
            v = _value(chunk, 5) if t in TAGS and chunk[:5] == TAGS[t] else None
            if not _valid(t, v):
                if t == "weapon":
                    continue
                return None
            out[t] = v
        return out
    except BotbaseError:
        return None


def pick(cands: list[dict], bot: Botbase) -> dict | None:
    """The one record to use out of several: they all say the same (an old copy of the save left behind), or None."""
    reads = [read_ids(bot, c) for c in cands]
    return cands[0] if reads and all(r is not None and r == reads[0] for r in reads) else None


def find(bot: Botbase, path: Path, gear_head: int, centers: list[int] | None = None, cancel=None,
         budget: float = BUDGET, peek=None, progress=None, reaches=REACHES) -> dict:
    """Look for the worn-gear record by its field hashes. {"state": "found"|"ambiguous"|"none"|"cancelled", "candidates": n, ...}.
    Looks near the chunk tables, where it was and the gear head first and only widens on a miss, in SLICE reads through `peek`
    (so a caller's lock is free between them), until cancel() or the budget (seconds) stops it. Remembers where it was."""
    peek = peek or bot.peek
    if centers is None:
        stock, old = load_offsets(path.with_name("stock_offsets.json")), load_offsets(path)
        centers = [*(old.get("at") or {}).values(), stock.get("near"), *(stock.get("at") or {}).values(), gear_head]
    kept: list[int] = []
    for c in (c for c in centers if isinstance(c, int) and c > 0):   # one ring covers centres close to each other (the old address's three fields, the two stock tables)
        if all(abs(c - k) > BLOCK for k in kept):
            kept.append(c)
    centers = kept
    deadline = time.monotonic() + budget
    seen: dict = {}
    try:
        with bot.gentle():
            for i, reach in enumerate(reaches):
                for c in centers:
                    scan(peek, c, reach, find_fields, seen, cancel, start=reaches[i - 1] if i else 0,
                         deadline=deadline, progress=progress)
                    if seen:                              # found around this centre (its whole ring read, so copies near it count too)
                        break
                if seen:
                    break
    except Stopped as e:
        if e.args[0] == "cancelled" or not seen:          # out of time with something found: use it
            return {"state": "cancelled" if e.args[0] == "cancelled" else "none", "candidates": 0, "timedOut": e.args[0] == "time"}
    cands = list(seen.values())
    if not cands:
        return {"state": "none", "candidates": 0}
    at = pick(cands, bot) if len(cands) > 1 else cands[0]
    if at is None:
        return {"state": "ambiguous", "candidates": len(cands), "at": cands}
    save_offsets(path, at=at, rel={t: a - gear_head for t, a in at.items()})
    return {"state": "found", "candidates": len(cands), "at": at}


def worn(bot: Botbase, path: Path, gear_head: int) -> dict[str, int] | None:
    """{"head": id, "clothes": id, "shoes": id, "weapon": id} as worn now, in one small read where the record was last seen;
    None when it isn't there any more (never found, or the save moved: find() again)."""
    known = load_offsets(path)
    ints = lambda d: {t: v for t, v in (d or {}).items() if isinstance(v, int)}
    at, rel = ints(known.get("at")), ints(known.get("rel"))
    got = read_ids(bot, at)
    if got is None and rel:
        moved = {t: gear_head + r for t, r in rel.items()}
        got = read_ids(bot, moved)
        if got is not None:
            save_offsets(path, at=moved)
    return got


def outfit(ids: dict[str, int], pieces: list[dict]) -> dict:
    """{slot: {gearId, row, main, subs}, weapon: {id, row}} for the worn ids from a snapshot's pieces; KeyError(slot) for a
    piece it doesn't hold."""
    by = {(p["slot"], p["gearId"]): p for p in pieces}
    out = {"weapon": {"id": ids["weapon"], "row": weapon_row(ids["weapon"])}} if ids.get("weapon") is not None else {}
    for t in SLOTS:
        p = by.get((t, ids[t]))
        if p is None:
            raise KeyError(t)
        out[t] = {"gearId": p["gearId"], "row": p["row"], "main": p["main"], "subs": list(p["subs"])}
    return out
