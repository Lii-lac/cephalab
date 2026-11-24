r"""Find Splatoon 3's gear tables after a game update and remember them (the companion also does this by itself).

    .venv\Scripts\python.exe tools\find_gear.py [--switch IP] [--port 6000]

Read only. Saves the address for the running game version to state/gear_offsets.json.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from s3seed import gear as G                                   # noqa: E402
from s3seed import gear_find as GF                             # noqa: E402
from s3seed.botbase import Botbase, BotbaseError               # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--switch")
    ap.add_argument("--port", type=int)
    ap.add_argument("--window", type=int, default=64, help="MB to look through each side (default 64)")
    ap.add_argument("--out", default=str(ROOT / "state" / "gear_offsets.json"))
    a = ap.parse_args(argv)
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
        print(f"Splatoon 3 v{version or '?'}: looking for the gear tables around 0x{G.GEAR_LIST_HEAD:X}")
        head = GF.find_head(bot, window=a.window << 20)
        if head is None:
            print("Not found. Open the game past the title screen (a lobby), then try again.")
            return 1
        G.use_head(head)
        n = len(G.read_all(bot, 0))
        GF.save_learned(Path(a.out), version, head)
        print(f"{n} pieces read. Saved v{version} -> 0x{head:X} to {a.out}")
        return 0
    except BotbaseError as e:
        print(f"Switch: {e}")
        return 1
    finally:
        bot.close()


if __name__ == "__main__":
    sys.exit(main())
