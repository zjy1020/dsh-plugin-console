"""标题栏窗口按钮的「墨迹检查」—— 像素级验证按钮图标真的画出来了。

为什么需要这个东西：CSS 层面查不出这类故障。三个窗口按钮的 DOM 完全正常
（opacity 1、visibility visible、elementFromPoint 命中按钮内部的 path、stroke 计算值也对），
但截图里那三块区域和纯背景一个像素都不差 —— 也就是「几何在、命中在、画不出来」。
只有把 PNG 打开逐像素统计，才能证明修完之后真的看得见。

用法：
    python scripts/inkcheck.py <截图.png> [--scale 1.5]
"""

from __future__ import annotations

import sys

from PIL import Image

# 按钮在 CSS 坐标系里的水平区间（实测值，见 docs/_log.md 里标题栏那一节）。
# 顺序与标题栏从左到右一致。改布局的话这三个数字要一起改。
BUTTONS = [
    ("最小化", 1188, 1232),
    ("最大化", 1232, 1276),
    ("关闭", 1276, 1320),
]

TITLEBAR_CSS_H = 38


def report(path: str, scale: float) -> int:
    im = Image.open(path).convert("RGB")
    px = im.load()
    w, h = im.size
    y_end = min(h, int(TITLEBAR_CSS_H * scale))

    # 取标题栏中段一块「什么也没有」的区域当背景基准，避免被壁纸带偏。
    bg = px[int(700 * scale), int(6 * scale)]
    bg_sum = sum(bg)
    print(f"image={w}x{h} scale={scale} bg={bg} bg_sum={bg_sum}")

    bad = 0
    for name, x0, x1 in BUTTONS:
        X0, X1 = int(x0 * scale), int(x1 * scale)
        darkest = (255, 255, 255)
        count = 0
        for y in range(0, y_end):
            for x in range(X0, X1):
                p = px[x, y]
                s = sum(p)
                if s < sum(darkest):
                    darkest = p
                # 判定「有墨」的门槛比背景深 80（三个通道合计），
                # 低于这个差值的抗锯齿边缘不说明问题。
                if s < bg_sum - 80:
                    count += 1
        ok = count > 0
        bad += 0 if ok else 1
        print(
            f"{name}: region=({X0},{0})-({X1},{y_end}) "
            f"darkest={darkest} inkPx={count} -> {'OK' if ok else 'NO INK'}"
        )

    # 顺带确认标题栏里别的内容（品牌 logo）是有墨的。
    # 品牌 logo 在 CSS x 23.3..54.7 —— 如果连它都是空的，说明整条标题栏没画，
    # 那就是截图本身的问题（窗口被遮挡 / 截到了空表面），不是按钮的问题。
    X0, X1 = int(23 * scale), int(55 * scale)
    brand = sum(
        1
        for y in range(0, y_end)
        for x in range(X0, X1)
        if sum(px[x, y]) < bg_sum - 80
    )
    print(f"品牌 logo 区域 inkPx={brand} -> {'OK' if brand > 0 else 'NO INK（先怀疑截图）'}")
    if brand == 0:
        return 2

    return 0 if bad == 0 else 1


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 64
    scale = 1.5
    if "--scale" in argv:
        scale = float(argv[argv.index("--scale") + 1])
    return report(argv[1], scale)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))