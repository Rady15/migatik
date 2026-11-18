#!/usr/bin/env python3
"""Generate PWA icons — MikroTik router wifi mark on deep navy."""
from PIL import Image, ImageDraw

def make_icon(size, maskable=False):
    img = Image.new("RGB", (size, size), "#0A1020")
    d = ImageDraw.Draw(img)
    s = size
    pad = 0 if maskable else int(s * 0.08)

    # rounded panel
    r = int(s * 0.18)
    m = pad
    d.rounded_rectangle([m, m, s - m, s - m], radius=r, fill="#0E1A31")

    # wifi arcs (cyan/blue)
    cx, cy = s / 2, s * 0.56
    for i, (rr, color, w) in enumerate([
        (s * 0.34, "#1685FF", max(4, int(s * 0.045))),
        (s * 0.24, "#22D3EE", max(3, int(s * 0.04))),
        (s * 0.15, "#5CA9FF", max(3, int(s * 0.035))),
    ]):
        bbox = [cx - rr, cy - rr, cx + rr, cy + rr]
        d.arc(bbox, start=215, end=325, fill=color, width=w)

    # dot
    dot_r = s * 0.05
    d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill="#4FC3F7")

    # router body
    bw, bh = s * 0.44, s * 0.12
    bx, by = cx - bw / 2, s * 0.70
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=int(s * 0.035), fill="#1D5FD6")
    led_y = by + bh * 0.5
    for i in range(3):
        lx = bx + bw * (0.18 + i * 0.13)
        lr = s * 0.014
        color = "#4ADE80" if i < 2 else "#FBBF24"
        d.ellipse([lx - lr, led_y - lr, lx + lr, led_y + lr], fill=color)
    # antennas
    for ax in (bx + bw * 0.25, bx + bw * 0.75):
        d.line([ax, by, ax, by - s * 0.10], fill="#5CA9FF", width=max(3, int(s * 0.025)))
        d.ellipse([ax - s * 0.017, by - s * 0.12, ax + s * 0.017, by - s * 0.086], fill="#22D3EE")

    img.save(f"public/icons/icon-{size}.png" if size == 192 else f"public/icons/icon-512.png")

import os
os.makedirs("public/icons", exist_ok=True)
make_icon(192)
make_icon(512)
# maskable copy with safe padding
img = Image.open("public/icons/icon-512.png")
mask = Image.new("RGB", (512, 512), "#0A1020")
mask.paste(img, (0, 0))
mask.save("public/icons/icon-512-maskable.png")
print("icons done:", os.listdir("public/icons"))
