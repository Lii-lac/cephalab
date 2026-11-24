"""Pull Leanny's seed checker sources (from the public build's source map) into reference/checker-src/ for reading.
The checker has no licence: read it to learn the mechanics, never copy its code into the app.
Usage: python tools/pull_checker_src.py   (needs network; reference/ is gitignored)"""
import json, os, urllib.request

MAP = "https://raw.githubusercontent.com/ToeMunchEnja/splat3seedchecker/main/static/js/main.773d8ff9.js.map"
OUT = os.path.join(os.path.dirname(__file__), "..", "reference", "checker-src")


def main():
    os.makedirs(OUT, exist_ok=True)
    m = json.load(urllib.request.urlopen(MAP))
    n = 0
    for src, code in zip(m["sources"], m.get("sourcesContent") or []):
        if not code or "node_modules" in src or src.startswith(("webpack", "../webpack")):
            continue
        with open(os.path.join(OUT, src.replace("/", "__")), "w", encoding="utf-8") as f:
            f.write(code)
        n += 1
    print(f"wrote {n} files to {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
