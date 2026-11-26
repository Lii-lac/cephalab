"""No-CFW source: each piece's current subs from SplatNet 3, through s3s's Nintendo login (s3s/iksm.py).

Login: the page shows a Nintendo link; the user signs in, copies the "Select this account" link and pastes it back
once. The session token and the SplatNet tokens then live in the OS keyring (vault.py). s3s gets its "f" token from
a third-party API (imink by default), which the page says before the user logs in.

Polling: the latest battle is checked every ACTIVE_EVERY seconds while battles keep coming (IDLE_EVERY when they've
stopped); the gear list is fetched only when a new battle shows up, on start, and on request.
"""
import base64
import datetime
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from pathlib import Path

import requests

from s3seed import gear as G
from s3seed.seedmath import ABILITY_ORDER

from . import log as clog
from .hub import Hub
from .vault import Vault, VaultError

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "s3s"))
try:
    import iksm                                      # noqa: E402  (s3s, GPLv3)
    import utils as s3s_utils                        # noqa: E402
    S3S_MISSING = ""
except ImportError as e:                             # s3s not cloned: the source says so instead of crashing the app
    iksm = s3s_utils = None
    S3S_MISSING = (f"s3s couldn't load ({e})" if (ROOT / "s3s" / "iksm.py").exists()
                   else "s3s isn't installed (s3s/ is empty): run tools/setup_s3s.py")

F_GEN_URL = "https://nxapi-znca-api.fancy.org.uk/api/znca/f"
NXAPI_AUTH_URL = "https://nxapi-auth.fancy.org.uk/api/oauth/token"
NXAPI_BASE_URL = "https://nxapi-znca-api.fancy.org.uk/api/znca"
NXAPI_CLIENT_ID = "bwO4_0fBZhJEGg5C41D0Gw"
NXAPI_CLIENT_VERSION = "d8fAZDPzwimzQ7c6"
CLIENT_VERSION = "0.2.3 (Cephalab)"      # sent in User-Agent to nxapi / s3s
if iksm is not None:                                # get_session_token() calls get_nsoapp_version() before log_in/get_gtoken sets these
    iksm.S3S_VERSION = CLIENT_VERSION
    iksm.F_GEN_URL = F_GEN_URL
APP_USER_AGENT = ("Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.6099.230 Mobile Safari/537.36")
ACTIVE_EVERY, IDLE_EVERY, ACTIVE_FOR = 90, 300, 20 * 60
FIVE_MIN = 300                                     # Settings > Check SplatNet > Every 5 min
MAX_BACKOFF = 600
LINK_TTL = 15 * 60
REFRESH_GAP = 30
SLOT_KEYS = {"head": ("headGears", "headGearId"), "clothes": ("clothingGears", "clothingGearId"),
             "shoes": ("shoesGears", "shoesGearId")}
# SplatNet's gearPowerId: 0..13 = the sub-able abilities in ABILITY_ORDER, 100..111 = main-only, 255 = empty
MAIN_ONLY = G.ABILITY_IDS[15:]


def power(pid) -> str:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return ""
    if 0 <= pid < len(ABILITY_ORDER):
        return ABILITY_ORDER[pid]
    if 100 <= pid < 100 + len(MAIN_ONLY):
        return MAIN_ONLY[pid - 100]
    return ""


def pieces_from_outfit(outfit: dict) -> list[dict]:
    """SplatNet's MyOutfitCommonDataEquipmentsQuery reply -> snapshot pieces (no seeds)."""
    data = (outfit or {}).get("data") or {}
    out = []
    for slot, (group, id_key) in SLOT_KEYS.items():
        for node in ((data.get(group) or {}).get("nodes") or []):
            try:
                gid = int(node[id_key])
            except (KeyError, TypeError, ValueError):
                continue
            info = G.GEAR_INFO.get((slot, gid))
            if info is None:
                continue
            subs = [power((p or {}).get("gearPowerId")) for p in (node.get("additionalGearPowers") or [])][:3]
            subs += [""] * (3 - len(subs))
            out.append({"slot": slot, "gearId": gid, "row": info[3], "brand": info[1],
                        "main": power((node.get("primaryGearPower") or {}).get("gearPowerId")), "subs": subs})
    return out


