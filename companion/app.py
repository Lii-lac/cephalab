"""Cephalab companion: reads your gear (Switch over sys-botbase, and/or SplatNet 3 through s3s), keeps every
snapshot, and serves the app at http://127.0.0.1:8765. The Switch address and SplatNet checking are set in the app's
Settings (kept in state/settings.json); the flags below set them from the command line and are remembered too.

    .venv\\Scripts\\python.exe -m companion --switch 192.168.1.50          CFW: exact seeds, live
    .venv\\Scripts\\python.exe -m companion --splatnet                     no CFW: subs from SplatNet 3
    .venv\\Scripts\\python.exe -m companion                                as last set in Settings
"""
import argparse
import sys
import threading
import webbrowser
from pathlib import Path

from .hub import Hub
from .settings import Settings, SettingsError


def root_dir() -> Path:
    """The repo (or, frozen as an .exe, the folder holding it): state/, cache/ and web/dist live here."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def flags_patch(args, current: dict) -> dict:
    """The settings the command line asks for (only the flags given)."""
    sw = {k: v for k, v in (("host", args.switch), ("port", args.botbase_port), ("every", args.every)) if v is not None}
    patch: dict = {"switch": sw} if sw else {}
    if args.splatnet and current["splatnet"]["every"] == "off":
        patch["splatnet"] = {"every": "battle"}
    return patch


def main(argv=None):
    ap = argparse.ArgumentParser(prog="companion", description="Cephalab companion")
    ap.add_argument("--switch", metavar="IP", help="the Switch's IP (System Settings > Internet), for sys-botbase")
    ap.add_argument("--every", type=float, help="seconds between Switch reads (default 15)")
    ap.add_argument("--botbase-port", type=int)
    ap.add_argument("--splatnet", action="store_true", help="read gear from SplatNet 3 (signs in to Nintendo once)")
    ap.add_argument("--port", type=int, default=8765, help="the app's port (default 8765)")
    ap.add_argument("--no-open", action="store_true", help="don't open the app in the browser")
    args = ap.parse_args(argv)

    root = root_dir()
    hub = Hub(root / "state")
    settings = Settings(root / "state" / "settings.json")
    try:
        settings.update(flags_patch(args, settings.get()))
    except SettingsError as e:
        print(e)
        return 2
    cfg = settings.get()

    from .botbase_source import BotbaseSource
    from .splatnet import SplatnetSource
    botbase = BotbaseSource(hub, **cfg["switch"])
    splatnet = SplatnetSource(hub, mode=cfg["splatnet"]["every"])
    settings.on_change(lambda new, old: (botbase.configure(**new["switch"]), splatnet.set_mode(new["splatnet"]["every"])))

    from .server import App
    from .updater import Updater
    stop = threading.Event()
    updater = Updater(on_change=lambda st: hub.emit("update", st))
    app_obj = App(hub, root, args.port, splatnet, settings=settings, botbase=botbase, updater=updater)
    try:                                              # bind first: a second copy stops here, before it polls anything
        server = app_obj.serve()
    except OSError as e:
        print(f"Can't open port {args.port} ({e.strerror}); is the companion already running? Try --port 8766.")
        return 1
    app_obj.on_exit = lambda: (stop.set(), server.shutdown())
    for s in (botbase, splatnet):
        threading.Thread(target=s.run, args=(stop,), daemon=True, name=s.name).start()
    if cfg.get("updates", {}).get("auto", True):
        threading.Thread(target=updater.check, daemon=True, name="updater").start()
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Cephalab: {url}  (Ctrl+C to stop)")
    if not args.no_open:                              # a restart: the tab already open reconnects (~1 s), so no new tab for it
        def open_unless_reconnected():
            if not stop.wait(3.0) and not hub.clients:
                webbrowser.open(url)
        threading.Thread(target=open_unless_reconnected, daemon=True, name="open").start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        botbase.wake.set()
        splatnet.wake.set()
        server.server_close()
    return 0
