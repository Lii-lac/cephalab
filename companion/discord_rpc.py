"""Discord Rich Presence through the Discord desktop app's local pipe (stdlib only; Windows named pipe, macOS/Linux unix socket).

card(state, level, rng) builds the activity; Presence keeps it on Discord: at most one SET_ACTIVITY per 15 s, only when
the card changed, the newest state wins, and it is cleared on stop and when the level goes "off". Discord not running is
not an error: it reconnects quietly (back off to 30 s). Nothing here raises into the caller.

state (every key optional; what isn't known is left off the card, never guessed):
    place     "splatsville" | "alterna" | "grizzco" | "lobby" | "matchroom" | "order" | "shop" | "recon" | "match"
              ("match" with no mode: in a match whose type is unknown; the rule is the details, the stage name the image text)
    mode      "anarchy" | "turf" | "xbattle" | "private" | "challenge" | "salmon"
    rule      "Pnt" style code or the English name ("Tower Control")      kind  "series" | "open" (anarchy)
    stage     the stage's __RowId (VersusSceneInfo.json; CoopSceneInfo.json for salmon)
    weapon    WeaponInfoMain.json __RowId           grade "S+" with rank 4 -> "S+4"       xpower 2140
    party     [n, max]      salmometer 0-5          since / session  unix seconds (Presence fills them in)
    stage_name, squid   a name or color to use as is
"""
import json
import os
import random
import re
import struct
import sys
import threading
import time
import uuid

from . import log as clog

CLIENT_ID = "1575317865286860880"                 # public: it ships in the app, IPC needs no secret
BASE = "https://raw.githubusercontent.com/Lii-lac/cephalab/rpc-assets/"
BUTTON = {"label": "Cephalab", "url": "https://github.com/Lii-lac/cephalab"}
EVERY = 15.0                                       # Discord's own limit: one update per 15 s
BACKOFF = (1.0, 2.0, 5.0, 10.0, 30.0)
LEVELS = ("off", "basic", "full")
SQUIDS = ("blue", "cyan", "orange", "purple", "red", "yellow")
MODES = ("anarchy", "turf", "xbattle", "private", "challenge", "salmon")
WEAPON_MODES = ("anarchy", "turf", "xbattle", "private", "challenge")   # weapon badges baked in each mode's color
SOLO = ("xbattle", "challenge")                    # solo queues: no party line
PLACES = {"splatsville": "In Splatsville", "alterna": "In Alterna", "grizzco": "At Grizzco", "lobby": "In the Lobby",
          "matchroom": "In a battle room", "order": "In the Order Sector", "shop": "Shopping", "recon": "Recon",
          "match": "In a match"}
PLACE_SHORT = {"splatsville": "Splatsville", "alterna": "Alterna", "grizzco": "Grizzco", "lobby": "Lobby",
               "matchroom": "Lobby", "order": "Order Sector", "shop": "Splatsville", "recon": "Recon", "match": "Splatoon 3"}
KINDS = {"series": "Series", "open": "Open"}
MODE_NAMES = {"anarchy": "Anarchy Battle", "turf": "Turf War", "xbattle": "X Battle", "private": "Private Battle",
              "challenge": "Challenge", "salmon": "Salmon Run"}
OP_HANDSHAKE, OP_FRAME, OP_CLOSE, OP_PING, OP_PONG = 0, 1, 2, 3, 4


# --- frames: little-endian uint32 opcode + uint32 length + UTF-8 JSON

def encode(op: int, payload: dict) -> bytes:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return struct.pack("<II", op, len(body)) + body


def decode(read) -> tuple[int, dict]:
    """One frame from read(n) -> bytes (a short read means the pipe closed)."""
    head = _exactly(read, 8)
    op, n = struct.unpack("<II", head)
    if n > 1 << 20:
        raise OSError("Discord sent an oversized frame")
    return op, json.loads(_exactly(read, n).decode("utf-8")) if n else {}


def _exactly(read, n: int) -> bytes:
    out = b""
    while len(out) < n:
        chunk = read(n - len(out))
        if not chunk:
            raise OSError("Discord closed the pipe")
        out += chunk
    return out


