"""Token-scrubbed rotating log for the companion (state/cephalab.log).

Everything written here (messages and tracebacks) passes through scrub() so Nintendo tokens, auth links and bearer
headers never land on disk or get copied when someone shares a log.
"""
import datetime
import logging
import logging.handlers
import platform
import re
import sys
import threading
from pathlib import Path

from .updater import VERSION

LOG_NAME = "cephalab.log"
MAX_BYTES = 512 * 1024
BACKUPS = 2
LOGGER_NAME = "cephalab"

_REDACT_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"npf71b963c1b7b6d119://auth[^\s\"'<>]*", re.I), "npf71b963c1b7b6d119://auth?[redacted]"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.I), "Bearer [redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[redacted-jwt]"),
    (re.compile(r"(?i)(session_token_code|session_token|access_token|id_token|gtoken|bullettoken|bulletToken|_gtoken)(\"?\s*[:=]\s*\"?)([^\"&\s;,}]+)"), r"\1\2[redacted]"),
)


def scrub(text: str) -> str:
    """Remove Nintendo auth links, JWTs and session/bearer tokens from any log line or traceback."""
    out = str(text or "")
    for pat, repl in _REDACT_RULES:
        out = pat.sub(repl, out)
    return out


class _ScrubFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return scrub(super().format(record))


def get() -> logging.Logger:
    return logging.getLogger(LOGGER_NAME)


def setup(state_dir: Path, *, console: bool = False) -> Path:
    """Attach a rotating file handler at state_dir/cephalab.log and hook uncaught exceptions."""
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / LOG_NAME
    logger = get()
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for h in list(logger.handlers):
        logger.removeHandler(h)
        try:
            h.close()
        except Exception:
            pass

    fmt = _ScrubFormatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.handlers.RotatingFileHandler(path, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    if console and sys.stderr is not None:
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        logger.addHandler(sh)

    prev_sys = sys.excepthook

    def _sys_hook(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, KeyboardInterrupt):
            prev_sys(exc_type, exc_value, exc_tb)
            return
        logger.error("Uncaught exception", exc_info=(exc_type, exc_value, exc_tb))
        if console:
            prev_sys(exc_type, exc_value, exc_tb)

    def _thread_hook(args: threading.ExceptHookArgs):
        if args.exc_type is SystemExit:
            return
        name = getattr(args.thread, "name", "?")
        logger.error("Uncaught exception in thread %s", name, exc_info=(args.exc_type, args.exc_value, args.exc_traceback))

    sys.excepthook = _sys_hook
    threading.excepthook = _thread_hook
    return path


def header(port: int | None = None) -> str:
    """Short environment header prepended when exporting/copying the log."""
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    frozen = "exe" if getattr(sys, "frozen", False) else "python"
    bits = [
        f"Cephalab v{VERSION} ({frozen})",
        f"OS: {platform.system()} {platform.release()} ({platform.version()})",
        f"Python: {platform.python_version()}",
    ]
    if port is not None:
        bits.append(f"Port: {port}")
    bits.append(f"Copied: {now}")
    return "\n".join(bits)


def read_tail(path: Path, *, port: int | None = None, max_bytes: int = 48 * 1024) -> str:
    """The diagnostic header plus the newest tail of cephalab.log, scrubbed."""
    head = header(port)
    if not path.is_file():
        return f"{head}\n\n(no log entries yet)"
    try:
        raw = path.read_bytes()
    except OSError as e:
        return f"{head}\n\n(couldn't read log: {e})"
    truncated = len(raw) > max_bytes
    if truncated:
        raw = raw[-max_bytes:]
        nl = raw.find(b"\n")
        if nl != -1:
            raw = raw[nl + 1:]
    body = scrub(raw.decode("utf-8", "replace")).strip()
    if not body:
        return f"{head}\n\n(no log entries yet)"
    prefix = "... (older lines trimmed)\n" if truncated else ""
    return f"{head}\n\n{prefix}{body}"
