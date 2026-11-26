"""Where the player is and with whom, read live from the game's heap for the Discord card (briefs/RPC-CFW.md "Stage 2
results": Splatoon 3 v12.0.0, heap-relative, held across a game restart, confirmed on the real Switch 2026-11-25/26).

read() is six small fixed-address peeks (~1.2 KB), never a search. Live turns reads that held still into the card's
values; Party applies the party rule agreed with Alex. Both are pure (no I/O).
"""
import json
import struct

from .seedmath import DATA, murmur3_32

SCENE = 0xB969F2C8          # u32 scene id (SCENES below; in a match 12-15 -> 30s -> 60s-110s; loads pass 0, 1, 2, 7)
SCENE_KEY = 0xB9760000      # u32 murmur3_32 of the scene name: 'Vss_<stage><suffix>' on a stage, 'Shop' in any shop
RULE = 0xBA6AB22C           # u32 0..4 (RULES); holds the last match's rule outside a match
ROOM = 0xB968F690           # ROOM_N entries ROOM_STEP apart, the name UTF-16LE at entry + NAME_AT, empty = no one
ROOM_N, ROOM_STEP, NAME_AT, NAME_MAX = 10, 0x70, 4, 0x2A
RANK = 0xB9F94478           # u32 anarchy grade (GRADES), u32 rank points, u32 Salmon Run points, u32 jobs into the Salmometer
CAPSULES = 0xBA226BC8       # u32 capsules (followed by u32 99, the max)

