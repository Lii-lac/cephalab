"""Build the companion as one .exe (PyInstaller) that carries the built app, the game data and s3s.
    python tools/build_exe.py        -> dist/cephalab.exe       (build web/ first: cd web && npm run build)
The .exe keeps state/ and cache/ next to itself."""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
sep = os.pathsep
add = [f"{ROOT / 'data'}{sep}data", f"{ROOT / 's3s' / 'iksm.py'}{sep}s3s", f"{ROOT / 's3s' / 'utils.py'}{sep}s3s"]
if (ROOT / "web" / "dist" / "index.html").exists():
    add.append(f"{ROOT / 'web' / 'dist'}{sep}web/dist")
else:
    print("warning: web/dist isn't built; the .exe will only serve the API")
if not (ROOT / "s3s" / "iksm.py").exists():
    sys.exit("s3s/ is empty: run tools/setup_s3s.py first")
entry = ROOT / "build" / "cephalab_entry.py"
entry.parent.mkdir(exist_ok=True)
entry.write_text("import sys\nfrom companion.app import main\nsys.exit(main())\n", encoding="utf-8")
cmd = [str(PY), "-m", "PyInstaller", "--noconfirm", "--onefile", "--name", "cephalab", "--paths", str(ROOT),
       "--distpath", str(ROOT / "dist"), "--workpath", str(ROOT / "build"), "--specpath", str(ROOT / "build"),
       "--hidden-import", "keyring.backends.Windows", "--hidden-import", "bs4", "--hidden-import", "msgpack",
       "--hidden-import", "uuid", "--hidden-import", "datetime", "--hidden-import", "hashlib", "--hidden-import", "urllib.parse"]  # s3s imports these
for a in add:
    cmd += ["--add-data", a]
subprocess.run(cmd + [str(entry)], check=True, cwd=ROOT)
print(f"built {ROOT / 'dist' / 'cephalab.exe'}")
