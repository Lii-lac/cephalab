"""The Settings screen's endpoints (server.py routes them here).

    GET  /api/settings       {switch: {host, port, every}, splatnet: {every}, data: {folder, cacheBytes}}
    POST /api/settings       any part of {switch: {...}, splatnet: {...}} -> the whole object again (400 {error})
    POST /api/switch/test    {host, port} -> {ok: true, version} | {ok: false, error}
    POST /api/data/open      opens the state folder in Explorer
    POST /api/cache/clear    deletes the cached game images and sendou builds -> {ok, cacheBytes}
    POST /api/reset          signs out of SplatNet, forgets every snapshot, the log and the settings
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

from .settings import SettingsError

CACHE_DIRS = ("img", "sendou")


def cache_bytes(root: Path) -> int:
    total = 0
    for d in CACHE_DIRS:
        for dirpath, _, files in os.walk(root / "cache" / d):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, f))
                except OSError:
                    pass
    return total


def open_folder(path: Path):
    if path.is_file():
        target = path
    else:
        path.mkdir(parents=True, exist_ok=True)
        target = path
    if sys.platform == "win32":
        os.startfile(str(target))                                # noqa: S606 (our own folder or log)
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(target)])


def view(app) -> dict:
    return {**app.settings.get(), "data": {"folder": str(app.hub.dir), "cacheBytes": cache_bytes(app.root)}}


def post(app, path: str, body) -> tuple[int, dict] | None:
    """(status, reply) for the settings endpoints, None for any other path."""
    if path == "/api/settings":
        try:
            app.settings.update(body)
        except SettingsError as e:
            return 400, {"error": str(e)}
        return 200, view(app)
    if path == "/api/switch/test":
        if not isinstance(body, dict):
            return 400, {"error": "expected {host, port}"}
        try:
            clean = app.settings.check({"switch": {"host": body.get("host", ""), "port": body.get("port", 6000)}})["switch"]
        except SettingsError as e:
            return 200, {"ok": False, "error": str(e)}
        if not clean["host"]:
            return 200, {"ok": False, "error": "Type the Switch's IP address first."}
        return 200, app.botbase.test(clean["host"], clean["port"])
    if path == "/api/data/open":
        try:
            app.open_folder(app.hub.dir)
        except OSError as e:
            return 500, {"error": f"Couldn't open the folder ({e.strerror or e})"}
        return 200, {"ok": True}
    if path == "/api/cache/clear":
        for d in CACHE_DIRS:
            shutil.rmtree(app.root / "cache" / d, ignore_errors=True)
        return 200, {"ok": True, "cacheBytes": cache_bytes(app.root)}
    if path == "/api/reset":
        if app.splatnet is not None:
            app.splatnet.logout()
        app.settings.reset()
        app.hub.reset()
        return 200, {"ok": True}
    return None
