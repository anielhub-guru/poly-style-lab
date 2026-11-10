#!/usr/bin/env python3
"""Generate a moving 2D subject crossing a static support for temporal separation tests."""

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np


def circle(frame, center, radius, colour):
    cx, cy = center
    y, x = np.ogrid[:frame.shape[0], :frame.shape[1]]
    frame[(x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2] = colour


def snake(frame, center_x, colour, ink):
    points = []
    for y in range(48, 151, 3):
        x = center_x + int(round(20 * np.sin((y - 48) / 17)))
        points.append((x, y))
        circle(frame, (x, y), 8, ink)
    for x, y in points:
        circle(frame, (x, y), 5, colour)
    circle(frame, (points[0][0] + 5, points[0][1] - 2), 10, ink)
    circle(frame, (points[0][0] + 5, points[0][1] - 2), 7, colour)


def render(index, count, width=320, height=180):
    frame = np.empty((height, width, 3), dtype=np.uint8)
    frame[:] = [168, 157, 92]
    frame[:92] = [176, 165, 101]
    frame[30:92, 65:280] = [77, 86, 46]
    frame[74:164, 150:178] = [86, 51, 27]
    center = 140 + int(round(index / max(1, count - 1) * 28))
    snake(frame, center, [103, 132, 84], [35, 38, 20])
    return frame, center


def write_ppm(path, frame):
    with open(path, "wb") as handle:
        handle.write(f"P6\n{frame.shape[1]} {frame.shape[0]}\n255\n".encode())
        handle.write(frame.tobytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    count, reference_index = 13, 6
    reference = None
    for index in range(count):
        frame, center = render(index, count)
        write_ppm(args.output_dir / f"frame-{index:03d}.ppm", frame)
        if index == reference_index:
            reference = frame.copy()
            reference_center = center
    video = args.output_dir / "temporal.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", "12",
        "-i", str(args.output_dir / "frame-%03d.ppm"), "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(video),
    ], check=True)
    for path in args.output_dir.glob("frame-*.ppm"):
        path.unlink()
    reference_ppm = args.output_dir / "reference.ppm"
    write_ppm(reference_ppm, reference)
    reference_png = args.output_dir / "reference.png"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(reference_ppm), str(reference_png)], check=True)
    reference_ppm.unlink()
    truth = {
        "schema": "ikistudio.temporal-benchmark/v1", "width": 320, "height": 180,
        "referenceTimeSec": reference_index / 12, "movingCenterX": reference_center,
        "staticSupportBoundsPx": [150, 74, 178, 164], "expectedDisplacementPx": 28,
    }
    truth_path = args.output_dir / "ground-truth.json"
    truth_path.write_text(json.dumps(truth, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"video": str(video), "reference": str(reference_png), "groundTruth": str(truth_path)}))


if __name__ == "__main__":
    main()
