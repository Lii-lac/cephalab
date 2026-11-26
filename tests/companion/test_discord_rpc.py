"""Discord Rich Presence: the card, the frames, the 15 s coalescing, the setting.  .venv\\Scripts\\python.exe -m unittest tests.companion.test_discord_rpc"""
import io
import random
import tempfile
import unittest
from pathlib import Path

from companion import discord_rpc as D
from companion.settings import Settings, SettingsError

W = "Shooter_Normal_00"


class Card(unittest.TestCase):
    def rng(self):
        return random.Random(3)

    def test_off_is_nothing(self):
        self.assertIsNone(D.card({"mode": "turf"}, "off", self.rng()))

    def test_basic_is_squid_and_session_only(self):
        c = D.card({"mode": "turf", "stage": "X", "weapon": W, "party": [2, 4], "session": 1000}, "basic", self.rng())
        self.assertEqual(set(c), {"assets", "timestamps"})
        self.assertEqual(c["assets"]["large_text"], "Splatoon 3")
        self.assertRegex(c["assets"]["large_image"], r"/squid/(blue|cyan|orange|purple|red|yellow)\.png$")
        self.assertEqual(set(c["assets"]), {"large_image", "large_text"})
        self.assertEqual(c["timestamps"], {"start": 1000})

    def test_full_with_nothing_known_is_basic(self):
        self.assertEqual(D.card({}, "full", self.rng()), D.card({}, "basic", self.rng()))
        self.assertEqual(D.card({"mode": "nonsense", "party": "x"}, "full", self.rng()), D.card({}, "basic", self.rng()))

    def test_every_mode(self):
        for mode in D.MODES:
            c = D.card({"mode": mode, "stage": "Vss_A", "weapon": W, "party": [2, 4], "salmometer": 3, "since": 5}, "full", self.rng())
            self.assertTrue(c["assets"]["large_image"].endswith(f"/stage/{mode}/Vss_A.png"), mode)
            self.assertEqual(c["timestamps"], {"start": 5})
            self.assertEqual(c["buttons"], [D.BUTTON])
            self.assertEqual("party" in c, mode not in D.SOLO, mode)
            if mode == "salmon":
                self.assertTrue(c["assets"]["small_image"].endswith("/salmometer/3.png"))
                self.assertEqual(c["assets"]["small_text"], "Cohozuna · Salmometer 3/5")
            else:
                self.assertTrue(c["assets"]["small_image"].endswith(f"/weapon/{W}.png"))
                self.assertEqual(c["assets"]["small_text"], "Splattershot")

    def test_details_line(self):
        r = self.rng()
        self.assertEqual(D.card({"mode": "turf"}, "full", r)["details"], "Turf War")
        self.assertEqual(D.card({"mode": "anarchy", "rule": "Vlf", "grade": "S+", "rank": 4}, "full", r)["details"], "Tower Control · S+4")
        self.assertEqual(D.card({"mode": "xbattle", "rule": "Var", "xpower": 2140.4}, "full", r)["details"], "Splat Zones · 2140 XP")
        self.assertEqual(D.card({"mode": "salmon", "rank": 240}, "full", r)["details"], "Salmon Run · EVP 240")
        self.assertEqual(D.card({"mode": "anarchy", "rule": "bogus"}, "full", r)["details"], "Anarchy Battle")
        for place, text in D.PLACES.items():
            c = D.card({"place": place}, "full", r)
            self.assertEqual(c["details"], text)
            self.assertNotIn("small_image", c["assets"])
            self.assertRegex(c["assets"]["large_image"], r"/squid/")

    def test_unknown_fields_are_left_out(self):
        c = D.card({"mode": "turf", "stage": "Vss_A"}, "full", self.rng())
        self.assertEqual(set(c), {"details", "assets", "buttons"})
        self.assertEqual(set(c["assets"]), {"large_image"})                  # no stage name, weapon, party, timer
        for bad in ([1], [0, 4], [5, 4], ["a", 4], True):
            self.assertNotIn("party", D.card({"mode": "turf", "party": bad}, "full", self.rng()))
        self.assertNotIn("small_image", D.card({"mode": "salmon", "salmometer": 6}, "full", self.rng())["assets"])

    def test_squid_from_state_wins(self):
        self.assertTrue(D.card({"squid": "red"}, "basic", self.rng())["assets"]["large_image"].endswith("/squid/red.png"))


class Frames(unittest.TestCase):
    def test_round_trip(self):
        for op, body in ((0, {"v": 1, "client_id": D.CLIENT_ID}), (1, {"cmd": "SET_ACTIVITY", "x": "·"}), (2, {})):
            raw = D.encode(op, body)
            self.assertEqual(raw[:4], op.to_bytes(4, "little"))
            self.assertEqual(int.from_bytes(raw[4:8], "little"), len(raw) - 8)
            self.assertEqual(D.decode(io.BytesIO(raw).read), (op, body))

    def test_short_read_is_an_error(self):
        with self.assertRaises(OSError):
            D.decode(io.BytesIO(D.encode(1, {"a": 1})[:-2]).read)


