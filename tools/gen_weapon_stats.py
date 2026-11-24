"""Generates web/src/data/weapon-stats.json from local data/WeaponInfoMain.json,
web/src/data/gear-catalog.json, and Leanny's v1200 datamine parameter tables
(cached under cache/params/1200/).
Run: .venv/Scripts/python.exe tools/gen_weapon_stats.py"""
import json
import math
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / "cache" / "params" / "1200"
BASE_URL = "https://raw.githubusercontent.com/Leanny/splat3/main/data/"

SPEED_TYPE = {"Fast": "L", "Mid": "N", "Slow": "H"}

# Engine default InkRecoverStop frames when omitted from a weapon's GameParameterTable.
DEFAULT_RECOVER_STOP = {
    "Shooter": 20,
    "Maneuver": 20,
    "Charger": 20,
    "Stringer": 20,
    "Shelter": 40,
    "Blaster": 20,
    "Roller": 40,
    "Brush": 30,
    "Slosher": 40,
    "Spinner": 40,
    "Saber": 40,
}


def fetch_json(rel_url: str, cache_rel: str) -> dict | list:
    dest = CACHE / cache_rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        return json.loads(dest.read_text(encoding="utf-8"))
    url = BASE_URL + rel_url
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Cephalab"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read()
            dest.write_bytes(raw)
            time.sleep(0.05)
            return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code == 404:
                break
            time.sleep(0.4 * (attempt + 1))
        except Exception as exc:
            last_err = exc
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def actor_from_gyml(path: str) -> str:
    return path.split("/")[-1].split(".")[0]


def fetch_weapon_param(actor: str) -> dict:
    direct = CACHE / "weapon" / f"{actor}.game__GameParameterTable.json"
    base = re.sub(r"_Cstm\d*$", "", actor)
    if not direct.exists() and base != actor:
        base_file = CACHE / "weapon" / f"{base}.game__GameParameterTable.json"
        if base_file.exists():
            return json.loads(base_file.read_text(encoding="utf-8"))["GameParameters"]
    try:
        return fetch_json(
            f"parameter/1200/weapon/{actor}.game__GameParameterTable.json",
            f"weapon/{actor}.game__GameParameterTable.json",
        )["GameParameters"]
    except RuntimeError:
        # Brella alt kits reference WeaponShelter*_Cstm / _Cstm2, whose params live on the base actor.
        if base != actor:
            return fetch_json(
                f"parameter/1200/weapon/{base}.game__GameParameterTable.json",
                f"weapon/{base}.game__GameParameterTable.json",
            )["GameParameters"]
        raise


def r4(v: float) -> float:
    return round(float(v), 4)