RULES = ("Pnt", "Var", "Vlf", "Vgl", "Vcl")      # Turf War, Splat Zones, Tower Control, Rainmaker, Clam Blitz
GRADES = ("C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "S", "S+")
EVP_AT = 800                 # Salmon Run points at Eggsecutive VP 0 (840 = EVP 40)
SCENES = {11: "lobby", 24: "room", 23: "matchroom", 3: "hub", 4: "alterna", 6: "order", 8: "grizzco", 0: "shop",
          15: "recon", 19: "recon", 26: "results"}
LOBBY = (11, 24)             # where a party forms
HOLD_S = 20.0                # the room list holds still this long before it is the party
BURST_S, BURST_N = 5.0, 2    # the list growing by BURST_N+ within BURST_S = matchmaking filling it: no one joins
PARTY_MAX = 4


def _u32(b: bytes, o: int = 0) -> int:
    return struct.unpack_from("<I", b, o)[0]


def names(room: bytes) -> list[str]:
    """The names in the room list, in join order (empty slots left out)."""
    out = []
    for i in range(ROOM_N):
        raw = room[i * ROOM_STEP + NAME_AT:i * ROOM_STEP + NAME_AT + NAME_MAX]
        end = next((j for j in range(0, len(raw) - 1, 2) if raw[j] == 0 and raw[j + 1] == 0), len(raw) // 2 * 2)
        try:
            n = raw[:end].decode("utf-16-le")
        except UnicodeDecodeError:
            continue
        if n.strip():
            out.append(n)
    return out


def read(bot) -> dict:
    """One look: {scene, scene_key, rule, names, grade, points, salmon, jobs, capsules} as raw numbers (names a list).
    Raises what bot.peek raises."""
    scene = _u32(bot.peek(SCENE, 4))
    key = _u32(bot.peek(SCENE_KEY, 4))
    rule = _u32(bot.peek(RULE, 4))
    room = bot.peek(ROOM, ROOM_N * ROOM_STEP)
    rank = bot.peek(RANK, 16)
    caps = _u32(bot.peek(CAPSULES, 4))
    return {"scene": scene, "scene_key": key, "rule": rule, "names": names(room), "grade": _u32(rank, 0),
            "points": _u32(rank, 4), "salmon": _u32(rank, 8), "jobs": _u32(rank, 12), "capsules": caps}


_stages: dict | None = None


def stage_rows() -> dict[int, str]:
    """murmur3_32('Vss_' + key + suffix) -> that row id ('Vss_Scrap01'), for every VS stage in USen.json."""
    global _stages
    if _stages is None:
        keys = json.loads((DATA / "USen.json").read_text(encoding="utf-8")).get("CommonMsg/VS/VSStageName", {})
        _stages = {}
        for k in keys:
            for suf in [""] + [f"{i:02d}" for i in range(10)]:
                row = f"Vss_{k}{suf}"
                _stages[murmur3_32(row)] = row
    return _stages


SHOP = murmur3_32("Shop")


def stage_names() -> dict[int, str]:
    """murmur3_32('Vss_' + key + suffix) -> the stage's English name; murmur3_32('Shop') -> 'shop'."""
    text = json.loads((DATA / "USen.json").read_text(encoding="utf-8")).get("CommonMsg/VS/VSStageName", {})
    out = {}
    for h, row in stage_rows().items():
        k = row[4:].rstrip("0123456789") if row[4:] not in text else row[4:]
        out[h] = text.get(k, k).replace("\n", " ")
    out[SHOP] = "shop"
    return out


def place(scene: int, key: int) -> str | None:
    """The place for a scene id and scene key: a SCENES name, "match" (a stage key in any other scene), or None (unknown:
    keep the previous place)."""
    if scene in SCENES:
        return SCENES[scene]
    if key in stage_rows():
        return "match"
    return None


class Party:
    """The party rule (briefs/RPC-CFW.md): the room list becomes the party while the scene is in LOBBY and the list held
    still HOLD_S; once matchmaking starts (the list grows by BURST_N+ within BURST_S, or the scene leaves LOBBY) members
    can only drop out until a new list holds still in the lobby. Always capped at PARTY_MAX: scene 23 is solo matchmaking
    as well as a Private Battle room, so it follows the same rule (no room count)."""

    def __init__(self):
        self.party: list[str] = []
        self.me: str | None = None
        self._common: set | None = None       # names in every party so far: the player himself
        self._names: list[str] | None = None
        self._since = 0.0                      # when the list last changed
        self._lock_at = float("-inf")          # the last time additions were barred (a burst, or outside the lobby)
        self._sizes: list[tuple[float, int]] = []
        self._burst = False                    # matchmaking filled the list while still in the lobby

    def update(self, now: float, scene: int, names: list[str]):
        if not names:
            return                             # a list being rewritten: no news
        if names != self._names:
            self._names, self._since = list(names), now
        self._sizes = [(t, n) for t, n in self._sizes if now - t <= BURST_S] + [(now, len(names))]
        if scene not in LOBBY:
            self._lock_at, self._burst = now, False
        elif any(len(names) - n >= BURST_N for _, n in self._sizes):
            self._lock_at, self._burst = now, True     # barred until those people leave again (or the lobby is left)
        elif self._burst and len(names) <= max(len(self.party), 1):
            self._burst = False
        if scene in LOBBY and not self._burst and self._since > self._lock_at and now - self._since >= HOLD_S:
            self.party = list(names)
            self._common = set(names) if self._common is None else self._common & set(names)
            if len(names) == 1:
                self.me = names[0]
            elif len(self._common) == 1:
                self.me = next(iter(self._common))
            elif self.me is None:
                self.me = names[0]
        else:
            self.party = [p for p in self.party if p in names]

    def count(self) -> tuple[int, int] | None:
        """(people, max) for the card, the player included; None before any party is known."""
        if not self.party and self.me is None:
            return None
        n = len(set(self.party) | ({self.me} if self.me else set()))
        return min(n, PARTY_MAX), PARTY_MAX


class Live:
    """Raw reads that held still -> the card's values: place, stage (row id), rule (code), party, partyMax, rank
    {grade, points}, salmon {points, evp, jobs}, capsules. What isn't known yet is left out."""

    def __init__(self):
        self.party = Party()
        self.vals: dict = {}

    def update(self, now: float, held: dict) -> dict:
        v = self.vals
        scene, key = held.get("scene"), held.get("scene_key")
        if scene is not None and key is not None:
            p = place(scene, key)
            if p is not None:
                v["place"] = p
                if p == "match":
                    v["stage"] = stage_rows()[key]
                elif p != "results":
                    v.pop("stage", None)
        if isinstance(held.get("rule"), int) and 0 <= held["rule"] < len(RULES):
            v["rule"] = RULES[held["rule"]]
        if scene is not None and "names" in held:
            self.party.update(now, scene, held["names"])
            c = self.party.count()
            if c:
                v["party"], v["partyMax"] = c
        g, pts = held.get("grade"), held.get("points")
        if isinstance(g, int) and 0 <= g < len(GRADES) and isinstance(pts, int):
            v["rank"] = {"grade": GRADES[g], "points": pts}
        s, jobs = held.get("salmon"), held.get("jobs")
        if isinstance(s, int) and isinstance(jobs, int):
            evp = s >= EVP_AT
            v["salmon"] = {"points": s - EVP_AT if evp else s, "evp": evp, "jobs": jobs}
        if isinstance(held.get("capsules"), int):
            v["capsules"] = held["capsules"]
        return dict(v)
