r"""Show the chunk and drink ticket counts the tracker reads from the Switch, or teach it where they are.

    .venv\Scripts\python.exe tools\find_stock.py                                   what it reads now
    .venv\Scripts\python.exe tools\find_stock.py chunks 132 111 130 115 ...         (14 counts, the game's order)

With counts, it looks for that table in the save in memory and remembers its field hash, for when a game update
renames it (the companion then finds it by itself). Read only. Run it with Splatoon 3 past the title screen.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from s3seed import gear as G                                   # noqa: E402
from s3seed import gear_find as GF                             # noqa: E402
from s3seed import stock as S                                  # noqa: E402
from s3seed.botbase import GENTLE_REST, Botbase, BotbaseError  # noqa: E402
from s3seed.seedmath import ABILITY_ORDER                      # noqa: E402


def enc(v: int) -> list[bytes]:
    """The ways MessagePack may write a count."""
    out = [bytes([v])] if v < 128 else []
    if v < 256:
        out.append(b"\xcc" + bytes([v]))
    out += [b"\xcd" + v.to_bytes(2, "big"), b"\xd1" + v.to_bytes(2, "big")]
    return out


def table_pattern(counts: list[int]) -> re.Pattern:
    body = b"".join(re.escape(bytes([i])) + b"(?:" + b"|".join(re.escape(e) for e in enc(v)) + b")" for i, v in enumerate(counts))
    return re.compile(rb"(?s)\xce(.{4})[\x8e\x8f]" + body)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("kind", nargs="?", choices=S.KINDS)
    ap.add_argument("counts", type=int, nargs="*")
    ap.add_argument("--switch")
    ap.add_argument("--port", type=int)
    ap.add_argument("--offsets", default=str(ROOT / "state" / "stock_offsets.json"))
    a = ap.parse_args(argv)
    if a.kind and len(a.counts) != len(ABILITY_ORDER):
        print(f"Give all {len(ABILITY_ORDER)} counts, in the game's order.")
        return 2
    try:
        sw = json.loads((ROOT / "state" / "settings.json").read_text(encoding="utf-8")).get("switch", {})
    except (OSError, ValueError):
        sw = {}
    host, port = a.switch or sw.get("host"), a.port or sw.get("port") or 6000
    if not host:
        print("No Switch address: pass --switch <IP> or set it in the app's Settings.")
        return 2
    bot = Botbase(host, port)
    try:
        bot.connect()
        if bot.title_id().upper() != "0100C2500FC20000":
            print("Splatoon 3 isn't running.")
            return 1
        version = bot.game_version()
        learned = GF.load_learned(ROOT / "state" / "gear_offsets.json")
        head = {**G.HEADS, **learned}.get(version, G.GEAR_LIST_HEAD)
        path = Path(a.offsets)
        if not a.kind:
            stock = S.read_stock(bot, path, head)
            if not stock:
                print("No chunk or ticket table found. Run with counts to teach it: find_stock.py chunks <14 counts>")
                return 1
            for kind, counts in stock.items():
                print(kind + ": " + " ".join(str(counts[x]) for x in ABILITY_ORDER))
            return 0
        pat = table_pattern(a.counts)
        center, reach = head + S.NEAR_GEAR, 64 << 20
        bot.rest = max(bot.rest, GENTLE_REST)                   # spaced-out reads: the game keeps its frame rate
        for k in range(0, reach // S.BLOCK + 1):
            for addr in ((center,) if k == 0 else (center + k * S.BLOCK, center - k * S.BLOCK)):
                try:
                    data = bot.peek(addr, S.BLOCK + 0x200)
                except BotbaseError:
                    continue
                m = pat.search(data)
                if m:
                    h = int.from_bytes(m.group(1), "big")
                    known = S.load_offsets(path)
                    S.save_offsets(path, near=addr + m.start(), hashes={**(known.get("hashes") or {}), a.kind: h})
                    print(f"Found {a.kind} at 0x{addr + m.start():X} under field hash {h:08x}; saved to {path}.")
                    return 0
        print("Not found. Check the counts against the game's menu (same order), or play a battle and try again.")
        return 1
    except BotbaseError as e:
        print(f"Switch: {e}")
        return 1
    finally:
        bot.close()


if __name__ == "__main__":
    sys.exit(main())