# --- names (from the datamined game text we already ship)

_names: dict = {}


def _text(table: str) -> dict:
    if not _names:
        try:
            from s3seed.seedmath import DATA
            raw = json.loads((DATA / "USen.json").read_text(encoding="utf-8"))
            for k in ("CommonMsg/VS/VSStageName", "CommonMsg/Coop/CoopStageName", "CommonMsg/VS/VSRuleName", "CommonMsg/Weapon/WeaponName_Main"):
                _names[k] = raw.get(k, {})
        except (OSError, ValueError, ImportError):
            _names["-"] = {}
    return _names.get(table, {})


def weapon_row(wid) -> str:
    """The weapon's row id for a game weapon id, "" when unknown (the adapter's way in)."""
    try:
        from s3seed import equip
        return equip.weapon_row(wid)
    except Exception:
        return ""


def _stage_name(state: dict) -> str:
    if state.get("stage_name"):
        return str(state["stage_name"])
    code = state.get("stage")
    for t in (("CommonMsg/Coop/CoopStageName",) if state.get("mode") == "salmon" else ("CommonMsg/VS/VSStageName",)):
        tail = str(code).split("_", 1)[-1]
        for c in (code, tail, re.sub(r"\d+$", "", tail)):          # the lang table keys "Factory" for Vss_Factory00
            if c and c in _text(t):
                return _text(t)[c].replace("\n", " ")
    return ""


def _rule_name(rule) -> str:
    if not isinstance(rule, str) or not rule:
        return ""
    t = _text("CommonMsg/VS/VSRuleName")
    if rule in t:
        return t[rule].replace("\n", " ")
    return rule if rule in t.values() else ""


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# --- the card

def card(state: dict, level: str, rng) -> dict | None:
    """The activity for this state at this level, or None (off). rng picks the squid when state has none."""
    state = state or {}
    if level not in ("basic", "full") or state.get("closed"):
        return None
    squid = state.get("squid") if state.get("squid") in SQUIDS else rng.choice(SQUIDS)
    basic: dict = {"assets": {"large_image": f"{BASE}squid/{squid}.png", "large_text": "Splatoon 3"}}
    if _num(state.get("session")) is not None:
        basic["timestamps"] = {"start": int(state["session"])}
    if level == "basic":
        return basic

    place, mode = state.get("place"), state.get("mode")
    place = place if place in PLACES else None
    mode = mode if mode in MODES else None
    assets: dict = {}
    act: dict = {}

    # details: one line
    if mode:
        name = _rule_name(state.get("rule")) if mode in ("anarchy", "xbattle", "private", "challenge") else ""
        name = name or MODE_NAMES[mode]
        if mode == "anarchy" and state.get("kind") in KINDS:
            name = f"{name} ({KINDS[state['kind']]})"
        extra = ""
        if mode == "anarchy" and isinstance(state.get("grade"), str) and state["grade"]:
            r = _num(state.get("rank"))
            extra = state["grade"] + (str(int(r)) if r is not None else "")
        elif mode == "xbattle" and _num(state.get("xpower")) is not None:
            extra = f"{int(round(state['xpower']))} XP"
        elif mode == "salmon" and _num(state.get("rank")) is not None:
            extra = f"EVP {int(state['rank'])}"
        act["details"] = f"{name} · {extra}" if extra else name
    elif place == "match":
        act["details"] = _rule_name(state.get("rule")) or PLACES[place]
    elif place:
        act["details"] = PLACES[place]

    # large image: the stage in its mode's frame, else the squid
    stage, staged = state.get("stage"), False
    if mode and isinstance(stage, str) and stage:
        staged = True
        assets["large_image"] = f"{BASE}stage/{mode}/{stage}.png"
        sn = _stage_name(state)
        if sn:
            assets["large_text"] = sn
    else:
        assets["large_image"] = basic["assets"]["large_image"]
        assets["large_text"] = PLACE_SHORT[place] if place and not mode else "Splatoon 3"
        if place == "match" and not mode and _stage_name(state):
            assets["large_text"] = _stage_name(state)

    # small image: the Salmometer in Salmon Run, the weapon in battle (or when we don't know where you are)
    wp, sm = state.get("weapon"), state.get("salmometer")
    if mode == "salmon":
        if isinstance(sm, int) and not isinstance(sm, bool) and 0 <= sm <= 5:
            assets["small_image"] = f"{BASE}salmometer/{sm}.png"
            assets["small_text"] = f"Cohozuna · Salmometer {sm}/5"
    elif (mode or not place) and isinstance(wp, str) and wp:
        assets["small_image"] = f"{BASE}weapon/{mode}/{wp}.png" if mode in WEAPON_MODES else f"{BASE}weapon/{wp}.png"
        wn = _text("CommonMsg/Weapon/WeaponName_Main").get(wp)
        if wn:
            assets["small_text"] = wn

    # party: only when known, never in a solo queue
    pt = state.get("party")
    if mode not in SOLO and isinstance(pt, (list, tuple)) and len(pt) == 2 and all(isinstance(x, int) and not isinstance(x, bool) for x in pt) and 1 <= pt[0] <= pt[1]:
        act["party"] = {"id": "cephalab", "size": [pt[0], pt[1]]}

    if not (act or staged or "small_image" in assets):
        return basic
    act["assets"] = assets
    since = _num(state.get("since")) if _num(state.get("since")) is not None else _num(state.get("session"))
    if since is not None:
        act["timestamps"] = {"start": int(since)}
    act["buttons"] = [dict(BUTTON)]
    return act


