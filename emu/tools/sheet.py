# Contact sheet of emulator frame dumps: python3 tools/sheet.py <frames-dir> <out.png> [max]
import sys, glob
from PIL import Image, ImageDraw
fs = sorted(glob.glob(sys.argv[1] + '/frame-*.png'))[: int(sys.argv[3]) if len(sys.argv) > 3 else 16]
W, H, C = 400, 240, 4
sheet = Image.new('RGB', (W * C, (H + 16) * ((len(fs) + C - 1) // C)), 'white')
d = ImageDraw.Draw(sheet)
for i, f in enumerate(fs):
    x, y = (i % C) * W, (i // C) * (H + 16)
    sheet.paste(Image.open(f).convert('RGB').resize((W, H)), (x, y + 16))
    d.text((x + 4, y + 2), f.split('/')[-1], fill='black')
sheet.save(sys.argv[2])