def player_key_from_history(history: dict) -> str | None:
    """The player id s3s's --getseed uses (`u-` + 20 characters), from the latest battle's player id."""
    try:
        node = history["data"]["latestBattleHistories"]["historyGroupsOnlyFirst"]["nodes"][0]["historyDetails"]["nodes"][0]
        return base64.b64decode(node["player"]["id"]).decode("utf-8").split(":")[-1]
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def player_name_from_history(history: dict) -> str | None:
    """The Splatoon 3 in-game name from the latest battle."""
    try:
        node = history["data"]["latestBattleHistories"]["historyGroupsOnlyFirst"]["nodes"][0]["historyDetails"]["nodes"][0]
        name = (node.get("player") or {}).get("name")
        return str(name) if name else None
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def latest_battle_id(history: dict) -> str | None:
    try:
        return history["data"]["latestBattleHistories"]["historyGroupsOnlyFirst"]["nodes"][0]["historyDetails"]["nodes"][0]["id"]
    except (KeyError, IndexError, TypeError):
        return None


# --- the last match, for the Discord card (SplatNet reports a match once it ends)
# SplatNet's numeric stage ids -> the datamine's __RowId (Leanny mush 1200 VersusSceneInfo / CoopSceneInfo `Id`).
VS_STAGES = {1: "Vss_Yunohana", 2: "Vss_District00", 3: "Vss_Yagara", 4: "Vss_Temple01", 5: "Vss_Factory00",
             6: "Vss_Scrap01", 7: "Vss_BigSlope00", 8: "Vss_Section01", 9: "Vss_Jyoheki03", 10: "Vss_Kaisou04",
             11: "Vss_Pivot03", 12: "Vss_Hiagari04", 13: "Vss_Upland03", 14: "Vss_Nagasaki03", 15: "Vss_Line03",
             16: "Vss_Carousel", 17: "Vss_Wave03", 18: "Vss_Pillar03", 19: "Vss_Spider00", 20: "Vss_Twist00",
             21: "Vss_Cross00", 22: "Vss_Ruins03", 23: "Vss_Propeller00", 24: "Vss_AutoWalk00", 25: "Vss_Manbou00",
             26: "Vss_Crank02"}
COOP_STAGES = {1: "Cop_Shakeup", 2: "Cop_Shakespiral", 4: "Cop_Shakelift", 6: "Cop_Shakeship", 7: "Cop_Shakedent",
               8: "Cop_Shakehighway", 9: "Cop_Shakerail", 100: "Cop_Carousel", 102: "Cop_Upland", 103: "Cop_Temple",
               104: "Cop_Factory", 105: "Cop_Section", 106: "Cop_District00", 107: "Cop_Manbou00"}
VS_MODES = {"REGULAR": "turf", "BANKARA": "anarchy", "X_MATCH": "xbattle", "PRIVATE": "private", "LEAGUE": "challenge"}
VS_RULES = {"TURF_WAR": "Pnt", "TRI_COLOR": "Tcl", "AREA": "Var", "LOFT": "Vlf", "GOAL": "Vgl", "CLAM": "Vcl"}
X_SUMMARY = {"Var": "xPowerAr", "Vlf": "xPowerLf", "Vgl": "xPowerGl", "Vcl": "xPowerCl"}
STREAK_GAP = 15 * 60                               # a match within this of the last one's end keeps the streak


def _newest_node(reply: dict, key: str) -> dict | None:
    """historyGroups first: where a reply has both, the OnlyFirst copy can leave fields out (Bankara's has no udemae)."""
    for groups in ("historyGroups", "historyGroupsOnlyFirst"):
        try:
            return reply["data"][key][groups]["nodes"][0]["historyDetails"]["nodes"][0]
        except (KeyError, IndexError, TypeError):
            pass
    return None


def _id_num(b64: str) -> int:
    """"VsStage-3" (base64) -> 3."""
    return int(base64.b64decode(b64).decode("utf-8").rsplit("-", 1)[-1])


