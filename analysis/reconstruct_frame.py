#!/usr/bin/env python3
"""Fit a compact, measured vector reconstruction to one evidence image.

This first reconstruction path is deliberately bounded: colour quantisation plus
merged horizontal regions. It is cheap, deterministic, and exports an SVG that
Three.js can use as a single lightweight plane. More complex reconstructors can
compete with it later without changing the measurement contract.
"""

import argparse
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

try:
    import world3d
except ImportError:  # imported as a package
    from analysis import world3d

LONG_SIDE = 320
MAX_COLORS = 12
MAX_REGIONS = 3500
QUALITY_PROFILES = {
    "standard": {"maxLayers": 64, "maxObjects": 128, "textureCeiling": 2048, "packageTargetBytes": 8 * 1024 * 1024, "analysisLongSide": 320, "regionBudget": 3500},
    "high": {"maxLayers": 128, "maxObjects": 256, "textureCeiling": 4096, "packageTargetBytes": 24 * 1024 * 1024, "analysisLongSide": 480, "regionBudget": 7000},
    "ultra": {"maxLayers": 256, "maxObjects": 512, "textureCeiling": 8192, "packageTargetBytes": 64 * 1024 * 1024, "analysisLongSide": 640, "regionBudget": 12000},
}


def rounded(value, places=4):
    return round(float(value), places)


def probe_size(path):
    stderr = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    for line in stderr.splitlines():
        if "Video:" in line:
            match = re.search(r"[ ,](\d{2,5})x(\d{2,5})[ ,\[]", line)
            if match:
                return int(match.group(1)), int(match.group(2))
    raise RuntimeError("could not read evidence image size")


def read_rgb(path, long_side=LONG_SIDE):
    width, height = probe_size(path)
    scale = min(1.0, long_side / max(width, height))
    w = max(8, int(round(width * scale)))
    h = max(8, int(round(height * scale)))
    data = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-frames:v", "1",
        "-vf", f"scale={w}:{h}:flags=area", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ], capture_output=True, check=True).stdout
    expected = w * h * 3
    if len(data) < expected:
        raise RuntimeError("evidence image produced no complete frame")
    return np.frombuffer(data[:expected], dtype=np.uint8).reshape(h, w, 3)


def kmeans(points, k, iterations=14):
    rng = np.random.default_rng(17)
    centers = [points[rng.integers(len(points))]]
    for _ in range(k - 1):
        distance = np.min([((points - center) ** 2).sum(1) for center in centers], axis=0)
        total = distance.sum()
        centers.append(points[rng.choice(len(points), p=distance / total)] if total > 0 else points[rng.integers(len(points))])
    centers = np.asarray(centers)
    for _ in range(iterations):
        labels = np.argmin(((points[:, None] - centers[None]) ** 2).sum(2), axis=1)
        previous = centers.copy()
        for index in range(k):
            if (labels == index).any():
                centers[index] = points[labels == index].mean(0)
        if np.max(np.abs(centers - previous)) < 0.5:
            break
    labels = np.argmin(((points[:, None] - centers[None]) ** 2).sum(2), axis=1)
    return np.clip(np.rint(centers), 0, 255).astype(np.uint8), labels


def quantize(frame, max_colors=MAX_COLORS):
    pixels = frame.reshape(-1, 3).astype(np.float64)
    unique = np.unique(frame.reshape(-1, 3), axis=0)
    count = min(max_colors, max(1, len(unique)))
    centers, labels = kmeans(pixels, count)
    shares = np.bincount(labels, minlength=count)
    order = np.argsort(-shares)
    remap = np.empty(count, dtype=np.int32)
    remap[order] = np.arange(count)
    centers = centers[order]
    labels = remap[labels].reshape(frame.shape[:2])
    return centers, labels, centers[labels]


def merged_runs(labels):
    """Merge equal horizontal runs vertically when their x-range is identical."""
    height, width = labels.shape
    rectangles = []
    active = {}
    for y in range(height):
        runs = []
        start = 0
        for x in range(1, width + 1):
            if x == width or labels[y, x] != labels[y, start]:
                runs.append((int(labels[y, start]), start, x))
                start = x
        keys = set(runs)
        for key in list(active):
            if key not in keys:
                rectangles.append(active.pop(key))
        for colour, x0, x1 in runs:
            key = (colour, x0, x1)
            if key in active:
                active[key][4] += 1
            else:
                active[key] = [colour, x0, y, x1 - x0, 1]
    rectangles.extend(active.values())
    return rectangles


def connected_components(mask, minimum=12):
    height, width = mask.shape
    seen = np.zeros(mask.shape, dtype=bool)
    components = []
    for start_y, start_x in zip(*np.nonzero(mask & ~seen)):
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
        ys = np.fromiter((p[0] for p in pixels), dtype=np.int32)
        xs = np.fromiter((p[1] for p in pixels), dtype=np.int32)
        component_mask = np.zeros(mask.shape, dtype=bool)
        component_mask[ys, xs] = True
        components.append({
            "mask": component_mask, "area": len(pixels),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)],
            "centroid": [float(xs.mean()), float(ys.mean())],
        })
    return components


def bbox_distance(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return max(0, ax0 - bx1, bx0 - ax1), max(0, ay0 - by1, by0 - ay1)


def fill_mask_holes(mask):
    height, width = mask.shape
    outside = np.zeros(mask.shape, dtype=bool)
    stack = []
    for x in range(width):
        if not mask[0, x]: stack.append((0, x))
        if not mask[height - 1, x]: stack.append((height - 1, x))
    for y in range(height):
        if not mask[y, 0]: stack.append((y, 0))
        if not mask[y, width - 1]: stack.append((y, width - 1))
    while stack:
        y, x = stack.pop()
        if outside[y, x] or mask[y, x]:
            continue
        outside[y, x] = True
        for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= yy < height and 0 <= xx < width and not outside[yy, xx] and not mask[yy, xx]:
                stack.append((yy, xx))
    return mask | (~mask & ~outside)


def close_mask(mask):
    padded = np.pad(mask, 1, constant_values=False)
    dilated = np.zeros(mask.shape, dtype=bool)
    for dy in range(3):
        for dx in range(3):
            dilated |= padded[dy:dy + mask.shape[0], dx:dx + mask.shape[1]]
    padded = np.pad(dilated, 1, constant_values=True)
    closed = np.ones(mask.shape, dtype=bool)
    for dy in range(3):
        for dx in range(3):
            closed &= padded[dy:dy + mask.shape[0], dx:dx + mask.shape[1]]
    return closed


def semantic_layers(labels, palette):
    """Extract generic, measurable visual instances without naming scene-specific objects."""
    height, width = labels.shape
    minimum = max(3, labels.size // 9000)
    atoms = []
    for label in range(len(palette)):
        for component in connected_components(labels == label, minimum=minimum):
            x0, y0, x1, y1 = component["bbox"]
            component.update({
                "label": label,
                "touchesBorder": x0 == 0 or y0 == 0 or x1 == width or y1 == height,
                "compactness": component["area"] / max(1, (x1 - x0) * (y1 - y0)),
            })
            atoms.append(component)

    border_labels = {
        item["label"] for item in atoms
        if item["touchesBorder"] and item["area"] >= labels.size * 0.01
    }
    seed_minimum = max(minimum * 2, int(labels.size * 0.00045))
    usable = [
        item for item in atoms
        if not item["touchesBorder"]
        and item["area"] < labels.size * 0.28
        and item["area"] >= seed_minimum
        and not (item["label"] in border_labels and item["area"] > labels.size * 0.04)
    ]
    repeated = set()
    prop_groups = []
    for label in range(len(palette)):
        candidates = []
        for index, item in enumerate(usable):
            x0, y0, x1, y1 = item["bbox"]
            w, h = x1 - x0, y1 - y0
            if item["label"] == label and item["area"] >= labels.size * 0.0008 and 0.55 <= w / max(1, h) <= 1.8 and item["compactness"] >= 0.42 and item["area"] <= labels.size * 0.018:
                candidates.append((index, item))
        if len(candidates) < 3:
            continue
        median_area = float(np.median([item["area"] for _, item in candidates]))
        family = [(index, item) for index, item in candidates if 0.4 * median_area <= item["area"] <= 1.65 * median_area]
        if len(family) >= 3:
            prop_groups.append(family)
            repeated.update(index for index, _ in family)

    remaining = [(index, item) for index, item in enumerate(usable) if index not in repeated]
    parent = list(range(len(remaining)))
    group_boxes = [item["bbox"][:] for _, item in remaining]

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(a, b):
        aa, bb = find(a), find(b)
        if aa != bb:
            a_box, b_box = group_boxes[aa], group_boxes[bb]
            joined = [min(a_box[0], b_box[0]), min(a_box[1], b_box[1]), max(a_box[2], b_box[2]), max(a_box[3], b_box[3])]
            joined_width, joined_height = joined[2] - joined[0], joined[3] - joined[1]
            if joined_width > width * 0.34 or joined_height > height * 0.72 or joined_width * joined_height > labels.size * 0.2:
                return
            parent[bb] = aa
            group_boxes[aa] = joined

    for left in range(len(remaining)):
        _, a = remaining[left]
        for right in range(left + 1, len(remaining)):
            _, b = remaining[right]
            gap_x, gap_y = bbox_distance(a["bbox"], b["bbox"])
            ax0, ay0, ax1, ay1 = a["bbox"]
            bx0, by0, bx1, by1 = b["bbox"]
            overlap_x = min(ax1, bx1) - max(ax0, bx0)
            overlap_y = min(ay1, by1) - max(ay0, by0)
            near_edge = (gap_x <= 2 and overlap_y >= -2) or (gap_y <= 2 and overlap_x >= -2)
            if near_edge:
                union(left, right)

    grouped = {}
    for index, (_, item) in enumerate(remaining):
        grouped.setdefault(find(index), []).append(item)

    layers = []
    for family_index, family in enumerate(prop_groups, 1):
        for instance_index, (_, item) in enumerate(family, 1):
            layers.append({
                "id": f"repeated-prop-{family_index}-{instance_index}", "role": "repeated-prop",
                "members": [item], "confidence": min(0.95, 0.58 + 0.06 * len(family)),
                "family": f"repeated-prop-{family_index}",
            })

    entity_index = 0
    for family in grouped.values():
        mask = np.logical_or.reduce([item["mask"] for item in family])
        area = int(mask.sum())
        if area < minimum * 2:
            continue
        ys, xs = np.nonzero(mask)
        bbox = [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)]
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w < 3 or h < 3:
            continue
        entity_index += 1
        environment = w > width * 0.5
        subject_score = 0.25 + 0.2 * (h > w * 1.15) + 0.15 * (bbox[3] > height * 0.58) + 0.15 * (len(family) >= 3)
        layers.append({
            "id": f"visual-entity-{entity_index}", "role": "environment-region" if environment else "subject-candidate" if subject_score >= 0.55 else "foreground-detail",
            "members": family, "confidence": 0.7 if environment else min(0.86, subject_score), "family": None,
        })

    for layer in layers:
        mask = np.logical_or.reduce([item["mask"] for item in layer["members"]])
        if layer["role"] == "subject-candidate":
            mask = fill_mask_holes(close_mask(mask))
        ys, xs = np.nonzero(mask)
        layer["mask"] = mask
        layer["area"] = int(mask.sum())
        layer["bbox"] = [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)]
        layer["labels"] = sorted({int(item["label"]) for item in layer["members"]})

    layers.sort(key=lambda item: (item["role"] != "subject-candidate", item["bbox"][1], item["bbox"][0]))
    claimed = np.zeros(labels.shape, dtype=bool)
    for layer in layers:
        claimed |= layer["mask"]
    return {"layers": layers, "backgroundMask": ~claimed, "atomCount": len(atoms)}


