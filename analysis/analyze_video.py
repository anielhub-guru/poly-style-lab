#!/usr/bin/env python3
"""Measure animation cadence, cuts, body motion and the visual look (see look.py) for ONE short video.

Pass A reads the SOURCE at its native frame rate (tiny gray frames, via ffmpeg) so that
animating on ones/twos/threes and hard cuts are measured on the real frame grid.
Pass B reads the 30 FPS NORMALIZED clip and runs pose tracking only on frames whose picture
changed. Speeds are in shoulder-widths per second, so framing and resolution do not matter.

Pose tracking (opencv + mediapipe) is optional: without it only pass A runs.
"""

import argparse
import json
import re
import subprocess
import sys
import warnings
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import look  # noqa: E402  (colour, edge lines, softness and 2D effects; numpy only)

try:
    import cv2
    import mediapipe as mp
except ImportError:  # pose is optional
    cv2 = None
    mp = None

VERSION = 5
FPS = 30.0
HOLD = 0.85        # mean abs gray difference (0-255, 160x90) below which the picture is "held"
CUT_MIN = 22.0     # a cut needs at least this difference ...
CUT_RATIO = 5.0    # ... and this many times the typical moving-frame difference
MAX_GAP = 8        # frames of tracking loss after which a speed sample is not trusted
BIN = 6            # frames per bin when correlating mouth and body (0.2 s)
ACTIVE_PIXEL = 12  # gray-level change that counts a pixel as "moving" (landmark-free motion)
ACTIVE_FRACTION = 0.002  # a frame also counts as changed when this share of pixels moved (small, local movement)

POSE_GROUPS = {
    "head": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "shoulders": [11, 12],
    "hands": [15, 16, 17, 18, 19, 20, 21, 22],
    "torso": [11, 12, 23, 24],
    "hips": [23, 24],
    "legs": [25, 26, 27, 28, 29, 30, 31, 32],
}


def r(value, places=4):
    return round(float(value), places)


def summary(values):
    data = np.asarray([v for v in values if v is not None and np.isfinite(v)], dtype=np.float64)
    if data.size == 0:
        return {"samples": 0}
    return {
        "samples": int(data.size), "median": r(np.median(data)), "mean": r(data.mean()),
        "p10": r(np.percentile(data, 10)), "p90": r(np.percentile(data, 90)),
        "p95": r(np.percentile(data, 95)), "max": r(data.max()),
    }


# ---------------------------------------------------------------- pass A: native cadence, cuts

def native_fps(path):
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    for pattern in (r"(\d+(?:\.\d+)?) fps", r"(\d+(?:\.\d+)?) tbr"):
        match = re.search(pattern, err)
        if match and float(match.group(1)) > 0:
            return float(match.group(1))
    return 30.0


def gray_frames(path, max_sec):
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-t", str(max_sec), "-an",
               "-vf", "scale=160:90:flags=area,format=gray", "-f", "rawvideo", "-"]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = 160 * 90
    try:
        while True:
            buffer = process.stdout.read(size)
            if len(buffer) < size:
                break
            yield np.frombuffer(buffer, dtype=np.uint8).astype(np.int16)
    finally:
        process.stdout.close()
        process.wait()


def landmark_free_motion(diffs, regions, cut_set, distinct, fps, duration):
    """Where and how the picture moves, from frame differences only (works on cartoons; no models needed)."""
    frames = [i for i in sorted(regions) if i not in cut_set]
    if len(frames) < 8:
        return None
    rows = np.array([regions[i][0] for i in frames])
    cols = np.array([regions[i][1] for i in frames])
    share = lambda m: (m.sum(axis=0) / max(m.sum(), 1e-9)).tolist()
    row_share, col_share = share(rows), share(cols)
    previous = {distinct[k]: distinct[k - 1] for k in range(1, len(distinct))}
    per_sec = np.array([diffs[i] / ((i - previous[i]) / fps) for i in frames])  # change per second, comparable across animation step
    median = float(np.median(per_sec))
    threshold = max(float(np.percentile(per_sec, 90)), 3 * median)
    events = []
    for i, value in zip(frames, per_sec):
        if value >= threshold:
            if events and i - events[-1]["frame"] <= max(3, round(0.15 * fps)):
                events[-1]["value"] = max(events[-1]["value"], float(value))
            else:
                events.append({"frame": i, "value": float(value)})
    return {
        "regionShare": {"top": r(row_share[0]), "middle": r(row_share[1]), "bottom": r(row_share[2]),
                        "left": r(col_share[0]), "center": r(col_share[1]), "right": r(col_share[2])},
        "activeAreaRatio": summary([regions[i][2] for i in frames]),
        "energyPerSec": summary(per_sec.tolist()),
        "burstiness": r(float(np.percentile(per_sec, 95)) / median) if median > 0 else None,
        "accents": {"count": len(events), "per10s": r(len(events) * 10 / duration, 2),
                    "top": [{"timeSec": r(e["frame"] / fps, 2), "ratioToMedian": r(e["value"] / median, 2) if median > 0 else None} for e in sorted(events, key=lambda e: -e["value"])[:6]]},
    }


