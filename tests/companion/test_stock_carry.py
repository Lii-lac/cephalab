import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from companion.hub import Hub


class StockCarry(unittest.TestCase):
    """When the save moves the chunk and ticket tables (2026-11-21, after a scrub), the snapshots keep the last counts while
    the companion looks for them: one went out without them and the Path planned a moment with no chunks at all."""

    def test_moved_stock_keeps_counts(self):
        from companion import botbase_source as BS
        from companion.botbase_source import BotbaseSource
        self.addCleanup(setattr, BS, "SETTLE_S", BS.SETTLE_S)
        BS.SETTLE_S = 0
        fp = 6330 + int(time.time()) % 40
        fake = subprocess.Popen([sys.executable, "tests/fake_botbase.py", "--port", str(fp), "--stock"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1.0)
            with tempfile.TemporaryDirectory() as d:
                hub = Hub(Path(d))
                bot = BotbaseSource(hub, "127.0.0.1", fp)
                bot._connect()
                bot.poll_once()
                bot.poll_once()                                   # searches wait for SETTLE_POLLS good polls
                stock = hub.snapshots["botbase"]["stock"]
                offs = Path(d) / "stock_offsets.json"
                known = json.loads(offs.read_text(encoding="utf-8"))
                moved = {k: v + 0x40 for k, v in known["at"].items()}
                offs.write_text(json.dumps({**known, "at": moved, "rel": {}}), encoding="utf-8")
                sent, real = [], hub.publish
                hub.publish = lambda s: sent.append(s) or real(s)
                bot.poll_once()                                   # a miss: unsettled, carries the counts
                bot.poll_once()
                bot.poll_once()                                   # settled again: looks for them
                self.assertTrue(sent and all(s.get("stock") == stock for s in sent), [s.get("stock") for s in sent])
                self.assertNotEqual(json.loads(offs.read_text(encoding="utf-8"))["at"], moved)   # found again
                bot._drop()
        finally:
            fake.kill()
            fake.wait()


if __name__ == "__main__":
    unittest.main()
