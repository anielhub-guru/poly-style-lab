"""Fake Holistic model with KNOWN motion so the analyser's maths can be checked exactly.

Head sways +-0.05 of the frame width once per second; shoulders are 0.2 of the width apart and still;
hands are still; the mouth opens and closes with the same rhythm. Expected head speed is about
1 shoulder-width per second, expected shoulder and hand speed 0.
"""
import math
import types

import cv2


class _Point:
    def __init__(self, x, y, visibility=1.0):
        self.x, self.y, self.visibility = x, y, visibility


class _Landmarks:
    def __init__(self, points):
        self.landmark = points


class Holistic:
    def __init__(self, **kwargs):
        pass

    def process(self, rgb):
        t = cv2.state["index"] / 30.0
        sway = 0.05 * math.sin(2 * math.pi * t)
        pose = [_Point(0.5, 0.5) for _ in range(33)]
        for index in range(11):
            pose[index] = _Point(0.5 + sway, 0.2)
        pose[11], pose[12], pose[23], pose[24] = _Point(0.4, 0.4), _Point(0.6, 0.4), _Point(0.42, 0.7), _Point(0.58, 0.7)
        for index in range(15, 23):
            pose[index] = _Point(0.3, 0.6)
        face = [_Point(0.5, 0.2) for _ in range(468)]
        face[13], face[14] = _Point(0.5, 0.2), _Point(0.5, 0.2 + 0.01 + 0.02 * abs(math.sin(2 * math.pi * t)))
        face[234], face[454] = _Point(0.4, 0.2), _Point(0.6, 0.2)
        return types.SimpleNamespace(pose_landmarks=_Landmarks(pose), face_landmarks=_Landmarks(face))

    def close(self):
        pass


solutions = types.SimpleNamespace(holistic=types.SimpleNamespace(Holistic=Holistic))
