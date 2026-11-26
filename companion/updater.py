"""GitHub Releases update checker (Lii-lac/cephalab).

Checks the latest release tag against VERSION on start (when enabled) and on request from Settings.
When running as the frozen cephalab.exe on Windows and the release ships a cephalab.exe asset, install()
downloads it beside the running exe, verifies its PE header (and SHA-256 if published), and spawns a
tiny detached helper to swap and relaunch once this process exits. As the frozen Cephalab.app on macOS (when the
folder holding the .app is writable) it does the same with Cephalab-macOS-arm64.zip: verify, unzip to a temp folder,
and a detached /bin/sh script replaces the .app, clears quarantine and reopens it. Otherwise the UI opens the release page.
"""
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

VERSION = "0.2.1"
REPO = "Lii-lac/cephalab"
API_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_URL = f"https://github.com/{REPO}/releases/latest"
ASSET_NAME = "cephalab.exe"
SHA_NAMES = ("sha256sums.txt", f"{ASSET_NAME}.sha256", "checksums.txt")
MAC_ASSET_NAME = "Cephalab-macOS-arm64.zip"
MAC_SHA_NAMES = ("sha256sums-macos.txt", "sha256sums.txt", f"{MAC_ASSET_NAME.lower()}.sha256", "checksums.txt")  # best first
HEADERS = {"User-Agent": "Cephalab", "Accept": "application/vnd.github+json"}


def parse_version(tag: str) -> tuple[int, ...]:
    """'v0.9.1' or '0.9.1-beta' -> (0, 9, 1); unparseable -> ()."""
    m = re.match(r"^\s*v?(\d+(?:\.\d+)*)", str(tag or ""))
    return tuple(int(p) for p in m.group(1).split(".")) if m else ()


def is_newer(latest: str, current: str) -> bool:
    a, b = parse_version(latest), parse_version(current)
    if not a or not b:
        return False
    n = max(len(a), len(b))
    return a + (0,) * (n - len(a)) > b + (0,) * (n - len(b))


def _default_fetch(url: str, timeout: int = 10) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""


