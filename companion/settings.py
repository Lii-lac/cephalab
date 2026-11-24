"""What the Settings screen changes, kept in state/settings.json. The sources are told the moment it changes.

    {"switch": {"host": "", "port": 6000, "every": 15}, "splatnet": {"every": "off"}}

host "" = no Switch (the botbase source idles); splatnet.every: "battle" (after each battle), "5min", or "off".
"""
import copy
import json
import re
import threading
from pathlib import Path

DEFAULTS = {"switch": {"host": "", "port": 6000, "every": 15}, "splatnet": {"every": "off"}, "updates": {"auto": True}}
SPLATNET_MODES = ("battle", "5min", "off")
HOST = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?")


class SettingsError(ValueError):
    pass


def _check(patch) -> dict:
    """The patch, cleaned, or SettingsError naming what is wrong. Nothing is applied unless all of it is valid."""
    if not isinstance(patch, dict):
        raise SettingsError("settings must be an object")
    out: dict = {}
    for group, fields in patch.items():
        if group not in DEFAULTS:
            raise SettingsError(f"unknown setting: {group}")
        if not isinstance(fields, dict):
            raise SettingsError(f"{group} must be an object")
        for k, v in fields.items():
            if k not in DEFAULTS[group]:
                raise SettingsError(f"unknown setting: {group}.{k}")
            out.setdefault(group, {})[k] = _value(group, k, v)
    return out


def _value(group: str, k: str, v):
    if group == "switch" and k == "host":
        v = v.strip() if isinstance(v, str) else v
        if not isinstance(v, str) or (v and not HOST.fullmatch(v)):
            raise SettingsError("That isn't an IP address (like 192.168.1.20).")
        return v
    if group == "switch" and k == "port":
        if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 65535:
            raise SettingsError("The port is a number from 1 to 65535 (sys-botbase uses 6000).")
        return v
    if group == "switch" and k == "every":
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 3 <= v <= 3600:
            raise SettingsError("Read every is 3 to 3600 seconds.")
        return v
    if group == "updates" and k == "auto":
        if not isinstance(v, bool):
            raise SettingsError("Check for updates on start must be true or false.")
        return v
    if v not in SPLATNET_MODES:
        raise SettingsError("Check SplatNet is battle, 5min or off.")
    return v


class Settings:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.listeners: list = []
        self.data = copy.deepcopy(DEFAULTS)
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            for group, fields in _check(saved).items():           # a hand-edited bad value falls back to defaults
                self.data[group].update(fields)
        except (OSError, ValueError):
            pass

    @staticmethod
    def check(patch) -> dict:
        return _check(patch)

    def get(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.data)

    def on_change(self, fn):
        """fn(new, old) after every change that changed something."""
        self.listeners.append(fn)

    def update(self, patch) -> dict:
        clean = _check(patch)
        with self.lock:
            old = copy.deepcopy(self.data)
            for group, fields in clean.items():
                self.data[group].update(fields)
            new = copy.deepcopy(self.data)
            if new != old:
                self._save(new)
        if new != old:
            for fn in self.listeners:
                fn(new, old)
        return new

    def reset(self) -> dict:
        with self.lock:
            old, self.data = self.data, copy.deepcopy(DEFAULTS)
            new = copy.deepcopy(self.data)
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
        if new != old:
            for fn in self.listeners:
                fn(new, old)
        return new

    def _save(self, data: dict):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        tmp.replace(self.path)