def extract_weapon(row: str, cls: str, wm_row: dict, gp: dict) -> dict:
    mws = gp.get("MainWeaponSetting") or {}
    wt = SPEED_TYPE.get(mws.get("WeaponSpeedType", "Mid"), "N")
    spp = int(wm_row["SpecialPoint"])

    ink: float | None = None
    act = "Shot"
    ink2: float | None = None
    act2: str | None = None
    rec_frames: float | None = None
    mspd: float | None = None
    rsu = True

    if cls == "Shooter":
        wp = gp["WeaponParam"]
        ink = wp["InkConsume"] * 100
        rec_frames = wp.get("InkRecoverStop")
        mspd = wp.get("MoveSpeed")
        vwp = gp.get("VariableWeaponParam")
        if vwp and "InkConsume" in vwp:
            # Squeezer: tap shot (WeaponParam) vs hold shot (VariableWeaponParam)
            act = "Tap shot"
            ink2 = vwp["InkConsume"] * 100
            act2 = "Hold shot"
        else:
            act = "Shot"
    elif cls == "Blaster":
        wp = gp["WeaponParam"]
        ink = wp["InkConsume"] * 100
        act = "Shot"
        rec_frames = wp.get("InkRecoverStop")
        mspd = wp.get("MoveSpeed")
    elif cls == "Maneuver":
        wp = gp["WeaponParam"]
        sp = gp.get("SideStepParam") or {}
        ink = wp["InkConsume"] * 100
        act = "Shot"
        if sp.get("InkConsume", 0) > 0:
            ink2 = sp["InkConsume"] * 100
            act2 = "Dodge roll"
        rec_frames = wp.get("InkRecoverStop")
        mspd = wp.get("MoveSpeed")
    elif cls == "Slosher":
        wp = gp["WeaponParam"]
        ink = wp["InkConsume"] * 100
        act = "Slosh"
        rec_frames = wp.get("InkRecoverStop")
        mspd = wp.get("MoveSpeed")
    elif cls == "Spinner":
        wp = gp["WeaponParam"]
        ink = wp["InkConsume"] * 100
        act = "Full charge"
        rec_frames = wp.get("InkRecoverStop")
        mspd = wp.get("MoveSpeed")
    elif cls == "Charger":
        wp = gp["WeaponParam"]
        ink = wp["InkConsumeFullCharge"] * 100
        act = "Full charge"
        if wp.get("InkConsumeMinCharge", 0) > 0:
            ink2 = wp["InkConsumeMinCharge"] * 100
            act2 = "Tap shot"
        rec_frames = wp.get("InkRecoverStop")
        mspd = wp.get("MoveSpeedFullCharge")
    elif cls == "Stringer":
        cp = gp["spl__WeaponStringerParam"]["ChargeParam"]
        ink = cp["InkConsumeFullCharge"] * 100
        act = "Full charge"
        if cp.get("InkConsumeMinCharge", 0) > 0:
            ink2 = cp["InkConsumeMinCharge"] * 100
            act2 = "Tap shot"
        rec_frames = cp.get("InkRecoverStop")
        mspd = cp.get("MoveSpeedFullCharge")
    elif cls == "Roller":
        wide = gp["WeaponWideSwingParam"]
        vert = gp.get("WeaponVerticalSwingParam") or {}
        ink = wide["InkConsume"] * 100
        act = "Flick"
        if vert.get("InkConsume", 0) > 0 and abs(vert["InkConsume"] - wide["InkConsume"]) > 1e-6:
            ink2 = vert["InkConsume"] * 100
            act2 = "Vertical flick"
        rec_frames = wide.get("InkRecoverStop")
        mspd = wide.get("SwingMoveSpeed")
        rsu = False
    elif cls == "Brush":
        sw = gp["WeaponSwingParam"]
        ink = sw["InkConsume"] * 100
        act = "Swing"
        rec_frames = sw.get("InkRecoverStop")
        mspd = sw.get("SwingMoveSpeed")
        rsu = False
    elif cls == "Saber":
        sp = gp["spl__WeaponSaberParam"]
        sw = sp["SwingParam"]
        cp = sp["ChargeParam"]
        ink = sw["InkConsume"] * 100
        act = "Swing"
        if cp.get("InkConsumeFullCharge", 0) > 0:
            ink2 = cp["InkConsumeFullCharge"] * 100
            act2 = "Full charge"
        rec_frames = sw.get("InkRecoverStop", cp.get("InkRecoverStop"))
        mspd = sw.get("ChargeMoveVelLimit")
    elif cls == "Shelter":
        sg = gp["spl__WeaponShelterShotgunParam"]
        cn = gp.get("spl__WeaponShelterCanopyParam") or {}
        ink = sg["InkConsume"] * 100
        act = "Shot"
        if cn.get("InkConsumeUmbrella", 0) > 0:
            ink2 = cn["InkConsumeUmbrella"] * 100
            act2 = "Shield launch"
        rec_frames = sg.get("InkRecoverStop")
        mspd = sg.get("MoveSpeed")
    else:
        raise ValueError(f"Unknown weapon class {cls!r} for {row}")

    if rec_frames is None:
        rec_frames = DEFAULT_RECOVER_STOP[cls]

    entry: dict = {
        "spp": spp,
        "wt": wt,
        "ink": r4(ink),
        "act": act,
        "rec": r4(rec_frames / 60.0),
    }
    if ink2 is not None and act2 is not None:
        entry["ink2"] = r4(ink2)
        entry["act2"] = act2
    if mspd is not None and mspd > 0:
        entry["mspd"] = r4(mspd * 10.0)
    if not rsu:
        entry["rsu"] = False

    # Main Ink Saver override: Nintendo uses -1.0 as sentinel for "use default".
    mis_hi = mws.get("Overwrite_ConsumeRt_Main_High")
    mis_mid = mws.get("Overwrite_ConsumeRt_Main_Mid")
    mis_lo = mws.get("Overwrite_ConsumeRt_Main_Low", 1.0)
    if mis_hi is not None and mis_hi > 0 and mis_mid is not None and mis_mid > 0:
        if mis_lo is None or mis_lo <= 0:
            mis_lo = 1.0
        entry["mis"] = [r4(mis_hi), r4(mis_mid), r4(mis_lo)]

    # Run Speed Up firing velocity override (Splatlings).
    rsu_hi = mws.get("Overwrite_MoveVelRt_Shot_High")
    rsu_mid = mws.get("Overwrite_MoveVelRt_Shot_Mid")
    rsu_lo = mws.get("Overwrite_MoveVelRt_Shot_Low", 1.0)
    if rsu and rsu_hi is not None and rsu_hi > 0 and rsu_mid is not None and rsu_mid > 0:
        if rsu_lo is None or rsu_lo <= 0:
            rsu_lo = 1.0
        if abs(rsu_hi - 1.25) > 1e-4 or abs(rsu_mid - 1.125) > 1e-4 or abs(rsu_lo - 1.0) > 1e-4:
            entry["rsuCurve"] = [r4(rsu_lo), r4(rsu_mid), r4(rsu_hi)]

    # Splattershot Jr. family has a 110% ink tank in Splatoon 3.
    if actor_from_gyml(wm_row["SpecActor"]) == "WeaponShooterFirst":
        entry["tank"] = 110

    return entry


