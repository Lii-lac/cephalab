"""Test vectors for tests/core/run_tests.mjs, from the Python reference (s3seed/seedmath.py, pymmh3).

Prints one JSON object: {"rolls": [...], "startSeed": [...]}. Fixed RNG seed, so runs repeat.
Usage: python tests/core/gen_vectors.py [rng_seed]
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import pymmh3  # noqa: E402
from s3seed import seedmath  # noqa: E402

MAPS = {"head": "HaveGearHeadMap", "clothes": "HaveGearClothesMap", "shoes": "HaveGearShoesMap"}
KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"


def main() -> None:
    rng = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 20261119)
    brands = list(seedmath.TRAITS.keys()) + ["B50", "B12", "B21"]  # unknown codes -> None row
    drinks = [None] + seedmath.ABILITY_ORDER

    rolls = []
    for _ in range(10000):
        seed = rng.getrandbits(32)
        brand = rng.choice(brands)
        drink = rng.choice(drinks)
        n = rng.randint(1, 12)
        rolls.append({"seed": seed, "brand": brand, "drink": drink, "n": n,
                      "expect": seedmath.predict(seed, brand, drink, n)})

    starts = []
    for i in range(1000):
        key = "u-" + "".join(rng.choice(KEY_CHARS) for _ in range(20))
        slot = rng.choice(list(MAPS))
        gear_id = rng.choice([26000, 26000, 0, 1, rng.randint(0, 30000), rng.randint(0, 2**31)])
        if i < 50:
            slot, gear_id = "clothes", 26000  # always cover the suffix case
        text = f"{key}_{MAPS[slot]}_{gear_id}"
        if slot == "clothes" and gear_id == 26000:
            text += "_JUEA-00006"
        starts.append({"playerKey": key, "slot": slot, "gearId": gear_id,
                       "expect": pymmh3.hash(text, 0) & 0xFFFFFFFF})

    json.dump({"rolls": rolls, "startSeed": starts}, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