def pass_a(source, max_sec):
    fps = native_fps(source)
    diffs, actives, previous, regions = [], [], None, {}
    for frame in gray_frames(source, max_sec):
        if previous is None:
            diffs.append(0.0)
            actives.append(0.0)
        else:
            delta = np.abs(frame - previous)
            value = float(delta.mean())
            active = float((delta >= ACTIVE_PIXEL).mean())
            diffs.append(value)
            actives.append(active)
            if value >= HOLD or active >= ACTIVE_FRACTION:  # per-frame energy by thirds (rows/columns) and share of the frame that moved
                grid = delta.reshape(90, 160)
                regions[len(diffs) - 1] = ([float(grid[a:b].mean()) for a, b in ((0, 30), (30, 60), (60, 90))],
                                           [float(grid[:, a:b].mean()) for a, b in ((0, 53), (53, 107), (107, 160))],
                                           active)
        previous = frame
    frames = len(diffs)
    if frames < 6:
        raise RuntimeError("video is too short or unreadable")
    d = np.asarray(diffs[1:])
    changed = np.array([v >= HOLD or a >= ACTIVE_FRACTION for v, a in zip(diffs[1:], actives[1:])])
    moving = d[changed]
    typical = float(np.median(moving)) if moving.size else 0.0
    cut_threshold = max(CUT_MIN, CUT_RATIO * typical)

    cuts = []
    for index, value in enumerate(d, start=1):
        if value >= cut_threshold and (not cuts or index - cuts[-1] > 2):
            cuts.append(index)

    distinct = [0] + [i for i, flag in enumerate(changed, start=1) if flag]
    intervals = [int(x) for x in np.diff(distinct)]  # frames each picture stayed on screen
    shares = {}
    if len(intervals) >= 3:
        for label, test in (("ones", lambda x: x == 1), ("twos", lambda x: x == 2), ("threes", lambda x: x == 3), ("fourPlus", lambda x: x >= 4)):
            shares[label] = r(sum(1 for x in intervals if test(x)) / len(intervals))
        step_label = max(shares, key=shares.get)
        step = {"ones": 1, "twos": 2, "threes": 3}.get(step_label) or int(np.median([x for x in intervals if x >= 4]))
    else:
        step = None
    holds = [x - 1 for x in intervals if x > 1]

    motion = landmark_free_motion(diffs, regions, set(cuts), distinct, fps, frames / fps)

    boundaries = [0] + cuts + [frames]
    shot_lengths = [(b - a) / fps for a, b in zip(boundaries, boundaries[1:]) if b - a >= 3]
    longest = max(range(len(boundaries) - 1), key=lambda i: boundaries[i + 1] - boundaries[i])
    duration = frames / fps
    return {
        "nativeFps": r(fps, 3), "nativeFrames": frames, "analysedSec": r(duration, 2),
        "cadence": {
            "animationStepNativeFrames": step, "estimatedContentFps": r(fps / step, 2) if step else None,
            "imageIntervalMs": summary([x / fps * 1000 for x in intervals]),
            "intervalShare": shares, "duplicateFrameRatio": r(1.0 - float(changed.mean())),
            "holdFrames": summary(holds),
        },
        "shots": {"cuts": len(cuts), "cutsPerMinute": r(len(cuts) / duration * 60, 2), "lengthSec": summary(shot_lengths)},
        "motionEnergy": summary(moving.tolist()), "motion": motion,
        "_typicalDiff": typical, "_cutThreshold": cut_threshold,
        "_fallbackTimeSec": (boundaries[longest] + boundaries[longest + 1]) / 2 / fps,
    }


# ---------------------------------------------------------------- pass B: pose motion at 30 fps

def landmark_xy(landmarks, index, width, height, minimum=0.35):
    if landmarks is None:
        return None
    point = landmarks.landmark[index]
    if getattr(point, "visibility", 1.0) < minimum:
        return None
    return np.array([point.x * width, point.y * height])


def centroid_px(landmarks, indexes, width, height):
    points = [p for p in (landmark_xy(landmarks, i, width, height) for i in indexes) if p is not None]
    return np.mean(points, axis=0) if points else None


def binned(series, scale=1.0):
    data = np.asarray(series, dtype=np.float64) / scale
    usable = len(data) // BIN * BIN
    if usable == 0:
        return np.array([])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(data[:usable].reshape(-1, BIN), axis=1)


