#!/usr/bin/env python3
"""Regenerate test/fixtures/ocr-zh-en.png, the OCR fixture with Chinese and English text.

Usage: python3 test/fixtures/make-ocr-fixture.py [font.ttc]
Needs Pillow and a font with CJK glyphs (default: WenQuanYi Zen Hei, as packaged
by Debian/Ubuntu fonts-wqy-zenhei). The PNG is synthetic; it holds no device data.
The expected lines are in test/fixtures/ocr-zh-en.json.
"""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

here = os.path.dirname(os.path.abspath(__file__))
font_path = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
with open(os.path.join(here, "ocr-zh-en.json"), encoding="utf-8") as handle:
    lines = json.load(handle)["lines"]
font = ImageFont.truetype(font_path, 40)
image = Image.new("RGB", (640, 120 + 90 * len(lines)), "white")
draw = ImageDraw.Draw(image)
for index, line in enumerate(lines):
    draw.text((48, 60 + 90 * index), line, fill="black", font=font)
image.convert("L").save(os.path.join(here, "ocr-zh-en.png"), optimize=True)
