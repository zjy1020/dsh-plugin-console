import os, sys
from PIL import Image, ImageDraw, ImageFilter
import numpy as np

SRC = r"C:\Users\YBY\.dsh\attachments\v1\objects\86\863af5ef753a492d99a16d754a7dffdebba44309b00d444dd2e27a87358e8a9e"
ROOT = r"D:\项目\DSH\deepseekharness插件台"

im = Image.open(SRC).convert("RGBA")
w, h = im.size
print("src", w, h)

# 四角朝内 floodfill，只吃掉与角落连通的白色（圆角外的白底）。
probe = im.convert("RGB").copy()
MAGIC = (255, 0, 255)
for xy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]:
    try:
        ImageDraw.floodfill(probe, xy, MAGIC, thresh=20)
    except Exception as e:
        print("floodfill skip", xy, e)

arr = np.array(probe)
white = (arr[:, :, 0] > 250) & (arr[:, :, 1] < 5) & (arr[:, :, 2] > 250)
print("白底像素", int(white.sum()), "(%.2f%%)" % (100.0 * white.sum() / (w * h)))

alpha = np.where(white, 0, 255).astype(np.uint8)
am = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.6))
out = im.copy()
out.putalpha(am)

# 裁掉四周可能的空白，保持方形
out.save(os.path.join(ROOT, "docs", "shots", "logo-alpha.png"))

def save_ico(img, path, sizes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, format="ICO", sizes=sizes)
    print("ico", path, sizes)

master = out.resize((1024, 1024), Image.LANCZOS)
save_ico(master, os.path.join(ROOT, "build", "icon.ico"),
         [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
save_ico(master, os.path.join(ROOT, "resources", "tray.ico"), [(16, 16), (20, 20), (24, 24), (32, 32)])

os.makedirs(os.path.join(ROOT, "resources"), exist_ok=True)
master.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "resources", "icon.png"))
os.makedirs(os.path.join(ROOT, "src", "renderer", "public"), exist_ok=True)
master.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "src", "renderer", "public", "logo.png"))
master.resize((64, 64), Image.LANCZOS).save(os.path.join(ROOT, "src", "renderer", "public", "logo-64.png"))
print("done")
