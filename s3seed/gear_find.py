"""Find the gear tables in RAM after a game update moves them (Splat3GearView's offsets lag behind new versions).

The tables keep their shape between versions (0xB0-byte records, head -> clothes -> shoes GEAR_LIST_STRIDE apart);
only where the heap puts them moves, by a few MB at most so far (10.x -> 11.3). So: read outward from the last known
address, find a run of records that parse as real headgear, check that clothes and shoes sit where they should, and
remember the address for that game version in state/gear_offsets.json. Read only; nothing is written to the Switch.
"""
import json
import re
import time
from pathlib import Path

from . import gear as G
from .botbase import Botbase, BotbaseError

BLOCK = 0x8000
RUN = 6                         # this many headgear records in a row, all real, before it counts
# a cheap first pass in C: rarity <= 5 at +0x50, main ability < 27 at +0x54, count <= 3 at +0x68, subs <= 14
SHAPE = re.compile(rb"(?s)(?=[^\x00].{79}[\x00-\x05].{3}[\x00-\x1a].{19}[\x00-\x03].{3}[\x00-\x0e].{3}[\x00-\x0e].{3}[\x00-\x0e])")


def load_learned(path: Path) -> dict:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_learned(path: Path, version: str, head: int):
    d = load_learned(path)
    d[version] = head
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(path)


def _run_at(data: bytes, off: int) -> bool:
    for i in range(RUN):
        rec = data[off + i * G.RECORD: off + (i + 1) * G.RECORD]
        if len(rec) < G.RECORD or G.parse_record("head", rec) is None:
            return False
    return True


def _confirm(bot: Botbase, head: int) -> bool:
    """Clothes and shoes start with real records too, at the strides the tables have always had."""
    for t in ("clothes", "shoes"):
        base = head + G.TYPES.index(t) * G.GEAR_LIST_STRIDE + G.FIRST_RECORD
        if G.parse_record(t, bot.peek(base, G.RECORD)) is None:
            return False
    return True


def find_head(bot: Botbase, center: int = G.GEAR_LIST_HEAD, window: int = 64 << 20, log=print, budget: float = 1800) -> int | None:
    """The gear list head (what GEAR_LIST_HEAD is for this version, DLC shift included), or None. Reads gently
    (spaced out, see Botbase.gentle), so the game keeps its frame rate while it looks."""
    with bot.gentle():
        return _find_head(bot, center, window, log, budget)


def _find_head(bot: Botbase, center: int, window: int, log, budget: float) -> int | None:
    pad = G.RECORD * RUN
    t0, done = time.time(), 0
    for k in range(0, window // BLOCK + 1):
        for addr in ((center + k * BLOCK,) if k == 0 else (center + k * BLOCK, center - k * BLOCK)):
            if addr < 0:
                continue
            try:
                data = bot.peek(addr, BLOCK + pad)
            except BotbaseError:
                continue
            for m in SHAPE.finditer(data, 0, BLOCK):
                off = m.start()
                if _run_at(data, off):
                    # the first record of the list: walk back while the record before is real headgear too
                    first = addr + off
                    while True:
                        prev = bot.peek(first - G.RECORD, G.RECORD)
                        if G.parse_record("head", prev) is None:
                            break
                        first -= G.RECORD
                    head = first - G.FIRST_RECORD
                    if _confirm(bot, head):
                        log(f"  found the gear at 0x{head:X} ({head - center:+#x} from where it was), {time.time() - t0:.0f} s")
                        return head
            done += BLOCK
            if done % (8 << 20) == 0:
                log(f"  looked through {done >> 20} MB ({time.time() - t0:.0f} s)")
            if time.time() - t0 > budget:
                log("  gave up: past the time budget")
                return None
    return None
