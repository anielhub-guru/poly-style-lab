#!/usr/bin/env python3
"""Measure animation motion from a CFR 30 FPS video using MediaPipe landmarks."""

import argparse
import json
import math
import statistics
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np


FPS = 30.0
POSE_GROUPS = {
    "head": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "shoulders": [11, 12],
    "hands": [15, 16, 17, 18, 19, 20, 21, 22],
    "torso": [11, 12, 23, 24],
    "hips": [23, 24],
    "legs": [25, 26, 27, 28, 29, 30, 31, 32],
}
FACE_GROUPS = {
    "mouth": [13, 14, 61, 291, 78, 308],
    "brows": [65, 105, 295, 334, 70, 300],
    "eyes": [33, 133, 263, 362, 159, 145, 386, 374],
}


def percentile(values, p):
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values, dtype=np.float64), p))


def summary(values):
    if not values:
        return {"samples": 0, "mean": 0, "median": 0, "p10": 0, "p90": 0, "p95": 0, "max": 0}
    return {
        "samples": len(values),
        "mean": round(float(statistics.fmean(values)), 6),
        "median": round(float(statistics.median(values)), 6),
        "p10": round(percentile(values, 10), 6),
        "p90": round(percentile(values, 90), 6),
        "p95": round(percentile(values, 95), 6),
        "max": round(float(max(values)), 6),
    }


def points(landmarks, indexes):
    if landmarks is None:
        return None
    visible = []
    for index in indexes:
        landmark = landmarks.landmark[index]
        if getattr(landmark, "visibility", 1.0) >= 0.35:
            visible.append((landmark.x, landmark.y, getattr(landmark, "z", 0.0)))
    return np.asarray(visible, dtype=np.float64) if visible else None


def centroid(landmarks, indexes):
    value = points(landmarks, indexes)
    return value.mean(axis=0) if value is not None else None


def distance(a, b):
    return float(np.linalg.norm(a[:2] - b[:2])) if a is not None and b is not None else None


def correlation(a, b):
    length = min(len(a), len(b))
    if length < 8:
        return 0.0
    left, right = np.asarray(a[-length:]), np.asarray(b[-length:])
    if np.std(left) < 1e-8 or np.std(right) < 1e-8:
        return 0.0
    return round(float(np.corrcoef(left, right)[0, 1]), 4)