def _played(node: dict) -> float | None:
    """playedTime (ISO, UTC) as epoch seconds; else the time in the node's id ("...:20240101T123456_uuid")."""
    s = node.get("playedTime")
    if isinstance(s, str) and s:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    try:
        m = re.search(r":(\d{8}T\d{6})_", base64.b64decode(node["id"]).decode("utf-8"))
    except (KeyError, TypeError, ValueError):
        m = None
    if not m:
        return None
    return datetime.datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=datetime.timezone.utc).timestamp()


def vs_match(detail: dict, udemae: str | None = None) -> dict | None:
    """One match from VsHistoryDetailQuery (the latest-history nodes carry only id + player):
    {mode, rule, stage, grade, rank, xpower, played, ended}. udemae ("S+4") comes from BankaraBattleHistoriesQuery."""
    try:
        node = detail["data"]["vsHistoryDetail"]
    except (KeyError, TypeError):
        return None
    played = _played(node) if isinstance(node, dict) else None
    if played is None:
        return None
    mode = VS_MODES.get((node.get("vsMode") or {}).get("mode"), "turf")
    grade, rank = None, None
    m = re.fullmatch(r"([A-Z][+-]?)(\d*)", str(udemae or ""))
    if m and mode == "anarchy":
        grade, rank = m.group(1), int(m.group(2)) if m.group(2) else None
    sid = (node.get("vsStage") or {}).get("id")
    dur = node.get("duration")
    return {"mode": mode, "rule": VS_RULES.get((node.get("vsRule") or {}).get("rule")),
            "stage": VS_STAGES.get(_id_num(sid)) if sid else None, "grade": grade, "rank": rank, "xpower": None,
            "played": played, "ended": played + dur if isinstance(dur, (int, float)) else played}


def coop_match(coop: dict) -> dict | None:
    """The newest job in CoopHistoryQuery: stage, title (grade) and its points (EVP, as rank)."""
    node = _newest_node(coop, "coopResult")
    played = _played(node) if node else None
    if played is None:
        return None
    sid = (node.get("coopStage") or {}).get("id")
    pts = node.get("afterGradePoint")
    return {"mode": "salmon", "rule": None, "stage": COOP_STAGES.get(_id_num(sid)) if sid else None,
            "grade": (node.get("afterGrade") or {}).get("name"), "rank": pts if isinstance(pts, int) else None,
            "xpower": None, "played": played, "ended": played}


def x_power(xhist: dict, rule: str | None) -> float | None:
    """XBattleHistoriesQuery: the newest measurement's power once it finished, else this rule's last X Power."""
    try:
        top = xhist["data"]["xBattleHistories"]
        meas = top["historyGroups"]["nodes"][0].get("xMatchMeasurement") or {}
        if meas.get("state") == "COMPLETED" and isinstance(meas.get("xPowerAfter"), (int, float)):
            return float(meas["xPowerAfter"])
        last = ((top.get("summary") or {}).get(X_SUMMARY.get(rule, "")) or {}).get("lastXPower")
        return float(last) if isinstance(last, (int, float)) else None
    except (KeyError, IndexError, TypeError, AttributeError):
        return None


def next_match(old: dict | None, new: dict) -> dict:
    """new as the hub keeps it: {mode, rule, stage, grade, rank, xpower, ended, started_streak}. The streak carries on
    when new is the same mode and began within STREAK_GAP of old's end; the same match again keeps old's streak."""
    m = {k: new.get(k) for k in ("mode", "rule", "stage", "grade", "rank", "xpower", "ended")}
    if old and old.get("ended") == new["ended"] and old.get("mode") == new["mode"]:
        m["started_streak"] = old.get("started_streak", new["played"])
    elif old and old.get("mode") == new["mode"] and 0 <= new["played"] - old.get("ended", 0) <= STREAK_GAP:
        m["started_streak"] = old.get("started_streak", new["played"])
    else:
        m["started_streak"] = new["played"]
    return m


class LoginNeeded(Exception):
    pass


class SplatnetError(Exception):
    pass