# --- the pipe

WIN_PIPE = r"\\?\pipe\discord-ipc-%d"
UNIX_DIRS = ("XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP")


def unix_paths(env=None, isdir=os.path.isdir) -> list[str]:
    """macOS/Linux: discord-ipc-0..9 in the first existing dir of $XDG_RUNTIME_DIR, $TMPDIR, $TMP, $TEMP, /tmp."""
    env = os.environ if env is None else env
    for base in [env.get(k) for k in UNIX_DIRS] + ["/tmp"]:
        if base and isdir(base):
            return [f"{base.rstrip('/')}/discord-ipc-{i}" for i in range(10)]
    return []


class _Sock:
    """A connected AF_UNIX socket with the file calls Pipe uses (write sends it all; read may be short)."""

    def __init__(self, s):
        self.s = s

    def write(self, b: bytes):
        self.s.sendall(b)

    def read(self, n: int) -> bytes:
        return self.s.recv(n)

    def close(self):
        self.s.close()


def _unix_connect(path: str):
    import socket
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(5)
        s.connect(path)
        s.settimeout(None)
    except Exception:
        s.close()
        raise
    return _Sock(s)


class Pipe:
    """The local pipe to the Discord desktop app (first of discord-ipc-0..9 that opens), handshaken.
    Windows: the named pipe. macOS/Linux (or when connect is given): the AF_UNIX socket from unix_paths()."""

    def __init__(self, f):
        self.f = f

    @classmethod
    def open(cls, client_id: str = CLIENT_ID, path=WIN_PIPE, connect=None, env=None, isdir=os.path.isdir):
        if connect is None and sys.platform == "win32":
            targets, opener = [path % i for i in range(10)], lambda t: open(t, "r+b", buffering=0)
        else:
            targets, opener = unix_paths(env, isdir), connect or _unix_connect
        last = None
        for t in targets:
            try:
                f = opener(t)
            except OSError as e:
                last = e
                continue
            p = cls(f)
            try:
                p.send(OP_HANDSHAKE, {"v": 1, "client_id": client_id})
                p.recv()                                   # READY
                return p
            except Exception as e:
                last = e
                p.close()
        raise OSError(f"Discord isn't running ({last})")

    def send(self, op: int, payload: dict):
        self.f.write(encode(op, payload))

    def recv(self) -> tuple[int, dict]:
        return decode(self.f.read)

    def set_activity(self, activity: dict | None):
        self.send(OP_FRAME, {"cmd": "SET_ACTIVITY", "args": {"pid": os.getpid(), "activity": activity}, "nonce": str(uuid.uuid4())})
        while True:                                        # its reply (PING from Discord is answered, anything else ends)
            op, body = self.recv()
            if op == OP_PING:
                self.send(OP_PONG, body)
            elif op == OP_CLOSE:
                raise OSError("Discord closed the connection")
            else:
                if body.get("evt") == "ERROR":
                    clog.get().info("Discord refused the activity: %s", body.get("data"))
                return

    def close(self):
        try:
            self.f.close()
        except Exception:
            pass


