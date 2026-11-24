# Builds gear13's ARTBUSY table: for each weapon art, which of its 150 columns are inked where the picker arrow pokes up (rows 108-132 of the 150px art).
# Run: .venv\Scripts\python.exe -I tools\art_busy.py cache\img\weapon_flat  (prints JSON of bitstrings; gear13 stores them as hex)
import sys, json, glob, os
from PIL import Image
d = sys.argv[1]; LIFT = 12; out = {}
for f in glob.glob(os.path.join(d, 'Path_Wst_*.png')):
    im = Image.open(f).convert('RGBA'); w, h = im.size; s = 150 / max(w, h)
    im = im.resize((round(w*s), round(h*s))); W, H = im.size; ox, oy = (150-W)//2, (150-H)//2
    a = im.getchannel('A').load(); bits = []
    for x in range(150):
        busy = 0
        for y in range(108, 132):   # rows where the arrow sits (box bottom 112, arrow up to ~126), with a margin for the drop shadow
            for dx in (-3, -2, -1, 0, 1, 2, 3):
                ix, iy = x - ox + dx - 2, y + LIFT - oy - 3   # the art's drop-shadow is 2px right, 3px down
                if 0 <= ix < W and 0 <= iy < H and a[ix, iy] > 24: busy = 1; break
            if busy: break
        bits.append(busy)
    out[os.path.basename(f)[9:-4]] = ''.join(map(str, bits))
print(json.dumps(out, separators=(',', ':')))