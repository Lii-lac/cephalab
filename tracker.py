"""Cephalab: live Splatoon 3 gear seed tracker.

Polls the Switch through sys-botbase, keeps every gear piece's current seed, logs each roll as it
happens and serves a small page at http://127.0.0.1:8765 with the seeds and the rolls to come.

    .venv\\Scripts\\python.exe tracker.py 192.168.1.50          (the Switch's IP)
    .venv\\Scripts\\python.exe tracker.py 192.168.1.50 --every 10 --port 8765
"""
import argparse
import json
import re
import urllib.request
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from s3seed import gear as G
from s3seed.botbase import Botbase, BotbaseError, NoGame
from s3seed.seedmath import ABILITY_ORDER, explain_change, predict

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
PAGE = ROOT / "page" / "index.html"
SPLATOON3 = "0100C2500FC20000"
IMG_CACHE = ROOT / "cache" / "img"
IMG_SRC = "https://leanny.github.io/splat3/images"
IMG_KINDS = {"skill", "gear", "weapon_flat", "brand", "subspe", "weapon_type"}
_img_lock = threading.Lock()


def image(kind: str, name: str) -> bytes | None:
    """Leanny's game images, fetched once and kept in cache/img/ so the page works offline."""
    if kind not in IMG_KINDS or not re.fullmatch(r"[A-Za-z0-9_]{1,80}", name):
        return None
    path = IMG_CACHE / kind / f"{name}.png"
    if path.exists():
        return path.read_bytes()
    with _img_lock:
        if path.exists():
            return path.read_bytes()
        try:
            req = urllib.request.Request(f"{IMG_SRC}/{kind}/{name}.png", headers={"User-Agent": "Cephalab"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = r.read()
        except OSError:
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        return data


class Tracker:
    def __init__(self, bot: Botbase, every: float):
        self.bot, self.every = bot, every
        self.lock = threading.Lock()
        self.gear: dict[str, G.Gear] = {}
        self.changed: dict[str, float] = {}
        self.log: list[dict] = []
        self.status = {"state": "starting", "message": "", "last_read": None, "version": "", "dlc": None}
        self.dlc: int | None = None
        STATE.mkdir(exist_ok=True)
        self._load_previous()

    # --- persistence: the last snapshot lets a restart still notice rolls made while it was off
    def _load_previous(self):
        snap = STATE / "last.json"
        if snap.exists():
            try:
                for d in json.loads(snap.read_text(encoding="utf-8")):
                    g = G.Gear(**{k: d[k] for k in G.Gear.__dataclass_fields__})
                    self.gear[g.key] = g
            except (ValueError, KeyError, TypeError):
                self.gear = {}
        logf = STATE / "log.jsonl"
        if logf.exists():
            for line in logf.read_text(encoding="utf-8").splitlines()[-200:]:
                try:
                    self.log.append(json.loads(line))
                except ValueError:
                    pass

    def _save(self):
        tmp = STATE / "last.json.tmp"
        tmp.write_text(json.dumps([g.to_json() for g in self.gear.values()]), encoding="utf-8")
        tmp.replace(STATE / "last.json")

    def _event(self, ev: dict):
        self.log.append(ev)
        self.log = self.log[-200:]
        with open(STATE / "log.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(ev) + "\n")

    # --- polling
    def _set(self, state: str, message: str = ""):
        with self.lock:
            self.status.update(state=state, message=message)

    def _connect(self):
        self.bot.connect()
        title = self.bot.title_id().upper()
        if not title:
            raise NoGame("no game running")
        version = self.bot.game_version() if title == SPLATOON3 else ""
        self.dlc = G.detect_dlc(self.bot)
        with self.lock:
            self.status.update(version=version, dlc=self.dlc)
        if self.dlc is None:
            if title != SPLATOON3:
                raise NoGame(f"Splatoon 3 isn't the running game ({title})")
            raise BotbaseError(f"no gear at the known address: these offsets are for v{G.GAME_VERSION}, "
                               f"the game is v{version or '?'} (or it's still on the title screen)")

    def diff(self, fresh: list[G.Gear]) -> list[dict]:
        events, now = [], time.time()
        first_read = not self.gear
        for g in fresh:
            old = self.gear.get(g.key)
            if old is None or first_read:
                continue
            if old.seed == g.seed and old.subs == g.subs:
                continue
            ev = {"t": now, "key": g.key, "name": g.name, "type": g.type,
                  "old_seed": f"0x{old.seed:08x}", "new_seed": f"0x{g.seed:08x}",
                  "steps": explain_change(old.seed, g.seed, g.brand) if old.seed != g.seed else 0,
                  "slots": []}
            for i, (a, b) in enumerate(zip(old.subs, g.subs)):
                if a != b:
                    ev["slots"].append({"slot": i + 1, "was": G.ability_name(a) if a else "",
                                        "now": G.ability_name(b) if b else "", "was_id": a, "now_id": b})
            events.append(ev)
            self.changed[g.key] = now
        return events

    def poll_once(self):
        fresh = G.read_all(self.bot, self.dlc)
        if not fresh:
            raise BotbaseError("read no gear (still on the title screen?)")
        with self.lock:
            for ev in self.diff(fresh):
                self._event(ev)
            self.gear = {g.key: g for g in fresh}
            self.status.update(state="ok", message="", last_read=time.time())
            self._save()

    def run(self, stop: threading.Event):
        backoff = 2
        while not stop.is_set():
            try:
                if not self.bot.sock or self.dlc is None:
                    self._set("connecting", f"connecting to {self.bot.host}")
                    self._connect()
                self.poll_once()
                backoff = 2
                stop.wait(self.every)
            except NoGame as e:
                self.bot.close()
                self.dlc = None
                self._set("waiting", str(e))
                stop.wait(5)
            except BotbaseError as e:
                self.bot.close()
                self.dlc = None
                self._set("error", str(e))
                stop.wait(backoff)
                backoff = min(backoff * 2, 30)

    # --- what the page asks for
    def snapshot(self) -> dict:
        with self.lock:
            items = []
            for g in self.gear.values():
                d = g.to_json()
                d["changed"] = self.changed.get(g.key)
                d["main_name"] = G.ability_name(g.main)
                d["sub_names"] = [G.ability_name(s) if s else "" for s in g.subs]
                d["next"] = [dict(r, name=G.ability_name(r["ability"])) for r in predict(g.seed, g.brand, None, 6)]
                items.append(d)
            items.sort(key=lambda d: (-(d["changed"] or 0), G.TYPES.index(d["type"]), d["name"]))
            return {"status": dict(self.status), "gear": items, "log": list(reversed(self.log[-50:])),
                    "abilities": [{"id": a, "name": G.ability_name(a)} for a in ABILITY_ORDER]}

    def predict(self, key: str, drink: str | None, n: int) -> dict | None:
        with self.lock:
            g = self.gear.get(key)
        if not g:
            return None
        n = max(1, min(n, 200))
        return {"key": key, "drink": drink,
                "rolls": [dict(r, name=G.ability_name(r["ability"]), seed_hex=f"0x{r['seed']:08x}")
                          for r in predict(g.seed, g.brand, drink, n)]}


def make_handler(tracker: Tracker):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/":
                self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            elif u.path.startswith("/img/"):
                parts = u.path[5:].removesuffix(".png").split("/")
                data = image(*parts) if len(parts) == 2 else None
                if data is None:
                    return self._send(404, b"", "image/png")
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Cache-Control", "max-age=604800")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif u.path == "/api/state":
                self._send(200, json.dumps(tracker.snapshot()).encode(), "application/json")
            elif u.path == "/api/predict":
                q = parse_qs(u.query)
                drink = q.get("drink", [""])[0] or None
                if drink and drink not in ABILITY_ORDER:
                    return self._send(400, b'{"error":"unknown drink"}', "application/json")
                try:
                    n = int(q.get("n", ["20"])[0])
                except ValueError:
                    n = 20
                res = tracker.predict(q.get("key", [""])[0], drink, n)
                if res is None:
                    return self._send(404, b'{"error":"no such gear"}', "application/json")
                self._send(200, json.dumps(res).encode(), "application/json")
            else:
                self._send(404, b"not found", "text/plain")
    return Handler


def main():
    ap = argparse.ArgumentParser(description="Cephalab — live Splatoon 3 gear seed tracker (sys-botbase)")
    ap.add_argument("ip", help="the Switch's IP address (System Settings > Internet)")
    ap.add_argument("--every", type=float, default=15, help="seconds between reads (default 15)")
    ap.add_argument("--port", type=int, default=8765, help="page port (default 8765)")
    ap.add_argument("--botbase-port", type=int, default=6000)
    ap.add_argument("--no-open", action="store_true", help="don't open the page")
    args = ap.parse_args()

    tracker = Tracker(Botbase(args.ip, args.botbase_port), max(3.0, args.every))
    stop = threading.Event()
    threading.Thread(target=tracker.run, args=(stop,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(tracker))
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Tracking {args.ip} every {tracker.every:g}s. Page: {url}  (Ctrl+C to stop)")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        tracker.bot.close()


if __name__ == "__main__":
    main()