_UNSET = object()


class Presence:
    """Keeps the card on Discord. source() -> state dict (the feeding side); open() -> a Pipe (a test passes a fake)."""
    name = "discord"

    def __init__(self, source=None, level: str = "basic", open=Pipe.open, clock=time.monotonic, wall=time.time, rng=None):
        self.source, self.level = source or (lambda: {}), level if level in LEVELS else "basic"
        self._open, self.clock, self.wall = open, clock, wall
        self.rng = rng or random.Random()
        self.wake = threading.Event()
        self.lock = threading.Lock()
        self.pipe = None
        self._sent = _UNSET                         # what Discord shows now (_UNSET: unknown, e.g. just connected)
        self._last_send = None
        self._fail = 0
        self._retry_at = 0.0
        self._key = None                            # (place, mode): the card's look; a new one rerolls squid + timer
        self._squid, self._since = None, None
        self._stage = None
        self._session = wall()
        self.sends = 0

    def configure(self, level: str):
        if level in LEVELS and level != self.level:
            with self.lock:
                self.level = level
            self.wake.set()

    def _state(self) -> dict:
        try:
            st = dict(self.source() or {})
        except Exception:
            clog.get().exception("Discord state feed failed")
            st = {}
        key = (st.get("place"), st.get("mode"))
        if key != self._key or self._squid is None or st.get("stage") != self._stage:
            self._stage = st.get("stage")                          # a new place or stage restarts the timer
            new_game = st.get("place") == "match" and (self._key or (None,))[0] != "match"
            if self._squid is None or new_game:                    # the squid's color changes per game, not per lobby screen
                self._squid = self.rng.choice(SQUIDS)
            self._key, self._since = key, self.wall()
        st.setdefault("squid", self._squid)
        st.setdefault("since", self._since if key != (None, None) else self._session)
        st.setdefault("session", self._session)
        return st

    def step(self) -> float:
        """Do what is due; return the seconds until the next look."""
        try:
            return self._step()
        except Exception:
            clog.get().exception("Discord presence step failed")
            self._drop()
            return 30.0

    def _step(self) -> float:
        now = self.clock()
        with self.lock:
            level = self.level
        want = card(self._state(), level, self.rng) if level != "off" else None
        if want is None and self._sent in (_UNSET, None):
            if level == "off" and self.pipe is not None:
                self._drop()                        # nothing shown: no reason to hold the pipe
            return 5.0
        if want == self._sent:
            return 2.0
        if want is not None and self._last_send is not None and now - self._last_send < EVERY:
            return max(0.2, EVERY - (now - self._last_send))     # newest state wins: send it when the 15 s are up
        if now < self._retry_at:
            return self._retry_at - now
        return self._send(want, now)

    def _send(self, want, now) -> float:
        try:
            if self.pipe is None:
                self.pipe = self._open()
                self._sent = _UNSET
            self.pipe.set_activity(want)
        except Exception as e:
            self._drop()
            wait = BACKOFF[min(self._fail, len(BACKOFF) - 1)]
            if self._fail == 0:
                clog.get().info("Discord isn't reachable (%s); trying again quietly", e)
            self._fail += 1
            self._retry_at = now + wait
            return wait
        self._fail, self._retry_at = 0, 0.0
        self._sent, self._last_send = want, now
        self.sends += 1
        return 2.0

    def _drop(self):
        if self.pipe is not None:
            self.pipe.close()
        self.pipe, self._sent = None, _UNSET

    def run(self, stop: threading.Event):
        try:
            while not stop.is_set():
                delay = self.step()
                self.wake.wait(min(delay, 5.0))
                self.wake.clear()
        finally:
            self.close()

    def close(self):
        """Clear the card (no waiting for the 15 s) and let go of the pipe."""
        if self.pipe is not None and self._sent not in (_UNSET, None):
            try:
                self.pipe.set_activity(None)
            except Exception:
                pass
        self._drop()