def analyse(path):
    capture = cv2.VideoCapture(str(path))
    reported_fps = capture.get(cv2.CAP_PROP_FPS)
    if abs(reported_fps - FPS) > 0.05:
        raise RuntimeError(f"Expected normalized 30 FPS input, received {reported_fps:.3f} FPS")

    holistic = mp.solutions.holistic.Holistic(
        static_image_mode=False,
        model_complexity=1,
        smooth_landmarks=False,
        refine_face_landmarks=True,
        min_detection_confidence=0.45,
        min_tracking_confidence=0.45,
    )
    positions = {group: [] for group in POSE_GROUPS}
    velocities = {group: [] for group in POSE_GROUPS}
    accelerations = {group: [] for group in POSE_GROUPS}
    face_series = {group: [] for group in FACE_GROUPS}
    previous_position = {}
    previous_velocity = {}
    frame_diffs, holds, hold_runs, current_hold = [], [], [], 0
    mouth_aperture, head_speed, shoulder_speed, hand_speed = [], [], [], []
    tracked_frames = 0
    representative = {"frame": 0, "score": -1.0}
    previous_gray = None
    frame_index = 0

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        small = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        frame_diff = 0.0 if previous_gray is None else float(cv2.absdiff(gray, previous_gray).mean())
        frame_diffs.append(frame_diff)
        held = previous_gray is not None and frame_diff < 0.85
        holds.append(held)
        if held:
            current_hold += 1
        elif current_hold:
            hold_runs.append(current_hold)
            current_hold = 0
        previous_gray = gray

        result = holistic.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        pose = result.pose_landmarks
        face = result.face_landmarks
        if pose is not None:
            tracked_frames += 1
        confidence = 1.0 if pose is not None else 0.0
        score = confidence - abs(frame_diff - 4.0) * 0.015
        if frame_index > 15 and score > representative["score"]:
            representative = {"frame": frame_index, "score": score}

        for group, indexes in POSE_GROUPS.items():
            current = centroid(pose, indexes)
            if current is None:
                continue
            positions[group].append(current.tolist())
            prior = previous_position.get(group)
            velocity = distance(current, prior) * FPS if prior is not None else 0.0
            velocities[group].append(velocity)
            prior_velocity = previous_velocity.get(group)
            if prior_velocity is not None:
                accelerations[group].append(abs(velocity - prior_velocity) * FPS)
            previous_position[group] = current
            previous_velocity[group] = velocity

        for group, indexes in FACE_GROUPS.items():
            current = centroid(face, indexes)
            if current is not None:
                face_series[group].append(current.tolist())
        if face is not None:
            top = points(face, [13])
            bottom = points(face, [14])
            mouth_aperture.append(distance(top[0], bottom[0]) if top is not None and bottom is not None else 0.0)
        head_speed.append(velocities["head"][-1] if velocities["head"] else 0.0)
        shoulder_speed.append(velocities["shoulders"][-1] if velocities["shoulders"] else 0.0)
        hand_speed.append(velocities["hands"][-1] if velocities["hands"] else 0.0)
        frame_index += 1

    if current_hold:
        hold_runs.append(current_hold)
    holistic.close()
    capture.release()

    motion_threshold = percentile(frame_diffs[1:], 90)
    pose_jumps = []
    for group, values in velocities.items():
        threshold = percentile(values, 95)
        pose_jumps.extend({"group": group, "frame": index, "timeSec": round(index / FPS, 3), "speed": round(value, 5)} for index, value in enumerate(values) if threshold > 0 and value >= threshold)
    pose_jumps = sorted(pose_jumps, key=lambda item: item["speed"], reverse=True)[:80]

    talking = [value > percentile(mouth_aperture, 60) for value in mouth_aperture]
    talk_head = [head_speed[index] for index in range(min(len(talking), len(head_speed))) if talking[index]]
    quiet_head = [head_speed[index] for index in range(min(len(talking), len(head_speed))) if not talking[index]]
    return {
        "analysisClock": {"fps": 30, "frameDurationMs": 33.333333, "constantFrameRate": True},
        "video": {"path": str(path), "frames": frame_index, "durationSec": round(frame_index / FPS, 3), "trackedFrameRatio": round(tracked_frames / max(1, frame_index), 4)},
        "representativeFrame": {"frame": representative["frame"], "timeSec": round(representative["frame"] / FPS, 3)},
        "frameCadence": {
            "duplicateFrameRatio": round(sum(holds) / max(1, len(holds)), 6),
            "holdLengthsFrames": summary(hold_runs),
            "frameDifference": summary(frame_diffs[1:]),
            "highMotionThreshold": round(motion_threshold, 6),
        },
        "bodyMotion": {group: {"speedNormalizedPerSec": summary(velocities[group]), "accelerationNormalizedPerSec2": summary(accelerations[group])} for group in POSE_GROUPS},
        "faceMotion": {
            "mouthApertureNormalized": summary(mouth_aperture),
            "mouthHeadCorrelation": correlation(mouth_aperture, head_speed),
            "mouthShoulderCorrelation": correlation(mouth_aperture, shoulder_speed),
            "mouthHandCorrelation": correlation(mouth_aperture, hand_speed),
            "headSpeedWhileMouthActive": summary(talk_head),
            "headSpeedWhileMouthQuiet": summary(quiet_head),
        },
        "snapEvents": pose_jumps,
        "confidence": {"poseTracking": round(tracked_frames / max(1, frame_index), 4), "semanticMotion": "measured-landmarks"},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = analyse(args.video)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