class FakePipe:
    def __init__(self, log):
        self.log = log

    def set_activity(self, a):
        self.log.append(a)

    def close(self):
        pass


class Coalescing(unittest.TestCase):
    def make(self, state, level="full"):
        self.t = [100.0]
        self.log = []
        self.opens = 0
        self.up = True

        def opener():
            self.opens += 1
            if not self.up:
                raise OSError("no discord")
            return FakePipe(self.log)
        return D.Presence(lambda: state, level=level, open=opener, clock=lambda: self.t[0], wall=lambda: 5000.0 + self.t[0],
                          rng=random.Random(1))

    def test_one_send_per_15s_newest_wins(self):
        state = {"mode": "turf", "stage": "A"}
        p = self.make(state)
        p.step()
        self.assertEqual(len(self.log), 1)
        p.step()
        self.assertEqual(len(self.log), 1)                       # unchanged: nothing sent
        state["stage"] = "B"
        self.t[0] += 5
        self.assertAlmostEqual(p.step(), 10.0)                   # changed, but the 15 s aren't up
        state["stage"] = "C"                                     # a newer one: B is never sent
        self.t[0] += 5
        p.step()
        self.assertEqual(len(self.log), 1)
        self.t[0] += 5.1
        p.step()
        self.assertEqual(len(self.log), 2)
        self.assertTrue(self.log[1]["assets"]["large_image"].endswith("/C.png"))

    def test_timer_and_squid_reset_only_when_the_look_changes(self):
        state = {"mode": "turf", "stage": "A"}
        p = self.make(state)
        p.step()
        first = self.log[0]
        state["weapon"] = W                                      # same place/mode: same squid, same start
        self.t[0] += 20
        p.step()
        self.assertEqual(self.log[1]["timestamps"], first["timestamps"])
        state["mode"] = "anarchy"
        self.t[0] += 20
        p.step()
        self.assertGreater(self.log[2]["timestamps"]["start"], first["timestamps"]["start"])

    def test_off_clears_at_once_and_idles(self):
        p = self.make({"mode": "turf"}, level="basic")
        p.step()
        self.t[0] += 1
        p.configure("off")
        p.step()
        self.assertIsNone(self.log[-1])
        n = len(self.log)
        self.t[0] += 60
        p.step()
        self.assertEqual(len(self.log), n)
        self.assertIsNone(p.pipe)

    def test_off_from_start_never_connects(self):
        p = self.make({}, level="off")
        p.step()
        self.assertEqual(self.opens, 0)

    def test_close_clears(self):
        p = self.make({"mode": "turf"})
        p.step()
        p.close()
        self.assertIsNone(self.log[-1])

    def test_discord_not_running_backs_off_quietly_then_sends(self):
        p = self.make({"mode": "turf"})
        self.up = False
        waits = []
        for _ in range(7):
            waits.append(p.step())
            self.t[0] += waits[-1]
        self.assertEqual(waits[:5], list(D.BACKOFF))
        self.assertEqual(waits[-1], 30.0)
        self.assertEqual(self.log, [])
        self.up = True
        p.step()
        self.assertEqual(len(self.log), 1)

    def test_pipe_dying_mid_send_never_raises(self):
        p = self.make({"mode": "turf"})
        p.step()

        def boom(a):
            raise OSError("broken pipe")
        p.pipe.set_activity = boom
        p.source = lambda: {"mode": "anarchy"}
        self.t[0] += 20
        p.step()                                                  # swallowed; reconnects on the next try
        self.t[0] += 2
        p.step()
        self.assertEqual(self.opens, 2)
        self.assertEqual(len(self.log), 2)


class Adapter(unittest.TestCase):
    def test_weapon_from_hub(self):
        class Hub:
            snapshots = {"botbase": {"weapon": 20}}
            status = {"botbase": {"state": "ok"}}
        row = D.weapon_row(20)
        self.assertTrue(row)
        self.assertEqual(D.from_hub(Hub), {"weapon": row})
        Hub.status = {"botbase": {"state": "error"}}
        self.assertEqual(D.from_hub(Hub), {})


class Setting(unittest.TestCase):
    def test_level_validated_and_saved(self):
        with tempfile.TemporaryDirectory() as d:
            s = Settings(Path(d) / "settings.json")
            self.assertEqual(s.get()["discord"], {"level": "basic"})
            seen = []
            s.on_change(lambda new, old: seen.append(new["discord"]["level"]))
            s.update({"discord": {"level": "full"}})
            self.assertEqual(seen, ["full"])
            for bad in ("loud", None, 1, True):
                with self.assertRaises(SettingsError):
                    s.update({"discord": {"level": bad}})
            with self.assertRaises(SettingsError):
                s.update({"discord": {"nope": "off"}})
            self.assertEqual(Settings(Path(d) / "settings.json").get()["discord"]["level"], "full")


if __name__ == "__main__":
    unittest.main()
