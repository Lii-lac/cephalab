"""The companion's one shared state: the latest snapshot and status per source, the snapshot log, and the page's
event streams.

A snapshot is what a source saw at one moment (core/API.md names):
    {source, gameVersion, playerKey?, pieces: [{slot, gearId, row, brand, main, subs[3], seed?, rarity?, exp?}], stock?,
     wearing?, drink?, xpGainMax?, at}
rarity (botbase only) = the piece's stars; the page shows slots past min(3, stars + 1) as locked. exp = the piece's XP.
stock (botbase, once found): {chunks?: {ability: n}, drinks?: {ability: n}} (s3seed/stock.py).
wearing (botbase, once the outfit was found): {head, clothes, shoes: gearId}. drink (botbase, once found): {ability,
battles} or null with no drink active (s3seed/drink.py). xpGainMax: the largest one-poll XP rise seen on a watched piece.
Every snapshot that differs from the source's previous one goes into state/log.jsonl as the pieces that changed (and
what they were), and the latest per source is kept whole in state/last_<source>.json, so a restart (or a page that
was closed) loses nothing.
"""
import json
import queue
import threading
import time
from pathlib import Path

SOURCES = ("botbase", "s3s", "file")
LIVE = ("stock", "drink", "wearing", "weapon", "xpGainMax", "player")   # snapshot keys besides the pieces whose change counts (and is logged)
# botbase's live presence for the Discord card (s3seed/presence.py): kept current in the snapshot (presence(), and carried
# by publish) but never a change of its own: not logged, not streamed, so a lobby wait doesn't flood log.jsonl
PRESENCE = ("place", "stage", "rule", "party", "partyMax", "rank", "salmon", "capsules")


def _same(a: dict | None, b: dict) -> bool:
    """Whether two snapshots hold the same gear (the time they were taken doesn't count)."""
    if a is None:
        return False
    if a.get("gameVersion") != b.get("gameVersion") or a.get("playerKey") != b.get("playerKey"):
        return False
    if any(a.get(k) != b.get(k) for k in LIVE):
        return False
    return {_key(p): p for p in a["pieces"]} == {_key(p): p for p in b["pieces"]}     # order doesn't count


def _key(p: dict) -> str:
    return f"{p['slot']}:{p['gearId']}"


def _delta(old: dict | None, new: dict) -> dict:
    """The log line for a new snapshot: only the pieces that changed, with what they were (a whole inventory per roll
    would bloat the log), or everything when there's nothing to compare with."""
    head = {k: new.get(k) for k in ("source", "at", "gameVersion", "playerKey") if new.get(k) is not None}
    if old is None or old.get("gameVersion") != new.get("gameVersion") or old.get("playerKey") != new.get("playerKey"):
        return {**head, "full": True, "pieces": new["pieces"]}
    was = {_key(p): p for p in old["pieces"]}
    now = {_key(p): p for p in new["pieces"]}
    for k in LIVE:
        if new.get(k) != old.get(k):
            head[k] = new.get(k)
    return {**head, "changed": [p for k, p in now.items() if was.get(k) != p],
            "was": [was[k] for k, p in now.items() if k in was and was[k] != p],
            "removed": [k for k in was if k not in now]}


