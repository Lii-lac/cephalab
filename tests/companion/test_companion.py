"""Companion guarantees that would hurt if they broke.  .venv\\Scripts\\python.exe -m unittest tests.companion.test_companion"""
import base64
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from companion import splatnet
from companion.hub import Hub
from companion.server import App, decode_export
from companion.vault import Vault


def piece(gid, subs, seed):
    return {"slot": "head", "gearId": gid, "row": "Hed_CAP002", "brand": "B11", "main": "ComeBack", "subs": subs, "seed": seed}


class RestartLosesNothing(unittest.TestCase):
    def test_snapshots_survive_restart_and_log_only_changes(self):
        with tempfile.TemporaryDirectory() as d:
            hub = Hub(Path(d))
            self.assertTrue(hub.publish({"source": "botbase", "gameVersion": "11.3.0", "pieces": [piece(1, ["", "", ""], 5), piece(2, ["", "", ""], 9)]}))
            self.assertFalse(hub.publish({"source": "botbase", "gameVersion": "11.3.0", "pieces": [piece(1, ["", "", ""], 5), piece(2, ["", "", ""], 9)]}))
            hub = Hub(Path(d))                                   # restart: the roll made while it was off is still caught
            self.assertEqual(hub.state()["snapshots"]["botbase"]["pieces"][0]["seed"], 5)
            self.assertTrue(hub.publish({"source": "botbase", "gameVersion": "11.3.0", "pieces": [piece(1, ["SquidMove_Up", "", ""], 77), piece(2, ["", "", ""], 9)]}))
            lines = [json.loads(x) for x in (Path(d) / "log.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(lines), 2)
            self.assertTrue(lines[0]["full"])
            self.assertEqual([p["gearId"] for p in lines[1]["changed"]], [1])
            self.assertEqual(lines[1]["was"][0]["seed"], 5)


class SplatnetMapping(unittest.TestCase):
    def test_outfit_and_export_decode(self):
        outfit = {"data": {"headGears": {"nodes": [{"headGearId": "1002", "primaryGearPower": {"gearPowerId": 103},
                                                    "additionalGearPowers": [{"gearPowerId": 0}, {"gearPowerId": 13}, {"gearPowerId": 255}]},
                                                   {"headGearId": "999999", "primaryGearPower": {"gearPowerId": 0}, "additionalGearPowers": []}]},
                           "clothingGears": {"nodes": []}, "shoesGears": {"nodes": [{"shoesGearId": "1000", "primaryGearPower": {"gearPowerId": 4},
                                                                                     "additionalGearPowers": []}]}}}
        p = splatnet.pieces_from_outfit(outfit)
        self.assertEqual(len(p), 2)                              # unknown gear id skipped
        self.assertEqual((p[0]["main"], p[0]["subs"]), ("ComeBack", ["MainInk_Save", "Action_Up", ""]))
        self.assertEqual(p[1]["subs"], ["", "", ""])
        # s3s --getseed: key = base64(player id XOR low byte of h)
        pid, h = "u-abcdefghijklmnopqrst", 0x1234ABCD
        key = base64.b64encode(bytes(b ^ (h & 0xFF) for b in pid.encode())).decode()
        self.assertEqual(decode_export({"key": key, "h": h, "gear": outfit})[0], pid)
        with self.assertRaises(ValueError):
            decode_export({"gear": outfit})


class SmallKeyring:
    """Like Windows Credential Manager: an entry over 1280 characters is refused."""
    def __init__(self):
        self.d = {}

    def get_password(self, svc, name):
        return self.d.get((svc, name))

    def set_password(self, svc, name, value):
        if len(value) > 1280:
            raise OSError("blob too big")
        self.d[(svc, name)] = value

    def delete_password(self, svc, name):
        del self.d[(svc, name)]


class TokensStayOutOfFiles(unittest.TestCase):
    def test_tokens_only_in_keyring_and_gone_after_logout(self):
        class FakeIksm:
            SPLATNET3_URL = "https://x"
            S3S_VERSION = "unknown"
            F_GEN_URL = "unknown"
            @classmethod
            def get_session_token(cls, code, v):
                assert cls.S3S_VERSION != "unknown" and cls.F_GEN_URL != "unknown"
                return "SESSION-" + code
            get_gtoken = staticmethod(lambda f, st, ver: ("GTOKEN-SECRET" + "x" * 2400, "nick", "en-US", "US"))
            get_bullet = staticmethod(lambda g, ua, lang, c: "BULLET-SECRET")
        real, splatnet.iksm = splatnet.iksm, FakeIksm
        try:
            with tempfile.TemporaryDirectory() as d:
                kr = SmallKeyring()
                vault = Vault(backend=kr)
                src = splatnet.SplatnetSource(Hub(Path(d)), vault)
                with self.assertRaises(splatnet.SplatnetError):
                    src.finish_login("https://example.com/not-the-link")
                src.login_url()
                src.finish_login("npf71b963c1b7b6d119://auth#session_token_code=CODE123&state=x&session_state=y")
                self.assertEqual(vault.load()["bullettoken"], "BULLET-SECRET")
                self.assertTrue(vault.load()["gtoken"].startswith("GTOKEN-SECRET"))   # 2400+ chars survive the cap
                src.logout()
                vault.update(gtoken="LATE-REFRESH")             # a poll finishing after sign-out puts nothing back
                self.assertEqual(kr.d, {})
                for f in Path(d).rglob("*"):
                    if f.is_file():
                        self.assertNotIn("SECRET", f.read_text(encoding="utf-8", errors="ignore"))
                        self.assertNotIn("SESSION-", f.read_text(encoding="utf-8", errors="ignore"))
        finally:
            splatnet.iksm = real


class ServerOnlyAnswersThisMachine(unittest.TestCase):
    def test_host_origin_and_traversal(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "web" / "dist" / "assets").mkdir(parents=True)
            (root / "web" / "dist" / "index.html").write_text("<p>app</p>", encoding="utf-8")
            (root / "secret.txt").write_text("nope", encoding="utf-8")
            srv = App(Hub(root / "state"), root, 0).serve()
            port = srv.server_address[1]
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            try:
                def get(path, host=None, method="GET", headers=None, body=None):
                    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    c.putrequest(method, path, skip_host=True)
                    c.putheader("Host", host or f"127.0.0.1:{port}")
                    for k, v in (headers or {}).items():
                        c.putheader(k, v)
                    c.putheader("Content-Length", str(len(body or b"")))
                    c.endheaders(body)
                    r = c.getresponse()
                    out = r.status, r.read()
                    c.close()
                    return out
                self.assertEqual(get("/api/state", host=f"evil.example:{port}")[0], 403)
                self.assertEqual(get("/")[1], b"<p>app</p>")
                self.assertEqual(get("/some/route")[1], b"<p>app</p>")        # app routes fall back to index.html
                for bad in ("/../../secret.txt", "/%2e%2e/%2e%2e/secret.txt", "/assets/../../../secret.txt", r"/..\..\secret.txt"):
                    self.assertNotEqual(get(bad)[1], b"nope", bad)
                self.assertEqual(get("/api/import", method="POST", headers={"Origin": "http://evil.example", "Content-Type": "application/json"}, body=b"{}")[0], 403)
                self.assertEqual(get("/api/import", method="POST", headers={"Content-Type": "text/plain"}, body=b"{}")[0], 403)
            finally:
                srv.shutdown()
                srv.server_close()
                srv.server_close()


class SettingsApi(unittest.TestCase):
    """Settings screen endpoints: validated, saved, applied to the sources live, and reset wipes everything."""

    def test_settings_roundtrip_test_cache_reset(self):
        import subprocess
        import sys
        import time
        from companion.botbase_source import BotbaseSource
        from companion.settings import Settings
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            hub = Hub(root / "state")
            settings = Settings(root / "state" / "settings.json")
            bot = BotbaseSource(hub, **settings.get()["switch"])
            settings.on_change(lambda new, old: bot.configure(**new["switch"]))
            app = App(hub, root, 0, None, settings=settings, botbase=bot)
            opened = []
            app.open_folder = opened.append
            srv = app.serve()
            port = srv.server_address[1]
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            stop = threading.Event()
            threading.Thread(target=bot.run, args=(stop,), daemon=True).start()

            def call(method, path, body=None):
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                data = json.dumps(body).encode() if body is not None else None
                c.request(method, path, body=data, headers={"Host": f"127.0.0.1:{port}", "Content-Type": "application/json"})
                r = c.getresponse()
                out = r.status, json.loads(r.read() or b"null")
                c.close()
                return out

            fake = None
            try:
                code, s = call("GET", "/api/settings")
                self.assertEqual((code, s["switch"], s["splatnet"]), (200, {"host": "", "port": 6000, "every": 15}, {"every": "off"}))
                self.assertEqual(s["data"]["folder"], str(root / "state"))
                for _ in range(50):                            # no host: the Switch source says so and idles
                    if (hub.status.get("botbase") or {}).get("state") == "off":
                        break
                    time.sleep(0.05)
                self.assertEqual(hub.status["botbase"]["state"], "off")

                for bad in ({"switch": {"host": "http://x"}}, {"switch": {"port": 70000}}, {"switch": {"every": 1}},
                            {"splatnet": {"every": "hourly"}}, {"nope": {}}, {"switch": {"host": "1.2.3.4", "port": "6000"}}):
                    self.assertEqual(call("POST", "/api/settings", bad)[0], 400, bad)
                self.assertEqual(settings.get()["switch"]["host"], "")      # a bad patch changes nothing

                fp = 6170 + (port % 50)
                fake = subprocess.Popen([sys.executable, "tests/fake_botbase.py", "--port", str(fp)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(1.0)
                ok = call("POST", "/api/switch/test", {"host": "127.0.0.1", "port": fp})[1]
                self.assertTrue(ok["ok"], ok)
                self.assertFalse(call("POST", "/api/switch/test", {"host": "127.0.0.1", "port": 1})[1]["ok"])
                self.assertFalse(call("POST", "/api/switch/test", {"host": "", "port": fp})[1]["ok"])

                code, s = call("POST", "/api/settings", {"switch": {"host": "127.0.0.1", "port": fp, "every": 5}})
                self.assertEqual((code, s["switch"]), (200, {"host": "127.0.0.1", "port": fp, "every": 5}))
                self.assertEqual(Settings(root / "state" / "settings.json").get()["switch"]["port"], fp)   # saved
                for _ in range(100):                           # the running source picked the address up live
                    if hub.snapshots.get("botbase"):
                        break
                    time.sleep(0.05)
                self.assertTrue(hub.snapshots.get("botbase"), hub.status.get("botbase"))
                self.assertTrue(call("POST", "/api/switch/test", {"host": "127.0.0.1", "port": fp})[1]["ok"])  # its own link answers

                (root / "cache" / "img" / "gear").mkdir(parents=True)
                (root / "cache" / "img" / "gear" / "a.png").write_bytes(b"x" * 1000)
                self.assertEqual(call("GET", "/api/settings")[1]["data"]["cacheBytes"], 1000)
                self.assertEqual(call("POST", "/api/cache/clear", {})[1], {"ok": True, "cacheBytes": 0})
                self.assertEqual(call("POST", "/api/data/open", {})[1], {"ok": True})
                self.assertEqual(opened, [root / "state"])

                self.assertEqual(call("POST", "/api/reset", {})[1], {"ok": True})
                self.assertEqual(settings.get()["switch"]["host"], "")
                self.assertFalse((root / "state" / "settings.json").exists())
                self.assertFalse((root / "state" / "log.jsonl").exists())
                for _ in range(100):                           # the source let go of the Switch
                    if hub.status["botbase"]["state"] == "off":
                        break
                    time.sleep(0.05)
                self.assertEqual(hub.status["botbase"]["state"], "off")
                self.assertEqual(hub.state()["snapshots"], {})
            finally:
                stop.set()
                bot.wake.set()
                if fake:
                    fake.kill()
                    fake.wait()
                srv.shutdown()
                srv.server_close()
                srv.server_close()

    def test_flags_patch_and_splatnet_off(self):
        import time
        from companion.app import flags_patch
        import argparse
        with tempfile.TemporaryDirectory() as d:
            hub = Hub(Path(d))
            sn = splatnet.SplatnetSource(hub, vault=object(), mode="off")
            stop = threading.Event()
            threading.Thread(target=sn.run, args=(stop,), daemon=True).start()
            for _ in range(50):
                if (hub.status.get("s3s") or {}).get("state") == "off":
                    break
                time.sleep(0.05)
            self.assertEqual(hub.status["s3s"]["state"], "off")        # off: no SplatNet call, no login prompt
            stop.set()
            sn.wake.set()
        a = argparse.Namespace(switch="10.0.0.2", botbase_port=None, every=None, splatnet=True)
        self.assertEqual(flags_patch(a, {"splatnet": {"every": "off"}}), {"switch": {"host": "10.0.0.2"}, "splatnet": {"every": "battle"}})
        self.assertEqual(flags_patch(argparse.Namespace(switch=None, botbase_port=None, every=None, splatnet=True),
                                     {"splatnet": {"every": "5min"}}), {})


class StockFinder(unittest.TestCase):
    """The companion reads chunk and ticket counts from the save's MessagePack tables by itself, and find_stock.py
    shows them or learns a table's hash from counts."""

    def test_read_and_learn(self):
        import contextlib
        import io
        import subprocess
        import sys
        import time
        from companion import botbase_source as BS
        from companion.botbase_source import BotbaseSource
        from s3seed import stock as S
        from s3seed.seedmath import ABILITY_ORDER
        from tools import find_stock
        chunks = [132, 111, 130, 115, 73, 115, 181, 156, 155, 125, 114, 159, 114, 127]
        drinks = [0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 3, 0, 4, 0]
        fp = 6230 + int(time.time()) % 40
        fake = subprocess.Popen([sys.executable, "tests/fake_botbase.py", "--port", str(fp), "--stock"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1.0)
            with tempfile.TemporaryDirectory() as d:
                hub = Hub(Path(d))
                bot = BotbaseSource(hub, "127.0.0.1", fp)
                self.addCleanup(setattr, BS, "SETTLE_S", BS.SETTLE_S)
                BS.SETTLE_S = 0                                   # searches wait for SETTLE_POLLS good polls: the 2nd finds them
                bot._connect()
                bot.poll_once()
                bot.poll_once()
                stock = hub.snapshots["botbase"]["stock"]
                self.assertEqual(stock["chunks"], dict(zip(ABILITY_ORDER, chunks)))      # 128+ counts take 3 bytes
                self.assertEqual(stock["drinks"], dict(zip(ABILITY_ORDER, drinks)))
                self.assertIsInstance(S.load_offsets(Path(d) / "stock_offsets.json").get("near"), int)
                peeks = []
                real_peek = bot.bot.peek
                bot.bot.peek = lambda a, s: peeks.append(s) or real_peek(a, s)
                S.read_stock(bot.bot, Path(d) / "stock_offsets.json", 0)      # next polls: one small read, no search
                self.assertEqual(len(peeks), 1)
                self.assertLessEqual(peeks[0], 0x4100)
                bot.bot.peek = real_peek
                bot._drop()
                off = str(Path(d) / "learn.json")
                run = lambda *a: find_stock.main([*a, "--switch", "127.0.0.1", "--port", str(fp), "--offsets", off])
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(run(), 0)
                    self.assertIn("chunks: " + " ".join(map(str, chunks)), out.getvalue())
                    self.assertEqual(run("chunks", *map(str, chunks)), 0, out.getvalue())
                self.assertEqual(S.load_offsets(Path(off))["hashes"]["chunks"], S.HASHES["chunks"])
        finally:
            fake.kill()
            fake.wait()

class WornGear(unittest.TestCase):
    """What the avatar wears (weapon, head, clothes, shoes) sits in one MessagePack record, each field under a fixed hash:
    read in one small read where it was, found again by the hashes when the save moved."""

    class Mem:
        def __init__(self, base, size):
            self.base, self.buf = base, bytearray(size)

        def put(self, at, weapon, head, clothes, shoes):
            fx = bytes.fromhex
            i = lambda h, v: fx("ce" + h + "d1") + v.to_bytes(2, "big")
            rec = (i("e297f85f", weapon) + i("ddcbe978", head) + fx("ce4b347ee200") + i("5e46a8c1", clothes)
                   + fx("ce69e2428901") + i("425935d4", shoes))
            self.buf[at:at + len(rec)] = rec

        def peek(self, addr, size):
            from s3seed.botbase import BotbaseError
            if addr < self.base or addr + size > self.base + len(self.buf):
                raise BotbaseError("unmapped")
            return bytes(self.buf[addr - self.base:addr - self.base + size])

        def gentle(self):
            import contextlib
            return contextlib.nullcontext()

    def test_find_remember_relocate(self):
        from s3seed import equip as E
        B = 1_000_000
        ids = {"weapon": 5000, "head": 3029, "clothes": 7017, "shoes": 25012}
        mem = self.Mem(B, 0x20000)
        mem.put(0x9000, 5000, 3029, 7017, 25012)
        mem.buf[0x9400:0x9408] = bytes.fromhex("cec3aaee2ed10bd5")       # another structure holding a gear id: not it
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "equip_offsets.json"
            self.assertIsNone(E.worn(mem, path, B))                          # never found: no guess
            r = E.find(mem, path, B, centers=[B + 0x10000])
            self.assertEqual((r["state"], r["at"]["weapon"]), ("found", B + 0x9000))
            self.assertEqual(E.worn(mem, path, B), ids)
            mem.put(0x9000, 5000, 3011, 1000, 1001)                          # changed clothes: same places
            self.assertEqual(E.worn(mem, path, B), {"weapon": 5000, "head": 3011, "clothes": 1000, "shoes": 1001})
            mem.buf[0x9000:0x9040] = bytes(0x40)                             # the save moved: the tags are gone, so unknown...
            mem.put(0xB000, 5000, 3029, 7017, 25012)
            self.assertIsNone(E.worn(mem, path, B))
            self.assertEqual(E.find(mem, path, B, centers=[B + 0x9000])["state"], "found")   # ...until it is found again
            self.assertEqual((E.worn(mem, path, B), E.load_offsets(path)["at"]["weapon"]), (ids, B + 0xB000))
            mem.put(0x14000, 5000, 3029, 7017, 25012)                        # an old copy left behind that says the same: fine
            self.assertEqual(E.find(mem, path, B, centers=[B + 0x10000])["state"], "found")
            mem.put(0x14000, 5000, 3011, 7017, 25012)                        # one that says something else: it can't tell
            path.unlink()
            r = E.find(mem, path, B, centers=[B + 0x10000])
            self.assertEqual((r["state"], r["candidates"], path.exists()), ("ambiguous", 2, False))
            sizes = []                                                       # reads come in slices, cancel is checked before each, and there is a time budget
            def spy(addr, size):
                sizes.append(size)
                return mem.peek(addr, size)
            r = E.find(mem, path, B, centers=[B + 0x10000], peek=spy, cancel=lambda: len(sizes) >= 5)
            self.assertEqual((r["state"], len(sizes), max(sizes) <= 0x1000), ("cancelled", 5, True))
            r = E.find(mem, path, B, centers=[B + 0x10000], budget=0)
            self.assertEqual((r["state"], r["timedOut"]), ("none", True))
        pieces = [{"slot": t, "gearId": ids[t], "row": "R_" + t, "main": "ComeBack", "subs": ["", "Action_Up", ""]} for t in E.SLOTS]
        out = E.outfit(ids, pieces)
        self.assertEqual((out["clothes"], out["weapon"]), ({"gearId": 7017, "row": "R_clothes", "main": "ComeBack", "subs": ["", "Action_Up", ""]},
                                                          {"id": 5000, "row": "Maneuver_Short_00"}))
        with self.assertRaises(KeyError):
            E.outfit({**ids, "shoes": 1}, pieces)


class WornGearFind(unittest.TestCase):
    """The find is a background job: POST starts it (202), GET shows it, it learns the place from a fake Switch,
    and a poll can run while it does."""

    def test_async_find_against_fake_switch(self):
        import subprocess
        import sys
        import time
        from companion import botbase_source as BS
        from companion.botbase_source import BotbaseSource
        from s3seed import gear as G
        from s3seed import stock as S
        from s3seed.botbase import BotbaseError
        self.addCleanup(setattr, BS, "SETTLE_S", BS.SETTLE_S)
        BS.SETTLE_S = 1.0                                         # 45 s on the Switch
        fp = 6270 + int(time.time()) % 40
        fake = subprocess.Popen([sys.executable, "tests/fake_botbase.py", "--port", str(fp), "--stock", "--worn", "--drink", "8"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1.0)
            with tempfile.TemporaryDirectory() as d:
                root = Path(d)
                hub = Hub(root / "state")
                bot = BotbaseSource(hub, "127.0.0.1", fp)
                bot._connect()
                sizes, real_peek = [], bot.bot.peek
                bot.bot.peek = lambda a, n: sizes.append(n) or real_peek(a, n)
                scanned = lambda: [n for n in sizes if n >= S.BLOCK]    # a stock scan reads BLOCK + pad at a time
                bot.poll_once()
                bot.poll_once()                                   # 2 good polls, but not SETTLE_S yet: no search
                self.assertEqual((scanned(), "stock" in hub.snapshots["botbase"]), ([], False))
                time.sleep(1.1)
                bot.poll_once()                                   # settled: learns where the stock tables are (the find starts there)
                self.assertTrue(scanned())
                stock = hub.snapshots["botbase"]["stock"]
                offs = hub.dir / "stock_offsets.json"             # a reload moves the save: the cheap read misses
                known = json.loads(offs.read_text(encoding="utf-8"))
                offs.write_text(json.dumps({**known, "at": {k: v + 0x40 for k, v in known["at"].items()}, "rel": {}}), encoding="utf-8")
                sizes.clear()
                bot.poll_once()
                bot.poll_once()
                self.assertEqual((scanned(), hub.snapshots["botbase"]["stock"]), ([], stock))   # no scan, last counts carried
                time.sleep(1.1)
                bot.poll_once()
                self.assertTrue(scanned())
                self.assertEqual(json.loads(offs.read_text(encoding="utf-8"))["at"], known["at"])   # found again
                bot.bot.peek = real_peek
                srv = App(hub, root, 0, None, botbase=bot).serve()
                port = srv.server_address[1]
                threading.Thread(target=srv.serve_forever, daemon=True).start()

                def call(method, path, body=None):
                    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                    c.request(method, path, body=json.dumps(body).encode() if body is not None else None,
                              headers={"Host": f"127.0.0.1:{port}", "Content-Type": "application/json"})
                    r = c.getresponse()
                    out = r.status, json.loads(r.read() or b"null")
                    c.close()
                    return out
                code, st = call("GET", "/api/wearing")                                       # the first ask starts the search by itself
                self.assertEqual((code, st["error"]), (409, "Looking for your outfit again"))
                self.assertEqual(call("POST", "/api/equip/find", {})[0], 409)                # one at a time
                polled = False
                for _ in range(200):
                    code, st = call("GET", "/api/equip/find")
                    if st["state"] != "running":
                        break
                    if not polled:                                # the connection is free between slices: a poll goes through
                        with bot._io:
                            bot.poll_once()
                        polled = True
                    time.sleep(0.1)
                self.assertEqual(st["state"], "found", st)
                self.assertGreater(st["scanned"], 0)
                self.assertEqual(bot.wearing(), {"weapon": 5000, "head": 3029, "clothes": 7017, "shoes": 25012})
                deadline = time.monotonic() + 5                   # the drink find waits for a settled save; a fast runner gets here first
                while not bot.settled() and time.monotonic() < deadline:
                    time.sleep(0.05)
                with bot._io:                                     # the outfit known: a poll reads it and finds the drink near it
                    bot.poll_once()
                    bot.poll_once()                               # then reads the drink where it was found
                snap = hub.snapshots["botbase"]
                self.assertEqual((snap["wearing"], snap["drink"]), ({"head": 3029, "clothes": 7017, "shoes": 25012},
                                                                    {"ability": "RespawnTime_Save", "battles": 17}))
                self.assertEqual((snap["pieces"][0]["exp"], snap["xpGainMax"]), (1234, 0))
                from s3seed import player as P
                self.assertEqual(snap["player"], "Mochi")         # read beside the drink field, once
                sizes.clear(); bot.bot.peek = lambda a, n: sizes.append(n) or real_peek(a, n)
                with bot._io:
                    bot.poll_once()
                    bot.poll_once()
                bot.bot.peek = real_peek
                self.assertEqual((sizes.count(P.WINDOW), hub.snapshots["botbase"]["player"]), (0, "Mochi"))   # not on every poll
                self.assertEqual(json.loads((hub.dir / "drink_offsets.json").read_text(encoding="utf-8"))["rel"], -0x690 + 14 - 36)   # 8 pad + 6 battles bytes into its island
                doffs = hub.dir / "drink_offsets.json"            # a load moves the save: the drink read misses. 2026-11-22 a find
                dk = json.loads(doffs.read_text(encoding="utf-8"))    # right then (no settle, no heartbeat) froze the game
                doffs.write_text(json.dumps({"at": dk["at"] + 0x40, "rel": dk["rel"] + 0x40}), encoding="utf-8")
                self.addCleanup(setattr, BS, "DRINK_RETRY", BS.DRINK_RETRY)
                BS.DRINK_RETRY = 0.0                                  # 300 s on the Switch: the settle gate alone must hold it
                sizes.clear(); bot.bot.peek = lambda a, n: sizes.append(n) or real_peek(a, n)
                with bot._io:
                    bot.poll_once()
                    bot.poll_once()
                self.assertEqual(([n for n in sizes if n >= 0x400 and n != G.RECORD * G.CHUNK], bot.settled()), ([], False))   # no find yet
                time.sleep(1.1)
                with bot._io:
                    bot.poll_once()
                self.assertEqual(json.loads(doffs.read_text(encoding="utf-8"))["at"], dk["at"])   # settled: found again
                bot.bot.peek = real_peek
                (hub.dir / "equip_offsets.json").unlink(missing_ok=True)   # a search that a failing poll interrupts stops
                with bot._io:
                    self.assertTrue(bot.equip_find())
                    def boom(a, n):
                        raise BotbaseError("dropped")
                    bot.bot.peek = boom
                    with self.assertRaises(BotbaseError):
                        bot.poll_once()
                    bot.bot.peek = real_peek
                for _ in range(100):
                    if bot.equip_state()["state"] != "running":
                        break
                    time.sleep(0.05)
                self.assertEqual(bot.equip_state()["state"], "cancelled")
                with self.assertRaisesRegex(BS.Unavailable, "settle"):   # and none starts until it settles again
                    bot.equip_find()
                self.assertEqual(call("POST", "/api/equip/find", {}), (409, {"error": "Waiting for the game to settle"}))
                self.addCleanup(setattr, BS, "HEARTBEAT_S", BS.HEARTBEAT_S)
                BS.HEARTBEAT_S = 0                                # a reload starting mid-scan: the heartbeat read stops it
                known = json.loads(offs.read_text(encoding="utf-8"))   # far off, so the scan's first read doesn't find them
                offs.write_text(json.dumps({**known, "near": known["near"] + (1 << 20), "at": {k: v + (1 << 20) for k, v in known["at"].items()}, "rel": {}}), encoding="utf-8")
                bot.poll_once()
                bot.poll_once()
                time.sleep(1.1)
                sizes.clear()
                def loading(a, n):
                    if scanned() and a == G._list_base("head", bot.dlc):
                        raise BotbaseError("loading")
                    return sizes.append(n) or real_peek(a, n)
                bot.bot.peek = loading
                bot.poll_once()
                bot.bot.peek = real_peek
                self.assertEqual(len(scanned()), 1)               # stopped after the scan's first read
                self.assertFalse(bot.settled())
                srv.shutdown()
                srv.server_close()
        finally:
            fake.kill()
            fake.wait()


class BuildsCopy(unittest.TestCase):
    """The companion keeps a copy of your builds (the browser's can be wiped) and every change in a history file."""

    def test_save_history_reset(self):
        with tempfile.TemporaryDirectory() as d:
            hub = Hub(Path(d))
            self.assertIsNone(hub.builds())
            a = [{"id": 100001, "title": "Swim Decav", "set": []}]
            hub.save_builds(a)
            hub.save_builds(a)                                    # unchanged: no second history line
            hub.save_builds(a + [{"id": 100002, "title": "Two", "set": []}])
            self.assertEqual([b["title"] for b in Hub(Path(d)).builds()], ["Swim Decav", "Two"])
            lines = (Path(d) / "builds-history.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 2)
            hub.reset()
            self.assertIsNone(hub.builds())
            self.assertTrue((Path(d) / "builds-history.jsonl").exists())   # the way back stays


    """Between whole reads a poll reads only the watched pieces (one record each), and still sees them roll (2026-11-21:
    a whole gear read every 15 s made a match lag)."""

    def test_watched_pieces_only(self):
        import subprocess
        import sys
        import time
        from companion.botbase_source import BotbaseSource
        from s3seed import gear as G
        fp = 6290 + int(time.time()) % 40
        fake = subprocess.Popen([sys.executable, "tests/fake_botbase.py", "--port", str(fp), "--roll-every", "1"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1.0)
            with tempfile.TemporaryDirectory() as d:
                hub = Hub(Path(d))
                bot = BotbaseSource(hub, "127.0.0.1", fp)
                bot._connect()
                bot.poll_once()
                pieces = hub.snapshots["botbase"]["pieces"]
                head = next(p for p in pieces if p["slot"] == "head")
                clothes = next(p for p in pieces if p["slot"] == "clothes")
                hub.set_watch([("head", head["gearId"]), ("clothes", clothes["gearId"])])
                self.assertEqual(Hub(Path(d)).watched(), [("head", head["gearId"]), ("clothes", clothes["gearId"])])   # kept across restarts
                sizes = []
                real = bot.bot.peek
                bot.bot.peek = lambda a, s: sizes.append(s) or real(a, s)
                time.sleep(1.3)                                   # the fake rolls the first head piece every second
                bot.poll_once()
                self.assertEqual(bot.reads[-1], "light")
                gear_reads = [s for s in sizes if s == G.RECORD]
                self.assertEqual(len(gear_reads), 2, sizes)
                self.assertLessEqual(sum(sizes), 2 * G.RECORD + 0x4100, sizes)
                now = hub.snapshots["botbase"]["pieces"]
                self.assertEqual(len(now), len(pieces))
                h2 = next(p for p in now if p["slot"] == "head" and p["gearId"] == head["gearId"])
                self.assertNotEqual(h2["seed"], head["seed"])     # the roll was seen by the light read
                hub.set_watch([("head", 65000)])                  # a piece it doesn't know: a whole read
                bot.poll_once()
                self.assertEqual(bot.reads[-1], "full")
                hub.set_watch([("head", head["gearId"])])
                bot.poll_once()
                self.assertEqual(bot.reads[-1], "light")
                bot._full_at -= 10000                             # past FULL_EVERY: a whole read again
                bot.poll_once()
                self.assertEqual(bot.reads[-1], "full")
                hub.set_watch([])                                 # nothing watched (no Path open yet): whole reads
                bot.poll_once()
                self.assertEqual(bot.reads[-1], "full")
                bot.bot.peek = real
                bot._drop()
        finally:
            fake.kill()
            fake.wait()


class GameUpdate(unittest.TestCase):
    """A game update moves the gear tables: the companion finds them again by itself and remembers where."""

    def test_finds_moved_tables(self):
        import subprocess
        import sys
        import time
        from companion.botbase_source import BotbaseSource
        from s3seed import gear as G
        fp = 6270 + int(time.time()) % 40
        shift = 0x2A3B48
        fake = subprocess.Popen([sys.executable, "tests/fake_botbase.py", "--port", str(fp), "--version", "12.1.0", "--shift", hex(shift)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1.0)
            with tempfile.TemporaryDirectory() as d:
                hub = Hub(Path(d))
                bot = BotbaseSource(hub, "127.0.0.1", fp)
                t0 = time.time()
                bot._connect()
                bot.poll_once()
                bot._drop()
                self.assertEqual(len(hub.snapshots["botbase"]["pieces"]), 18)
                self.assertEqual(hub.snapshots["botbase"]["gameVersion"], "12.1.0")
                learned = json.loads((Path(d) / "gear_offsets.json").read_text())
                self.assertEqual(learned["12.1.0"], G.GEAR_LIST_HEAD + shift)
                self.assertLess(time.time() - t0, 60)
                bot2 = BotbaseSource(hub, "127.0.0.1", fp)              # next start: straight from the saved address
                t1 = time.time()
                bot2._connect()
                bot2._drop()
                self.assertLess(time.time() - t1, 2)
        finally:
            G.use_head(G.GEAR_LIST_HEAD)
            fake.kill()
            fake.wait()
        # v12.0.0 reporting "11.3.0" (Alex's Switch, 2026-11-22): the 11.3 head parses as 18 pieces sharing one main,
        # the real tables sit at the 12.0.0 head; it must read those, straight away, without scanning or learning
        fp += 1
        fake = subprocess.Popen([sys.executable, "tests/fake_botbase.py", "--port", str(fp), "--version", "11.3.0",
                                 "--shift", hex(G.HEADS["12.0.0"] - G.GEAR_LIST_HEAD), "--garbage", "18"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1.0)
            with tempfile.TemporaryDirectory() as d:
                hub = Hub(Path(d))
                bot = BotbaseSource(hub, "127.0.0.1", fp)
                t0 = time.time()
                bot._connect()
                self.assertLess(time.time() - t0, 2)                    # no scan (poll_once's stock search takes its own time)
                bot.poll_once()
                bot._drop()
                self.assertEqual(G._head, G.HEADS["12.0.0"])
                pieces = hub.snapshots["botbase"]["pieces"]
                self.assertEqual(len(pieces), 18)
                self.assertEqual({p["slot"] for p in pieces}, set(G.TYPES))
                self.assertGreater(len({p["main"] for p in pieces}), 1)
                self.assertFalse((Path(d) / "gear_offsets.json").exists())
        finally:
            G.use_head(G.GEAR_LIST_HEAD)
            fake.kill()
            fake.wait()

    def test_updater(self):
        import sys
        from companion.settings import Settings
        from companion.updater import Updater, is_newer, parse_version

        self.assertEqual(parse_version("v0.10.2"), (0, 10, 2))
        self.assertTrue(is_newer("v0.10.0", "0.9.9"))
        self.assertFalse(is_newer("v0.8.0", "0.8.0"))

        # 404 (no published release yet) reads cleanly as up-to-date
        u404 = Updater(current="0.8.0", fetch=lambda url, t=10: (404, b""), is_frozen=False)
        self.assertEqual(u404.check()["state"], "up-to-date")

        # Newer release with cephalab.exe asset
        rel = json.dumps({
            "tag_name": "v0.9.0",
            "html_url": "https://github.com/Lii-lac/cephalab/releases/tag/v0.9.0",
            "assets": [{"name": "cephalab.exe", "browser_download_url": "https://example.test/cephalab.exe"}],
        }).encode()
        seen = []
        u = Updater(current="0.8.0", fetch=lambda url, t=10: (200, rel), is_frozen=False, on_change=seen.append)
        st = u.check()
        self.assertEqual(st["state"], "available")
        self.assertEqual(st["latest"], "0.9.0")
        self.assertFalse(st["canInstall"])
        self.assertTrue(any(s["state"] == "available" for s in seen))

        # Frozen Windows exe sees canInstall=True
        uf = Updater(current="0.8.0", fetch=lambda url, t=10: (200, rel), is_frozen=True)
        self.assertEqual(uf.check()["canInstall"], sys.platform == "win32")

        # macOS: the zip asset and SHA256SUMS-macos.txt (over SHA256SUMS.txt); installable only when the .app's folder is writable
        from companion import updater as U
        relm = json.dumps({
            "tag_name": "v0.9.0",
            "assets": [{"name": n, "browser_download_url": f"https://example.test/{n}"} for n in
                       ("cephalab.exe", "SHA256SUMS.txt", "Cephalab-macOS-arm64.zip", "SHA256SUMS-macos.txt")],
        }).encode()
        with tempfile.TemporaryDirectory() as d:
            exe = Path(d) / "Apps" / "Cephalab.app" / "Contents" / "MacOS" / "cephalab"
            exe.parent.mkdir(parents=True)
            um = Updater(current="0.8.0", fetch=lambda url, t=10: (200, relm), is_frozen=True, platform="darwin", executable=str(exe))
            self.assertTrue(um.check()["canInstall"])
            self.assertEqual((um._asset_url, um._sha_url), ("https://example.test/Cephalab-macOS-arm64.zip", "https://example.test/SHA256SUMS-macos.txt"))
            self.assertEqual(U.app_bundle(exe), Path(d).absolute() / "Apps" / "Cephalab.app")
            gone = Path(d) / "missing" / "Cephalab.app" / "Contents" / "MacOS" / "cephalab"
            self.assertFalse(Updater(current="0.8.0", fetch=lambda url, t=10: (200, relm), is_frozen=True, platform="darwin",
                                     executable=str(gone)).check()["canInstall"])          # parent folder not writable (absent)
            self.assertFalse(Updater(current="0.8.0", fetch=lambda url, t=10: (200, relm), is_frozen=True, platform="darwin",
                                     executable=str(Path(d) / "cephalab")).check()["canInstall"])   # not inside a .app
            self.assertFalse(Updater(current="0.8.0", fetch=lambda url, t=10: (200, relm), is_frozen=False, platform="darwin",
                                     executable=str(exe)).check()["canInstall"])
            old = json.loads(relm)
            old["assets"] = [a for a in old["assets"] if a["name"] != "SHA256SUMS-macos.txt"]
            uo = Updater(current="0.8.0", fetch=lambda url, t=10: (200, json.dumps(old).encode()), is_frozen=True, platform="darwin", executable=str(exe))
            uo.check()
            self.assertEqual(uo._sha_url, "https://example.test/SHA256SUMS.txt")
            uw = Updater(current="0.8.0", fetch=lambda url, t=10: (200, relm), is_frozen=True, platform="win32", executable=str(exe))
            uw.check()
            self.assertEqual((uw._asset_url, uw._sha_url), ("https://example.test/cephalab.exe", "https://example.test/SHA256SUMS.txt"))

            # zip: unix modes come back (exec bits; checked off Windows), paths out of the folder are refused
            import io, os, stat, zipfile
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                zi = zipfile.ZipInfo("Cephalab.app/Contents/MacOS/cephalab")
                zi.external_attr = (stat.S_IFREG | 0o755) << 16
                z.writestr(zi, b"bin")
                z.writestr("Cephalab.app/Contents/Info.plist", b"plist")
            U.unzip_keeping_modes(buf.getvalue(), Path(d) / "x")
            got = Path(d) / "x" / "Cephalab.app" / "Contents" / "MacOS" / "cephalab"
            self.assertEqual(got.read_bytes(), b"bin")
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(got.stat().st_mode), 0o755)
            bad = io.BytesIO()
            with zipfile.ZipFile(bad, "w") as z:
                z.writestr("../evil", b"x")
            with self.assertRaises(RuntimeError):
                U.unzip_keeping_modes(bad.getvalue(), Path(d) / "y")

        # the swap script quotes every path
        from pathlib import PurePosixPath as P
        sh = U.mac_swap_script(P("/Applications/My Apps/Cephalab.app"), P("/tmp/it's new/Cephalab.app"), 4242, P("/tmp/it's new"))
        self.assertIn("kill -0 4242", sh)
        app, aside, new = "'/Applications/My Apps/Cephalab.app'", "'/Applications/My Apps/Cephalab.app.old-4242'", "'/tmp/it'\"'\"'s new/Cephalab.app'"
        steps = [f"if mv {app} {aside}; then", f"if mv {new} {app}; then rm -rf {aside}; else mv {aside} {app}; fi", f"open -n {app}"]
        at = [sh.find(s) for s in steps]
        self.assertTrue(all(i >= 0 for i in at) and at == sorted(at), sh)      # aside, new in, drop aside (or restore), reopen
        self.assertNotIn(f"rm -rf {app}\n", sh)
        self.assertIn("xattr -dr com.apple.quarantine '/Applications/My Apps/Cephalab.app'", sh)
        self.assertIn("open -n '/Applications/My Apps/Cephalab.app'", sh)

        # Settings accepts updates.auto toggle
        with tempfile.TemporaryDirectory() as d:
            s = Settings(Path(d) / "settings.json")
            self.assertTrue(s.get()["updates"]["auto"])
            s.update({"updates": {"auto": False}})
            self.assertFalse(Settings(Path(d) / "settings.json").get()["updates"]["auto"])

    def test_log_protocol_and_tray(self):
        import os
        import sys
        import urllib.request
        from companion import log as clog, protocol, tray as tray_mod

        # Token scrubbing removes auth links, JWTs, bearer headers, and token fields
        raw = (
            "link=npf71b963c1b7b6d119://auth#session_token_code=SECRET123&state=abc "
            "Authorization: Bearer abcdef1234567890 "
            "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c "
            '{"session_token": "tok_secret_value", "gtoken": "g_secret"}'
        )
        clean = clog.scrub(raw)
        for secret in ("SECRET123", "abcdef1234567890", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "tok_secret_value", "g_secret"):
            self.assertNotIn(secret, clean)

        # Rotating log file + GET /api/log + unhandled POST exception returns 500 JSON (not dropped socket)
        with tempfile.TemporaryDirectory() as d:
            p = clog.setup(Path(d), console=False)
            clog.get().info("hello session_token=SHOULD_NOT_APPEAR")
            tail = clog.read_tail(p, port=8765)
            self.assertIn("Cephalab v", tail)
            self.assertIn("hello", tail)
            self.assertNotIn("SHOULD_NOT_APPEAR", tail)

            class BoomSplatnet:
                mode = "off"
                vault = type("V", (), {"load": lambda self: {}})()
                def finish_login(self, link):
                    raise RuntimeError("boom session_token=SECRET_BOOM")

            hub = Hub(Path(d))
            app = App(hub, Path(d), 0, splatnet=BoomSplatnet())
            srv = app.serve()
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            try:
                base = f"http://127.0.0.1:{app.port}"
                with urllib.request.urlopen(f"{base}/api/log") as r:
                    doc = json.loads(r.read())
                self.assertIn("Cephalab v", doc["text"])
                req = urllib.request.Request(
                    f"{base}/api/login",
                    data=b'{"link":"x"}',
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    urllib.request.urlopen(req)
                self.assertEqual(ctx.exception.code, 500)
                err_doc = json.loads(ctx.exception.read())
                ctx.exception.close()
                self.assertIn("RuntimeError", err_doc["error"])
                self.assertNotIn("SECRET_BOOM", clog.read_tail(p))
            finally:
                srv.shutdown()
                srv.server_close()
                for h in list(clog.get().handlers):
                    clog.get().removeHandler(h)
                    h.close()

        # Protocol URI parsing + isolated HKCU test registration
        self.assertEqual(protocol.parse_uri("cephalab://start"), "start")
        self.assertEqual(protocol.parse_uri("CEPHALAB://open/"), "open")
        self.assertEqual(protocol.parse_uri("https://example.com"), "")
        if sys.platform == "win32":
            import winreg
            test_root = f"Software\\CephalabTest_{os.getpid()}"
            try:
                ok = protocol.register(Path(r"C:\Fake\cephalab.exe"), reg_root=test_root)
                self.assertTrue(ok)
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, f"{test_root}\\cephalab\\shell\\open\\command") as k:
                    val, _ = winreg.QueryValueEx(k, "")
                self.assertIn("cephalab.exe", val)
                self.assertIn("--uri", val)
            finally:
                for sub in (f"{test_root}\\cephalab\\shell\\open\\command", f"{test_root}\\cephalab\\shell\\open",
                            f"{test_root}\\cephalab\\shell", f"{test_root}\\cephalab\\DefaultIcon",
                            f"{test_root}\\cephalab", test_root):
                    try:
                        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, sub)
                    except OSError:
                        pass

            # Tray icon starts and stops cleanly on Windows
            ico = Path(__file__).resolve().parents[2] / "assets" / "cephalab.ico"
            tr = tray_mod.TrayIcon(ico, on_open=lambda: None, on_open_log=lambda: None, on_open_folder=lambda: None, on_quit=lambda: None)
            self.assertTrue(tr.start())
            tr.stop()


class RootDir(unittest.TestCase):
    def test_frozen_mac_uses_application_support_and_windows_the_exe_folder(self):
        import sys
        from unittest import mock
        from companion.app import root_dir
        with tempfile.TemporaryDirectory() as d:
            home, exe = Path(d) / "home", Path(d) / "dist" / "cephalab.exe"
            with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "executable", str(exe)), \
                    mock.patch.object(Path, "home", return_value=home):
                with mock.patch.object(sys, "platform", "darwin"):
                    got = root_dir()
                self.assertEqual(got, home / "Library" / "Application Support" / "Cephalab")
                self.assertTrue(got.is_dir())
                with mock.patch.object(sys, "platform", "win32"):
                    self.assertEqual(root_dir(), exe.resolve().parent)


class Presence(unittest.TestCase):
    def test_stage_names_from_known_hashes(self):
        from s3seed import presence as PR
        names = PR.stage_names()
        self.assertEqual({h: names[h] for h in (3448801241, 3091052709, 2212797925, 3833858915, 3069060397)},
                         {3448801241: "Scorch Gorge", 3091052709: "Mincemeat Metalworks", 2212797925: "Eeltail Alley",
                          3833858915: "Manta Maria", 3069060397: "shop"})
        self.assertEqual(PR.place(70, 3091052709), "match")
        self.assertEqual(PR.place(9, 885812243), "lobby")        # the Challenge lobby (scene 9) has the battle lobby's key

    def test_party_rule(self):
        from s3seed.presence import Party
        p, t = Party(), 0.0

        def feed(scene, names, secs):
            nonlocal t
            for _ in range(int(secs // 3)):
                t += 3
                p.update(t, scene, names)
        feed(24, ["Alex", "Bo"], 6)
        self.assertEqual(p.count(), (1, 4))                     # not held 20 s yet: just the player
        feed(24, ["Alex", "Bo"], 21)
        self.assertEqual(p.count(), (2, 4))
        feed(24, ["Alex", "Bo", "R1", "R2", "R3"], 30)          # matchmaking fills the room: no one joins, even held
        self.assertEqual(p.count(), (2, 4))
        feed(70, ["Alex", "Bo", "R1", "R2", "R3", "R4", "R5", "R6"], 9)
        feed(26, ["Alex", "Bo", "R1", "R2", "R3", "R4", "R5", "R6"], 6)
        feed(23, ["Alex", "Bo", "R1"], 30)                      # play again after a match: still the party only
        self.assertEqual(p.count(), (2, 4))
        feed(23, ["Alex", "R1"], 3)                             # Bo left
        self.assertEqual(p.count(), (1, 4))
        self.assertEqual(p.me, "Alex")
        solo, t = Party(), 0.0                                  # solo queue: lobby 11 -> matchmaking 23 fills with 8
        for _ in range(8):
            t += 3
            solo.update(t, 11, ["Alex"])
        self.assertEqual(solo.count(), (1, 4))
        for _ in range(12):
            t += 3
            solo.update(t, 23, ["Alex", "R1", "R2", "R3", "R4", "R5", "R6", "R7"])
        self.assertEqual(solo.count(), (1, 4))


if __name__ == "__main__":
    unittest.main()
