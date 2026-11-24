"""The companion's local web server (127.0.0.1 only): the built app, game images, and the API the app reads.

    GET  /api/state            every source's latest snapshot and status
    GET  /api/events           server-sent events: state (on connect), snapshot, status, source-error, login-needed
    GET  /api/login            {enabled, signedIn, fApi}
    POST /api/login/link       {url}: the Nintendo sign-in link (the same one for 15 minutes)
    POST /api/login {link}     the pasted "Select this account" link
    POST /api/logout, /api/refresh
    POST /api/import           an s3s --getseed export (gear_*.json) as the "file" source
    POST /api/watch {pieces}   the pieces the Path plans; the Switch reads just these between whole reads
    GET  /api/wearing          what the avatar wears now: {weapon: {id, row}, head, clothes, shoes: {gearId, row, main, subs}} (409 when unknown)
    POST /api/equip/find       start looking for where the game keeps the worn gear (202; {cancel: true} stops it; /api/wearing
                               starts it by itself when the record moved); GET /api/equip/find: {state, scanned, ...} while it runs and after
    GET/POST /api/builds       a copy of your builds (state/builds.json; each change appended to builds-history.jsonl)
    GET/POST /api/settings, POST /api/switch/test, /api/data/open, /api/cache/clear, /api/reset   (control.py)
    GET  /api/sendou/<slug>    sendou.ink's builds for a weapon (cached a day)
    GET  /img/<kind>/<name>.png
    GET  /...                  web/dist (the app), index.html for routes

Only requests addressed to this machine by name are answered (Host check against DNS rebinding), and POSTs must be
JSON from the app's own origin, so another site open in the browser can't drive it.
"""
import base64
import json
import mimetypes
import queue
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from s3seed import equip

from . import control, images, sendou
from .botbase_source import Unavailable
from .hub import Hub
from .splatnet import F_GEN_URL, SplatnetError, pieces_from_outfit
from .updater import Updater

MAX_BODY = 8 * 1024 * 1024
TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css",
         ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
         ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}
NO_APP = b"""<!doctype html><meta charset="utf-8"><title>Cephalab</title>
<p style="font:16px system-ui;margin:48px">The app isn't built yet: <code>cd web &amp;&amp; npm install &amp;&amp; npm run build</code>,
then reload. The API is running at <a href="/api/state">/api/state</a>.</p>"""


def decode_export(doc: dict) -> tuple[str, list[dict]]:
    """An s3s --getseed export: key = base64 of the player id XORed with the low byte of its murmur3 hash (h)."""
    try:
        h = int(doc["h"]) & 0xFF
        key = bytes(b ^ h for b in base64.b64decode(doc["key"])).decode("utf-8")
    except (KeyError, TypeError, ValueError):
        raise ValueError("not an s3s --getseed export (needs key, h and gear)") from None
    pieces = pieces_from_outfit(doc.get("gear") or {})
    if not pieces:
        raise ValueError("the export holds no gear")
    return key, pieces


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second companion bind the same port silently (two pollers on one account);
    # without it the second start fails and says so.
    allow_reuse_address = sys.platform != "win32"