class Hub:
    def __init__(self, state_dir: Path):
        self.dir = state_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.snapshots: dict[str, dict] = {}
        self.status: dict[str, dict] = {}
        self.last_match: dict | None = None    # the newest match SplatNet reported (splatnet.next_match), for the Discord card
        self.clients: list[queue.Queue] = []
        for s in SOURCES:
            p = self.dir / f"last_{s}.json"
            if p.exists():
                try:
                    self.snapshots[s] = json.loads(p.read_text(encoding="utf-8"))
                except ValueError:
                    pass                     # a torn file from a crash: the log still has it

    # --- a copy of your builds (the browser's can be wiped): the latest, and every change in a history file
    def builds(self) -> list | None:
        try:
            return json.loads((self.dir / "builds.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def save_builds(self, builds: list):
        with self.lock:
            text = json.dumps(builds, ensure_ascii=False)
            p = self.dir / "builds.json"
            try:
                if p.exists() and p.read_text(encoding="utf-8") == text:
                    return
            except OSError:
                pass
            with open(self.dir / "builds-history.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"at": time.time(), "builds": builds}, ensure_ascii=False) + "\n")
            tmp = self.dir / "builds.json.tmp"
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(p)

    # --- the pieces the Path is planning (POST /api/watch): botbase reads just these between whole reads
    def set_watch(self, pieces: list[tuple[str, int]]):
        with self.lock:
            self._watch = list(pieces)
            try:
                (self.dir / "watch.json").write_text(json.dumps([[t, g] for t, g in self._watch]), encoding="utf-8")
            except OSError:
                pass

    def watched(self) -> list[tuple[str, int]]:
        with self.lock:
            if not hasattr(self, "_watch"):
                try:
                    self._watch = [(str(t), int(g)) for t, g in json.loads((self.dir / "watch.json").read_text(encoding="utf-8"))]
                except (OSError, ValueError, TypeError):
                    self._watch = []
            return list(self._watch)

    # --- sources call these
    def publish(self, snap: dict) -> bool:
        """A source's fresh reading. Returns True when it changed anything (and was logged and streamed)."""
        src = snap["source"]
        snap = {**snap, "at": snap.get("at") or time.time()}
        with self.lock:
            old = self.snapshots.get(src)
            if _same(old, snap):
                keep = {k: v for k, v in old.items() if k not in PRESENCE}
                self.snapshots[src] = {**keep, **{k: snap[k] for k in PRESENCE if k in snap}, "seenAt": snap["at"]}   # replaced, never mutated: readers may be
                return False                                         # serialising the old one right now
            line = _delta(self.snapshots.get(src), snap)
            self.snapshots[src] = snap
            with open(self.dir / "log.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(line, separators=(",", ":")) + "\n")
            tmp = self.dir / f"last_{src}.json.tmp"
            tmp.write_text(json.dumps(snap), encoding="utf-8")
            tmp.replace(self.dir / f"last_{src}.json")
        self.emit("snapshot", snap)
        return True

    def presence(self, source: str, values: dict):
        """The source's live presence values (PRESENCE keys) into its latest snapshot, without logging or streaming."""
        with self.lock:
            old = self.snapshots.get(source)
            if old is not None:
                self.snapshots[source] = {**{k: v for k, v in old.items() if k not in PRESENCE},
                                          **{k: v for k, v in values.items() if k in PRESENCE}}

    def set_status(self, source: str, state: str, message: str = "", **extra):
        """state: off | starting | connecting | waiting | ok | error | login-needed."""
        st = {"state": state, "message": message, "at": time.time(), **extra}
        with self.lock:
            old = self.status.get(source)
            self.status[source] = st
        if old and old.get("state") == state and old.get("message") == message:
            return
        self.emit("status", {"source": source, **st})
        if state == "error":
            self.emit("source-error", {"source": source, "message": message})
        elif state == "login-needed":
            self.emit("login-needed", {"source": source, "message": message})

    def reset(self):
        """Forget every snapshot and the log (Settings > Reset everything); the page gets an empty state."""
        with self.lock:
            self.snapshots = {}
            for name in ["log.jsonl", "splatnet_raw.json", "builds.json"] + [f"last_{s}.json" for s in SOURCES]:   # builds-history.jsonl stays: the way back
                try:
                    (self.dir / name).unlink()
                except FileNotFoundError:
                    pass
        self.emit("state", self.state())

    # --- the page reads these
    def state(self) -> dict:
        with self.lock:
            return {"snapshots": {k: v for k, v in self.snapshots.items()}, "status": dict(self.status), "at": time.time()}

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self.lock:
            self.clients.append(q)
        return q

    def subscribed(self, q: queue.Queue) -> bool:
        with self.lock:
            return q in self.clients

    def unsubscribe(self, q: queue.Queue):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)

    def emit(self, event: str, data: dict):
        with self.lock:
            clients = list(self.clients)
        for q in clients:
            try:
                q.put_nowait((event, data))
            except queue.Full:               # a stuck page: drop it, it reconnects and reads /api/state
                self.unsubscribe(q)
