"""CFW source: exact gear seeds read live from the Switch's RAM over sys-botbase (grown from tracker.py).

The address and the read interval come from Settings and can change while it runs (configure); an empty host idles it.
"""
import threading
import time

from s3seed import gear as G
from s3seed import drink as D
from s3seed import player as P
from s3seed import equip as E
from s3seed import gear_find as GF
from s3seed import stock as S
from s3seed import presence as PR
from s3seed.botbase import Botbase, BotbaseError, NoGame

from .hub import Hub

SPLATOON3 = "0100C2500FC20000"
NO_HOST = "No Switch address set"
# A full gear read is ~330 records x 0xB0 (~58 KB, a dozen-plus sys-botbase commands, each pausing the game a moment: Alex
# felt it mid-match, 2026-11-21). So a poll reads only the pieces the Path is planning (the hub's watch list, one 0xB0
# record each) plus the stock counts; the whole list is read at the start, when a watched piece isn't where it was or
# isn't known yet, and every FULL_EVERY seconds (new gear for the Gear screen). The game can't tell us when it saves.
FULL_EVERY = 600.0
STOCK_CARRY = 600.0     # how long counts read on this connection stand in while the tables are looked for again
FIND_RETRY = 30.0        # seconds after a find came up empty before a worn-gear read starts another
IO_WAIT = 20.0          # how long a worn-gear read waits for a poll in progress (one connection serves both)
# A map-rotation reload moves the save in RAM; a search (thousands of peeks, each pausing the game) then froze the game on
# that loading screen and crashed it on close (2026-11-22, only with the companion on). So searches wait until the game
# has been settled: SETTLE_S since anything looked off (a failed poll, the gear list changing, the stock not where it was)
# and SETTLE_POLLS good polls in a row; a search running when that resets stops.
SETTLE_S = 45.0
SETTLE_POLLS = 2
HEARTBEAT_S = 5.0       # a stock search re-reads the first headgear records this often; a change or error stops it
DRINK_RETRY = 300.0     # seconds after a drink find came up empty before the next (windows up to 160 KB, s3seed/drink.py)
PRESENCE_EVERY = 3.0    # a light presence look (place, party, rank: s3seed/presence.py, six small fixed peeks) between polls
# A find reads a lot while the game is held still: it may only run when settled, with the stock where it was (the save isn't
# moving) and with _search_cancel()'s heartbeat. Without those, one ran during a load screen on 2026-11-22 and froze the game.


class Unavailable(Exception):
    """No worn-gear answer right now; `busy` is true when asking again in a moment may work."""
    def __init__(self, msg: str, busy: bool = False):
        super().__init__(msg)
        self.busy = busy


def piece(g: G.Gear) -> dict:
    return {"slot": g.type, "gearId": g.id, "row": g.row, "brand": g.brand, "main": g.main,
            "subs": list(g.subs), "seed": g.seed, "rarity": g.rarity,   # rarity = stars: min(3, stars + 1) slots open
            "exp": g.exp}                                                # XP towards the next sub slot (resets per slot)


