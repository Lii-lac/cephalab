"""A stand-in Switch for testing tracker.py: answers sys-botbase's peek/getTitleID/game version.

    python tests/fake_botbase.py [--port 6000] [--dlc] [--no-version] [--roll-every SECONDS]
                                 [--drop-after N] [--no-game-for SECONDS] [--stock [--worn [--drink N]]]
"""
import argparse
import socket
import struct
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from s3seed import gear as G                    # noqa: E402
from s3seed.seedmath import ABILITY_ORDER, roll  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=6000)
ap.add_argument("--dlc", action="store_true")
ap.add_argument("--no-version", action="store_true")
ap.add_argument("--roll-every", type=float, default=0)
ap.add_argument("--drop-after", type=int, default=0, help="close the connection after N peeks (once)")
ap.add_argument("--no-game-for", type=float, default=0, help="report no game for the first N seconds")
ap.add_argument("--version", default="11.3.0", help="the game version it reports")
ap.add_argument("--shift", type=lambda s: int(s, 0), default=0, help="move the gear tables by this many bytes (a game update)")
ap.add_argument("--garbage", type=int, default=0, help="with --shift: N headgear records that parse but all share one main, at the unshifted head (a stale version head)")
ap.add_argument("--stock", action="store_true", help="put chunk counts (u16) and drink tickets (u32 every 8) near the gear")
ap.add_argument("--worn", action="store_true", help="with --stock: the worn weapon, head, clothes and shoes (5000, 3029, 7017, 25012) as MessagePack fields under their hashes, 12 KB past the tables")
ap.add_argument("--drink", type=int, default=None, help="with --worn: the active drink (an ABILITY_ORDER index, 17 battles left) 0x690 bytes before the worn record")
args = ap.parse_args()

dlc = (G.DLC_OFFSET if args.dlc else 0) + args.shift
mem: dict[int, bytearray] = {}   # list base -> bytes
gear_ids = {t: [g for (tt, g) in G.GEAR_INFO if tt == t and G.GEAR_INFO[(tt, g)][1] not in ('B97', 'B98', 'B99')][3::29][:6]
            for t in G.TYPES}
lock = threading.Lock()
started = time.time()


def record(gid: int, rarity: int, subs: list[int], seed: int, main: int = 3) -> bytes:
    r = bytearray(G.RECORD)
    struct.pack_into("<H", r, 0, gid)
    struct.pack_into("<H", r, 0x48, 1234)
    r[0x50], r[0x54], r[0x68] = rarity, main, sum(1 for s in subs if s)
    for i, s in enumerate(subs):
        r[0x6C + 4 * i] = s
    struct.pack_into("<I", r, 0x80, seed)
    return bytes(r)


for ti, t in enumerate(G.TYPES):
    base = G.GEAR_LIST_HEAD + ti * G.GEAR_LIST_STRIDE + G.FIRST_RECORD + dlc
    buf = bytearray()
    for i, gid in enumerate(gear_ids[t]):
        buf += record(gid, 2, [1 + i, 0, 0], 0x1000 * (ti + 1) + i + 1, 3 + i % 4)
    buf += bytes(G.RECORD * 60)  # zeros: end of list
    mem[base] = buf

if args.garbage:   # what a stale head finds after an update: records that parse, every one with the same main
    mem[G.GEAR_LIST_HEAD + G.FIRST_RECORD] = bytearray(b"".join(record(gear_ids["head"][i % 6], 1, [0, 0, 0], 0x77 + i) for i in range(args.garbage)) + bytes(G.RECORD * 60))


STOCK_CHUNKS = [12, 0, 3, 40, 7, 0, 0, 1, 9, 0, 2, 5, 0, 18]
PLAYER = "Mochi"
STOCK_DRINKS = [0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 3, 0, 4, 0]
def msgint(v: int) -> bytes:
    return bytes([v]) if v < 128 else b"\xd1" + v.to_bytes(2, "big")


