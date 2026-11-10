#!/usr/bin/env python3
"""Build lightweight articulated rigs from measured reconstruction layers."""

import argparse
import json
import re
from pathlib import Path


VIEWBOX = re.compile(r'viewBox="0 0 ([\d.]+) ([\d.]+)"')


def read_svg(path):
    text = path.read_text(encoding="utf-8")
    match = VIEWBOX.search(text)
    if not match:
        raise RuntimeError(f"missing viewBox in {path.name}")
    return text, float(match.group(1)), float(match.group(2))


def clipped_svg(source, width, height, rect):
    x, y, w, h = rect
    inner = source[source.index(">") + 1:source.rindex("</svg>")]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:g} {height:g}" '
        'shape-rendering="geometricPrecision">'
        f'<defs><clipPath id="cut"><rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}"/></clipPath></defs>'
        f'<g clip-path="url(#cut)">{inner}</g></svg>'
    )


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def classify_subject(layer_data, track_data, scene_type):
    x0, y0, x1, y1 = layer_data["boundsPx"]
    width, height = max(1, x1 - x0), max(1, y1 - y0)
    area = max(1, layer_data.get("areaPx", width * height))
    compactness = area / (width * height)
    elongation = max(width, height) / min(width, height)
    palette_size = len(layer_data.get("palette", []))
    displacement = float((track_data or {}).get("displacementPx", 0))
    normalized_motion = displacement / max(width, height)
    persistence = float((track_data or {}).get("persistence", 0))
    runs = (track_data or {}).get("referenceMaskRuns", [])
    occupied_rows = len({item[0] for item in runs}) / height if runs else 0
    features = {
        "aspectRatio": round(width / height, 4), "elongation": round(elongation, 4),
        "compactness": round(compactness, 4), "paletteSize": palette_size,
        "normalizedMotion": round(normalized_motion, 4), "persistence": round(persistence, 4),
        "occupiedRowRatio": round(occupied_rows, 4),
    }
    if scene_type == "hybrid-2d-3d" and not track_data:
        return "2d-billboard-in-3d", "svg-billboard", round(clamp(.62 + palette_size * .02), 3), features
    spline_score = clamp((.38 - compactness) * 2.4 + min(1, elongation / 3) * .28 + occupied_rows * .18)
    articulated_score = clamp((compactness - .28) * 1.45 + min(1, palette_size / 8) * .28 + min(1, normalized_motion * 2) * .12)
    rigid_score = clamp(.58 - normalized_motion * .8 + max(0, .35 - persistence) + (1 if palette_size <= 3 else 0) * .12)
    scores = {
        "flexible-spline-character": spline_score,
        "articulated-2d-cutout": articulated_score,
        "rigid-sprite": rigid_score,
    }
    classification = max(scores, key=scores.get)
    strategy = {
        "flexible-spline-character": "spline-bands",
        "articulated-2d-cutout": "segmented-cutout",
        "rigid-sprite": "rigid-plane",
    }[classification]
    ordered = sorted(scores.values(), reverse=True)
    confidence = clamp(.5 + (ordered[0] - ordered[1]) * .55) if len(ordered) > 1 else .5
    features["scores"] = {key: round(value, 4) for key, value in scores.items()}
    return classification, strategy, round(confidence, 3), features


def motion(track_data):
    points = track_data.get("centroidsPx", [])
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return {
        "translationAmplitudePx": [round((max(xs) - min(xs)) / 2, 3), round((max(ys) - min(ys)) / 2, 3)] if points else [0, 0],
        "observedDisplacementPx": track_data["displacementPx"],
        "sampleFps": 12,
        "method": "centroid-range-over-measured-window",
    }


def centerline_from_runs(track_data, bounds, samples=8):
    x0, y0, x1, y1 = bounds
    rows = {}
    for y, left, right in track_data.get("referenceMaskRuns", []):
        rows.setdefault(y, []).append((left + right - 1) / 2)
    output = []
    for index in range(samples):
        y = y0 + (y1 - y0 - 1) * index / max(1, samples - 1)
        candidates = [(abs(row - y), sum(values) / len(values)) for row, values in rows.items()]
        x = min(candidates)[1] if candidates else (x0 + x1) / 2
        output.append([round((x - x0) / max(1, x1 - x0), 4), round((y - y0) / max(1, y1 - y0), 4)])
    return output


