"""Persistent OCR worker for poki-bridged (workstream J1, fork-only).

The daemon starts this once (python -I -c <this file>) and keeps it, so the engine and its models
load once instead of on every call. Requests and answers are one JSON object per line.

    request: {"id": n, "path": "<jpeg or png>", "box": [x, y, w, h] | null}
             box is a fraction of the image (0 to 1); null reads the whole image.
    answer:  {"id": n, "elements": [...], "ms": float, "size": [w, h]}
          or {"id": n, "error": "..."}

Elements are the same shape as native/ocr.py (RapidOCR quads turned into axis-aligned boxes):
{"text", "confidence", "x", "y", "width", "height"}, in pixels of the whole image, so a box
read and a whole-image read agree. The first line written is {"ready": true} once the engine has
loaded and run once.
"""
import json
import os
import sys
import time


def to_elements(boxes, texts, scores, dx=0.0, dy=0.0, scale=1.0):
    elements = []
    for quad, text, score in zip(boxes if boxes is not None else [], texts or [], scores or []):
        if not text:
            continue
        xs = [float(p[0]) / scale for p in quad]
        ys = [float(p[1]) / scale for p in quad]
        x, y = max(0.0, min(xs)), max(0.0, min(ys))
        elements.append({
            "text": str(text),
            "confidence": float(score),
            "x": x + dx,
            "y": y + dy,
            "width": max(xs) - x,
            "height": max(ys) - y,
        })
    return elements


def main():
    os.environ.setdefault("ORT_LOGGING_LEVEL", "3")
    import logging
    logging.disable(logging.WARNING)
    import numpy as np
    from PIL import Image
    from rapidocr import RapidOCR

    # The detector's default (short side scaled up to 736) makes a field-sized crop several
    # thousand pixels wide: 800 ms instead of about 100. Cap the long side instead: 960 for a box,
    # 1280 for a whole screen (13 pt text is still about 19 px tall there). The angle classifier is
    # for rotated photos; a phone screen is upright.
    def engine(side):
        return RapidOCR(params={
            "Global.log_level": "error",
            "Global.use_cls": False,
            "Det.limit_type": "max",
            "Det.limit_side_len": side,
        })

    engines = {"box": engine(960), "full": engine(1280)}

    def read(image, mode="box"):
        # RapidOCR takes arrays in OpenCV's channel order.
        array = np.ascontiguousarray(np.asarray(image.convert("RGB"))[:, :, ::-1])
        result = engines[mode](array)
        return getattr(result, "boxes", None), getattr(result, "txts", None), getattr(result, "scores", None)

    # Load the models and run once, so the first real request pays no start-up.
    warm = Image.new("RGB", (200, 64), "white")
    try:
        from PIL import ImageDraw
        ImageDraw.Draw(warm).text((10, 20), "warm up", fill="black")
    except Exception:  # noqa: BLE001 - warm-up text is optional
        pass
    read(warm, "box")
    read(warm, "full")
    out = sys.stdout
    out.write(json.dumps({"ready": True}) + "\n")
    out.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        ident = None
        try:
            request = json.loads(line)
            ident = request.get("id")
            started = time.perf_counter()
            with Image.open(request["path"]) as image:
                image.load()
                width, height = image.size
                box = request.get("box")
                dx = dy = 0.0
                scale = 1.0
                if box:
                    x, y, w, h = (float(v) for v in box)
                    left = max(0, int(x * width))
                    top = max(0, int(y * height))
                    right = min(width, int((x + w) * width + 0.999))
                    bottom = min(height, int((y + h) * height + 0.999))
                    if right - left < 2 or bottom - top < 2:
                        raise ValueError("box is empty")
                    image = image.crop((left, top, right, bottom))
                    dx, dy = float(left), float(top)
                    # The detector misses short lines; small crops read better enlarged.
                    if image.size[1] < 48:
                        scale = 48.0 / image.size[1]
                        image = image.resize(
                            (max(2, int(image.size[0] * scale)), 48), Image.LANCZOS
                        )
                boxes, texts, scores = read(image, "box" if box else "full")
            answer = {
                "id": ident,
                "elements": to_elements(boxes, texts, scores, dx, dy, scale),
                "ms": round((time.perf_counter() - started) * 1000, 1),
                "size": [width, height],
            }
        except Exception as error:  # noqa: BLE001 - every failure is an answer, never an exit
            answer = {"id": ident, "error": f"OCR failed: {error}"}
        out.write(json.dumps(answer, ensure_ascii=False, separators=(",", ":")) + "\n")
        out.flush()


main()
