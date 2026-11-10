#!/usr/bin/env python3
"""Measure local component motion around one evidence frame using only FFmpeg and NumPy."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

LONG_SIDE = 320
SAMPLE_FPS = 12


def probe_size(path):
    stderr = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    match = re.search(r"[ ,](\d{2,5})x(\d{2,5})[ ,\[]", stderr)
    if not match:
        raise RuntimeError("could not read video dimensions")
    return int(match.group(1)), int(match.group(2))


def read_window(path, time_sec, window_sec):
    source_width, source_height = probe_size(path)
    scale = min(1.0, LONG_SIDE / max(source_width, source_height))
    width = max(8, int(round(source_width * scale)))
    height = max(8, int(round(source_height * scale)))
    start = max(0.0, time_sec - window_sec)
    duration = max(0.35, window_sec * 2)
    data = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-i", str(path),
        "-t", str(duration), "-an", "-vf", f"fps={SAMPLE_FPS},scale={width}:{height}:flags=area",
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ], capture_output=True, check=True).stdout
    frame_bytes = width * height * 3
    count = len(data) // frame_bytes
    if count < 4:
        raise RuntimeError("too few frames for temporal measurement")
    frames = np.frombuffer(data[:count * frame_bytes], dtype=np.uint8).reshape(count, height, width, 3)
    reference = min(count - 1, max(0, int(round((time_sec - start) * SAMPLE_FPS))))
    return frames, reference, width, height, start


def close_mask(mask):
    padded = np.pad(mask, 1, constant_values=False)
    dilated = np.zeros(mask.shape, dtype=bool)
    for dy in range(3):
        for dx in range(3):
            dilated |= padded[dy:dy + mask.shape[0], dx:dx + mask.shape[1]]
    padded = np.pad(dilated, 1, constant_values=True)
    result = np.ones(mask.shape, dtype=bool)
    for dy in range(3):
        for dx in range(3):
            result &= padded[dy:dy + mask.shape[0], dx:dx + mask.shape[1]]
    return result


def components(mask, minimum):
    height, width = mask.shape
    seen = np.zeros(mask.shape, dtype=bool)
    output = []
    for start_y, start_x in zip(*np.nonzero(mask)):
        if seen[start_y, start_x]:
            continue
        stack = [(int(start_y), int(start_x))]
        seen[start_y, start_x] = True
        pixels = []
        while stack:
            y, x = stack.pop()
            pixels.append((y, x))
            for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= yy < height and 0 <= xx < width and mask[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True
                    stack.append((yy, xx))
        if len(pixels) < minimum:
            continue
        ys = np.asarray([item[0] for item in pixels])
        xs = np.asarray([item[1] for item in pixels])
        component_mask = np.zeros(mask.shape, dtype=bool)
        component_mask[ys, xs] = True
        output.append({
            "mask": component_mask, "area": len(pixels),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)],
            "centroid": [float(xs.mean()), float(ys.mean())],
        })
    return output


def mask_runs(mask):
    runs = []
    for y, row in enumerate(mask):
        start = None
        for x in range(len(row) + 1):
            active = x < len(row) and row[x]
            if active and start is None:
                start = x
            elif not active and start is not None:
                runs.append([int(y), int(start), int(x)])
                start = None
    return runs


def merge_nearby(items, gap=2):
    items = list(items)
    changed = True
    while changed:
        changed = False
        for left in range(len(items)):
            ax0, ay0, ax1, ay1 = items[left]["bbox"]
            for right in range(left + 1, len(items)):
                bx0, by0, bx1, by1 = items[right]["bbox"]
                gap_x = max(0, ax0 - bx1, bx0 - ax1)
                gap_y = max(0, ay0 - by1, by0 - ay1)
                if gap_x > gap or gap_y > gap:
                    continue
                mask = items[left]["mask"] | items[right]["mask"]
                ys, xs = np.nonzero(mask)
                items[left] = {
                    "mask": mask, "area": int(mask.sum()),
                    "bbox": [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)],
                    "centroid": [float(xs.mean()), float(ys.mean())],
                }
                items.pop(right)
                changed = True
                break
            if changed:
                break
    return items


def measure(path, time_sec, window_sec=0.6):
    frames, reference, width, height, start = read_window(path, time_sec, window_sec)
    values = frames.astype(np.float32)
    temporal_median = np.median(values, axis=0)
    distance = np.sqrt(np.mean((values - temporal_median[None]) ** 2, axis=3))
    variation = np.percentile(distance, 85, axis=0)
    threshold = max(10.0, float(np.percentile(variation, 78)))
    minimum = max(12, width * height // 1800)
    frame_components = []
    for index in range(len(frames)):
        mask = close_mask((distance[index] >= threshold) & (variation >= threshold * 0.72))
        frame_components.append(merge_nearby(components(mask, minimum)))
    reference_components = frame_components[reference]
    if not reference_components:
        return {"schema": "ikistudio.temporal-components/v1", "available": False, "reason": "no coherent moving component", "width": width, "height": height}
    def follow(selected):
        found = {reference: selected["centroid"]}
        limit = max(width, height) * 0.18
        for indexes in (range(reference - 1, -1, -1), range(reference + 1, len(frames))):
            previous = selected["centroid"]
            for index in indexes:
                candidates = frame_components[index]
                if not candidates:
                    continue
                candidate = min(candidates, key=lambda item: (item["centroid"][0] - previous[0]) ** 2 + (item["centroid"][1] - previous[1]) ** 2)
                if np.hypot(candidate["centroid"][0] - previous[0], candidate["centroid"][1] - previous[1]) <= limit:
                    found[index] = candidate["centroid"]
                    previous = candidate["centroid"]
        ordered = [found[index] for index in sorted(found)]
        displacement = float(np.hypot(ordered[-1][0] - ordered[0][0], ordered[-1][1] - ordered[0][1])) if len(ordered) >= 2 else 0.0
        persistence = len(ordered) / len(frames)
        confidence = min(0.98, 0.42 + 0.35 * persistence + min(0.2, displacement / max(width, height)))
        return ordered, displacement, persistence, confidence

    tracks = []
    for selected in sorted(reference_components, key=lambda item: -item["area"])[:6]:
        centroids, displacement, persistence, confidence = follow(selected)
        if persistence < 0.5:
            continue
        tracks.append({
            "role": "moving-component-candidate", "confidence": round(confidence, 3),
            "persistence": round(persistence, 4), "displacementPx": round(displacement, 3),
            "referenceBoundsPx": selected["bbox"], "referenceAreaPx": selected["area"],
            "referenceMaskRuns": mask_runs(selected["mask"]),
            "centroidsPx": [[round(x, 3), round(y, 3)] for x, y in centroids],
        })
    tracks.sort(key=lambda item: -(item["referenceAreaPx"] * item["confidence"]))
    for index, track in enumerate(tracks, 1):
        track["id"] = f"motion-track-{index}"
    return {
        "schema": "ikistudio.temporal-components/v1", "available": True,
        "width": width, "height": height, "sampleFps": SAMPLE_FPS,
        "window": {"startSec": round(start, 4), "frameCount": len(frames), "referenceIndex": reference, "referenceTimeSec": round(time_sec, 4)},
        "thresholdRgb": round(threshold, 3),
        "tracks": tracks,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("--time", type=float, required=True)
    parser.add_argument("--window", type=float, default=0.6)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = measure(args.video, args.time, args.window)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"available": result["available"], "tracks": len(result.get("tracks", []))}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
