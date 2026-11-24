"""Fetch s3s (frozenpandaman/s3s, GPLv3) into s3s/ at the commit the companion was checked against, and install what
it and the companion need into .venv.   python tools/setup_s3s.py"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIN = "732c91e"
DEST = ROOT / "s3s"
PY = ROOT / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")

if not (DEST / "iksm.py").exists():
    if DEST.exists() and any(DEST.iterdir()):
        sys.exit(f"{DEST} isn't empty and has no iksm.py; move it away first")
    subprocess.run(["git", "clone", "https://github.com/frozenpandaman/s3s.git", str(DEST)], check=True)
    subprocess.run(["git", "-C", str(DEST), "checkout", "-q", PIN], check=True)
subprocess.run([str(PY), "-m", "pip", "install", "-q", "-r", str(DEST / "requirements.txt"), "keyring"], check=True)
print(f"s3s ready at {DEST} ({PIN})")