if args.stock:   # the save's tables as the game keeps them in RAM: MessagePack maps under a field hash (s3seed/stock.py)
    STOCK_CHUNKS = [132, 111, 130, 115, 73, 115, 181, 156, 155, 125, 114, 159, 114, 127]
    table = lambda h, vals, extra=b"": b"\xce" + h.to_bytes(4, "big") + bytes([0x80 + len(vals) + (1 if extra else 0)]) + b"".join(bytes([i]) + msgint(v) for i, v in enumerate(vals)) + extra
    save = (b"\x81\xce\x2a\x1f\xe8\x04\xd2\x63\x25\x3b\x1e" * 8 + table(0xC5943B25, STOCK_CHUNKS, b"\xce\xff\xff\xff\xff\x1b")
            + b"\xce\xe3\xaf\xf0\x6d\x86\x01\x18\x02\x29\x03\x11\x04\x14\x05\x0b\x06\x00" + table(0x5CB5B875, STOCK_DRINKS) + b"\xce\x89\x27\xa2\x29")
    mem[G.GEAR_LIST_HEAD + dlc - 0x6CDD67 - 0x1F0] = bytearray(save)
    if args.worn:   # the worn-gear record as the game keeps it (s3seed/equip.py finds it by its field hashes)
        fx = bytes.fromhex
        worn = fx("ce" "e297f85f" "d11388" "ce" "ddcbe978" "d10bd5" "ce" "4b347ee2" "00" "ce" "5e46a8c1" "d11b69" "ce" "69e24289" "01" "ce" "425935d4" "d161b4")
        mem[G.GEAR_LIST_HEAD + dlc - 0x6CDD67 + 0x3000] = bytearray(fx("81ce01020304" "07") * 4 + worn + fx("c0") * 8)
        if args.drink is not None:   # s3seed/drink.py: battles left, then the drink, each under its hash
            nm = fx("ce4540508d") + bytes([0xA0 + len(PLAYER)]) + PLAYER.encode() + fx("c0") * 40   # the player's name, before the drink field (s3seed/player.py)
            mem[G.GEAR_LIST_HEAD + dlc - 0x6CDD67 + 0x3000 - 0x690 - len(nm)] = bytearray(nm + fx("c0" * 8 + "ce8871b197" "11" "cefbc8a6f8") + bytes([args.drink]) + fx("c0" * 8))


def read(addr: int, size: int) -> bytes:
    with lock:
        for base, buf in mem.items():
            if base <= addr and addr + size <= base + len(buf):
                return bytes(buf[addr - base:addr - base + size])
        out = bytearray(size)                       # unmapped reads come back as zeros, with any island inside copied
        for base, buf in mem.items():
            lo, hi = max(addr, base), min(addr + size, base + len(buf))
            if lo < hi:
                out[lo - addr:hi - addr] = buf[lo - base:hi - base]
    return bytes(out)


def roller():
    base = G.GEAR_LIST_HEAD + G.FIRST_RECORD + dlc
    while True:
        time.sleep(args.roll_every)
        with lock:
            buf = mem[base]
            seed = struct.unpack_from("<I", buf, 0x80)[0]
            gid = struct.unpack_from("<H", buf, 0)[0]
            brand = G.GEAR_INFO[("head", gid)][1]
            new, ability, _ = roll(seed, brand)
            slot = next((i for i in range(3) if buf[0x6C + 4 * i] == 0), 2)
            buf[0x6C + 4 * slot] = ABILITY_ORDER.index(ability) + 1
            buf[0x68] = sum(1 for i in range(3) if buf[0x6C + 4 * i])
            struct.pack_into("<I", buf, 0x80, new)
        print(f"rolled head slot {slot + 1}: {ability}, seed {seed:08x} -> {new:08x}", flush=True)


peeks = 0
dropped = False


def serve(conn: socket.socket):
    global peeks, dropped
    f = conn.makefile("rb")
    try:
        for raw in f:
            parts = raw.decode().strip().split()
            if not parts:
                continue
            no_game = time.time() - started < args.no_game_for
            if parts[0] == "getTitleID":
                conn.sendall(b"\n" if no_game else b"0100C2500FC20000\n")
            elif parts == ["game", "version"]:
                if not args.no_version:
                    conn.sendall(args.version.encode() + b"\n")
            elif parts[0] == "peek" and len(parts) == 3:
                if no_game:
                    conn.sendall(b"\n")
                    continue
                peeks += 1
                if args.drop_after and peeks >= args.drop_after and not dropped:
                    dropped = True
                    print("dropping connection", flush=True)
                    conn.close()
                    return
                conn.sendall(read(int(parts[1], 16), int(parts[2])).hex().upper().encode() + b"\n")
    except OSError:
        pass
    finally:
        conn.close()


if args.roll_every:
    threading.Thread(target=roller, daemon=True).start()
srv = socket.create_server(("127.0.0.1", args.port))
print(f"fake sys-botbase on 127.0.0.1:{args.port} (dlc={bool(dlc)})", flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