def _find_sha256(text: str, filename: str) -> str | None:
    """Match a standard sha256sum line for filename (or a bare 64-hex hash)."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) == 1 and re.fullmatch(r"[0-9a-fA-F]{64}", lines[0]):
        return lines[0].lower()
    for ln in lines:
        m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+)$", ln)
        if m and Path(m.group(2).strip()).name.lower() == filename.lower():
            return m.group(1).lower()
    return None


def app_bundle(executable) -> Path | None:
    """The .app folder that contains executable (Cephalab.app/Contents/MacOS/cephalab -> Cephalab.app), or None."""
    p = Path(executable).absolute()
    for d in (p, *p.parents):
        if d.name.lower().endswith(".app"):
            return d
    return None


class Updater:
    def __init__(self, current: str = VERSION, fetch=_default_fetch, is_frozen: bool | None = None, on_change=None,
                 platform: str | None = None, executable: str | None = None):
        self.current = current
        self.fetch = fetch
        self.is_frozen = bool(getattr(sys, "frozen", False)) if is_frozen is None else bool(is_frozen)
        self.on_change = on_change
        self.platform = sys.platform if platform is None else platform
        self.executable = sys.executable if executable is None else executable
        self.lock = threading.Lock()
        self._state = "idle"
        self._latest = ""
        self._url = RELEASES_URL
        self._asset_url = ""
        self._sha_url = ""
        self._error = ""
        self._checked_at = 0.0

    def _mac(self) -> bool:
        return self.platform == "darwin"

    def _installable(self) -> bool:
        """Frozen, the release has our asset, and (macOS) the folder holding the .app can be written."""
        if not (self.is_frozen and self._asset_url):
            return False
        if self.platform == "win32":
            return True
        if self._mac():
            app = app_bundle(self.executable)
            return bool(app and os.access(app.parent, os.W_OK))
        return False

    def status(self) -> dict:
        with self.lock:
            return self._snap()

    def _snap(self) -> dict:
        return {
            "current": self.current,
            "state": self._state,
            "latest": self._latest,
            "url": self._url or RELEASES_URL,
            "canInstall": bool(self._state == "available" and self._installable()),
            "error": self._error,
            "checkedAt": self._checked_at,
        }

    def _emit(self, snap: dict):
        if self.on_change:
            try:
                self.on_change(snap)
            except Exception:
                pass

    def check(self) -> dict:
        with self.lock:
            if self._state in ("checking", "installing", "restarting"):
                return self._snap()
            self._state = "checking"
            self._error = ""
            snap = self._snap()
        self._emit(snap)

        try:
            code, raw = self.fetch(API_URL, 10)
        except Exception as e:
            return self._finish("error", error=f"Couldn't reach GitHub ({e.__class__.__name__})")

        if code == 404:                                    # repo has no published release yet
            return self._finish("up-to-date", latest=self.current, url=RELEASES_URL)
        if code != 200:
            return self._finish("error", error=f"GitHub returned {code}")
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._finish("error", error="Couldn't read release info")

        tag = str(doc.get("tag_name") or "").strip()
        url = str(doc.get("html_url") or RELEASES_URL).strip()
        assets = doc.get("assets") if isinstance(doc.get("assets"), list) else []
        want_asset = (MAC_ASSET_NAME if self._mac() else ASSET_NAME).lower()
        sha_names = MAC_SHA_NAMES if self._mac() else SHA_NAMES
        asset_url = ""
        sha_found = {}
        for a in assets:
            if not isinstance(a, dict):
                continue
            name = str(a.get("name") or "")
            dl = str(a.get("browser_download_url") or "")
            if not dl:
                continue
            if name.lower() == want_asset:
                asset_url = dl
            elif name.lower() in sha_names:
                sha_found[name.lower()] = dl
        sha_url = next((sha_found[n] for n in sha_names if n in sha_found), "")

        if is_newer(tag, self.current):
            return self._finish("available", latest=tag.lstrip("v"), url=url, asset_url=asset_url, sha_url=sha_url)
        return self._finish("up-to-date", latest=tag.lstrip("v") or self.current, url=url)

    def _finish(self, state: str, *, latest: str = "", url: str = "", asset_url: str = "", sha_url: str = "", error: str = "") -> dict:
        with self.lock:
            self._state = state
            if latest:
                self._latest = latest
            if url:
                self._url = url
            self._asset_url = asset_url
            self._sha_url = sha_url
            self._error = error
            self._checked_at = time.time()
            snap = self._snap()
        self._emit(snap)
        return snap

    def install(self, on_exit=None) -> dict:
        with self.lock:
            if self._state != "available":
                return {"ok": False, "url": self._url or RELEASES_URL, "error": "No update ready to install"}
            if not self._installable():
                return {"ok": False, "url": self._url or RELEASES_URL, "error": "Open GitHub to download the latest release"}
            asset_url, sha_url = self._asset_url, self._sha_url
            self._state = "installing"
            self._error = ""
            snap = self._snap()
        self._emit(snap)

        try:
            code, data = self.fetch(asset_url, 120)
            if self._mac():
                if code != 200 or not data.startswith(b"PK\x03\x04"):
                    raise RuntimeError("Downloaded file wasn't a valid zip")
            elif code != 200 or len(data) < 64 or not data.startswith(b"MZ"):
                raise RuntimeError("Downloaded file wasn't a valid Windows executable")
            if sha_url:
                sc, sraw = self.fetch(sha_url, 15)
                if sc == 200:
                    want = _find_sha256(sraw.decode("utf-8", "ignore"), MAC_ASSET_NAME if self._mac() else ASSET_NAME)
                    got = hashlib.sha256(data).hexdigest().lower()
                    if want and got != want:
                        raise RuntimeError("Checksum mismatch on downloaded update")
            if self._mac():
                _install_mac(data, app_bundle(self.executable), os.getpid())
            else:
                exe = Path(sys.executable).resolve()
                staged = exe.with_suffix(".exe.new")
                staged.write_bytes(data)
                _spawn_swapper(exe, staged, os.getpid())
        except Exception as e:
            st = self._finish("error", latest=self._latest, url=self._url, asset_url=asset_url, sha_url=sha_url, error=str(e))
            return {"ok": False, "url": st["url"], "error": str(e)}

        with self.lock:
            self._state = "restarting"
            snap = self._snap()
        self._emit(snap)
        if on_exit:
            threading.Timer(0.5, on_exit).start()
        return {"ok": True, "restarting": True, "status": snap}


def _spawn_swapper(exe: Path, staged: Path, pid: int):
    """Detach a tiny cmd script that waits for pid to exit, swaps staged -> exe, and relaunches."""
    bat = Path(tempfile.gettempdir()) / f"cephalab-update-{pid}.cmd"
    bat.write_text(
        "@echo off\r\n"
        f":wait\r\n"
        f"tasklist /FI \"PID eq {pid}\" 2>NUL | find /I \"{pid}\" >NUL && (timeout /t 1 /nobreak >NUL & goto wait)\r\n"
        f"move /Y \"{staged}\" \"{exe}\" >NUL\r\n"
        f"start \"\" \"{exe}\"\r\n"
        f"del \"%~f0\" >NUL 2>&1\r\n",
        encoding="utf-8",
    )
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen(["cmd.exe", "/c", str(bat)], creationflags=flags, close_fds=True)


# --- macOS

def _inside(root: str, p: str) -> bool:
    root, p = os.path.realpath(root), os.path.realpath(p)
    return p == root or p.startswith(root.rstrip(os.sep) + os.sep)


def unzip_keeping_modes(data: bytes, dest) -> None:
    """Extract a zip (as `ditto -c -k` / `zip -y` write it) into dest, restoring the unix modes zipfile drops
    (external_attr >> 16: exec bits) and recreating symlinks; nothing may land or point outside dest."""
    dest = os.path.abspath(dest)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            name = info.filename
            if name.startswith(("/", "\\")) or ".." in re.split(r"[\\/]", name) or ":" in name:
                raise RuntimeError(f"Unsafe path in update zip: {name}")
            target = os.path.join(dest, *[s for s in re.split(r"[\\/]", name) if s])
            mode = info.external_attr >> 16
            if not _inside(dest, os.path.dirname(target) if not info.is_dir() else target):
                raise RuntimeError(f"Unsafe path in update zip: {name}")
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if stat.S_ISLNK(mode):
                link = z.read(info).decode("utf-8")
                if os.path.isabs(link) or not _inside(dest, os.path.join(os.path.dirname(target), link)):
                    raise RuntimeError(f"Update zip has a link out of the app: {name}")
                os.symlink(link, target)
                continue
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            if mode & 0o777:
                os.chmod(target, stat.S_IMODE(mode))


def mac_swap_script(app: Path, new_app: Path, pid: int, workdir: Path) -> str:
    """The /bin/sh script that waits for pid to exit, replaces app with new_app, clears quarantine and reopens it."""
    a, n, w = shlex.quote(str(app)), shlex.quote(str(new_app)), shlex.quote(str(workdir))
    o = shlex.quote(f"{app}.old-{int(pid)}")               # the old .app waits beside it until the new one is in place
    return (
        "#!/bin/sh\n"
        f"while kill -0 {int(pid)} 2>/dev/null; do sleep 1; done\n"
        f"rm -rf {o}\n"
        f"if mv {a} {o}; then\n"
        f"  if mv {n} {a}; then rm -rf {o}; else mv {o} {a}; fi\n"
        "fi\n"
        f"xattr -dr com.apple.quarantine {a} 2>/dev/null\n"
        f"open -n {a}\n"
        f"rm -rf {w}\n"
    )


def _install_mac(data: bytes, app: Path | None, pid: int):
    if app is None:
        raise RuntimeError("Couldn't find the running Cephalab.app")
    work = Path(tempfile.mkdtemp(prefix="cephalab-update-"))
    try:
        unzip_keeping_modes(data, work / "new")
        apps = [p for p in (work / "new").iterdir() if p.name.lower().endswith(".app") and p.is_dir()]
        if len(apps) != 1:
            raise RuntimeError("The update zip didn't hold one .app")
        script = work / "swap.sh"
        script.write_text(mac_swap_script(app, apps[0], pid, work), encoding="utf-8")
        subprocess.Popen(["/bin/sh", str(script)], start_new_session=True, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise
