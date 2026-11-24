"""Windows custom URI protocol registration (cephalab://) in HKCU (no admin required).

When the frozen cephalab.exe runs, it registers HKCU\\Software\\Classes\\cephalab so the web app's "Start companion"
button can wake cephalab.exe back up via cephalab://start if it isn't running.
"""
import sys
from pathlib import Path
from urllib.parse import urlparse

from . import log as clog

SCHEME = "cephalab"


def parse_uri(uri: str | None) -> str:
    """'cephalab://start' -> 'start'; anything else -> ''."""
    if not uri:
        return ""
    p = urlparse(uri.strip())
    if p.scheme.lower() != SCHEME:
        return ""
    return (p.netloc or p.path.lstrip("/")).strip().lower()


def register(exe_path: Path | None = None, *, command: str | None = None, reg_root: str = r"Software\Classes") -> bool:
    """Register cephalab:// under HKCU. Only auto-runs when frozen (unless exe_path or command is given)."""
    if sys.platform != "win32":
        return False
    import winreg

    icon: str | None = None
    if command is None:
        if exe_path is None:
            if not getattr(sys, "frozen", False):
                return False
            exe_path = Path(sys.executable).resolve()
        else:
            exe_path = Path(exe_path).resolve()
        command = f'"{exe_path}" --uri "%1"'
        icon = f'"{exe_path}",0'

    base = f"{reg_root}\\{SCHEME}"
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, base, 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:Cephalab Protocol")
            winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
        if icon:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, f"{base}\\DefaultIcon", 0, winreg.KEY_SET_VALUE) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, icon)
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, f"{base}\\shell\\open\\command", 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, command)
        clog.get().info("Registered %s:// protocol handler", SCHEME)
        return True
    except OSError as e:
        clog.get().warning("Couldn't register %s:// protocol handler: %s", SCHEME, e)
        return False
