#!/usr/bin/env python3
"""Linux OCR helper behind the build/ocr contract.

Same contract as native/ocr.swift: one argument, a PNG path; stdout is a
compact JSON array with sorted keys, one object per recognised line:

    {"confidence": float 0..1, "height": px, "text": str,
     "width": px, "x": px, "y": px}

Coordinates are image pixels with a top-left origin, the axis-aligned box
around the detected text quad. A bad path exits 1 with "Expected a readable
image path"; an engine failure exits 1 with "OCR failed: ...".

The engine is RapidOCR (Apache-2.0) on onnxruntime (MIT), with the PP-OCR
models that ship inside the rapidocr wheel, so nothing is downloaded at run
time. Pinned versions are in native/ocr-requirements.txt.
"""
import json
import os
import sys


def to_elements(boxes, texts, scores):
    """Turn RapidOCR quads into build/ocr elements, in reading order."""
    elements = []
    for quad, text, score in zip(boxes if boxes is not None else [], texts or [], scores or []):
        if not text:
            continue
        xs = [float(p[0]) for p in quad]
        ys = [float(p[1]) for p in quad]
        x, y = max(0.0, min(xs)), max(0.0, min(ys))
        elements.append({
            "text": str(text),
            "confidence": float(score),
            "x": x,
            "y": y,
            "width": max(xs) - x,
            "height": max(ys) - y,
        })
    return elements


def dump(elements):
    return json.dumps(elements, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def readable(path):
    try:
        with open(path, "rb") as handle:
            return bool(handle.read(1))
    except OSError:
        return False


def main(argv):
    if len(argv) != 2 or not readable(argv[1]):
        sys.stderr.write("Expected a readable image path\n")
        return 1
    try:
        from PIL import Image
        try:
            with Image.open(argv[1]) as probe:
                probe.verify()
        except Exception:
            sys.stderr.write("Expected a readable image path\n")
            return 1
        os.environ.setdefault("ORT_LOGGING_LEVEL", "3")
        import logging
        logging.disable(logging.WARNING)
        from rapidocr import RapidOCR
        engine = RapidOCR(params={"Global.log_level": "error"})
        result = engine(argv[1])
        elements = to_elements(getattr(result, "boxes", None), getattr(result, "txts", None), getattr(result, "scores", None))
    except Exception as error:  # noqa: BLE001 - mirror the Swift helper's single failure path
        sys.stderr.write(f"OCR failed: {error}\n")
        return 1
    sys.stdout.write(dump(elements))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