def correlation(a, b):
    mask = np.isfinite(a) & np.isfinite(b)
    if mask.sum() < 12 or np.std(a[mask]) < 1e-9 or np.std(b[mask]) < 1e-9:
        return None
    return r(np.corrcoef(a[mask], b[mask])[0, 1])


def pass_b(normalized, cut_threshold, typical_diff, fallback_time):
    capture = cv2.VideoCapture(str(normalized))
    if abs(capture.get(cv2.CAP_PROP_FPS) - FPS) > 0.5:
        raise RuntimeError(f"normalized clip is {capture.get(cv2.CAP_PROP_FPS):.2f} fps, expected 30")
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    holistic = mp.solutions.holistic.Holistic(
        static_image_mode=False, model_complexity=0, smooth_landmarks=False, refine_face_landmarks=False,
        min_detection_confidence=0.4, min_tracking_confidence=0.4)

    samples = {g: [] for g in POSE_GROUPS}      # (frame, px/s)
    accel = {g: [] for g in POSE_GROUPS}        # px/s^2
    series = {g: [] for g in POSE_GROUPS}       # per-frame px/s, NaN = unknown, 0 = picture held
    mouth_series, shoulder_widths, ear_widths = [], [], []
    prev_pos, prev_idx, prev_v = {}, {}, {}
    last_ok = {g: False for g in POSE_GROUPS}
    last_mouth, last_pose = np.nan, False
    pose_frames = processed = 0
    previous, best = None, {"score": -1e9, "frame": None}
    index = 0

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        small = cv2.cvtColor(cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.int16)
        diff = 0.0 if previous is None else float(np.abs(small - previous).mean())
        active = 0.0 if previous is None else float((np.abs(small - previous) >= ACTIVE_PIXEL).mean())
        previous = small
        cut = index > 0 and diff >= cut_threshold
        held = index > 0 and diff < HOLD and active < ACTIVE_FRACTION and not cut
        if cut:
            prev_pos.clear(); prev_idx.clear(); prev_v.clear()
            last_ok = {g: False for g in POSE_GROUPS}
            last_mouth, last_pose = np.nan, False

        if held:
            for g in POSE_GROUPS:
                series[g].append(0.0 if last_ok[g] else np.nan)
            mouth_series.append(last_mouth)
            pose_frames += int(last_pose)
        else:
            processed += 1
            result = holistic.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            pose, face = result.pose_landmarks, result.face_landmarks
            last_pose = pose is not None
            pose_frames += int(last_pose)
            if pose is not None:
                a, b = landmark_xy(pose, 11, width, height), landmark_xy(pose, 12, width, height)
                if a is not None and b is not None:
                    shoulder_widths.append(float(np.linalg.norm(a - b)))
                a, b = landmark_xy(pose, 7, width, height), landmark_xy(pose, 8, width, height)
                if a is not None and b is not None:
                    ear_widths.append(float(np.linalg.norm(a - b)))
                if index >= 15:
                    score = -abs(diff - typical_diff)
                    if score > best["score"]:
                        best = {"score": score, "frame": index}
            for g, ids in POSE_GROUPS.items():
                current = centroid_px(pose, ids, width, height)
                if current is None:
                    series[g].append(np.nan); last_ok[g] = False
                    continue
                before = prev_pos.get(g)
                if before is not None and index - prev_idx[g] <= MAX_GAP:
                    dt = (index - prev_idx[g]) / FPS
                    speed = float(np.linalg.norm(current - before)) / dt
                    samples[g].append((index, speed)); series[g].append(speed)
                    if g in prev_v:
                        accel[g].append(abs(speed - prev_v[g][0]) / ((index - prev_v[g][1]) / FPS))
                    prev_v[g] = (speed, index)
                else:
                    series[g].append(np.nan); prev_v.pop(g, None)
                prev_pos[g], prev_idx[g], last_ok[g] = current, index, True
            aperture = np.nan
            if face is not None:
                top, bottom = landmark_xy(face, 13, width, height, 0), landmark_xy(face, 14, width, height, 0)
                left, right = landmark_xy(face, 234, width, height, 0), landmark_xy(face, 454, width, height, 0)
                face_width = float(np.linalg.norm(left - right))
                if face_width > 1:
                    aperture = float(np.linalg.norm(top - bottom)) / face_width
            last_mouth = aperture
            mouth_series.append(aperture)
        index += 1

    holistic.close()
    capture.release()
    frames = index
    ratio = pose_frames / max(1, frames)

    if shoulder_widths:
        scale, basis = float(np.median(shoulder_widths)), "shoulder-width"
    elif ear_widths:
        scale, basis = float(np.median(ear_widths)) * 2.7, "ear-width-x2.7"
    else:
        scale, basis = height * 0.25, "frame-height-x0.25"
    scale = max(scale, 1.0)

    enough = len(samples["head"]) + len(samples["shoulders"]) >= 20
    usable = ratio >= 0.3 and enough and basis != "frame-height-x0.25"
    reason = None if usable else (f"pose tracked on only {ratio:.0%} of frames" if ratio < 0.3 else "too few body-motion samples" if not enough else "no shoulders or ears visible to scale motion")

    body = {g: {"speedPerSec": summary([v / scale for _, v in samples[g]]), "accelerationPerSec2": summary([a / scale for a in accel[g]])} for g in POSE_GROUPS}

    # snap accents: unusually fast moments, merged across body groups
    events = []
    for g, values in samples.items():
        speeds = np.array([v for _, v in values])
        if speeds.size < 8:
            continue
        threshold = max(np.percentile(speeds, 90), 3 * np.median(speeds))
        events += [(i, g, v / scale) for i, v in values if v >= threshold]
    events.sort()
    merged = []
    for i, g, v in events:
        if merged and i - merged[-1]["frame"] <= 3:
            merged[-1]["groups"].add(g); merged[-1]["speed"] = max(merged[-1]["speed"], v)
        else:
            merged.append({"frame": i, "groups": {g}, "speed": v})
    seconds = frames / FPS
    snaps = {
        "count": len(merged), "per10s": r(len(merged) * 10 / seconds, 2) if seconds else 0,
        "top": [{"timeSec": r(m["frame"] / FPS, 2), "groups": sorted(m["groups"]), "speedPerSec": r(m["speed"], 3)} for m in sorted(merged, key=lambda m: -m["speed"])[:8]],
    }

    mouth = binned(mouth_series)
    co_speech = None
    if np.isfinite(mouth).sum() >= 12:
        head, shoulders, hands = (binned(series[g], scale) for g in ("head", "shoulders", "hands"))
        size = min(len(mouth), len(head))
        threshold = np.nanpercentile(mouth, 60)
        active, quiet = mouth[:size] > threshold, mouth[:size] <= threshold
        valid = np.isfinite(head[:size]) & np.isfinite(mouth[:size])
        co_speech = {
            "mouthHeadCorrelation": correlation(mouth[:size], head[:size]),
            "mouthShoulderCorrelation": correlation(mouth[:min(len(mouth), len(shoulders))], shoulders[:min(len(mouth), len(shoulders))]),
            "mouthHandCorrelation": correlation(mouth[:min(len(mouth), len(hands))], hands[:min(len(mouth), len(hands))]),
            "headSpeedMouthActive": summary(head[:size][active & valid].tolist()),
            "headSpeedMouthQuiet": summary(head[:size][quiet & valid].tolist()),
        }

    representative = best["frame"] if best["frame"] is not None else int(fallback_time * FPS)
    return {
        "pose": {"available": True, "usable": usable, "reason": reason, "trackedFrameRatio": r(ratio), "processedFrames": processed, "frames": frames, "scalePx": r(scale, 1), "scaleBasis": basis},
        "bodyMotion": body, "coSpeech": co_speech, "snapEvents": snaps, "representativeFrame": {"frame": representative, "timeSec": r(representative / FPS, 2)},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="original video (native frame rate)")
    parser.add_argument("normalized", type=Path, help="constant 30 FPS clip")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-sec", type=float, default=45)
    parser.add_argument("--no-pose", action="store_true")
    parser.add_argument("--look-sheet", type=Path, help="write a frame | edges evidence sheet (PPM) here")
    parser.add_argument("--no-look", action="store_true")
    args = parser.parse_args()

    result = pass_a(args.source, args.max_sec)
    typical, threshold, fallback = result.pop("_typicalDiff"), result.pop("_cutThreshold"), result.pop("_fallbackTimeSec")
    result = {"version": VERSION, "analysisClock": {"fps": 30, "constantFrameRate": True}, **result}
    if cv2 is not None and mp is not None and not args.no_pose:
        result.update(pass_b(args.normalized, threshold, typical, fallback))
    else:
        result.update({"pose": {"available": False, "usable": False, "reason": "pose tracking not installed or disabled"}, "bodyMotion": None, "coSpeech": None, "snapEvents": None,
                       "representativeFrame": {"frame": int(fallback * FPS), "timeSec": r(fallback, 2)}})
    if args.no_look:
        result["look"] = {"available": False, "reason": "disabled"}
    else:
        try:
            result["look"] = look.analyze(args.normalized, args.max_sec, args.look_sheet)
        except Exception as error:  # the look is an extra; cadence and motion must survive its failure
            result["look"] = {"available": False, "reason": f"{type(error).__name__}: {error}"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # surfaced to the Node caller
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
