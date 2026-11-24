"""Nintendo tokens live in the OS keyring (Windows Credential Manager), never in a file.

Credential Manager holds at most 2560 bytes (1280 UTF-16 characters) per entry and keyring doesn't split, while a
gtoken alone can come close to that. So each field is its own entry, cut into PART-character pieces:
"<field>" holds the piece count, "<field>#0", "<field>#1" ... the text.
"""
import threading

import keyring

SERVICE = "cephalab"
LEGACY_SERVICE = "splat3-seed-tracker"
FIELDS = ("session_token", "gtoken", "bullettoken", "lang", "country", "playerKey")
PART = 1000


class VaultError(Exception):
    pass


class Vault:
    def __init__(self, service: str = SERVICE, backend=None):
        self.service = service
        self.kr = backend or keyring
        self.lock = threading.RLock()

    def _get(self, field: str, service: str | None = None) -> str | None:
        svc = service or self.service
        n = self.kr.get_password(svc, field)
        if not n or not n.isdigit():
            return None
        parts = [self.kr.get_password(svc, f"{field}#{i}") for i in range(int(n))]
        return None if any(p is None for p in parts) else "".join(parts)

    def _set(self, field: str, value: str):
        old = self.kr.get_password(self.service, field)
        parts = [value[i:i + PART] for i in range(0, len(value), PART)] or [""]
        for i, p in enumerate(parts):
            self.kr.set_password(self.service, f"{field}#{i}", p)
        self.kr.set_password(self.service, field, str(len(parts)))
        if old and old.isdigit():                          # a shorter value leaves no stale tail behind
            for i in range(len(parts), int(old)):
                self._delete(f"{field}#{i}")

    def _delete(self, name: str, service: str | None = None):
        try:
            self.kr.delete_password(service or self.service, name)
        except Exception:                                  # not there: nothing to remove
            pass

    def _clear_service(self, service: str):
        for f in FIELDS:
            try:
                n = self.kr.get_password(service, f)
            except Exception:
                n = None
            if n and n.isdigit():
                for i in range(int(n)):
                    self._delete(f"{f}#{i}", service)
            self._delete(f, service)

    def load(self) -> dict:
        with self.lock:
            try:
                data = {f: v for f in FIELDS if (v := self._get(f)) is not None}
                if not data and self.service == SERVICE:
                    legacy = {f: v for f in FIELDS if (v := self._get(f, LEGACY_SERVICE)) is not None}
                    if legacy:
                        try:
                            self._write(legacy)
                        except VaultError:
                            pass
                        return legacy
                return data
            except Exception:                              # a locked or broken keyring reads as signed out
                return {}

    def save(self, data: dict):
        """Replace everything with data."""
        with self.lock:
            self.clear()
            self._write(data)

    def update(self, **kw) -> dict:
        """Set some fields. Writes nothing once signed out (no session token), so a poll finishing after a sign-out
        can't put tokens back."""
        with self.lock:
            cur = self.load()
            if not cur.get("session_token") and "session_token" not in kw:
                return cur
            self._write(kw)
            return self.load()

    def _write(self, data: dict):
        try:
            for k, v in data.items():
                if k in FIELDS and v is not None:
                    self._set(k, str(v))
        except Exception as e:
            raise VaultError(f"Couldn't save the Nintendo sign-in to Windows Credential Manager ({e.__class__.__name__})") from None

    def clear(self):
        with self.lock:
            self._clear_service(self.service)
            if self.service == SERVICE:
                self._clear_service(LEGACY_SERVICE)