class BotbaseSource:
    name = "botbase"

    def __init__(self, hub: Hub, host: str = "", port: int = 6000, every: float = 15):
        self.hub, self.bot, self.every = hub, Botbase(host, port), max(3.0, every)
        self.dlc: int | None = None
        self.version = ""
        self.wake = threading.Event()
        self._lock = threading.Lock()
        self._find: dict | None = None             # the worn-gear search's progress / result (equip_find)
        self._find_stop = threading.Event()
        self._io = threading.Lock()               # held while the connection is read: a poll, or a worn-gear read
        self._pending: tuple[str, int, float] | None = None
        self._full: list | None = None            # the last whole list, kept current by the light polls
        self._full_at = 0.0
        self._idx: dict[tuple[str, int], int] = {}   # (slot, gear id) -> its record index in that slot's list
        self._sought = False                         # a light poll looked for the stock since it went missing
        self._stock: dict | None = None              # the counts last read on this connection (never from disk), and when
        self._stock_at = 0.0
        self._calm_from = time.monotonic()           # settle gate: when things last looked off, and good polls since
        self._good = 0
        self._hit: set = set()                       # stock kinds the last read found where it looked
        self._exp: dict[tuple[str, int], int] = {}   # watched pieces' XP at the last poll (gains between polls)
        self._drink: dict | None = None              # the last drink read on this connection, when, and the last find
        self._drink_at = 0.0
        self._drink_tried = float("-inf")             # never tried: monotonic() starts near 0 on a fresh boot
        self._player: str | None = None              # the player's name, read once per connection and drink address
        self._player_at: int | None = None
        self._worn_ok = self._drink_ok = False       # the last poll's outfit / drink read found it (a miss right after unsettles)
        self._pr = PR.Live()                         # presence for the Discord card: the values that held, the party
        self._pr_prev: dict | None = None            # the last presence read (a value counts once two reads agree)
        self._pr_vals: dict = {}

    def _unsettle(self):
        self._calm_from, self._good = time.monotonic(), 0

    def _heartbeat(self) -> bool:
        """One small read: the headgear list still starts with the pieces of the last whole read (no reload under way)."""
        try:
            data = self.bot.peek(G._list_base("head", self.dlc or 0), G.RECORD * G.CHUNK)
        except (BotbaseError, OSError):
            return False
        ids = []
        for j in range(G.CHUNK):
            g = G.parse_record("head", data[j * G.RECORD:(j + 1) * G.RECORD])
            if g is None:
                break
            ids.append(g.id)
        return ids == [g.id for g in (self._full or []) if g.type == "head"][:G.CHUNK]

    def _search_cancel(self):
        """cancel() for a stock search: a settings change, the gate closing, or a failed heartbeat every HEARTBEAT_S."""
        last = [time.monotonic()]

        def cancel() -> bool:
            if self.wake.is_set() or not self.settled():
                return True
            if time.monotonic() - last[0] < HEARTBEAT_S:
                return False
            last[0] = time.monotonic()
            if self._heartbeat():
                return False
            self._unsettle()
            return True
        return cancel

    def settled(self) -> bool:
        """True when a search may run: nothing looked off for SETTLE_S and the last SETTLE_POLLS polls went fine."""
        return self._good >= SETTLE_POLLS and time.monotonic() - self._calm_from >= SETTLE_S

    def configure(self, host: str, port: int = 6000, every: float = 15):
        """New settings: taken at the top of the next loop, which this wakes."""
        with self._lock:
            self._pending = (host, int(port), float(every))
        self._find_stop.set()                       # a settings change stops a worn-gear search too
        self.wake.set()

    def _apply(self):
        with self._lock:
            p, self._pending = self._pending, None
        if p is None:
            return
        host, port, every = p
        self.every = max(3.0, every)
        if (host, port) != (self.bot.host, self.bot.port):
            self._drop()
            self.bot = Botbase(host, port)

    def _wait(self, seconds: float):
        self.wake.wait(seconds)
        self.wake.clear()            # a configure() during the next poll sets it again, so it's never lost

    def test(self, host: str, port: int) -> dict:
        """Settings > Test connection. The connection the source already holds answers for its own address
        (sys-botbase serves one client at a time); any other address gets a short connection of its own."""
        st = self.hub.status.get(self.name) or {}
        if (host, port) == (self.bot.host, self.bot.port) and st.get("state") == "ok":
            return {"ok": True, "version": self.version}
        b = Botbase(host, port, timeout=4.0)
        try:
            b.connect()
            if b.title_id().upper() != SPLATOON3:
                return {"ok": False, "error": "Reached the Switch, but Splatoon 3 isn't running."}
            return {"ok": True, "version": b.game_version()}
        except (BotbaseError, OSError) as e:
            return {"ok": False, "error": str(e) or "Couldn't reach the Switch."}
        finally:
            b.close()

    def _connect(self):
        self.bot.connect()
        title = self.bot.title_id().upper()
        if not title:
            raise NoGame("no game running")
        if title != SPLATOON3:
            raise NoGame(f"Splatoon 3 isn't the running game ({title})")
        self.version = self.bot.game_version()
        learned = self.hub.dir / "gear_offsets.json"
        known = {**G.HEADS, **GF.load_learned(learned)}
        # the version string is untrusted (v12.0.0 reported "11.3.0", whose head parses as garbage there): try its own
        # head first, then every other known one, and keep whichever reads a real-looking list
        own = known.get(self.version)
        picked = G.pick_head(self.bot, ([own] if own is not None else []) + list(known.values()))
        self.dlc = picked[1] if picked else None
        if self.dlc is None and self.version and self.version not in known:
            # a game update moved the tables: find them once for this version and remember where (a known version
            # with nothing plausible is the title screen or a near-empty save: fail fast below, the poller retries)
            self.hub.set_status(self.name, "connecting", f"Finding your gear in v{self.version} (once)")
            with self.bot.gentle(3.0):
                head = GF.find_head(self.bot, log=lambda m: None)
            if head is None:
                raise BotbaseError(f"Can't find the gear in v{self.version}")
            GF.save_learned(learned, self.version, head)
            G.use_head(head)
            self.dlc = G.detect_dlc(self.bot)
        if self.dlc is None:
            raise BotbaseError("No gear yet (title screen?)")

    def poll_once(self):
        try:
            self._poll_once()
        except BaseException:
            self._unsettle()                           # a failed poll: maybe a loading screen, no searching for a while
            raise

    def _poll_once(self):
        watch = self.hub.watched()
        fresh = None
        if self._full is not None and watch and time.monotonic() - self._full_at < FULL_EVERY and all(w in self._idx for w in watch):
            fresh = self._light(watch)
        light = fresh is not None
        if not light:
            fresh = G.read_all(self.bot, self.dlc)
            if not fresh:
                raise BotbaseError("Read no gear (still on the title screen?)")
            if self._full is not None and [(g.type, g.id) for g in self._full] != [(g.type, g.id) for g in fresh]:
                self._unsettle()                       # gear bought, sold or the list moved
            self._full, self._full_at, self._idx, n = fresh, time.monotonic(), {}, {}
            for g in fresh:
                self._idx[(g.type, g.id)] = n.get(g.type, 0)
                n[g.type] = n.get(g.type, 0) + 1
        self.reads = getattr(self, "reads", []) + ["light" if light else "full"]   # for tests
        snap = {"source": self.name, "gameVersion": self.version, "pieces": [piece(g) for g in fresh],
                "xpGainMax": self._gains(fresh, watch), **self._pr_vals}
        path, head = self.hub.dir / "stock_offsets.json", G._head + (self.dlc or 0)
        epath, dpath = self.hub.dir / "equip_offsets.json", self.hub.dir / "drink_offsets.json"
        worn = E.worn(self.bot, epath, head)                         # one small read where the outfit was (never a search)
        if worn:
            snap["wearing"] = {t: worn[t] for t in G.TYPES}
            if worn.get("weapon") is not None:
                snap["weapon"] = worn["weapon"]                      # for the Discord card; no new read
        drink = D.read(self.bot, dpath)                              # one small read where the drink was
        if drink is not None:
            self._drink, self._drink_at = drink, time.monotonic()
        if (drink is None and self._drink_ok) or (worn is None and self._worn_ok):
            self._unsettle()                           # it was there a poll ago: the save is moving (a load screen). 2026-11-22
        self._drink_ok, self._worn_ok = drink is not None, worn is not None   # 19:25 a drink find that ran right then froze the game: see DRINK_RETRY
        self._put_drink(snap, drink)
        self._put_player(snap, drink)
        stock = S.read_stock(self.bot, path, head, search=False)     # chunk / ticket counts from the save in RAM
        # Not where they were (the save moves them; 2026-11-21 after a scrub): the last counts stay in the snapshot until
        # the search below finds them. A snapshot without them made the Path plan a moment with no chunks at all.
        now = time.monotonic()
        if self._hit - set(stock or {}):
            self._unsettle()                           # not where they just were: the save moved (a reload?)
        self._hit = set(stock or {})
        if stock:
            self._stock, self._stock_at = {**(self._stock or {}), **stock}, now
        last = self._stock if self._stock and now - self._stock_at < STOCK_CARRY else {}
        if stock or last:
            snap["stock"] = {**last, **(stock or {})}
        self.hub.publish(snap)
        self.hub.set_status(self.name, "ok", "", host=self.bot.host)
        self._good += 1
        if len(stock or {}) == len(S.KINDS):
            self._sought = False
        elif (not light or not self._sought) and self.settled():   # look for them, the gear out first: every full poll,
            self._sought = True                                     # a light one once until found; never while unsettled
            with self.bot.gentle(3.0):
                found = S.read_stock(self.bot, path, head, cancel=self._search_cancel())
            if found:
                self._hit |= set(found)
                self._stock, self._stock_at = {**(self._stock or {}), **found}, time.monotonic()
                if {**snap.get("stock", {}), **found} != snap.get("stock"):
                    snap = {**snap, "stock": {**snap.get("stock", {}), **found}}
                    self.hub.publish(snap)
        wh = D.worn_head(epath) if worn else None
        if drink is None and wh is not None and self.settled() and len(stock or {}) == len(S.KINDS):   # the save sits still
            got = D.relocate(self.bot, dpath, wh)                      # one small read at the old distance from the outfit
            if got is None and time.monotonic() - self._drink_tried >= DRINK_RETRY:
                self._drink_tried = time.monotonic()
                with self.bot.gentle(3.0):
                    got = D.find(self.bot, dpath, wh, cancel=self._search_cancel())   # heartbeat: stops the moment a load starts
            if got is not None:
                self._drink, self._drink_at = got, time.monotonic()
                new = dict(snap)
                self._put_drink(new, got)
                if new != snap:
                    self.hub.publish(new)

    def _put_player(self, snap: dict, drink: dict | None):
        """snap["player"]: the name beside the drink field, read (one 0x400 read) only after a drink read that worked, when it
        isn't known yet on this connection or the drink moved, and only when settled; the last one is carried."""
        at = D.load_offsets(self.hub.dir / "drink_offsets.json").get("at") if drink is not None else None
        if isinstance(at, int) and at != self._player_at and self.settled():
            self._player_at = at
            name = P.name_near(self.bot, at)
            if name:
                self._player = name
        if self._player:
            snap["player"] = self._player

    def _put_drink(self, snap: dict, drink: dict | None):
        """snap["drink"]: {ability, battles}, None with no drink active, or no key when it isn't known (a read that missed
        stands in with the last one read on this connection for STOCK_CARRY seconds, like the stock)."""
        if drink is None and self._drink and time.monotonic() - self._drink_at < STOCK_CARRY:
            drink = self._drink
        if drink is not None:
            snap["drink"] = dict(drink) if drink.get("ability") else None

    def _gains(self, fresh: list, watch: list) -> int:
        """The largest single-poll XP rise seen on a watched piece (a drop is a slot unlock: not a gain), kept in
        state/xp_gains.json {"max": n, "at": unix}."""
        p = self.hub.dir / "xp_gains.json"
        best = S.load_offsets(p).get("max")
        best = best if isinstance(best, int) else 0
        w = set(watch)
        for g in fresh:
            k = (g.type, g.id)
            if k not in w:
                continue
            old, self._exp[k] = self._exp.get(k), g.exp
            if old is not None and g.exp - old > best:
                best = g.exp - old
                S.save_offsets(p, max=best, at=int(time.time()))
        return best

    def _live(self):
        if not self.bot.host:
            raise Unavailable(NO_HOST)
        if not self.bot.sock or self.dlc is None:
            raise Unavailable("The Switch isn't connected")
        if not self._io.acquire(timeout=IO_WAIT):
            raise Unavailable("The Switch is busy, try again in a moment", busy=True)

    def wearing(self) -> dict:
        """{slot: gear id, weapon: id} the player wears now, one small read through this connection. When the record isn't
        where it was (the save moved), a background search starts and this raises Unavailable until it lands."""
        self._live()
        try:
            ids = E.worn(self.bot, self.hub.dir / "equip_offsets.json", G._head + (self.dlc or 0))
        except BotbaseError as e:
            raise Unavailable(str(e) or "The Switch read failed", busy=True) from e
        finally:
            self._io.release()
        if ids is None:
            with self._lock:
                last = self._find or {}
                failed = last.get("state") in ("none", "ambiguous", "error") and time.time() - last.get("endedAt", 0) < FIND_RETRY
            if failed:
                raise Unavailable("Couldn't find your outfit in the Switch's memory")
            if not self.settled():
                raise Unavailable("Waiting for the game to settle", busy=True)
            self.equip_find()
            raise Unavailable("Looking for your outfit again")
        return ids

    def equip_find(self) -> bool:
        """Start looking for the worn-gear record (by its field hashes). It runs on a thread of its own, reading a slice at
        a time between the polls; False when one is already running. equip_state() tells how it goes."""
        if not self.bot.host:
            raise Unavailable(NO_HOST)
        if not self.bot.sock or self.dlc is None:
            raise Unavailable("The Switch isn't connected")
        if not self.settled():                           # no searching while the game may be loading
            raise Unavailable("Waiting for the game to settle", busy=True)
        with self._lock:
            if self._find and self._find.get("state") == "running":
                return False
            self._find = {"state": "running", "scanned": 0, "startedAt": time.time()}
            self._find_stop.clear()
        threading.Thread(target=self._find_run, args=(self._find,), daemon=True).start()
        return True

    def equip_cancel(self):
        self._find_stop.set()

    def equip_state(self) -> dict:
        with self._lock:
            return dict(self._find or {"state": "idle"})

    def _find_peek(self, addr: int, size: int) -> bytes:
        if not self.bot.sock or self.dlc is None:
            raise E.Aborted("The Switch connection dropped")
        if not self.settled():                           # a poll failed or something moved: stop, it may be loading
            raise E.Stopped("cancelled")
        self.bot.settle()                                # the rest after the last read is spent outside the lock
        while not self._io.acquire(timeout=0.2):         # a poll in progress: wait for it, but a cancel doesn't wait
            if self._find_stop.is_set():
                raise E.Stopped("cancelled")
        if not self.settled():
            self._io.release()
            raise E.Stopped("cancelled")
        try:                                             # one slice at a time: the polls get the connection between them
            return self.bot.peek(addr, size)
        finally:
            self._io.release()

    def _find_run(self, st: dict):
        def more(n):
            st["scanned"] += n
        try:
            with self.bot.gentle(3.0):
                res = E.find(self.bot, self.hub.dir / "equip_offsets.json", G._head + (self.dlc or 0),
                             cancel=lambda: self._find_stop.is_set() or not self.settled(), peek=self._find_peek, progress=more)
        except (E.Aborted, BotbaseError, OSError) as e:
            res = {"state": "error", "error": str(e) or "The Switch read failed"}
        except Exception as e:                           # a bug: say so rather than leave it "running"
            res = {"state": "error", "error": f"{e.__class__.__name__}: {e}"}
        with self._lock:
            st.update(res, took=round(time.time() - st["startedAt"], 1), endedAt=time.time())

    def _light(self, watch: list[tuple[str, int]]) -> list | None:
        """The last whole list with just the watched records read again; None when one isn't where it was (gear bought,
        sold or moved): then the caller reads everything."""
        fresh = list(self._full)
        at = {(g.type, g.id): k for k, g in enumerate(fresh)}
        for t, gid in watch:
            g = G.parse_record(t, self.bot.peek(G._list_base(t, self.dlc) + self._idx[(t, gid)] * G.RECORD, G.RECORD))
            if g is None or g.id != gid or (t, gid) not in at:
                return None
            fresh[at[(t, gid)]] = g
        self._full = fresh
        return fresh

    def run(self, stop: threading.Event):
        backoff = 2
        while not stop.is_set():
            self._apply()
            if not self.bot.host:
                self._drop()
                self.hub.set_status(self.name, "off", NO_HOST)
                self._wait(3600)
                continue
            try:
                if not self.bot.sock or self.dlc is None:
                    self.hub.set_status(self.name, "connecting", f"Connecting to the Switch at {self.bot.host}")
                    self._connect()
                with self._io:
                    self.poll_once()
                backoff = 2
                self._between(stop)
            except NoGame as e:
                self._drop()
                self.hub.set_status(self.name, "waiting", str(e))
                self._wait(5)
            except Exception as e:                      # BotbaseError, OSError, or a bug: report it, back off, go on
                self._drop()
                msg = str(e) if isinstance(e, (BotbaseError, OSError)) else f"Switch read failed ({e.__class__.__name__})"
                self.hub.set_status(self.name, "error", msg or e.__class__.__name__)
                self._wait(backoff)
                backoff = min(backoff * 2, 30)
        self._drop()

    def presence_once(self) -> bool:
        """One presence look (six small peeks at fixed addresses, never a search; the only read allowed in a poll that saw
        a miss). A value counts once two reads in a row agree (loads pass through scenes 0/1/2/7); a failed read unsettles
        and the card keeps the last good values."""
        try:
            raw = PR.read(self.bot)
        except (BotbaseError, OSError):
            self._pr_prev = None
            self._unsettle()
            return False
        prev, self._pr_prev = self._pr_prev, raw
        if prev is None:
            return True
        held = {k: v for k, v in raw.items() if prev.get(k) == v}
        held["names"] = raw["names"]                 # the party rule does its own holding (and needs every read for a burst)
        vals = self._pr.update(time.monotonic(), held)
        if vals != self._pr_vals:
            self._pr_vals = vals
            self.hub.presence(self.name, vals)
        return True

    def _between(self, stop: threading.Event):
        """Wait out self.every until the next poll, a presence look every PRESENCE_EVERY s on the same connection (the rest
        after the last read spent outside the lock, like a find's slices). A configure() ends the wait."""
        end = time.monotonic() + self.every
        while not stop.is_set():
            left = end - time.monotonic()
            if left <= 0:
                return
            if self.wake.wait(min(PRESENCE_EVERY, left)):
                self.wake.clear()
                return
            if not self.bot.sock or self.dlc is None:
                return
            self.bot.settle()
            with self._io:
                ok = self.presence_once()
            if not ok and not self.bot.sock:
                return                                   # the connection went: the loop reconnects

    def _drop(self):
        self._find_stop.set()
        self._pr_prev = None
        try:
            self.bot.close()
        except OSError:
            pass
        self.dlc = None
        self._full, self._idx = None, {}
        self._stock, self._sought = None, False      # another connection may be another save or game version
        self._hit = set()
        self._exp, self._drink = {}, None
        self._player, self._player_at = None, None
        self._unsettle()