class App:
    def __init__(self, hub: Hub, root: Path, port: int, splatnet=None, settings=None, botbase=None, updater=None, on_exit=None):
        self.hub, self.root, self.port, self.splatnet = hub, root, port, splatnet
        self.settings, self.botbase = settings, botbase          # None: the settings endpoints answer 409
        self.updater = updater if updater is not None else Updater()
        self.on_exit = on_exit
        self.open_folder = control.open_folder
        bundle = Path(getattr(sys, "_MEIPASS", root))      # the .exe carries the built app inside it
        self.dist = (bundle / "web" / "dist").resolve()
        self.img_cache = root / "cache" / "img"
        self.sendou_cache = root / "cache" / "sendou"
        self._allow(port)

    def _allow(self, port: int):
        self.port = port
        self.hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.origins = {f"http://{h}" for h in self.hosts}

    def serve(self) -> ThreadingHTTPServer:
        srv = Server(("127.0.0.1", self.port), make_handler(self))
        self._allow(srv.server_address[1])                 # port 0 = any free port (tests)
        return srv


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code: int, body: bytes, ctype: str, cache: str = "no-store"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, code: int, obj):
            self._send(code, json.dumps(obj).encode(), "application/json")

        def _host_ok(self) -> bool:
            if self.headers.get("Host", "") not in app.hosts:
                self._send(403, b"forbidden", "text/plain")
                return False
            return True

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            if not self._host_ok():
                return
            path = urlparse(self.path).path
            if path == "/api/state":
                return self._json(200, app.hub.state())
            if path == "/api/events":
                return self._events()
            if path == "/api/login":
                return self._json(200, self._login_state())
            if path == "/api/builds":
                return self._json(200, {"builds": app.hub.builds()})
            if path == "/api/wearing":
                return self._wearing()
            if path == "/api/equip/find":
                return self._json(200, app.botbase.equip_state() if app.botbase else {"state": "idle"})
            if path == "/api/settings":
                if app.settings is None:
                    return self._json(409, {"error": "settings aren't available"})
                return self._json(200, control.view(app))
            if path == "/api/update":
                return self._json(200, app.updater.status())
            if path.startswith("/api/sendou/"):
                try:
                    return self._json(200, sendou.builds(path[len("/api/sendou/"):], app.sendou_cache))
                except sendou.SendouError as e:
                    return self._json(502, {"error": str(e)})
            if path.startswith("/api/"):
                return self._json(404, {"error": "no such endpoint"})
            if path.startswith("/img/"):
                parts = path[5:].split("/")
                if len(parts) != 2 or "." not in parts[1]:
                    return self._send(404, b"", "text/plain")
                name, _, e = parts[1].rpartition(".")
                data = images.image(app.img_cache, parts[0], name) if e == images.ext(parts[0]) else None
                ctype = "image/avif" if e == "avif" else "image/png"
                if data is None:
                    return self._send(404, b"", ctype)
                return self._send(200, data, ctype, "max-age=604800")
            return self._static(path)

        def do_POST(self):
            if not self._host_ok():
                return
            origin = self.headers.get("Origin")
            if (origin and origin not in app.origins) or not self.headers.get("Content-Type", "").startswith("application/json"):
                return self._json(403, {"error": "forbidden"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if n < 0 or n > MAX_BODY:
                return self._json(413, {"error": "too large"})
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self._json(400, {"error": "not JSON"})
            path = urlparse(self.path).path
            sn = app.splatnet
            if path in ("/api/settings", "/api/switch/test", "/api/data/open", "/api/cache/clear", "/api/reset"):
                if app.settings is None or app.botbase is None:
                    return self._json(409, {"error": "settings aren't available"})
                return self._json(*control.post(app, path, body))
            if path == "/api/builds":                        # your builds' copy: {builds: [...]}, every change kept in the history
                bs = body.get("builds") if isinstance(body, dict) else None
                if not isinstance(bs, list) or len(bs) > 2000 or not all(isinstance(b, dict) for b in bs):
                    return self._json(400, {"error": "builds: a list"})
                app.hub.save_builds(bs)
                return self._json(200, {"ok": True})
            if path == "/api/watch":                         # the pieces the Path plans: {pieces: [{slot, gearId}]}
                ps = body.get("pieces") if isinstance(body, dict) else None
                if not isinstance(ps, list) or len(ps) > 3 or not all(isinstance(p, dict) and p.get("slot") in ("head", "clothes", "shoes")
                                                                     and isinstance(p.get("gearId"), int) for p in ps):
                    return self._json(400, {"error": "pieces: up to 3 {slot, gearId}"})
                app.hub.set_watch([(p["slot"], p["gearId"]) for p in ps])
                return self._json(200, {"ok": True})
            if path == "/api/equip/find":                    # dev: start the search; {cancel: true} stops it
                if app.botbase is None:
                    return self._json(409, {"error": "no Switch source"})
                if isinstance(body, dict) and body.get("cancel"):
                    app.botbase.equip_cancel()
                    return self._json(200, {"ok": True})
                try:
                    started = app.botbase.equip_find()
                except Unavailable as e:
                    return self._json(409, {"error": str(e)})
                return self._json(202 if started else 409, app.botbase.equip_state() if started else {"error": "a find is already running"})
            if path == "/api/import":
                try:
                    key, pieces = decode_export(body)
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
                app.hub.publish({"source": "file", "gameVersion": "", "playerKey": key, "pieces": pieces})
                return self._json(200, {"ok": True, "pieces": len(pieces)})
            if path in ("/api/login", "/api/login/link", "/api/logout", "/api/refresh") and sn is None:
                return self._json(409, {"error": "SplatNet isn't turned on (Settings > Check SplatNet)"})
            if path == "/api/login":
                try:
                    sn.finish_login(str(body.get("link", "")))
                except SplatnetError as e:
                    return self._json(400, {"error": str(e)})
                return self._json(200, {"ok": True})
            if path == "/api/login/link":                    # a POST, so no other site can void the open link
                return self._json(200, {"url": sn.login_url()})
            if path == "/api/logout":
                sn.logout()
                return self._json(200, {"ok": True})
            if path == "/api/refresh":
                return self._json(200, {"ok": True, "queued": sn.refresh()})
            if path == "/api/update/check":
                return self._json(200, app.updater.check())
            if path == "/api/update/install":
                return self._json(200, app.updater.install(on_exit=app.on_exit))
            return self._json(404, {"error": "no such endpoint"})

        def _wearing(self):
            if app.botbase is None:
                return self._json(409, {"error": "No Switch connected"})
            try:
                ids = app.botbase.wearing()
            except Unavailable as e:
                return self._json(503 if e.busy else 409, {"error": str(e)})
            try:
                return self._json(200, equip.outfit(ids, (app.hub.state()["snapshots"].get("botbase") or {}).get("pieces") or []))
            except KeyError as e:
                return self._json(404, {"error": f"The {e.args[0]} you wear isn't in the gear last read; wait for the next read"})

        def _login_state(self) -> dict:
            sn = app.splatnet
            if sn is None:
                return {"enabled": False}
            signed = bool(sn.vault.load().get("session_token"))       # signing in works while checking is off, so
            return {"enabled": True, "signedIn": signed, "checking": sn.mode, "fApi": F_GEN_URL}   # it can come first

        def _events(self):
            q = app.hub.subscribe()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                self._event("state", app.hub.state())
                while True:
                    try:
                        ev, data = q.get(timeout=15)
                        self._event(ev, data)
                    except queue.Empty:
                        if not app.hub.subscribed(q):         # dropped for falling behind: end; the page reconnects
                            break
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                app.hub.unsubscribe(q)
                self.close_connection = True

        def _event(self, ev: str, data):
            self.wfile.write(f"event: {ev}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode())
            self.wfile.flush()

        def _static(self, path: str):
            if not (app.dist / "index.html").exists():
                return self._send(200, NO_APP, "text/html; charset=utf-8")
            rel = path.lstrip("/") or "index.html"
            try:
                f = (app.dist / rel).resolve()
            except (OSError, ValueError):
                return self._send(404, b"not found", "text/plain")
            if not f.is_relative_to(app.dist):
                return self._send(404, b"not found", "text/plain")
            if not f.is_file():
                if "." in Path(rel).name:                     # a missing file, not an app route
                    return self._send(404, b"not found", "text/plain")
                f = app.dist / "index.html"
            ctype = TYPES.get(f.suffix.lower()) or mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            cache = "no-store" if f.name == "index.html" else "max-age=31536000, immutable" if "/assets/" in f.as_posix() else "no-cache"
            self._send(200, f.read_bytes(), ctype, cache)

    return Handler
