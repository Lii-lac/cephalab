"""Minimal sys-botbase client: plain-text commands over TCP port 6000 (wifi) on the Switch."""
import socket
import time
from contextlib import contextmanager

# sys-botbase pauses the game for every read (it attaches as a debugger), so back-to-back reads drop frames.
# After each read the next one waits REST times as long as that read took: the game runs at least half the time
# on polls and searches alike (gentle() can space a search out further; Alex chose 1x on 2026-11-20 for speed).
REST, GENTLE_REST = 1.0, 1.0
# sys-botbase keeps the game paused while it prints a whole reply (commands.c peek), so a big read is one long
# freeze: 32 KB ~50 ms = 3 frames. Reads are cut into SLICE pieces so each pause stays under one frame (4 KB ~15 ms).
SLICE = 0x1000


class BotbaseError(Exception):
    pass


class NoGame(BotbaseError):
    pass


class Botbase:
    def __init__(self, host: str, port: int = 6000, timeout: float = 5.0):
        self.host, self.port, self.timeout = host, port, timeout
        self.sock: socket.socket | None = None
        self._buf = b""
        self.rest, self._free_at = REST, 0.0

    @contextmanager
    def gentle(self, rest: float = GENTLE_REST):
        """Space reads further apart while a search runs, so the game keeps its frame rate."""
        old, self.rest = self.rest, max(self.rest, rest)
        try:
            yield self
        finally:
            self.rest = old

    def connect(self) -> None:
        self.close()
        try:
            self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as e:
            raise BotbaseError(f"No answer from {self.host}:{self.port}") from e
        self.sock.settimeout(self.timeout)
        self._buf = b""

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None

    def _send(self, cmd: str) -> None:
        if not self.sock:
            raise BotbaseError("not connected")
        try:
            self.sock.sendall((cmd + "\r\n").encode())
        except OSError as e:
            self.close()
            raise BotbaseError(f"connection lost ({e})") from e

    def _line(self) -> str:
        while b"\n" not in self._buf:
            try:
                chunk = self.sock.recv(65536) if self.sock else b""
            except OSError as e:
                self.close()
                raise BotbaseError(f"connection lost ({e})") from e
            if not chunk:
                self.close()
                raise BotbaseError("sys-botbase closed the connection")
            self._buf += chunk
        line, self._buf = self._buf.split(b"\n", 1)
        return line.decode(errors="replace").strip()

    def peek(self, addr: int, size: int) -> bytes:
        """Read `size` bytes at a heap-relative address, in slices short enough not to drop a frame."""
        if size <= SLICE:
            return self._peek1(addr, size)
        return b"".join(self._peek1(addr + o, min(SLICE, size - o)) for o in range(0, size, SLICE))

    def settle(self) -> None:
        """Wait out the rest the last read asked for (a caller that shares the connection does it before taking its lock,
        so the others can use the connection meanwhile)."""
        wait = self._free_at - time.monotonic()
        if wait > 0:
            time.sleep(wait)

    def _peek1(self, addr: int, size: int) -> bytes:
        self.settle()
        t0 = time.monotonic()
        try:
            self._send(f"peek 0x{addr:X} {size}")
            line = self._line()
        finally:
            t1 = time.monotonic()
            self._free_at = t1 + self.rest * (t1 - t0)
        if not line:  # sys-botbase prints an empty line when no game is running or the read fails
            raise NoGame("no game running, or the read failed")
        try:
            data = bytes.fromhex(line)
        except ValueError as e:
            raise BotbaseError(f"bad peek reply: {line[:60]!r}") from e
        if len(data) != size:
            raise BotbaseError(f"peek returned {len(data)} bytes, wanted {size}")
        return data

    def game_version(self) -> str:
        """Display version of the running game, or "" (sys-botbase sends nothing when it can't tell)."""
        self._send("game version")
        self.sock.settimeout(2.0)
        try:
            return self._line()
        except BotbaseError:
            self.connect()  # the timeout closed the socket; nothing was in flight, so reopen
            return ""
        finally:
            if self.sock:
                self.sock.settimeout(self.timeout)

    def title_id(self) -> str:
        self._send("getTitleID")
        return self._line()