_iksm_lock = threading.Lock()
_TOKENISH = re.compile(r"eyJ[\w.-]+|[\w-]{40,}")

# s3s's own requests have no timeout; a hung call would hold the login lock forever. Every requests call made in
# this process gets 20 s unless it says otherwise.
_session_request = requests.Session.request


def _with_timeout(self, method, url, **kw):
    kw.setdefault("timeout", 20)
    return _session_request(self, method, url, **kw)


requests.Session.request = _with_timeout


def _quiet(step: str, fn, *a):
    """Run an s3s function. It prints (sometimes whole token replies) and calls sys.exit on errors, so its prints are
    caught by swapping the module's own print (not the process's stdout), and only its last line, with anything
    token-like cut out, goes into our message."""
    lines: list[str] = []
    mods = [m for m in (iksm, s3s_utils) if m is not None]
    with _iksm_lock:
        for m in mods:
            m.print = lambda *x, **k: lines.append(" ".join(str(v) for v in x))
        try:
            return fn(*a)
        except SystemExit:
            last = next((ln.strip() for ln in reversed(lines) if ln.strip()), "")
            last = _TOKENISH.sub("…", last)[:160]
            raise SplatnetError(f"{step}: {last}" if last else step) from None
        except requests.RequestException as e:
            raise SplatnetError(f"{step}: couldn't reach Nintendo ({e.__class__.__name__})") from None
        except (KeyError, TypeError, ValueError, IndexError):
            raise SplatnetError(f"{step}: Nintendo's reply wasn't what s3s expected") from None
        finally:
            for m in mods:
                try:
                    delattr(m, "print")
                except AttributeError:
                    pass


_nso_ver_cache: str | None = None


def _nxapi_nso_version() -> str:
    """Newest Android NSO app version supported by nxapi-znca-api (cached for the process)."""
    global _nso_ver_cache
    if _nso_ver_cache:
        return _nso_ver_cache
    try:
        r = requests.get(f"{NXAPI_BASE_URL}/config", headers={"User-Agent": f"s3s/{CLIENT_VERSION}"}, timeout=15)
        cfg = r.json() if r.ok else {}
        vers = [
            v["version"] for v in (cfg.get("versions") or [])
            if isinstance(v, dict) and isinstance(v.get("version"), str)
            and re.fullmatch(r"\d+(?:\.\d+){1,3}", v["version"])
            and (not v.get("platform") or v.get("platform") == "Android")
        ]
        if vers:
            _nso_ver_cache = max(vers, key=lambda s: tuple(int(p) for p in s.split(".")))
            return _nso_ver_cache
        if isinstance(cfg.get("nso_version"), str) and re.fullmatch(r"\d+(?:\.\d+){1,3}", cfg["nso_version"]):
            _nso_ver_cache = cfg["nso_version"]
            return _nso_ver_cache
    except Exception:
        pass
    return "3.6.0"