def build(blueprint_path, temporal_path, output_dir):
    blueprint = json.loads(blueprint_path.read_text(encoding="utf-8"))
    temporal = json.loads(temporal_path.read_text(encoding="utf-8")) if temporal_path else {"tracks": []}
    source_dir = blueprint_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = output_dir / "assets"
    assets_dir.mkdir(exist_ok=True)

    tracks = {item["id"]: item for item in temporal.get("tracks", [])}
    candidates = [item for item in blueprint["components"].get("semanticLayers", []) if item["role"] in {"subject-candidate", "character-candidate"} and item.get("asset")]
    if not candidates and blueprint["components"].get("character", {}).get("available") and (source_dir / "character.svg").exists():
        bounds = blueprint["components"]["character"]["boundsPx"]
        candidates = [{"id": "measured-character", "role": "character-candidate", "confidence": .7, "boundsPx": bounds, "areaPx": max(1, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]) // 2), "palette": [], "asset": "character.svg"}]

    subjects = []
    for candidate in candidates:
        track_id = (candidate.get("track") or {}).get("id")
        track_data = tracks.get(track_id)
        classification, strategy, confidence, features = classify_subject(candidate, track_data, blueprint["representation"]["type"])
        source, source_width, source_height = read_svg(source_dir / candidate["asset"])
        safe_id = re.sub(r"[^a-zA-Z0-9_-]", "-", candidate["id"])
        subject = {
            "id": safe_id, "sourceLayer": candidate["id"], "boundsPx": candidate["boundsPx"],
            "sourceSizePx": [source_width, source_height], "classification": classification,
            "selectedStrategy": strategy, "classificationConfidence": confidence, "features": features,
            "motion": motion(track_data) if track_data else {"translationAmplitudePx": [0, 0], "observedDisplacementPx": 0, "sampleFps": 0, "method": "no-temporal-evidence"},
        }
        if strategy == "segmented-cutout":
            templates = [
                ("upper", [0, 0, source_width, source_height * .30], [.50, .27], 4),
                ("left-side", [0, source_height * .30, source_width * .34, source_height * .34], [.32, .34], 3),
                ("core", [source_width * .34, source_height * .30, source_width * .39, source_height * .34], [.50, .31], 2),
                ("right-side", [source_width * .73, source_height * .30, source_width * .27, source_height * .34], [.73, .34], 3),
                ("lower", [0, source_height * .64, source_width, source_height * .36], [.50, .66], 1),
            ]
            parts = []
            for name, rect, pivot, order in templates:
                filename = f"{safe_id}-{name}.svg"
                (assets_dir / filename).write_text(clipped_svg(source, source_width, source_height, rect), encoding="utf-8")
                parts.append({"id": name, "cutRectPx": [round(v, 3) for v in rect], "pivotNormalized": pivot, "layerOrder": order, "asset": f"assets/{filename}"})
            subject.update({"parts": parts, "supportedMotion": ["root-translate", "upper-tilt", "side-swing", "lower-rock"], "unsupported": ["verified-anatomical-joints", "facial-expression"]})
        elif strategy == "spline-bands":
            bands, bones = 8, []
            for index in range(bands):
                y = source_height * index / bands
                band_height = source_height / bands + (1 if index < bands - 1 else 0)
                filename = f"{safe_id}-band-{index + 1}.svg"
                (assets_dir / filename).write_text(clipped_svg(source, source_width, source_height, [0, y, source_width, band_height]), encoding="utf-8")
                bones.append({"id": f"bone-{index + 1}", "cutRectPx": [0, round(y, 3), source_width, round(band_height, 3)], "pivotNormalized": [0.5, round((index + .5) / bands, 4)], "layerOrder": index + 1, "asset": f"assets/{filename}"})
            subject.update({"bones": bones, "centerlineNormalized": centerline_from_runs(track_data or {}, candidate["boundsPx"], bands), "supportedMotion": ["root-translate", "spline-wave", "end-turn"], "unsupported": ["semantic-head-identification", "independent-face-controls"]})
        else:
            filename = f"{safe_id}-plane.svg"
            (assets_dir / filename).write_text(source, encoding="utf-8")
            subject.update({"parts": [{"id": "plane", "cutRectPx": [0, 0, source_width, source_height], "pivotNormalized": [.5, .5], "layerOrder": 1, "asset": f"assets/{filename}"}], "supportedMotion": ["root-translate", "root-rotate", "root-scale"], "unsupported": ["internal-deformation"]})
        subjects.append(subject)

    world = blueprint["components"].get("world", {})
    objects = []
    if world.get("representation") == "three-primitives":
        for index, bounds in enumerate(world.get("buildingBoundsPx", []), 1):
            x0, y0, x1, y1 = bounds
            width, height = max(1, x1 - x0), max(1, y1 - y0)
            objects.append({
                "id": f"measured-world-object-{index}", "classification": "low-poly-3d-object",
                "selectedStrategy": "primitive-mesh", "classificationConfidence": round(clamp(blueprint["components"].get("character", {}).get("available", False) * .08 + .72), 3),
                "sourceBoundsPx": bounds,
                "features": {"aspectRatio": round(width / height, 4), "projectedAreaPx": width * height, "primitiveEvidence": "measured-building-region"},
                "primitive": {"type": "box", "depthRatio": .65, "flatShading": True},
            })

    rig = {
        "schema": "ikistudio.measured-character-rig/v1",
        "canvasPx": [blueprint["canvas"]["width"]["value"], blueprint["canvas"]["height"]["value"]],
        "sceneStrategy": {
            "classification": blueprint["representation"]["type"],
            "selectedStrategy": "primitive-mesh-with-svg-billboards" if blueprint["representation"]["type"] == "hybrid-2d-3d" else "ordered-svg-planes",
            "method": "measured-scene-representation",
        },
        "subjects": subjects,
        "objects": objects,
        "animation": {
            "durationSec": 6, "loopPeriodSec": 3,
            "poseDefinition": "absolute-time sinusoidal transforms; no source-coordinate replay",
            "seekSafe": True,
        },
    }
    rig_path = output_dir / "rig-definition.json"
    rig_path.write_text(json.dumps(rig, indent=2) + "\n", encoding="utf-8")
    module_path = output_dir / "rig-definition.js"
    module_path.write_text("export const rigDefinition = " + json.dumps(rig, separators=(",", ":")) + ";\n", encoding="utf-8")
    return rig_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("blueprint", type=Path)
    parser.add_argument("temporal", type=Path, nargs="?")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    path = build(args.blueprint, args.temporal, args.output_dir)
    print(json.dumps({"rig": str(path)}))


if __name__ == "__main__":
    main()