def decode_temporal_mask(track, temporal, shape):
    source = np.zeros((int(temporal["height"]), int(temporal["width"])), dtype=bool)
    for y, x0, x1 in track.get("referenceMaskRuns", []):
        if 0 <= y < source.shape[0]:
            source[y, max(0, x0):min(source.shape[1], x1)] = True
    height, width = shape
    if source.shape == shape:
        return source
    ys = np.minimum(source.shape[0] - 1, np.floor(np.arange(height) * source.shape[0] / height).astype(int))
    xs = np.minimum(source.shape[1] - 1, np.floor(np.arange(width) * source.shape[1] / width).astype(int))
    return source[ys[:, None], xs[None, :]]


def describe_mask(mask, labels, identifier, role, confidence, track=None):
    ys, xs = np.nonzero(mask)
    return {
        "id": identifier, "role": role, "confidence": confidence, "family": None,
        "members": [], "mask": mask, "area": int(mask.sum()),
        "bbox": [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)],
        "labels": sorted(int(value) for value in np.unique(labels[mask])),
        **({"track": track} if track else {}),
    }


def apply_temporal_layers(decomposition, temporal, labels):
    if not temporal or not temporal.get("available") or not temporal.get("tracks"):
        return decomposition
    layers = list(decomposition["layers"])
    original_subjects = [layer for layer in layers if layer["role"] in {"subject-candidate", "character-candidate"}]
    decoded_tracks = [(track, decode_temporal_mask(track, temporal, labels.shape)) for track in temporal["tracks"]]
    whole_subject_tracks = {}
    for subject in original_subjects:
        matching = [(track, mask) for track, mask in decoded_tracks if (subject["mask"] & mask).sum() >= max(6, labels.size // 6000)]
        if len(matching) < 2:
            continue
        union = np.logical_or.reduce([mask for _, mask in matching])
        ys, xs = np.nonzero(union)
        sx0, sy0, sx1, sy1 = subject["bbox"]
        envelope_width = int(xs.max() + 1 - xs.min())
        envelope_height = int(ys.max() + 1 - ys.min())
        if envelope_width / max(1, sx1 - sx0) >= 0.5 and envelope_height / max(1, sy1 - sy0) >= 0.75:
            whole_subject_tracks[subject["id"]] = {"mask": subject["mask"], "trackIds": [track["id"] for track, _ in matching]}
    confirmed = []
    temporal_claimed = np.zeros(labels.shape, dtype=bool)
    promoted_subjects = set()
    for track, decoded_mask in decoded_tracks:
        motion_mask = decoded_mask & ~temporal_claimed
        if motion_mask.sum() < max(12, labels.size // 3000):
            continue
        overlaps = []
        for index, layer in enumerate(layers):
            overlap = int((layer["mask"] & motion_mask).sum())
            if overlap:
                overlaps.append((index, layer, overlap))
        x0, y0, x1, y1 = track["referenceBoundsPx"]
        scaled_width = (x1 - x0) * labels.shape[1] / max(1, temporal["width"])
        scaled_height = (y1 - y0) * labels.shape[0] / max(1, temporal["height"])
        lower_subject_shape = scaled_height > scaled_width * 1.15 and y1 > temporal["height"] * 0.48
        source_roles = {layer["role"] for _, layer, _ in overlaps}
        dynamic_role = "character-candidate" if lower_subject_shape or source_roles & {"subject-candidate", "character-candidate"} else "prop-candidate" if "repeated-prop" in source_roles else "moving-detail"
        matched_ids = [layer["id"] for _, layer, _ in overlaps]
        whole_subject = next((layer for _, layer, _ in overlaps if layer["id"] in whole_subject_tracks and layer["id"] not in promoted_subjects), None)
        merged_track_ids = None
        if whole_subject:
            motion_mask = whole_subject_tracks[whole_subject["id"]]["mask"] & ~temporal_claimed
            merged_track_ids = whole_subject_tracks[whole_subject["id"]]["trackIds"]
            promoted_subjects.add(whole_subject["id"])
            dynamic_role = "character-candidate"
        elif dynamic_role == "character-candidate":
            subject_overlap = max((item for item in overlaps if item[1]["role"] in {"subject-candidate", "character-candidate"}), key=lambda item: item[2], default=None)
            if subject_overlap:
                subject = subject_overlap[1]
                selected_labels = []
                for label in subject["labels"]:
                    label_mask = subject["mask"] & (labels == label)
                    motion_pixels = int((label_mask & motion_mask).sum())
                    if motion_pixels >= 3 and motion_pixels / max(1, label_mask.sum()) >= 0.08:
                        selected_labels.append(label)
                if selected_labels:
                    propagated = subject["mask"] & np.isin(labels, selected_labels)
                    if propagated.sum() <= subject["area"] * 0.88:
                        motion_mask |= propagated
        track_summary = {
            "id": track["id"], "persistence": track["persistence"],
            "displacementPx": track["displacementPx"], "confidence": track["confidence"],
            "matchedLayers": matched_ids, "promotedRole": dynamic_role,
            **({"mergedTrackIds": merged_track_ids} if merged_track_ids else {}),
        }
        next_layers = []
        for layer in layers:
            overlap = int((layer["mask"] & motion_mask).sum())
            if not overlap:
                next_layers.append(layer)
                continue
            remaining = layer["mask"] & ~motion_mask
            if remaining.sum() < max(12, labels.size // 3000):
                continue
            static_role = "static-support" if dynamic_role == "character-candidate" and layer["role"] in {"subject-candidate", "character-candidate"} else layer["role"]
            next_layers.append(describe_mask(remaining, labels, f'{layer["id"]}-static' if static_role == "static-support" else layer["id"], static_role, layer["confidence"]))
        dynamic = describe_mask(motion_mask, labels, f'{track["id"]}-moving', dynamic_role, track["confidence"], track_summary)
        layers = [dynamic, *next_layers]
        temporal_claimed |= motion_mask
        confirmed.append(track_summary)
    if not confirmed:
        return decomposition
    claimed = np.zeros(labels.shape, dtype=bool)
    for layer in layers:
        claimed |= layer["mask"]
    return {**decomposition, "layers": layers, "backgroundMask": ~claimed, "temporalTracks": confirmed}


def promote_supported_props(decomposition, labels, palette):
    """Promote a large dark mass touching a measured static support into one prop layer."""
    layers = list(decomposition["layers"])
    background = decomposition["backgroundMask"].copy()
    height, width = labels.shape
    luminance = np.asarray([0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2] for colour in palette])
    for index, support in enumerate([item for item in layers if item["role"] == "static-support"], 1):
        sx0, sy0, sx1, sy1 = support["bbox"]
        sw, sh = sx1 - sx0, sy1 - sy0
        rx0, rx1 = max(0, sx0 - sw * 2), min(width, sx1 + sw * 3)
        ry0, ry1 = max(0, int(sy0 - sh * 1.6)), min(height, sy0 + max(4, sh // 5))
        roi = np.zeros(labels.shape, dtype=bool); roi[ry0:ry1, rx0:rx1] = True
        roi_values = luminance[labels[roi & background]]
        if not len(roi_values):
            continue
        dark = roi & background & (luminance[labels] <= np.percentile(roi_values, 48))
        candidates = connected_components(close_mask(dark), minimum=max(12, labels.size // 1000))
        strip = np.zeros(labels.shape, dtype=bool)
        strip[max(0, sy0 - max(6, sh // 5)):min(height, sy0 + max(4, sh // 8)), max(0, sx0 - sw):min(width, sx1 + sw)] = True
        candidates = [item for item in candidates if (item["mask"] & strip).any() and item["area"] >= labels.size * .025 and item["bbox"][2] - item["bbox"][0] >= sw * 1.5]
        if not candidates:
            continue
        canopy = max(candidates, key=lambda item: item["area"])["mask"] & background
        if canopy.sum() < labels.size * .02:
            continue
        layer = describe_mask(canopy, labels, f"supported-prop-{index}", "prop-candidate", .72)
        layers.append(layer); background &= ~canopy
    return {**decomposition, "layers": layers, "backgroundMask": background}


def mask_paths(mask):
    """Trace pixel-boundary loops; output polygons rather than scanline rectangles."""
    height, width = mask.shape
    edges = []
    for y, x in zip(*np.nonzero(mask)):
        if y == 0 or not mask[y - 1, x]: edges.append(((int(x), int(y)), (int(x + 1), int(y))))
        if x == width - 1 or not mask[y, x + 1]: edges.append(((int(x + 1), int(y)), (int(x + 1), int(y + 1))))
        if y == height - 1 or not mask[y + 1, x]: edges.append(((int(x + 1), int(y + 1)), (int(x), int(y + 1))))
        if x == 0 or not mask[y, x - 1]: edges.append(((int(x), int(y + 1)), (int(x), int(y))))
    outgoing = {}
    for start, end in edges:
        outgoing.setdefault(start, []).append(end)
    loops = []
    while outgoing:
        start = next(iter(outgoing))
        points, current = [start], start
        for _ in range(len(edges) + 1):
            choices = outgoing.get(current)
            if not choices:
                break
            following = choices.pop()
            if not choices:
                outgoing.pop(current, None)
            if following == start:
                break
            points.append(following)
            current = following
        if len(points) < 4:
            continue
        simplified = []
        for point in points:
            if len(simplified) >= 2:
                a, b = simplified[-2], simplified[-1]
                if (a[0] == b[0] == point[0]) or (a[1] == b[1] == point[1]):
                    simplified[-1] = point
                    continue
            simplified.append(point)
        if len(simplified) >= 4:
            loops.append(simplified)
    return loops


def infer_structure(labels, palette):
    height, width = labels.shape
    top = labels[:max(2, height // 12)]
    bottom = labels[-max(2, height // 12):]
    sky = int(np.bincount(top.reshape(-1), minlength=len(palette)).argmax())
    ground = int(np.bincount(bottom.reshape(-1), minlength=len(palette)).argmax())
    ground_share = (labels == ground).mean(1)
    rows = np.nonzero(ground_share > 0.42)[0]
    horizon = int(rows[0]) if rows.size else int(height * 0.58)

    background = {sky, ground}
    for label in range(len(palette)):
        mask = labels == label
        if mask[:, :max(2, width // 30)].mean() > 0.12 and mask[:, -max(2, width // 30):].mean() > 0.12:
            background.add(label)

    minimum = max(10, labels.size // 3000)
    objects = connected_components(~np.isin(labels, list(background)), minimum=minimum)
    labelled = []
    for label in range(len(palette)):
        if label in background:
            continue
        for component in connected_components(labels == label, minimum=minimum):
            labelled.append({**component, "label": label})
    sun = None
    for component in objects:
        x0, y0, x1, y1 = component["bbox"]
        w, h = x1 - x0, y1 - y0
        compactness = component["area"] / max(1, w * h)
        if y1 < horizon and 0.65 <= w / max(h, 1) <= 1.5 and compactness > 0.45:
            if sun is None or component["area"] > sun["area"]:
                sun = component

    lower = [component for component in objects if component is not sun and component["bbox"][3] > horizon]
    seed = None
    for component in labelled:
        x0, y0, x1, y1 = component["bbox"]
        w, h = x1 - x0, y1 - y0
        colour = palette[component["label"]].astype(float)
        saturation = (colour.max() - colour.min()) / max(colour.max(), 1)
        if y1 <= horizon or h < height * 0.18 or w > width * 0.24 or h / max(w, 1) < 1.15:
            continue
        score = min(2.0, h / max(w, 1)) + h / height + saturation * 3
        if seed is None or score > seed["score"]:
            seed = {**component, "score": score}
    character = None
    if seed:
        selected = [seed]
        selected_keys = {(seed["label"], tuple(seed["bbox"]))}
        seed_x0, seed_y0, seed_x1, seed_y1 = seed["bbox"]
        pad_x = max(6, int((seed_x1 - seed_x0) * 0.5))
        pad_y = max(8, int((seed_y1 - seed_y0) * 0.65))
        limit = [max(0, seed_x0 - pad_x), max(0, seed_y0 - pad_y), min(width, seed_x1 + pad_x), min(height, seed_y1 + pad_y)]
        changed = True
        while changed:
            changed = False
            sx0 = min(item["bbox"][0] for item in selected); sy0 = min(item["bbox"][1] for item in selected)
            sx1 = max(item["bbox"][2] for item in selected); sy1 = max(item["bbox"][3] for item in selected)
            for component in labelled:
                key = (component["label"], tuple(component["bbox"]))
                if key in selected_keys or component["area"] > labels.size * 0.12:
                    continue
                x0, y0, x1, y1 = component["bbox"]
                if x0 < limit[0] or y0 < limit[1] or x1 > limit[2] or y1 > limit[3]:
                    continue
                if x0 == 0 or y0 == 0 or x1 == width or y1 == height:
                    continue
                gap_x = max(0, sx0 - x1, x0 - sx1)
                gap_y = max(0, sy0 - y1, y0 - sy1)
                if gap_x <= 3 and gap_y <= 3:
                    selected.append(component); selected_keys.add(key); changed = True
        mask = np.logical_or.reduce([item["mask"] for item in selected])
        ys, xs = np.nonzero(mask)
        character = {"mask": mask, "area": int(mask.sum()), "bbox": [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)], "centroid": [float(xs.mean()), float(ys.mean())], "score": seed["score"]}
    buildings = []
    for component in lower:
        if character and np.array_equal(component["mask"], character["mask"]):
            continue
        x0, y0, x1, y1 = component["bbox"]
        w, h = x1 - x0, y1 - y0
        if y1 < height and component["area"] > labels.size * 0.008 and w > h * 0.65:
            buildings.append(component)

    confidence = 0.0
    confidence += 0.25 if sky != ground else 0
    confidence += 0.25 if 0.3 * height < horizon < 0.8 * height else 0
    confidence += 0.2 if sun else 0
    confidence += 0.2 if character else 0
    confidence += 0.1 if buildings else 0
    return {"sky": sky, "ground": ground, "horizon": horizon, "sun": sun, "character": character, "buildings": buildings, "objects": objects, "confidence": confidence}


def luma(rgb):
    value = rgb.astype(np.float64) / 255.0
    return value[..., 0] * 0.2126 + value[..., 1] * 0.7152 + value[..., 2] * 0.0722


def erode_mask(mask, steps=2):
    out = mask.copy()
    for _ in range(steps):
        padded = np.pad(out, 1, constant_values=False)
        shrunk = out.copy()
        for dy, dx in ((0, 1), (2, 1), (1, 0), (1, 2)):
            shrunk &= padded[dy:dy + out.shape[0], dx:dx + out.shape[1]]
        out = shrunk
    return out


def volume_evidence(result, mask):
    """Measure whether a subject carries smooth, single-light shading (a volume cue) or is flat colour.

    Uses the original pixels, not the quantised ones, and only region interiors so anti-aliasing
    does not count as shading. One frame cannot prove volume: cel-shaded 3D can look flat, and
    textured 2D art can look shaded, so the result is evidence with an explicit confidence.
    """
    # Measure on a higher-resolution copy: small subjects have no interior pixels at the analysis size.
    frame = result.get("evidenceFrame")
    labels = result["labels"]
    if frame is None:
        frame = result["frame"]
    elif frame.shape[:2] != labels.shape:
        rows = (np.arange(frame.shape[0]) * labels.shape[0] / frame.shape[0]).astype(int)
        cols = (np.arange(frame.shape[1]) * labels.shape[1] / frame.shape[1]).astype(int)
        mask, labels = mask[rows][:, cols], labels[rows][:, cols]
    inner = erode_mask(mask, 2)
    lum = luma(frame)
    total = tonal = explained = 0.0
    vectors, ramps = [], {}
    ys_all, xs_all = np.nonzero(inner)
    for label in np.unique(labels[inner]):
        region = inner & (labels == label)
        count = int(region.sum())
        if count < 12:
            continue
        ys, xs = np.nonzero(region)
        values = lum[ys, xs]
        spread = float(values.std())
        design = np.column_stack([np.ones(count), xs - xs.mean(), ys - ys.mean()])
        coefficients, *_ = np.linalg.lstsq(design, values, rcond=None)
        residual = float(((values - design @ coefficients) ** 2).mean())
        variance = float(values.var())
        total += count
        tonal += spread * count
        if variance > 1e-6:
            explained += max(0.0, 1 - residual / variance) * count
        gradient = np.array(coefficients[1:])
        strength = float(np.hypot(*gradient)) * max(np.ptp(xs), np.ptp(ys), 1)
        if strength > 0.02:
            vectors.append(gradient / (np.hypot(*gradient) + 1e-12) * count)
        mean_rgb = frame[ys, xs].reshape(-1, 3).mean(0) / 255
        hue_bin = int(np.argmax(mean_rgb)) if mean_rgb.max() - mean_rgb.min() > 0.08 else 3
        ramps.setdefault(hue_bin, []).append(float(values.mean()))
    if total < 30:
        return {"sufficient": False, "samples": int(total)}
    # Across regions: a lit volume keeps one chromaticity while its luminance sweeps a wide range, smoothly in space.
    pixels = frame[ys_all, xs_all].astype(np.float64) / 255
    bright = pixels.sum(1)
    keep = bright > 0.15
    chroma = pixels[keep, :2] / bright[keep, None]
    keys = np.floor(chroma / 0.05).astype(int)
    cluster_ids = keys[:, 0] * 100 + keys[:, 1]
    lum_values, cx, cy = lum[ys_all, xs_all][keep], xs_all[keep].astype(float), ys_all[keep].astype(float)
    span_total = fit_total = weight = 0.0
    for cluster in np.unique(cluster_ids):
        pick = cluster_ids == cluster
        count = int(pick.sum())
        if count < 40:
            continue
        values = lum_values[pick]
        span = float(np.percentile(values, 90) - np.percentile(values, 10))
        x, y = cx[pick] - cx[pick].mean(), cy[pick] - cy[pick].mean()
        design = np.column_stack([np.ones(count), x, y, x * y, x * x, y * y])
        coefficients, *_ = np.linalg.lstsq(design, values, rcond=None)
        variance = float(values.var())
        fit = max(0.0, 1 - float(((values - design @ coefficients) ** 2).mean()) / variance) if variance > 1e-6 else 0.0
        span_total += span * count
        fit_total += fit * count
        weight += count
    tonal_variation = tonal / total
    gradient_explained = explained / total
    coherence = float(np.hypot(*np.sum(vectors, axis=0)) / (sum(np.hypot(*v) for v in vectors) + 1e-12)) if vectors else 0.0
    steps = 0
    for levels in ramps.values():
        ordered = sorted(levels)
        distinct = 1 + sum(1 for a, b in zip(ordered, ordered[1:]) if b - a > 0.05)
        steps = max(steps, distinct)
    light = None
    if vectors:
        v = np.sum(vectors, axis=0)
        light = [rounded(v[0] / (np.hypot(*v) + 1e-12), 3), rounded(v[1] / (np.hypot(*v) + 1e-12), 3)]
    return {
        "sufficient": True, "samples": int(total),
        "tonalVariation": rounded(tonal_variation), "gradientExplained": rounded(gradient_explained),
        "lightCoherence": rounded(coherence), "toneRampSteps": int(steps),
        "chromaLuminanceSpan": rounded(span_total / weight) if weight else 0.0,
        "smoothShadingFit": rounded(fit_total / weight) if weight else 0.0,
        "lightDirection2d": light,
    }


def block_ssim(a, b, block=8):
    a, b = luma(a), luma(b)
    values = []
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    for y in range(0, a.shape[0], block):
        for x in range(0, a.shape[1], block):
            aa, bb = a[y:y + block, x:x + block], b[y:y + block, x:x + block]
            if aa.size < 4:
                continue
            ma, mb = aa.mean(), bb.mean()
            va, vb = aa.var(), bb.var()
            covariance = ((aa - ma) * (bb - mb)).mean()
            values.append(((2 * ma * mb + c1) * (2 * covariance + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2)))
    return float(np.mean(values)) if values else 0.0


def edge_f1(a, b):
    def edges(image):
        lum = luma(image)
        gx = np.zeros_like(lum)
        gy = np.zeros_like(lum)
        gx[:, 1:-1] = np.abs(lum[:, 2:] - lum[:, :-2]) / 2
        gy[1:-1] = np.abs(lum[2:] - lum[:-2]) / 2
        return np.hypot(gx, gy) > 0.09
    source, fitted = edges(a), edges(b)
    intersection = np.logical_and(source, fitted).sum()
    precision = intersection / max(1, fitted.sum())
    recall = intersection / max(1, source.sum())
    return 2 * precision * recall / max(1e-9, precision + recall)


def edge_density(image):
    lum = luma(image)
    gx = np.zeros_like(lum)
    gy = np.zeros_like(lum)
    gx[:, 1:-1] = np.abs(lum[:, 2:] - lum[:, :-2]) / 2
    gy[1:-1] = np.abs(lum[2:] - lum[:-2]) / 2
    return float((np.hypot(gx, gy) > 0.09).mean())


def hex_color(rgb):
    return "#" + "".join(f"{int(channel):02x}" for channel in rgb)


def measurement(value, unit, method, samples, confidence):
    return {
        "value": value, "unit": unit, "method": method, "confidence": rounded(confidence, 3),
        "samples": int(samples), "status": "measured",
    }


def fit_frame(frame, temporal=None):
    palette, labels, fitted = quantize(frame)
    rectangles = merged_runs(labels)
    difference = frame.astype(np.float64) - fitted.astype(np.float64)
    rmse = float(np.sqrt(np.mean(difference ** 2)))
    psnr = 99.0 if rmse == 0 else 20 * math.log10(255 / rmse)
    similarity = block_ssim(frame, fitted)
    edge = edge_f1(frame, fitted)
    complexity = len(rectangles)
    shares = np.bincount(labels.reshape(-1), minlength=len(palette)) / labels.size
    entropy = float(-np.sum(shares * np.log(np.maximum(shares, 1e-12))) / math.log(len(shares))) if len(shares) > 1 else 0.0
    density = edge_density(frame)
    dominant = float(shares.max())
    information_penalty = max(0.0, 0.18 - entropy) * 0.8 + max(0.0, dominant - 0.85) * 1.5 + max(0.0, 0.01 - density) * 8
    # Error is 0..roughly 1. Complexity prevents selecting photographic frames that need thousands of tiny regions.
    selection_error = rmse / 255 + (1 - similarity) * 0.35 + (1 - edge) * 0.15 + min(0.5, complexity / 8000) + information_penalty
    structure = infer_structure(labels, palette)
    decomposition = promote_supported_props(apply_temporal_layers(semantic_layers(labels, palette), temporal, labels), labels, palette)
    refined = fitted.copy()
    for layer in decomposition["layers"]:
        layer["localLabels"] = None
        layer["localPalette"] = None
        if layer["role"] not in {"subject-candidate", "character-candidate", "static-support", "repeated-prop", "prop-candidate"}:
            continue
        points = frame[layer["mask"]].reshape(-1, 3).astype(np.float64)
        ys, xs = np.nonzero(layer["mask"])
        x0, y0, x1, y1 = layer["bbox"]
        spatial_weight = 48.0 if layer["role"] in {"subject-candidate", "character-candidate", "static-support"} else 12.0
        features = np.column_stack([
            points,
            (xs - x0) / max(1, x1 - x0) * spatial_weight,
            (ys - y0) / max(1, y1 - y0) * spatial_weight,
        ])
        colour_limit = 20 if layer["role"] in {"subject-candidate", "character-candidate"} else 12 if layer["role"] == "static-support" else 3
        colour_count = min(colour_limit, len(np.unique(points, axis=0)))
        _, local_assignments = kmeans(features, max(1, colour_count), iterations=18)
        local_palette = np.asarray([
            np.clip(np.rint(points[local_assignments == index].mean(0)), 0, 255)
            if (local_assignments == index).any() else np.zeros(3)
            for index in range(max(1, colour_count))
        ], dtype=np.uint8)
        local_labels = np.full(labels.shape, -1, dtype=np.int16)
        local_labels[layer["mask"]] = local_assignments
        layer["localLabels"] = local_labels
        layer["localPalette"] = local_palette
        refined[layer["mask"]] = local_palette[local_assignments]
    fitted = refined
    difference = frame.astype(np.float64) - fitted.astype(np.float64)
    rmse = float(np.sqrt(np.mean(difference ** 2)))
    psnr = 99.0 if rmse == 0 else 20 * math.log10(255 / rmse)
    similarity = block_ssim(frame, fitted)
    edge = edge_f1(frame, fitted)
    return {
        "frame": frame, "fitted": fitted, "palette": palette, "labels": labels, "rectangles": rectangles,
        "structure": structure, "decomposition": decomposition, "temporal": temporal,
        "summary": {
            "width": frame.shape[1], "height": frame.shape[0], "paletteSize": len(palette),
            "regionCount": complexity, "rmseRgb": rounded(rmse, 3), "psnrDb": rounded(psnr, 3),
            "structuralSimilarity": rounded(similarity), "edgeF1": rounded(edge),
            "edgeDensity": rounded(density), "paletteEntropy": rounded(entropy), "dominantColourShare": rounded(dominant),
            "informationPenalty": rounded(information_penalty),
            "hybridConfidence": rounded(structure["confidence"]),
            "selectionScore": rounded(selection_error),
            "palette": [{"hex": hex_color(color), "share": rounded(shares[index], 4)} for index, color in enumerate(palette)],
        },
    }


def analyze(path, temporal=None, quality="standard"):
    profile = QUALITY_PROFILES[quality]
    frame = read_rgb(path, profile["analysisLongSide"])
    result = fit_frame(frame, temporal)
    evidence_frame = read_rgb(path, 960)
    while result["summary"]["regionCount"] > profile["regionBudget"] and min(frame.shape[:2]) > 48:
        frame = frame[::2, ::2]
        result = fit_frame(frame, temporal)
    result["evidenceFrame"] = evidence_frame
    result["summary"]["regionBudget"] = profile["regionBudget"]
    result["summary"]["budgetMet"] = result["summary"]["regionCount"] <= profile["regionBudget"]
    return result


def svg_of(result):
    width, height = result["summary"]["width"], result["summary"]["height"]
    palette = [hex_color(color) for color in result["palette"]]
    shapes = []
    for colour, x, y, w, h in result["rectangles"]:
        shapes.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{palette[colour]}"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" shape-rendering="crispEdges">{"".join(shapes)}</svg>\n'


def simplify_loop(points, epsilon):
    """Douglas-Peucker on a closed polyline (anchored at its two farthest-apart points)."""
    count = len(points)
    if count < 8:
        return points
    first = 0
    second = int(np.argmax(np.linalg.norm(points - points[first], axis=1)))
    def rdp(lo, hi, out):
        if hi - lo < 2:
            return
        a, b = points[lo], points[hi % count]
        d = b - a
        norm = float(np.hypot(*d)) or 1e-9
        idx = np.arange(lo + 1, hi) % count
        dist = np.abs(d[0] * (points[idx, 1] - a[1]) - d[1] * (points[idx, 0] - a[0])) / norm
        far = int(np.argmax(dist))
        if dist[far] > epsilon:
            mid = lo + 1 + far
            rdp(lo, mid, out); out.append(mid); rdp(mid, hi, out)
    keep = [first]
    rdp(first, second, keep); keep.append(second)
    rdp(second, first + count, keep)
    return points[sorted(set(keep))]


def smooth_loop(points, bounds, passes=None, spacing=0.5):
    """Relax pixel stair-steps with Taubin (shrink-free) smoothing of a resampled outline.

    Points on the asset border stay pinned so backdrops still tile edge to edge.
    """
    width, height = bounds
    pts = np.asarray(points, dtype=float)
    turn = np.cross(pts - np.roll(pts, 1, axis=0), np.roll(pts, -1, axis=0) - pts)
    corners = pts[np.abs(turn) > 1e-9]
    if len(corners) <= 4 and max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1])) > 3:
        return [tuple(p) for p in corners]  # a large axis-aligned rectangle is already exact
    if passes is None:  # larger shapes tolerate (and need) a wider smoothing radius
        extent = float(max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1])))
        passes = int(min(48, 8 + extent / 3))
    spans = np.linalg.norm(np.roll(pts, -1, axis=0) - pts, axis=1)
    dense = []
    for index, length in enumerate(spans):
        a, b = pts[index], pts[(index + 1) % len(pts)]
        steps = max(1, int(round(length / spacing)))
        dense.extend(a + (b - a) * (k / steps) for k in range(steps))
    dense = np.array(dense)
    pinned = (dense[:, 0] <= 0) | (dense[:, 0] >= width) | (dense[:, 1] <= 0) | (dense[:, 1] >= height)
    free = ~pinned
    if free.sum() < 3:
        return points
    for _ in range(passes):
        for factor in (0.5, -0.53):
            average = (np.roll(dense, 1, axis=0) + np.roll(dense, -1, axis=0)) / 2
            dense[free] += factor * (average[free] - dense[free])
    dense[:, 0] = np.clip(dense[:, 0], 0, width)
    dense[:, 1] = np.clip(dense[:, 1], 0, height)
    return [tuple(p) for p in simplify_loop(dense, 0.06)]


def path_data(loops, offset=(0, 0), bounds=None, smooth=True):
    ox, oy = offset
    commands = []
    for loop in loops:
        points = [(x - ox, y - oy) for x, y in loop]
        if smooth and bounds:
            points = smooth_loop(points, bounds)
        commands.append("M" + "L".join(f"{x:.2f},{y:.2f}".replace(".00", "") for x, y in points) + "Z")
    return "".join(commands)


def svg_paths(result, mask, bbox=None, label_map=None, local_palette=None):
    labels, palette = result["labels"], result["palette"]
    if bbox is None:
        bbox = [0, 0, labels.shape[1], labels.shape[0]]
    x0, y0, x1, y1 = bbox
    parts = []
    source_labels = label_map if label_map is not None else labels
    source_palette = local_palette if local_palette is not None else palette
    for label in np.unique(source_labels[mask]):
        data = path_data(mask_paths(mask & (source_labels == label)), (x0, y0), (x1 - x0, y1 - y0))
        if data:
            colour = hex_color(source_palette[int(label)])
            parts.append(f'<path d="{data}" fill="{colour}" stroke="{colour}" stroke-width="0.5" stroke-linejoin="round"/>')
    return "".join(parts)


def svg_asset(result, mask, bbox=None, label_map=None, local_palette=None):
    labels = result["labels"]
    if bbox is None:
        bbox = [0, 0, labels.shape[1], labels.shape[0]]
    x0, y0, x1, y1 = bbox
    parts = svg_paths(result, mask, bbox, label_map, local_palette)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {x1 - x0} {y1 - y0}" shape-rendering="geometricPrecision">{"".join(parts)}</svg>\n'


def opaque_background_svg(result):
    """Fill each removed measured layer with its dominant immediate surround."""
    background = result["decomposition"]["backgroundMask"]
    filled = result["labels"].copy()
    height, width = background.shape
    fallback = int(np.bincount(filled[background]).argmax()) if background.any() else 0
    for layer in result["decomposition"]["layers"]:
        mask = layer["mask"]
        expanded = mask.copy()
        for _ in range(6):
            padded = np.pad(expanded, 1, constant_values=False)
            grown = expanded.copy()
            for dy in range(3):
                for dx in range(3):
                    grown |= padded[dy:dy + height, dx:dx + width]
            expanded = grown
        ring = expanded & ~mask
        label = int(np.bincount(result["labels"][ring]).argmax()) if ring.any() else fallback
        filled[mask] = label
    return svg_asset(result, np.ones((height, width), dtype=bool), label_map=filled, local_palette=result["palette"])


def semantic_svg(result):
    width, height = result["summary"]["width"], result["summary"]["height"]
    parts = [svg_paths(result, result["decomposition"]["backgroundMask"])]
    parts.extend(svg_paths(result, item["mask"], label_map=item["localLabels"], local_palette=item["localPalette"]) for item in result["decomposition"]["layers"])
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" shape-rendering="geometricPrecision">{"".join(parts)}</svg>\n'


def layered_scene_module(result, layer_specs):
    width, height = result["summary"]["width"], result["summary"]["height"]
    aspect = width / height
    specs = json.dumps(layer_specs, separators=(",", ":"))
    return f'''// Generated measured semantic layers. Roles are evidence-based candidates, not fixed object classes.
export async function createMeasuredScene(THREE, options = {{}}) {{
  const scene = options.scene || new THREE.Scene();
  const root = new THREE.Group(); root.name = 'measured-semantic-root'; scene.add(root);
  const camera = options.camera || new THREE.OrthographicCamera(-{aspect:.8f}, {aspect:.8f}, 1, -1, 0.01, 100);
  if (!options.camera) camera.position.z = 2;
  const specs = {specs};
  const textures = [], materials = [], geometries = [], layers = [];
  for (const [index, spec] of specs.entries()) {{
    const assetUrl = new URL(spec.asset, import.meta.url).href;
    const texture = await new THREE.TextureLoader().loadAsync(assetUrl); textures.push(texture);
    if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
    const material = new THREE.MeshBasicMaterial({{ map: texture, transparent: true, alphaTest: .01, depthWrite: false, side: THREE.DoubleSide }}); materials.push(material);
    const worldWidth = 2 * {aspect:.8f} * spec.bounds[2] / {width};
    const worldHeight = 2 * spec.bounds[3] / {height};
    const geometry = new THREE.PlaneGeometry(worldWidth, worldHeight); geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material); mesh.name = spec.id;
    mesh.position.set(-{aspect:.8f} + 2 * {aspect:.8f} * (spec.bounds[0] + spec.bounds[2] / 2) / {width}, 1 - 2 * (spec.bounds[1] + spec.bounds[3] / 2) / {height}, index * .001);
    mesh.userData = {{ role: spec.role, confidence: spec.confidence, boundsPx: spec.bounds, editable: spec.role !== 'background' }};
    root.add(mesh); layers.push(mesh);
  }}
  return {{ scene, camera, root, layers, update() {{}}, dispose() {{ geometries.forEach(item => item.dispose()); materials.forEach(item => item.dispose()); textures.forEach(item => item.dispose()); }} }};
}}
'''


def component_label(component, labels, palette):
    values = labels[component["mask"]]
    label = int(np.bincount(values, minlength=len(palette)).argmax())
    return label, hex_color(palette[label])


def hybrid_svgs(result):
    width, height = result["summary"]["width"], result["summary"]["height"]
    labels, palette, structure = result["labels"], result["palette"], result["structure"]
    sky, ground, horizon = hex_color(palette[structure["sky"]]), hex_color(palette[structure["ground"]]), structure["horizon"]
    parts = [f'<rect width="{width}" height="{height}" fill="{sky}"/>', f'<rect y="{horizon}" width="{width}" height="{height - horizon}" fill="{ground}"/>']
    for component in structure["objects"]:
        for label in np.unique(labels[component["mask"]]):
            mask = component["mask"] & (labels == label)
            data = path_data(mask_paths(mask))
            if data:
                parts.append(f'<path d="{data}" fill="{hex_color(palette[int(label)])}"/>')
    preview = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" shape-rendering="geometricPrecision">{"".join(parts)}</svg>\n'

    character_svg = None
    character = structure["character"]
    if character:
        x0, y0, x1, y1 = character["bbox"]
        character_parts = []
        values, counts = np.unique(labels[character["mask"]], return_counts=True)
        for label in values[np.argsort(-counts)]:
            mask = character["mask"] & (labels == label)
            data = path_data(mask_paths(mask), (x0, y0))
            if data:
                character_parts.append(f'<path d="{data}" fill="{hex_color(palette[int(label)])}"/>')
        character_svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {x1 - x0} {y1 - y0}" shape-rendering="geometricPrecision">{"".join(character_parts)}</svg>\n'
    return preview, character_svg


def write_ppm(path, frame):
    height, width = frame.shape[:2]
    with open(path, "wb") as handle:
        handle.write(f"P6\n{width} {height}\n255\n".encode())
        handle.write(frame.astype(np.uint8).tobytes())


def scene_module(width, height):
    aspect = width / height
    return f'''// Generated measured 2D layer. Pass the host application's THREE namespace.
export async function createMeasuredScene(THREE, options = {{}}) {{
  const scene = options.scene || new THREE.Scene();
  const root = new THREE.Group();
  root.name = 'measured-style-root';
  scene.add(root);
  const camera = options.camera || new THREE.OrthographicCamera(-{aspect:.8f}, {aspect:.8f}, 1, -1, 0.01, 100);
  if (!options.camera) camera.position.z = 2;
  const assetUrl = options.assetUrl || new URL('./reconstruction.svg', import.meta.url).href;
  const texture = await new THREE.TextureLoader().loadAsync(assetUrl);
  if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({{ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false }});
  const worldHeight = Number.isFinite(options.worldHeight) ? options.worldHeight : 2;
  const geometry = new THREE.PlaneGeometry(worldHeight * {aspect:.8f}, worldHeight);
  const layer = new THREE.Mesh(geometry, material);
  layer.name = 'measured-2d-layer';
  layer.userData = {{ representation: 'svg-plane', role: '2d-character-or-scene-layer', billboard: true, worldAnchor: [0, 0, 0] }};
  const anchor = options.worldAnchor || [0, 0, 0];
  layer.position.set(anchor[0], anchor[1], anchor[2]);
  root.add(layer);
  const update = () => {{ if (options.billboard !== false && options.camera) layer.quaternion.copy(camera.quaternion); }};
  update();
  return {{ scene, camera, root, layer, update, dispose() {{ geometry.dispose(); material.dispose(); texture.dispose(); }} }};
}}
'''


def hybrid_scene_module(result):
    width, height = result["summary"]["width"], result["summary"]["height"]
    structure, labels, palette = result["structure"], result["labels"], result["palette"]
    sky = hex_color(palette[structure["sky"]])
    ground = hex_color(palette[structure["ground"]])
    sun = None
    if structure["sun"]:
        _, colour = component_label(structure["sun"], labels, palette)
        x0, y0, x1, y1 = structure["sun"]["bbox"]
        sun = {"colour": colour, "x": (x0 + x1) / 2 / width, "y": (y0 + y1) / 2 / height, "size": max(x1 - x0, y1 - y0) / height}
    buildings = []
    for component in structure["buildings"]:
        _, colour = component_label(component, labels, palette)
        x0, y0, x1, y1 = component["bbox"]
        buildings.append({"colour": colour, "x": ((x0 + x1) / 2 / width - 0.5) * 7, "width": (x1 - x0) / width * 7, "height": (y1 - y0) / height * 4})
    character = structure["character"]
    char = None
    if character:
        x0, y0, x1, y1 = character["bbox"]
        char = {"x": ((x0 + x1) / 2 / width - 0.5) * 6, "height": (y1 - y0) / height * 4, "aspect": (x1 - x0) / max(1, y1 - y0)}
    sun_json, buildings_json, char_json = json.dumps(sun), json.dumps(buildings), json.dumps(char)
    return f'''// Generated hybrid handoff: editable 3D world primitives plus a separate 2D character billboard.
export async function createMeasuredScene(THREE, options = {{}}) {{
  const scene = options.scene || new THREE.Scene();
  scene.background = new THREE.Color('{sky}');
  const camera = options.camera || new THREE.PerspectiveCamera(50, {width / height:.8f}, 0.1, 100);
  if (!options.camera) {{ camera.position.set(0, 2.5, 7); camera.lookAt(0, 1.2, 0); }}
  const root = new THREE.Group(); root.name = 'measured-hybrid-root'; scene.add(root);
  const groundMaterial = new THREE.MeshLambertMaterial({{ color: '{ground}' }});
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), groundMaterial);
  ground.name = 'measured-3d-ground'; ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; root.add(ground);
  const hemi = new THREE.HemisphereLight('{sky}', '{ground}', 1.4); hemi.name = 'measured-ambient'; scene.add(hemi);
  const key = new THREE.DirectionalLight('#fff2d6', 2.2); key.name = 'measured-key'; key.position.set(-3, 7, 4); key.castShadow = true; scene.add(key);
  const buildingSpecs = {buildings_json};
  const buildings = buildingSpecs.map((spec, index) => {{
    const geometry = new THREE.BoxGeometry(Math.max(.35, spec.width), Math.max(.45, spec.height), Math.max(.4, spec.width * .65));
    const material = new THREE.MeshLambertMaterial({{ color: spec.colour, flatShading: true }});
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `measured-building-${{index + 1}}`;
    mesh.position.set(spec.x, spec.height / 2, -1.2 - index * .35); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); return mesh;
  }});
  const sunSpec = {sun_json};
  let sun = null;
  if (sunSpec) {{
    sun = new THREE.Mesh(new THREE.CircleGeometry(Math.max(.2, sunSpec.size * 3), 32), new THREE.MeshBasicMaterial({{ color: sunSpec.colour }}));
    sun.name = 'measured-sun'; sun.position.set((sunSpec.x - .5) * 8, (1 - sunSpec.y) * 5, -4); root.add(sun);
  }}
  const charSpec = {char_json};
  let character = null, characterTexture = null;
  if (charSpec) {{
    const assetUrl = options.characterAssetUrl || new URL('./character.svg', import.meta.url).href;
    characterTexture = await new THREE.TextureLoader().loadAsync(assetUrl);
    if ('colorSpace' in characterTexture && THREE.SRGBColorSpace) characterTexture.colorSpace = THREE.SRGBColorSpace;
    character = new THREE.Mesh(new THREE.PlaneGeometry(charSpec.height * charSpec.aspect, charSpec.height), new THREE.MeshBasicMaterial({{ map: characterTexture, transparent: true, alphaTest: .02, side: THREE.DoubleSide }}));
    character.name = 'measured-2d-character'; character.position.set(charSpec.x, charSpec.height / 2, .35); character.castShadow = true;
    character.userData = {{ representation: 'svg-billboard', worldAnchor: [charSpec.x, 0, .35], editable: true }}; root.add(character);
  }}
  const update = () => {{ if (character && options.billboard !== false) character.quaternion.copy(camera.quaternion); }}; update();
  return {{ scene, camera, root, ground, buildings, sun, character, update, dispose() {{ root.traverse(object => {{ object.geometry?.dispose(); object.material?.dispose(); }}); characterTexture?.dispose(); }} }};
}}
'''


def aikiscene_package(result, quality):
    """Build a declarative fixed-layer set that AikiStudio can validate and edit."""
    width, height = result["summary"]["width"], result["summary"]["height"]
    aspect, fov, camera_z = width / height, 50.0, 8.0
    profile = QUALITY_PROFILES[quality]
    detected = result["decomposition"]["layers"][:max(0, profile["maxLayers"] - 1)]
    records = [{
        "id": "background", "role": "background", "confidence": 1.0,
        "bbox": [0, 0, width, height], "svg": opaque_background_svg(result), "z": -1.0,
        "backingColor": hex_color(result["palette"][result["structure"]["sky"]]),
    }]
    for index, item in enumerate(detected):
        x0, y0, x1, y1 = item["bbox"]
        records.append({
            "id": item["id"], "role": item["role"], "confidence": rounded(item["confidence"], 3),
            "bbox": [x0, y0, x1, y1],
            "svg": svg_asset(result, item["mask"], item["bbox"], item["localLabels"], item["localPalette"]),
            "z": -0.2 + index * (0.8 / max(1, len(detected) - 1)),
            "backingColor": hex_color(item["localPalette"][0]) if item["localPalette"] is not None and len(item["localPalette"]) else "#303030",
        })

    assets, layers, primitives = {}, [], []
    tangent = math.tan(math.radians(fov / 2))
    focal = 1 / tangent
    background_asset = "svg-background"
    world = world3d.build_world(width, height, fov, result["structure"], background_asset, hex_color(result["palette"][result["structure"]["sky"]]), hex_color(result["palette"][result["structure"]["ground"]]))
    shift = world["horizonNdc"]
    for record in records:
        x0, y0, x1, y1 = record["bbox"]
        is_background = record["id"] == "background"
        on_ground = False
        if is_background:
            distance = world3d.WALL_DISTANCE
        else:
            distance, on_ground = world3d.place_layer(world, record["bbox"], (width, height), focal, len(layers), record["role"])
        record["z"] = world3d.CAMERA_Z - distance
        view_height, view_width = 2 * distance * tangent, 2 * distance * tangent * aspect
        centre_x, centre_y = (x0 + x1) / 2 / width, (y0 + y1) / 2 / height
        size = [(x1 - x0) / width * view_width, (y1 - y0) / height * view_height]
        position = [(centre_x - 0.5) * view_width, (0.5 - centre_y) * view_height - shift * view_height / 2, record["z"]]
        asset_id = f'svg-{record["id"]}'
        assets[asset_id] = {"mediaType": "image/svg+xml", "encoding": "utf8", "content": record["svg"]}
        thickness = 0.025 if is_background else world3d.layer_thickness(record["role"], size, on_ground)
        if on_ground:
            primitives.append(world3d.contact_shadow(record["id"], position[0], world["ground"]["y"], position[2] - thickness / 2, size[0]))
        layers.append({
            "id": record["id"], "name": record["id"].replace("-", " ").title(), "role": record["role"], "assetId": asset_id,
            "transform": {"position": [rounded(value) for value in position], "rotation": [0, 0, 0], "scale": [1, 1, 1]},
            "size": [rounded(size[0]), rounded(size[1])],
            "thickness": thickness, "backingMode": "none" if is_background else "solid", "backingColor": record["backingColor"], "depthOrder": len(layers),
            "depth": {"distance": rounded(distance, 3), "standingOnGround": on_ground, "method": "backdrop" if is_background else "ground-contact" if on_ground else "far-backdrop"},
            "projectedBackdrop": is_background,
            "confidence": record["confidence"], "sourceBoundsPx": [x0, y0, x1 - x0, y1 - y0], "optional": False,
        })

    supported = len(layers) > 1
    warnings = [] if supported else ["No independently editable foreground layer could be recovered; AikiStudio must not build a flattened scene."]
    return {
        "schema": "aikistudio.scene-reconstruction/v1", "title": "Measured reference set", "units": "meters",
        "coordinateSystem": "threejs-y-up",
        "quality": {"profile": quality, **profile, "requestedFeatures": {"shadows": False, "antialiasing": "standard" if quality == "standard" else "high", "contourDetail": "balanced" if quality == "standard" else "detailed"}},
        "canvas": {"widthPx": width, "heightPx": height, "aspect": f"{width}:{height}"},
        "camera": {"projection": "perspective", "position": [0, 0, camera_z], "target": [0, 0, 0], "verticalFovDeg": fov, "near": 0.1, "far": 100, "lensShiftNdcY": world["horizonNdc"], "confidence": rounded(result["structure"]["confidence"], 3), "framingErrorPx": 0, "method": "analytic-screen-space-fit"},
        "world": world,
        "layers": layers, "primitives": primitives, "assets": assets,
        "validation": {"structuralSimilarity": result["summary"]["structuralSimilarity"], "edgeF1": result["summary"]["edgeF1"], "supported": supported, "warnings": warnings},
    }


def export(result, source, output_dir, quality="standard"):
    output_dir.mkdir(parents=True, exist_ok=True)
    temporal_confirmed = bool(result["decomposition"].get("temporalTracks"))
    hybrid = not temporal_confirmed and result["structure"]["confidence"] >= 0.79 and result["structure"]["character"] is not None
    detected_layers = result["decomposition"]["layers"]
    layered = not hybrid and len(detected_layers) >= 2 and any(item["role"] in {"subject-candidate", "character-candidate"} for item in detected_layers)
    character_svg = None
    if hybrid:
        svg, character_svg = hybrid_svgs(result)
    elif layered:
        svg = semantic_svg(result)
    else:
        svg = svg_of(result)
    (output_dir / "reconstruction.svg").write_text(svg, encoding="utf-8")
    if result.get("temporal"):
        (output_dir / "temporal-tracks.json").write_text(json.dumps(result["temporal"], indent=2) + "\n", encoding="utf-8")
    if character_svg:
        (output_dir / "character.svg").write_text(character_svg, encoding="utf-8")
    layer_records = []
    if layered:
        assets_dir = output_dir / "assets"
        assets_dir.mkdir(exist_ok=True)
        for stale_asset in assets_dir.glob("*.svg"):
            stale_asset.unlink()
        width, height = result["summary"]["width"], result["summary"]["height"]
        background_svg = svg_asset(result, result["decomposition"]["backgroundMask"])
        (assets_dir / "background.svg").write_text(background_svg, encoding="utf-8")
        layer_records.append({"id": "background", "role": "background", "confidence": 1.0, "bounds": [0, 0, width, height], "asset": "./assets/background.svg"})
        for item in detected_layers:
            x0, y0, x1, y1 = item["bbox"]
            filename = f'{item["id"]}.svg'
            (assets_dir / filename).write_text(svg_asset(result, item["mask"], item["bbox"], item["localLabels"], item["localPalette"]), encoding="utf-8")
            layer_records.append({
                "id": item["id"], "role": item["role"], "confidence": rounded(item["confidence"], 3),
                "bounds": [x0, y0, x1 - x0, y1 - y0], "asset": f"./assets/{filename}",
            })
        (output_dir / "layers.json").write_text(json.dumps(layer_records, indent=2) + "\n", encoding="utf-8")
    scene = hybrid_scene_module(result) if hybrid else layered_scene_module(result, layer_records) if layered else scene_module(result["summary"]["width"], result["summary"]["height"])
    (output_dir / "scene.js").write_text(scene, encoding="utf-8")
    (output_dir / "scene.aikiscene").write_text(json.dumps(aikiscene_package(result, quality), indent=2) + "\n", encoding="utf-8")
    reference_ppm, fitted_ppm = output_dir / "reference.ppm", output_dir / "reconstruction.ppm"
    write_ppm(reference_ppm, result["frame"])
    write_ppm(fitted_ppm, result["fitted"])
    for ppm, png in ((reference_ppm, output_dir / "reference.png"), (fitted_ppm, output_dir / "reconstruction.png")):
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(ppm), str(png)], check=True)
        ppm.unlink()
    summary = result["summary"]
    confidence = max(0.0, min(1.0, 1 - summary["selectionScore"]))
    blueprint = {
        "schema": "ikistudio.visual-reconstruction-blueprint/v1",
        "source": {"evidenceImage": str(source)},
        "representation": {
            "type": "hybrid-2d-3d" if hybrid else "semantic-layered-2d" if layered else "svg-plane",
            "hybridReady": True,
            "threeObject": "measured-hybrid-root" if hybrid else "measured-semantic-root" if layered else "measured-2d-layer",
        },
        "canvas": {
            "width": measurement(summary["width"], "px", "ffmpeg-area-scale", 1, 1),
            "height": measurement(summary["height"], "px", "ffmpeg-area-scale", 1, 1),
            "projection": {"value": "orthographic", "method": "bounded-vector-baseline", "confidence": rounded(confidence, 3), "samples": 1, "status": "fitted"},
        },
        "palette": [{
            "hex": item["hex"], "share": measurement(item["share"], "ratio", "deterministic-kmeans", result["labels"].size, confidence),
        } for item in summary["palette"]],
        "geometry": {
            "regionCount": measurement(summary["regionCount"], "rectangles", "merged-colour-runs", summary["height"], confidence),
            "regionBudget": {"value": summary["regionBudget"], "unit": "rectangles", "method": "performance-ceiling", "confidence": 1, "samples": 1, "status": "derived"},
            "regionBudgetMet": summary["budgetMet"],
            "assetBytes": measurement(len(svg.encode("utf-8")), "bytes", "utf8-length", 1, 1),
            "runtimeDrawCalls": {"value": (4 + len(result["structure"]["buildings"])) if hybrid else len(layer_records) if layered else 1, "unit": "draw-calls", "method": "hybrid-primitives" if hybrid else "semantic-svg-layers" if layered else "single-svg-plane", "confidence": 1, "samples": 1, "status": "derived"},
        },
        "components": {
            "character": {"available": result["structure"]["character"] is not None, "representation": "svg-billboard" if hybrid else "unseparated", "boundsPx": result["structure"]["character"]["bbox"] if result["structure"]["character"] else None, **({"volumeEvidence": volume_evidence(result, result["structure"]["character"]["mask"])} if result["structure"]["character"] else {})},
            "world": {"available": hybrid, "representation": "three-primitives" if hybrid else "unseparated", "buildingCount": len(result["structure"]["buildings"]), "buildingBoundsPx": [item["bbox"] for item in result["structure"]["buildings"]]},
            "sun": {"available": result["structure"]["sun"] is not None, "representation": "circle-geometry" if hybrid else "unseparated", "boundsPx": result["structure"]["sun"]["bbox"] if result["structure"]["sun"] else None},
            "horizonY": measurement(result["structure"]["horizon"], "px", "dominant-ground-row", result["summary"]["height"], result["structure"]["confidence"]),
            "semanticLayers": [{
                "id": item["id"], "role": item["role"], "confidence": rounded(item["confidence"], 3),
                "boundsPx": item["bbox"], "areaPx": item["area"],
                "palette": [hex_color(colour) for colour in item["localPalette"]] if item["localPalette"] is not None else [hex_color(result["palette"][label]) for label in item["labels"]],
                **({"volumeEvidence": volume_evidence(result, item["mask"])} if item["role"] in {"subject-candidate", "character-candidate"} else {}),
                **({"family": item["family"]} if item["family"] else {}),
                **({"track": item["track"]} if item.get("track") else {}),
                "asset": f'assets/{item["id"]}.svg' if layered else None,
            } for item in detected_layers],
            "atomicRegionCount": result["decomposition"]["atomCount"],
        },
        "reconstruction": {
            "rmseRgb": summary["rmseRgb"], "psnrDb": summary["psnrDb"],
            "structuralSimilarity": summary["structuralSimilarity"], "edgeF1": summary["edgeF1"],
            "selectionScore": summary["selectionScore"], "confidence": rounded(confidence, 3),
        },
        "temporal": {
            "available": bool((result.get("temporal") or {}).get("available")),
            "confirmedTracks": result["decomposition"].get("temporalTracks", []),
            "method": "median-background component motion",
        },
        "files": {"scene": "scene.js", "aikiScene": "scene.aikiscene", "vectorAsset": "reconstruction.svg", **({"characterAsset": "character.svg"} if hybrid else {}), **({"layerManifest": "layers.json"} if layered else {}), **({"temporalTracks": "temporal-tracks.json"} if result.get("temporal") else {}), "reference": "reference.png", "rendered": "reconstruction.png"},
        "limitations": ([
            "World geometry is recovered as bounded primitives; arbitrary topology and hidden surfaces remain unavailable.",
            "The 2D character is a measured billboard and stays editable as a separate scene object.",
        ] if hybrid else [
            "Layers are separated by measured appearance and topology; role names remain candidates until corroborated across video frames.",
            "Depth and hidden surfaces are unavailable from one image, so the Three.js handoff uses ordered SVG planes.",
        ] if layered else [
            "This bounded fallback fits colour regions on one 2D plane because hybrid evidence was insufficient.",
            "No unsupported 3D world geometry is invented.",
        ]),
    }
    (output_dir / "visual-reconstruction-blueprint.json").write_text(json.dumps(blueprint, indent=2) + "\n", encoding="utf-8")
    return blueprint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--measure-only", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--temporal", type=Path)
    parser.add_argument("--quality", choices=tuple(QUALITY_PROFILES), default="standard")
    args = parser.parse_args()
    temporal = json.loads(args.temporal.read_text(encoding="utf-8")) if args.temporal else None
    result = analyze(args.image, temporal, args.quality)
    if args.measure_only:
        print(json.dumps(result["summary"], separators=(",", ":")))
        return
    if not args.output_dir:
        raise RuntimeError("--output-dir is required unless --measure-only is used")
    blueprint = export(result, args.image, args.output_dir, args.quality)
    print(json.dumps({"summary": result["summary"], "blueprint": blueprint}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