def _nxapi_gtoken(session_token: str) -> tuple[str, str, str, str]:
    """Exchange a Nintendo session_token for a SplatNet 3 gtoken using Coral v4 + nxapi-znca-api."""
    nso_ver = _nxapi_nso_version()
    ua = f"s3s/{CLIENT_VERSION}"
    try:
        r = requests.post(
            "https://accounts.nintendo.com/connect/1.0.0/api/token",
            headers={
                "Host": "accounts.nintendo.com", "Accept-Encoding": "gzip", "Content-Type": "application/json",
                "Accept": "application/json", "Connection": "Keep-Alive",
                "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 14; Pixel 7a Build/UQ1A.240105.004)",
            },
            json={
                "client_id": "71b963c1b7b6d119", "session_token": session_token,
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token",
            },
            timeout=25,
        )
        if not r.ok:
            raise SplatnetError(f"Nintendo token exchange failed (HTTP {r.status_code})")
        id_resp = r.json()
        access_token, id_token = id_resp["access_token"], id_resp["id_token"]

        r = requests.get(
            "https://api.accounts.nintendo.com/2.0.0/users/me",
            headers={
                "User-Agent": "NASDKAPI; Android", "Content-Type": "application/json", "Accept": "application/json",
                "Authorization": f"Bearer {access_token}", "Host": "api.accounts.nintendo.com",
                "Connection": "Keep-Alive", "Accept-Encoding": "gzip",
            },
            timeout=25,
        )
        if not r.ok:
            raise SplatnetError(f"Nintendo user lookup failed (HTTP {r.status_code})")
        me = r.json()
        nick, lang, country, user_id = me.get("nickname", ""), me["language"], me["country"], me["id"]

        r = requests.post(
            NXAPI_AUTH_URL,
            data={"grant_type": "client_credentials", "client_id": NXAPI_CLIENT_ID, "scope": "ca:gf ca:er ca:dr"},
            headers={"User-Agent": ua},
            timeout=25,
        )
        if not r.ok:
            raise SplatnetError(f"nxapi auth failed (HTTP {r.status_code})")
        nx_token = r.json()["access_token"]

        def nx_post(path: str, payload: dict, accept: str = "application/json"):
            resp = requests.post(
                f"{NXAPI_BASE_URL}/{path}",
                headers={
                    "Authorization": f"Bearer {nx_token}", "Content-Type": "application/json", "Accept": accept,
                    "User-Agent": ua, "X-znca-Platform": "Android", "X-znca-Version": nso_ver,
                    "X-znca-Client-Version": NXAPI_CLIENT_VERSION,
                },
                json=payload,
                timeout=30,
            )
            if not resp.ok:
                detail = ""
                try:
                    err = resp.json()
                    detail = err.get("error_description") or err.get("error") or ""
                except Exception:
                    pass
                raise SplatnetError(f"nxapi {path} failed (HTTP {resp.status_code}{': ' + detail if detail else ''})")
            return resp.json()

        def coral_v4(path: str, token: str, hash_method: str, parameter: dict, coral_user_id: str | None = None) -> dict:
            url = f"https://api-lp1.znc.srv.nintendo.net/v4/{path}"
            req_body: dict = {
                "token": token, "hash_method": hash_method, "na_id": user_id,
                "encrypt_token_request": {"url": url, "parameter": parameter},
            }
            if coral_user_id is not None:
                req_body["coral_user_id"] = coral_user_id
            enc = nx_post("f", req_body)
            raw_req = base64.b64decode(enc["encrypted_token_request"])
            headers = {
                "X-Platform": "Android", "X-ProductVersion": nso_ver,
                "Content-Type": "application/octet-stream", "Accept": "application/octet-stream,application/json",
                "User-Agent": f"com.nintendo.znca/{nso_ver}(Android/12)",
            }
            if hash_method == "2":
                headers["Authorization"] = f"Bearer {token}"
            n_resp = requests.post(url, headers=headers, data=raw_req, timeout=30)
            if n_resp.status_code != 200:
                raise SplatnetError(f"Nintendo {path} failed (HTTP {n_resp.status_code})")
            dec = nx_post("decrypt-response", {"data": base64.b64encode(n_resp.content).decode("ascii")}, accept="text/plain")
            if isinstance(dec, dict) and isinstance(dec.get("data"), str):
                dec = json.loads(dec["data"])
            if not isinstance(dec, dict) or dec.get("status") != 0 or not dec.get("result"):
                raise SplatnetError(f"Nintendo {path} rejected authentication")
            return dec["result"]

        acct = coral_v4("Account/Login", id_token, "1", {
            "naIdToken": id_token, "language": lang, "timestamp": 0, "requestId": "", "f": "",
        })
        coral_token = acct["webApiServerCredential"]["accessToken"]
        coral_uid = str(acct["user"]["id"])
        game = coral_v4("Game/GetWebServiceToken", coral_token, "2", {
            "id": 4834290508791808, "registrationToken": "", "f": "", "requestId": "", "timestamp": 0,
        }, coral_user_id=coral_uid)
        return game["accessToken"], nick, lang, country
    except SplatnetError:
        raise
    except requests.RequestException as e:
        raise SplatnetError(f"SplatNet token: couldn't reach server ({e.__class__.__name__})") from None
    except (KeyError, TypeError, ValueError) as e:
        raise SplatnetError(f"SplatNet token: unexpected auth reply ({e.__class__.__name__})") from None