def extract_sub(sub_key: str, gp: dict) -> dict:
    sws = gp.get("SubWeaponSetting") or {}
    wp = gp.get("WeaponParam") or {}
    # Default SubWeapon InkConsume is 0.7 (Splat Bomb, Suction Bomb), SubInkSaveLv default is 2.
    ink = wp.get("InkConsume", 0.7) * 100.0
    rec_frames = wp.get("InkRecoverStop", 60)
    lv = int(sws.get("SubInkSaveLv", 2))
    return {
        "ink": r4(ink),
        "rec": r4(rec_frames / 60.0),
        "lv": lv,
    }


def _find_spec_up(blast: dict, spec_type: str) -> dict | None:
    for item in blast.get("SubSpecialSpecUpList") or []:
        if item.get("SpecUpType") == spec_type:
            return item.get("Value")
    return None


def _curve3(d: dict, scale: float = 1.0) -> tuple[float, float, float]:
    return (r4(d["Low"] * scale), r4(d["Mid"] * scale), r4(d["High"] * scale))


def extract_special(sp_key: str, gp: dict) -> list[dict]:
    if sp_key == "SpGreatBarrier":
        bp = gp["spl__BulletSpGreatBarrierMoveParam"]["BarrierParam"]
        lo1, mid1, hi1 = _curve3(bp["MaxFieldHP"], 0.1)
        lo2, mid2, hi2 = _curve3(bp["MaxHP"], 0.1)
        return [
            {"n": "Big Bubbler shield HP", "low": lo1, "mid": mid1, "high": hi1, "d": 0, "u": "hp"},
            {"n": "Big Bubbler device HP", "low": lo2, "mid": mid2, "high": hi2, "d": 0, "u": "hp"},
        ]
    if sp_key == "SpBlower":
        lo, mid, hi = _curve3(gp["InhaleParam"]["RadiusMax"])
        return [{"n": "Ink Vac inhale radius", "low": lo, "mid": mid, "high": hi, "d": 2, "u": ""}]
    if sp_key == "SpCastle":
        lo, mid, hi = _curve3(gp["WeaponParam"]["SpecialTotalFrame"], 1 / 60)
        return [{"n": "Kraken Royale duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s"}]
    if sp_key == "SpChariot":
        lo, mid, hi = _curve3(gp["WeaponSpChariotParam"]["SpecialTotalFrame"], 1 / 60)
        return [{"n": "Crab Tank duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s"}]
    if sp_key == "SpChimney":
        lo, mid, hi = _curve3(gp["WallParam"]["MoveSpeed"], 10.0)
        return [{"n": "Splattercolor Screen speed", "low": lo, "mid": mid, "high": hi, "d": 2, "u": ""}]
    if sp_key == "SpEnergyStand":
        lo, mid, hi = _curve3(gp["FridgeParam"]["PowerUpFrame"], 1 / 60)
        return [{"n": "Tacticooler buff duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s"}]
    if sp_key == "SpFirework":
        v = _find_spec_up(gp["IceParam"]["BlastParam"], "DistanceDamageDistanceRate")
        lo, mid, hi = _curve3(v, 100.0)
        return [{"n": "Super Chump blast radius", "low": lo, "mid": mid, "high": hi, "d": 1, "u": "%"}]
    if sp_key == "SpInkStorm":
        lo, mid, hi = _curve3(gp["CloudParam"]["RainyFrame"], 1 / 60)
        return [{"n": "Ink Storm duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s"}]
    if sp_key == "SpJetpack":
        lo, mid, hi = _curve3(gp["WeaponParam"]["SpecialTotalFrame"], 1 / 60)
        return [{"n": "Inkjet duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s"}]
    if sp_key == "SpMicroLaser":
        lo, mid, hi = _curve3(gp["spl__BulletSpMicroLaserBitParam"]["LaserParam"]["LaserFrame"], 1 / 60)
        return [{"n": "Killer Wail 5.1 duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s"}]
    if sp_key == "SpMultiMissile":
        c = gp["spl__WeaponSpMultiMissileLockOnParam"]["TargetInCircleRadius"]
        base = c["Low"]
        return [{"n": "Tenta Missiles reticle", "low": 100.0, "mid": r4(c["Mid"] / base * 100), "high": r4(c["High"] / base * 100), "d": 1, "u": "%"}]
    if sp_key == "SpNiceBall":
        # Auto-charge rate per frame; editor-stats converts to auto-charge time = 1 / (rate * 60)
        lo, mid, hi = _curve3(gp["WeaponParam"]["ChargeRateAutoPerFrame"], 60.0)
        return [{"n": "Booyah Bomb auto-charge", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s", "inv": True}]
    if sp_key == "SpPogo":
        v = _find_spec_up(gp["BlastParamNormal"], "DistanceDamageDistanceRate")
        lo, mid, hi = _curve3(v, 100.0)
        return [{"n": "Triple Splashdown blast radius", "low": lo, "mid": mid, "high": hi, "d": 1, "u": "%"}]
    if sp_key == "SpShockSonar":
        lo, mid, hi = _curve3(gp["spl__BulletSpShockSonarParam"]["WaveParam"]["MaxRadius"])
        return [{"n": "Wave Breaker radius", "low": lo, "mid": mid, "high": hi, "d": 1, "u": ""}]
    if sp_key == "SpSkewer":
        v = _find_spec_up(gp["BulletBlastParam"], "DistanceDamageDistanceRate")
        lo, mid, hi = _curve3(v, 100.0)
        return [{"n": "Reefslider blast radius", "low": lo, "mid": mid, "high": hi, "d": 1, "u": "%"}]
    if sp_key == "SpSuperHook":
        # Ink consumed per second while active; editor-stats converts to max duration = 1 / rate
        lo, mid, hi = _curve3(gp["WeaponParam"]["InkConsume_PerSec"])
        return [{"n": "Zipcaster max duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s", "inv": True}]
    if sp_key == "SpTripleTornado":
        c = gp["MoveParam"]["SpawnSpeedZSpecUp"]
        base = c["Low"]
        return [{"n": "Triple Inkstrike throw speed", "low": 100.0, "mid": r4(c["Mid"] / base * 100), "high": r4(c["High"] / base * 100), "d": 1, "u": "%"}]
    if sp_key == "SpUltraShot":
        lo, mid, hi = _curve3(gp["spl__WeaponSpUltraShotParam"]["SpecialDurationFrame"], 1 / 60)
        return [{"n": "Trizooka duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s"}]
    if sp_key == "SpUltraStamp":
        lo, mid, hi = _curve3(gp["spl__WeaponSpUltraStampParam"]["SpecialTotalFrame"], 1 / 60)
        return [{"n": "Ultra Stamp duration", "low": lo, "mid": mid, "high": hi, "d": 2, "u": "s"}]
    return [{"n": f"{sp_key} power", "low": 100.0, "mid": 115.0, "high": 130.0, "d": 1, "u": "%"}]


def main() -> None:
    wm = {w["__RowId"]: w for w in json.loads((DATA / "WeaponInfoMain.json").read_text(encoding="utf-8"))}
    catalog = json.loads((ROOT / "web" / "src" / "data" / "gear-catalog.json").read_text(encoding="utf-8"))

    spl_player = fetch_json(
        "parameter/1200/misc/SplPlayer.game__GameParameterTable.json",
        "misc/SplPlayer.game__GameParameterTable.json",
    )["GameParameters"]
    wsub_info = {
        w["__RowId"]: w
        for w in fetch_json("mush/1200/WeaponInfoSub.json", "mush/WeaponInfoSub.json")
    }
    wspe_info = {
        w["__RowId"]: w
        for w in fetch_json("mush/1200/WeaponInfoSpecial.json", "mush/WeaponInfoSpecial.json")
    }

    action_squid = spl_player["spl__PlayerGearSkillParam_ActionSpecUp_Squid"]
    sub_def = spl_player["spl__PlayerGearSkillParam_SubEffectReduction"]
    player_params = {
        "surgeFrm": [
            int(action_squid["WallJumpChargeFrm_Low"]),
            int(action_squid["WallJumpChargeFrm_Mid"]),
            int(action_squid["WallJumpChargeFrm_High"]),
        ],
        "bombDmgRt": [
            100.0,
            r4(sub_def["DamageRt_BombL_Mid"] * 100.0),
            r4(sub_def["DamageRt_BombL_High"] * 100.0),
        ],
    }

    actor_cache: dict[str, dict] = {}
    weapons_out: dict[str, dict] = {}
    subs_out: dict[str, dict] = {}
    specials_out: dict[str, list[dict]] = {}

    for w in catalog["weapons"]:
        row, cls, sub_key, sp_key = w["row"], w["cls"], w["sub"], w["sp"]
        wm_row = wm[row]
        actor = actor_from_gyml(wm_row["SpecActor"])
        if actor not in actor_cache:
            actor_cache[actor] = fetch_weapon_param(actor)
        weapons_out[row] = extract_weapon(row, cls, wm_row, actor_cache[actor])

        if sub_key not in subs_out:
            sub_actor = actor_from_gyml(wsub_info[sub_key]["SpecActor"])
            if sub_actor not in actor_cache:
                actor_cache[sub_actor] = fetch_weapon_param(sub_actor)
            subs_out[sub_key] = extract_sub(sub_key, actor_cache[sub_actor])

        if sp_key not in specials_out:
            sp_actor = actor_from_gyml(wspe_info[sp_key]["SpecActor"])
            if sp_actor not in actor_cache:
                actor_cache[sp_actor] = fetch_weapon_param(sp_actor)
            specials_out[sp_key] = extract_special(sp_key, actor_cache[sp_actor])

    # Assertions required by brief: every catalog weapon has valid, finite params.
    for w in catalog["weapons"]:
        row, sub_key, sp_key = w["row"], w["sub"], w["sp"]
        ws = weapons_out[row]
        assert math.isfinite(ws["spp"]) and ws["spp"] > 0, f"bad spp for {row}: {ws}"
        assert math.isfinite(ws["ink"]) and ws["ink"] > 0, f"bad ink for {row}: {ws}"
        assert math.isfinite(ws["rec"]) and ws["rec"] >= 0, f"bad rec for {row}: {ws}"
        assert ws["wt"] in ("L", "N", "H"), f"bad wt for {row}: {ws}"
        if "ink2" in ws:
            assert math.isfinite(ws["ink2"]) and ws["ink2"] > 0, f"bad ink2 for {row}: {ws}"
        if "mis" in ws:
            assert all(math.isfinite(x) and 0 < x <= 1.0 for x in ws["mis"]), f"bad mis for {row}: {ws}"
        sb = subs_out[sub_key]
        assert math.isfinite(sb["ink"]) and sb["ink"] > 0, f"bad sub ink for {sub_key}: {sb}"
        assert math.isfinite(sb["rec"]) and sb["rec"] >= 0, f"bad sub rec for {sub_key}: {sb}"
        assert sb["lv"] in (0, 1, 2, 3, 4), f"bad sub lv for {sub_key}: {sb}"
        sp_list = specials_out[sp_key]
        assert len(sp_list) >= 1, f"empty special stats for {sp_key}"
        for st in sp_list:
            for k in ("low", "mid", "high"):
                assert math.isfinite(st[k]) and st[k] > 0, f"bad special {sp_key} {st}"

    out = {
        "ver": 1200,
        "player": player_params,
        "weapons": weapons_out,
        "subs": subs_out,
        "specials": specials_out,
    }
    dest = ROOT / "web" / "src" / "data" / "weapon-stats.json"
    dest.write_text(json.dumps(out, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    print(
        f"Wrote {dest} ({dest.stat().st_size} bytes): "
        f"{len(weapons_out)} weapons, {len(subs_out)} subs, {len(specials_out)} specials"
    )


if __name__ == "__main__":
    main()