FRESH = 5 * 60 + 90                                # without a live Switch the card lasts this long after a battle ended:
                                                   # about one more game, plus SplatNet's 90 s check; then it goes away
FRESH_SALMON = 10 * 60 + 90                        # a Salmon Run job's time is when it started, and a shift runs ~5 min
CARD_PLACE = {"room": "lobby", "hub": "splatsville", "results": "match"}   # presence places -> card() places

# --- the match type: no Switch read has it, so the live stage + rule are matched against the public rotation
SCHEDULES_URL = "https://splatoon3.ink/data/schedules.json"
SCHEDULES_EVERY = 2 * 3600                         # at most one fetch per 2 h (a failed one counts)
SN_RULES = {"TURF_WAR": "Pnt", "TRI_COLOR": "Tcl", "AREA": "Var", "LOFT": "Vlf", "GOAL": "Vgl", "CLAM": "Vcl"}


def _fetch_schedules() -> dict:
    import urllib.request
    req = urllib.request.Request(SCHEDULES_URL, headers={"User-Agent": "Cephalab"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def _iso(t) -> float | None:
    import datetime
    try:
        return datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class Schedules:
    """splatoon3.ink's schedules.json, cached in cache/schedules.json (path), fetched at most once per SCHEDULES_EVERY.
    Network errors are silent: the type is just left off."""

    def __init__(self, path=None, fetch=None):
        self.path, self.fetch = path, fetch or _fetch_schedules
        self._data, self._tried = None, float("-inf")

    def get(self, now: float) -> dict | None:
        if self._data is None and self.path is not None:
            try:
                self._data = json.loads(self.path.read_text(encoding="utf-8"))
                self._tried = self.path.stat().st_mtime
            except (OSError, ValueError):
                pass
        if now - self._tried >= SCHEDULES_EVERY:
            self._tried = now
            try:
                data = self.fetch()
                if isinstance(data, dict):
                    self._data = data
                    if self.path is not None:
                        self.path.parent.mkdir(parents=True, exist_ok=True)
                        self.path.write_text(json.dumps(data), encoding="utf-8")
            except Exception:
                pass
        return self._data

    def match_type(self, now: float, stage_name: str, rule: str | None, x_ok: bool = True) -> tuple[str, str | None] | None:
        """(mode, kind) of the current rotation that has this stage + rule: ("turf", None), ("anarchy", "series" | "open"),
        ("xbattle", None), ("challenge", None); Turf outside a Splatfest is Regular; None when nothing matches."""
        data = (self.get(now) or {}).get("data") or {}
        fest_on = False
        groups = (("festSchedules", "festMatchSettings", "turf"), ("regularSchedules", "regularMatchSetting", "turf"),
                  ("bankaraSchedules", "bankaraMatchSettings", "anarchy"), ("xSchedules", "xMatchSetting", "xbattle"))
        for sched, field, mode in groups:
            if mode == "xbattle" and not x_ok:          # X Battle needs S+: skip it below S+ (the same stage + rule can be in X too)
                continue
            for node in (data.get(sched) or {}).get("nodes") or []:
                a, b = _iso(node.get("startTime")), _iso(node.get("endTime"))
                if a is None or b is None or not a <= now < b:
                    continue
                sets = node.get(field)
                sets = sets if isinstance(sets, list) else [sets] if isinstance(sets, dict) else []
                if sched == "festSchedules" and sets:
                    fest_on = True
                for ms in sets:
                    if not isinstance(ms, dict) or SN_RULES.get((ms.get("vsRule") or {}).get("rule")) != rule:
                        continue
                    if any(isinstance(v, dict) and v.get("name") == stage_name for v in ms.get("vsStages") or []):
                        kind = {"CHALLENGE": "series", "OPEN": "open"}.get(ms.get("bankaraMode")) if mode == "anarchy" else None
                        return mode, kind
        for node in (data.get("eventSchedules") or {}).get("nodes") or []:   # Challenge: periods inside the node
            ms = node.get("leagueMatchSetting") or {}
            if SN_RULES.get((ms.get("vsRule") or {}).get("rule")) != rule:
                continue
            if not any(isinstance(v, dict) and v.get("name") == stage_name for v in ms.get("vsStages") or []):
                continue
            for p in node.get("timePeriods") or []:
                a, b = _iso(p.get("startTime")), _iso(p.get("endTime"))
                if a is not None and b is not None and a <= now < b:
                    return "challenge", None
        if rule == "Pnt" and not fest_on:
            return "turf", None
        return None


schedules: Schedules | None = None


def _schedules(hub) -> Schedules:
    global schedules
    if schedules is None:
        d = getattr(hub, "dir", None)
        schedules = Schedules(d.parent / "cache" / "schedules.json" if d is not None else None)
    return schedules


def from_hub(hub, now=None) -> dict:
    """The adapter: what the Discord card can use from what the hub knows. With the Switch connected (botbase ok and its
    snapshot has a place: s3seed/presence.py) everything is live: place, stage, rule, party, anarchy grade, and the match
    type from the public rotation. Else mode, rule, stage and rank are the last match SplatNet reported (hub.last_match),
    shown while it ended under FRESH ago, on the bet he's still playing the same thing. Past that, or with nothing known
    at all, there is no card ({"closed": True}): there is no telling he's still playing. The weapon is live either way."""
    st: dict = {}
    now = time.time() if now is None else now
    snap = hub.snapshots.get("botbase") or {}
    bs = (hub.status.get("botbase") or {}).get("state")
    if bs == "waiting":
        return {"closed": True}        # the Switch answers but Splatoon 3 isn't running: no card, not an old SplatNet match
    ok = bs == "ok"
    if ok and snap.get("weapon") is not None:
        row = weapon_row(snap["weapon"])
        if row:
            st["weapon"] = row
    if ok and isinstance(snap.get("place"), str) and snap["place"]:
        p = snap["place"]
        st["place"] = CARD_PLACE.get(p, p)
        if st["place"] == "match" and isinstance(snap.get("stage"), str):
            st["stage"] = snap["stage"]
            if isinstance(snap.get("rule"), str):
                st["rule"] = snap["rule"]
            rank = snap.get("rank")
            x_ok = not (isinstance(rank, dict) and rank.get("grade") and not str(rank["grade"]).startswith("S+"))
            t = _schedules(hub).match_type(now, _stage_name({"stage": snap["stage"]}), st.get("rule"), x_ok)
            if t:
                st["mode"] = t[0]
                if t[1]:
                    st["kind"] = t[1]
                if t[0] == "anarchy" and isinstance(rank, dict) and rank.get("grade"):
                    st["grade"] = rank["grade"]
        pt, mx = snap.get("party"), snap.get("partyMax")
        if isinstance(pt, int) and isinstance(mx, int):
            st["party"] = [pt, mx]
        return st
    if ok and snap.get("seenAt") is not None and "rule" in snap:
        return st                      # the Switch is live but the place isn't known yet: don't fall back to an old match
    m = getattr(hub, "last_match", None)
    if not (isinstance(m, dict) and _num(m.get("ended")) is not None and m.get("mode") in MODES
            and now - m["ended"] < (FRESH_SALMON if m["mode"] == "salmon" else FRESH)):
        return st if ok else {"closed": True}   # Splatoon 3 is running on a live Switch; else no recent match: done, no card
    st["mode"] = m["mode"]
    for k in ("rule", "stage"):
        if m.get(k):
            st[k] = m[k]
    if m["mode"] == "anarchy" and m.get("grade"):
        st["grade"] = m["grade"]
        if _num(m.get("rank")) is not None:
            st["rank"] = m["rank"]
    elif m["mode"] == "xbattle" and _num(m.get("xpower")) is not None:
        st["xpower"] = m["xpower"]
    elif m["mode"] == "salmon" and _num(m.get("rank")) is not None:
        st["rank"] = m["rank"]
    if _num(m.get("started_streak")) is not None:
        st["since"] = m["started_streak"]
    return st