class SplatnetSource:
    name = "s3s"

    def __init__(self, hub: Hub, vault: Vault | None = None, state_dir: Path | None = None, mode: str = "battle"):
        self.hub, self.vault = hub, vault or Vault()
        self.mode = mode                                   # Settings > Check SplatNet: battle | 5min | off
        self.state_dir = state_dir or hub.dir
        self.wake = threading.Event()
        self._verifier: bytes | None = None
        self._link: tuple[str, float] | None = None
        self._last_battle: str | None = None
        self._last_battle_at = 0.0
        self._need_outfit = True
        self._outfit_at = 0.0
        self._vs: tuple[str, dict | None] | None = None    # (battle id, its parsed match): one detail query per battle
        self._coop: tuple[str, dict | None] | None = None  # (newest job id, its parsed job)

    def _vs_match(self, bid: str) -> dict | None:
        detail = self._query("VsHistoryDetailQuery", "vsResultId", bid)
        mode = (((detail.get("data") or {}).get("vsHistoryDetail") or {}).get("vsMode") or {}).get("mode")
        udemae = None
        if mode == "BANKARA":
            try:
                node = _newest_node(self._query("BankaraBattleHistoriesQuery"), "bankaraBattleHistories")
                udemae = (node or {}).get("udemae")
            except Exception:
                pass                                       # the card just goes without the rank
        vs = vs_match(detail, udemae)
        if vs and vs["mode"] == "xbattle":
            try:
                vs["xpower"] = x_power(self._query("XBattleHistoriesQuery"), vs["rule"])
            except Exception:
                pass                                       # the card just goes without X Power
        return vs

    def _update_match(self, history: dict):
        """hub.last_match <- the newest VS match or Salmon Run job, whichever is newer. Only a new battle id / job id is
        parsed (and only a new battle costs extra queries). Never raises: a reply it can't read keeps the old value."""
        try:
            bid = latest_battle_id(history)
            if bid and (self._vs is None or self._vs[0] != bid):
                try:
                    self._vs = (bid, self._vs_match(bid))
                except Exception:
                    clog.get().warning("SplatNet battle detail not read", exc_info=True)   # retried next poll
            try:
                coop = self._query("CoopHistoryQuery")
                jid = (_newest_node(coop, "coopResult") or {}).get("id")
                if jid and (self._coop is None or self._coop[0] != jid):
                    self._coop = (jid, coop_match(coop))
            except Exception:
                clog.get().warning("SplatNet jobs not read", exc_info=True)
            new = max((c[1] for c in (self._vs, self._coop) if c and c[1]), key=lambda m: m["played"], default=None)
            if new:
                self.hub.last_match = next_match(getattr(self.hub, "last_match", None), new)
        except Exception:
            clog.get().warning("SplatNet last match not read", exc_info=True)

    # --- login (the page drives this through /api/login)
    def login_url(self) -> str:
        """A Nintendo sign-in link (PKCE); the verifier stays in memory until the link comes back. The same link is
        handed out for LINK_TTL, so the page asking twice doesn't void the one the user already opened."""
        if self._link and time.time() - self._link[1] < LINK_TTL:
            return self._link[0]
        self._verifier = base64.urlsafe_b64encode(os.urandom(32))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self._verifier.replace(b"=", b"")).digest())
        body = {
            "state": base64.urlsafe_b64encode(os.urandom(36)).decode(),
            "redirect_uri": "npf71b963c1b7b6d119://auth",
            "client_id": "71b963c1b7b6d119",
            "scope": "openid user user.birthday user.mii user.screenName",
            "response_type": "session_token_code",
            "session_token_code_challenge": challenge.replace(b"=", b"").decode(),
            "session_token_code_challenge_method": "S256",
            "theme": "login_form",
        }
        url = "https://accounts.nintendo.com/connect/1.0.0/authorize?" + urllib.parse.urlencode(body)
        self._link = (url, time.time())
        return url

    def finish_login(self, link: str):
        """The pasted "Select this account" link -> tokens in the keyring. Raises SplatnetError with a plain message."""
        if iksm is None:
            raise SplatnetError(S3S_MISSING)
        if self._verifier is None:
            raise SplatnetError("Open the sign-in link first (it expires when the companion restarts)")
        m = re.search(r"session_token_code=([^&\s]+)", link or "") or re.search(r"de=(.*)&st", link or "")
        if not m:
            raise SplatnetError("That isn't the link from \"Select this account\" (it starts with npf71b963c1b7b6d119://auth)")
        iksm.S3S_VERSION = CLIENT_VERSION
        iksm.F_GEN_URL = F_GEN_URL
        if getattr(iksm, "__name__", "") == "iksm":
            iksm.NSOAPP_VERSION = _nxapi_nso_version()
        clog.get().info("SplatNet login: exchanging Nintendo session_token_code")
        session_token = _quiet("Nintendo sign-in", iksm.get_session_token, m.group(1), self._verifier)
        if not session_token:
            raise SplatnetError("Nintendo didn't accept that link; open a new sign-in link and try again")
        self._verifier, self._link = None, None
        try:
            self.vault.save({"session_token": session_token})
            self._refresh_tokens()
        except VaultError as e:
            raise SplatnetError(str(e)) from None
        clog.get().info("SplatNet login: tokens saved and verified")
        self._need_outfit = True
        self.wake.set()

    def logout(self):
        self.vault.clear()
        self.hub.set_status(self.name, "login-needed", "Signed out")

    def _refresh_tokens(self) -> dict:
        v = self.vault.load()
        if not v.get("session_token"):
            raise LoginNeeded("Sign in to Nintendo once to read your gear from SplatNet")
        if getattr(iksm, "__name__", "") == "iksm":
            gtoken, nick, lang, country = _nxapi_gtoken(v["session_token"])
        else:
            gtoken, nick, lang, country = _quiet("SplatNet token", iksm.get_gtoken, F_GEN_URL, v["session_token"], CLIENT_VERSION)
        bullet = _quiet("SplatNet token", iksm.get_bullet, gtoken, APP_USER_AGENT, lang, country)
        return self.vault.update(gtoken=gtoken, bullettoken=bullet, lang=lang, country=country, nickname=nick or v.get("nickname") or "")

    # --- SplatNet
    def _query(self, name: str, var_name: str | None = None, var_val: str | None = None, retry: bool = True) -> dict:
        v = self.vault.load()
        if not v.get("session_token"):
            raise LoginNeeded("Sign in to Nintendo once to read your gear from SplatNet")
        if not v.get("gtoken") or not v.get("bullettoken"):
            v = self._refresh_tokens()
        lang, country = v.get("lang") or "en-US", v.get("country") or "US"
        headers = {
            "Authorization": f"Bearer {v['bullettoken']}", "Accept-Language": lang, "User-Agent": APP_USER_AGENT,
            "X-Web-View-Ver": _quiet("SplatNet version", iksm.get_web_view_ver), "Content-Type": "application/json", "Accept": "*/*",
            "Origin": iksm.SPLATNET3_URL, "X-Requested-With": "com.nintendo.znca",
            "Referer": f"{iksm.SPLATNET3_URL}?lang={lang}&na_country={country}&na_lang={lang}",
        }
        rid = s3s_utils.translate_rid[name]
        body = s3s_utils.gen_graphql_body(rid, var_name, var_val) if var_name else s3s_utils.gen_graphql_body(rid)
        try:
            r = requests.post(iksm.GRAPHQL_URL, data=body, headers=headers, cookies={"_gtoken": v["gtoken"]}, timeout=20)
        except requests.RequestException as e:
            raise SplatnetError(f"Couldn't reach SplatNet 3: {e.__class__.__name__}") from None
        if r.status_code in (401, 403) and retry:          # tokens expire every few hours: make new ones once
            self._refresh_tokens()
            return self._query(name, var_name, var_val, retry=False)
        if r.status_code != 200:
            raise SplatnetError(f"SplatNet 3 answered {r.status_code}")
        try:
            return r.json()
        except ValueError:
            raise SplatnetError("SplatNet 3 sent something that isn't JSON") from None

    def poll_once(self):
        history = self._query("LatestBattleHistoriesQuery")
        bid = latest_battle_id(history)
        key = player_key_from_history(history)
        v = self.vault.load()
        pname = player_name_from_history(history) or v.get("playerName")
        if not pname and bid:
            try:
                detail = self._query("VsHistoryDetailQuery", "vsResultId", bid)
                players = ((detail.get("data") or {}).get("vsHistoryDetail") or {}).get("myTeam", {}).get("players") or []
                pname = next((str(p["name"]) for p in players if p.get("isMyself") and p.get("name")), None)
            except Exception:
                pname = None
        if key or pname:
            patch = {}
            if key and v.get("playerKey") != key:
                patch["playerKey"] = key
            if pname and v.get("playerName") != pname:
                patch["playerName"] = pname
            if patch:
                v = self.vault.update(**patch)
        self._update_match(history)
        if bid and bid != self._last_battle:
            if self._last_battle is not None:
                self._last_battle_at = time.time()
                self._need_outfit = True
            self._last_battle = bid
        if self._need_outfit:
            outfit = self._query("MyOutfitCommonDataEquipmentsQuery")
            raw = self.state_dir / "splatnet_raw.json"
            if not raw.exists():                           # kept once, to check the id mapping against a real reply
                raw.write_text(json.dumps(outfit), encoding="utf-8")
            pieces = pieces_from_outfit(outfit)
            if not pieces:
                raise SplatnetError("SplatNet 3 returned no gear")
            v = self.vault.load()
            player = pname or v.get("playerName") or v.get("nickname") or ""
            self.hub.publish({"source": self.name, "gameVersion": "", "playerKey": key or v.get("playerKey"),
                              "player": player, "pieces": pieces})
            self._need_outfit = False
            self._outfit_at = time.time()
        self.hub.set_status(self.name, "ok", "", f_api=F_GEN_URL)

    def refresh(self) -> bool:
        """Fetch the gear now (the page's refresh button). Ignored within REFRESH_GAP of the last fetch."""
        if time.time() - self._outfit_at < REFRESH_GAP:
            return False
        self._need_outfit = True
        self.wake.set()
        return True

    def set_mode(self, mode: str):
        if mode != self.mode:
            self.mode = mode
            self._need_outfit = True                       # turned back on: fetch the gear at once
            self.wake.set()

    def run(self, stop: threading.Event):
        backoff = 30
        while not stop.is_set():
            if self.mode == "off" or iksm is None:
                if self.mode == "off":
                    self.hub.set_status(self.name, "off", "SplatNet checking is off")
                else:
                    self.hub.set_status(self.name, "error", S3S_MISSING)
                self.wake.wait(3600)
                self.wake.clear()
                continue
            try:
                self.poll_once()
                backoff = 30
                active = time.time() - self._last_battle_at < ACTIVE_FOR
                delay = FIVE_MIN if self.mode == "5min" else ACTIVE_EVERY if active else IDLE_EVERY
            except LoginNeeded as e:
                self.hub.set_status(self.name, "login-needed", str(e), f_api=F_GEN_URL)
                delay = 3600
            except SplatnetError as e:
                clog.get().warning("SplatNet poll error: %s", e)
                self.hub.set_status(self.name, "error", str(e), f_api=F_GEN_URL)
                delay, backoff = backoff, min(backoff * 2, MAX_BACKOFF)
            except Exception as e:                      # anything else must not kill the poller silently
                clog.get().exception("SplatNet poll crashed")
                self.hub.set_status(self.name, "error", f"SplatNet read failed ({e.__class__.__name__})", f_api=F_GEN_URL)
                delay, backoff = backoff, min(backoff * 2, MAX_BACKOFF)
            self.wake.wait(delay)
            self.wake.clear()                            # cleared after waking, before the next poll: a wake that
                                                         # comes in during that poll is kept for the wait after it
