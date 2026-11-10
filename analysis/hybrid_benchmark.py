#!/usr/bin/env python3
"""Generate a deterministic 2D-character-in-3D-world reconstruction benchmark."""

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np


def polygon(frame, points, colour):
    points = np.asarray(points, dtype=np.float64)
    x0, y0 = np.floor(points.min(0)).astype(int)
    x1, y1 = np.ceil(points.max(0)).astype(int)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(frame.shape[1] - 1, x1), min(frame.shape[0] - 1, y1)
    if x1 < x0 or y1 < y0:
        return
    xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
    inside = np.zeros(xs.shape, dtype=bool)
    previous = points[-1]
    for current in points:
        cross = ((current[1] > ys) != (previous[1] > ys)) & (xs < (previous[0] - current[0]) * (ys - current[1]) / (previous[1] - current[1] + 1e-12) + current[0])
        inside ^= cross
        previous = current
    frame[y0:y1 + 1, x0:x1 + 1][inside] = colour


def circle(frame, center, radius, colour):
    cx, cy = center
    y, x = np.ogrid[:frame.shape[0], :frame.shape[1]]
    frame[(x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2] = colour


def ellipse(frame, center, radii, colour):
    cx, cy = center
    rx, ry = radii
    y, x = np.ogrid[:frame.shape[0], :frame.shape[1]]
    frame[((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1] = colour


def line(frame, a, b, width, colour):
    ax, ay = a
    bx, by = b
    y, x = np.ogrid[:frame.shape[0], :frame.shape[1]]
    dx, dy = bx - ax, by - ay
    t = np.clip(((x - ax) * dx + (y - ay) * dy) / max(dx * dx + dy * dy, 1), 0, 1)
    distance = np.hypot(x - (ax + t * dx), y - (ay + t * dy))
    frame[distance <= width / 2] = colour


def render(width=640, height=360):
    colours = {
        "sky": [111, 173, 202], "ground": [190, 163, 111], "road": [151, 130, 94],
        "sun": [255, 213, 92], "ink": [29, 38, 48], "skin": [239, 184, 137],
        "character": [222, 76, 52], "houseFront": [91, 127, 109], "houseSide": [65, 94, 84],
        "roof": [111, 65, 55], "tree": [62, 112, 76], "trunk": [104, 76, 52], "shadow": [118, 102, 82],
    }
    rgb = {key: np.asarray(value, dtype=np.uint8) for key, value in colours.items()}
    horizon = 188
    frame = np.empty((height, width, 3), dtype=np.uint8)
    frame[:horizon] = rgb["sky"]
    frame[horizon:] = rgb["ground"]

    # Perspective ground lanes converge at the horizon.
    polygon(frame, [(262, height), (315, horizon), (325, horizon), (404, height)], rgb["road"])
    for offset in (-150, 145):
        polygon(frame, [(320 + offset, height), (320 + offset * 0.08, horizon), (323 + offset * 0.08, horizon), (330 + offset, height)], rgb["road"])

    circle(frame, (520, 70), 31, rgb["sun"])

    # Low-poly house: distinct front, side and roof planes.
    polygon(frame, [(410, 151), (523, 151), (523, 268), (410, 268)], rgb["houseFront"])
    polygon(frame, [(523, 151), (568, 174), (568, 268), (523, 268)], rgb["houseSide"])
    polygon(frame, [(394, 154), (466, 104), (540, 154)], rgb["roof"])
    polygon(frame, [(540, 154), (466, 104), (508, 124), (575, 177)], rgb["houseSide"])
    polygon(frame, [(445, 204), (474, 204), (474, 268), (445, 268)], rgb["ink"])

    # Simple tree in a second depth layer.
    polygon(frame, [(348, 183), (361, 183), (361, 254), (348, 254)], rgb["trunk"])
    circle(frame, (354, 163), 34, rgb["tree"])
    circle(frame, (334, 177), 25, rgb["tree"])
    circle(frame, (374, 178), 25, rgb["tree"])

    # A deliberately 2D outlined character, visually distinct from the 3D world.
    ellipse(frame, (212, 289), (42, 10), rgb["shadow"])
    line(frame, (206, 202), (201, 279), 25, rgb["ink"])
    line(frame, (205, 224), (168, 256), 17, rgb["ink"])
    line(frame, (207, 225), (246, 249), 17, rgb["ink"])
    line(frame, (200, 277), (177, 326), 19, rgb["ink"])
    line(frame, (203, 277), (234, 326), 19, rgb["ink"])
    line(frame, (206, 203), (201, 279), 15, rgb["character"])
    line(frame, (205, 224), (168, 256), 8, rgb["character"])
    line(frame, (207, 225), (246, 249), 8, rgb["character"])
    line(frame, (200, 277), (177, 326), 10, rgb["character"])
    line(frame, (203, 277), (234, 326), 10, rgb["character"])
    circle(frame, (208, 174), 35, rgb["ink"])
    circle(frame, (208, 174), 27, rgb["skin"])
    circle(frame, (198, 172), 3, rgb["ink"])
    circle(frame, (218, 172), 3, rgb["ink"])
    line(frame, (199, 187), (216, 187), 3, rgb["ink"])

    truth = {
        "schema": "ikistudio.hybrid-benchmark/v1", "width": width, "height": height, "horizonY": horizon,
        "camera": {"projection": "perspective", "fovDeg": 50}, "palette": colours,
        "character": {"representation": "2d-billboard", "boundsPx": [159, 139, 256, 336], "outlineWidthPx": 5},
        "world": {"representation": "low-poly-3d", "buildingBoundsPx": [394, 104, 575, 268], "sun": {"centerPx": [520, 70], "radiusPx": 31}},
    }
    return frame, truth


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    frame, truth = render()
    ppm = args.output_dir / "reference.ppm"
    with open(ppm, "wb") as handle:
        handle.write(f"P6\n{frame.shape[1]} {frame.shape[0]}\n255\n".encode())
        handle.write(frame.tobytes())
    output = args.output_dir / "reference.png"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(ppm), str(output)], check=True)
    ppm.unlink()
    (args.output_dir / "ground-truth.json").write_text(json.dumps(truth, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"reference": str(output), "groundTruth": str(args.output_dir / "ground-truth.json")}))


if __name__ == "__main__":
    main()
