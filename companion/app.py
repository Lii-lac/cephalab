"""Cephalab companion: reads your gear (Switch over sys-botbase, and/or SplatNet 3 through s3s), keeps every
snapshot, and serves the app at http://127.0.0.1:8765. The Switch address and SplatNet checking are set in the app's
Settings (kept in state/settings.json); the flags below set them from the command line and are remembered too.

    .venv\\Scripts\\python.exe -m companion --switch 192.168.1.50          CFW: exact seeds, live
    .venv\\Scripts\\python.exe -m companion --splatnet                     no CFW: subs from SplatNet 3
    .venv\\Scripts\\python.exe -m companion                                as last set in Settings
"""
import argparse
import json
import sys
import threading
import urllib.request
import webbrowser
from pathlib import Path

from . import control, log as clog, protocol, tray as tray_mod
from .hub import Hub
from .settings import Settings, SettingsError


def root_dir() -> Path:
    """The repo (or, frozen as an .exe, the folder holding it): state/, cache/ and web/dist live here."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def icon_path(root: Path) -> Path:
    bundle = Path(getattr(sys, "_MEIPASS", root))
    return bundle / "assets" / "cephalab.ico"


def _is_cephalab_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1.5) as r:
            return r.status == 200 and isinstance(json.loads(r.read().decode("utf-8", "ignore")), dict)
    except Exception:
        return False


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
    ap.add_argument("--no-tray", action="store_true", help="don't show the Windows system tray icon")
    ap.add_argument("--uri", default="", help="custom protocol URI (e.g. cephalab://start)")
    args = ap.parse_args(argv)

    frozen = bool(getattr(sys, "frozen", False))
    uri_action = protocol.parse_uri(args.uri)
    root = root_dir()
    log_path = clog.setup(root / "state", console=not frozen)
    clog.get().info("Starting Cephalab (%s, port=%d, uri=%r)", "exe" if frozen else "python", args.port, uri_action)
    protocol.register()

    hub = Hub(root / "state")
    settings = Settings(root / "state" / "settings.json")
    try:
        settings.update(flags_patch(args, settings.get()))
    except SettingsError as e:
        clog.get().error("Invalid CLI settings: %s", e)
        if not frozen:
            print(e)
        return 2
    cfg = settings.get()

    from .botbase_source import BotbaseSource
    from .splatnet import SplatnetSource
    botbase = BotbaseSource(hub, **cfg["switch"])
    splatnet = SplatnetSource(hub, mode=cfg["splatnet"]["every"])
    from .discord_rpc import Presence, from_hub
    discord = Presence(lambda: from_hub(hub), level=cfg["discord"]["level"])
    settings.on_change(lambda new, old: (botbase.configure(**new["switch"]), splatnet.set_mode(new["splatnet"]["every"]),
                                         discord.configure(new["discord"]["level"])))

    from .server import App
    from .updater import Updater
    stop = threading.Event()
    updater = Updater(on_change=lambda st: hub.emit("update", st))
    app_obj = App(hub, root, args.port, splatnet, settings=settings, botbase=botbase, updater=updater)
    url = f"http://127.0.0.1:{args.port}/"
    try:                                              # bind first: a second copy stops here, before it polls anything
        server = app_obj.serve()
    except OSError as e:
        if _is_cephalab_running(args.port):
            clog.get().info("Companion already running on port %d", args.port)
            if not args.no_open and uri_action != "start":
                webbrowser.open(url)
            return 0
        msg = f"Can't open port {args.port} ({e.strerror}); is another program using it? Try --port 8766."
        clog.get().error("%s", msg)
        if frozen:
            tray_mod.notify_error("Cephalab", msg)
        else:
            print(msg)
        return 1

    def request_exit():
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True, name="shutdown").start()

    app_obj.on_exit = request_exit
    tray = None
    if sys.platform == "win32" and not args.no_tray:
        tray = tray_mod.TrayIcon(
            icon_path(root),
            on_open=lambda: webbrowser.open(url),
            on_open_log=lambda: control.open_folder(log_path if log_path.is_file() else root / "state"),
            on_open_folder=lambda: control.open_folder(root / "state"),
            on_quit=request_exit,
        )
        tray.start()

    for s in (botbase, splatnet):
        threading.Thread(target=s.run, args=(stop,), daemon=True, name=s.name).start()
    discord_thread = threading.Thread(target=discord.run, args=(stop,), daemon=True, name=discord.name)
    discord_thread.start()
    if cfg.get("updates", {}).get("auto", True):
        threading.Thread(target=updater.check, daemon=True, name="updater").start()
    clog.get().info("Listening at %s", url)
    if not frozen:
        print(f"Cephalab: {url}  (Ctrl+C to stop)")
    if not args.no_open and uri_action != "start":    # a restart: the tab already open reconnects (~1 s), so no new tab for it
        def open_unless_reconnected():
            if not stop.wait(3.0) and not hub.clients:
                webbrowser.open(url)
        threading.Thread(target=open_unless_reconnected, daemon=True, name="open").start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        clog.get().info("Stopping Cephalab")
        stop.set()
        botbase.wake.set()
        splatnet.wake.set()
        discord.wake.set()
        discord_thread.join(3.0)                      # it clears the card on its way out
        if tray is not None:
            tray.stop()
        server.server_close()
    return 0
